//! 演员补充总计 40 秒、最多三个并发查询；失败只保留姓名，不阻塞整部影片。
use crate::{
    images,
    metatube::Backend,
    model::{Actor, ActorOutcome, Movie},
};
use futures_util::{StreamExt, stream};
use std::time::Duration;
use tgdrive_backend_sdk::{Error, Result};
use tokio_util::sync::CancellationToken;

pub const TOTAL_BUDGET: Duration = Duration::from_secs(40);
const ALL_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub struct Enriched {
    pub outcome: ActorOutcome,
    pub image: Option<Vec<u8>>,
}
async fn one(
    backend: &Backend,
    name: String,
    order: usize,
    cancel: &CancellationToken,
) -> Enriched {
    let mut outcome = ActorOutcome {
        data: Actor {
            name: name.clone(),
            order: Some(order as u32),
            ..Default::default()
        },
        state: "unmatched".into(),
        message: "没有唯一精确同名的人物资料".into(),
        image_step: None,
    };
    let person = match backend.person(&name, cancel).await {
        Ok(Some(person)) => person,
        Ok(None) => {
            return Enriched {
                outcome,
                image: None,
            };
        }
        Err(error) => {
            outcome.state = "failed".into();
            outcome.message = error.message;
            return Enriched {
                outcome,
                image: None,
            };
        }
    };
    outcome.data.provider = person.provider.clone();
    outcome.data.id = person.id.clone();
    outcome.data.biography = person.summary.trim().to_owned();
    let image = match backend.image(&person.provider, &person.id, cancel).await {
        Ok(Some(bytes)) => match images::prepare(bytes, true).await {
            Ok(image) => {
                outcome.state = "matched".into();
                outcome.message.clear();
                Some(image)
            }
            Err(_) => {
                outcome.state = "failed".into();
                outcome.message = "人物头像无法解码或超过图片预算".into();
                None
            }
        },
        Ok(None) => {
            outcome.state = "no_image".into();
            outcome.message = "人物来源未提供可用头像".into();
            None
        }
        Err(error) => {
            outcome.state = "failed".into();
            outcome.message = error.message;
            None
        }
    };
    Enriched { outcome, image }
}
pub async fn enrich(
    backend: &Backend,
    names: Vec<String>,
    cancel: &CancellationToken,
) -> Result<Vec<Enriched>> {
    enrich_with_budget(backend, names, cancel, TOTAL_BUDGET).await
}
pub async fn enrich_with_budget(
    backend: &Backend,
    names: Vec<String>,
    cancel: &CancellationToken,
    budget: Duration,
) -> Result<Vec<Enriched>> {
    let mut results: Vec<_> = names
        .iter()
        .enumerate()
        .map(|(i, name)| Enriched {
            outcome: ActorOutcome {
                data: Actor {
                    name: name.clone(),
                    order: Some(i as u32),
                    ..Default::default()
                },
                state: "timeout".into(),
                message: "人物补充已达到本片 40 秒查询等待上限".into(),
                image_step: None,
            },
            image: None,
        })
        .collect();
    let mut requests = stream::iter(
        names
            .into_iter()
            .enumerate()
            .map(|(i, name)| async move { (i, one(backend, name, i, cancel).await) }),
    )
    .buffer_unordered(3);
    let deadline = tokio::time::Instant::now() + budget.min(TOTAL_BUDGET);
    let (mut image_bytes, mut biography_bytes) = (0usize, 0usize);
    loop {
        let next = tokio::select! { biased; _=cancel.cancelled()=>return Err(Error::Cancelled), _=tokio::time::sleep_until(deadline)=>break, value=requests.next()=>value };
        let Some((index, mut result)) = next else {
            break;
        };
        if result
            .image
            .as_ref()
            .is_some_and(|bytes| image_bytes.saturating_add(bytes.len()) > ALL_IMAGE_BYTES)
        {
            result.image = None;
            result.outcome.state = "failed".into();
            result.outcome.message = "本片头像资料超过 8 MiB 暂存预算".into();
        }
        if biography_bytes.saturating_add(result.outcome.data.biography.len())
            > crate::nfo::MAX_BYTES
        {
            result.outcome.data.biography.clear();
            result.outcome.message = "人物简介超过本片资料预算，已保留姓名和头像".into();
        }
        image_bytes += result.image.as_ref().map(Vec::len).unwrap_or(0);
        biography_bytes += result.outcome.data.biography.len();
        results[index] = result;
    }
    Ok(results)
}
/// 只丢弃无法容纳的可选人物字段；影片原始标题、完整简介和演员姓名绝不截断。
pub fn fit_nfo(movie: &Movie, enriched: &mut [Enriched]) -> Result<()> {
    let actors = |rows: &[Enriched]| {
        rows.iter()
            .map(|row| row.outcome.data.clone())
            .collect::<Vec<_>>()
    };
    if movie.nfo_with_actors(&actors(enriched)).is_ok() {
        return Ok(());
    }
    for row in enriched.iter_mut() {
        row.outcome.data.biography.clear();
        row.outcome.message = "人物简介无法完整写入 NFO，已保留姓名和可用头像".into();
    }
    if movie.nfo_with_actors(&actors(enriched)).is_ok() {
        return Ok(());
    }
    for row in enriched.iter_mut() {
        row.outcome.data.provider.clear();
        row.outcome.data.id.clear();
        row.outcome.data.thumb.clear();
        row.image = None;
        row.outcome.state = "failed".into();
        row.outcome.message = "人物附加资料超过 NFO 预算，已完整保留演员姓名".into();
    }
    movie.nfo_with_actors(&actors(enriched)).map(|_| ())
}
/// 手动重试只补已经精确匹配但尚未提交的头像；已核实的头像和人物资料复用，不重复生成文件。
pub async fn complete_known_images(
    backend: &Backend,
    mut rows: Vec<Enriched>,
    cancel: &CancellationToken,
) -> Result<Vec<Enriched>> {
    let requests: Vec<_> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            r.outcome.data.thumb.is_empty()
                && r.outcome.state == "matched"
                && !r.outcome.data.provider.is_empty()
                && !r.outcome.data.id.is_empty()
        })
        .map(|(i, r)| {
            (
                i,
                r.outcome.data.provider.clone(),
                r.outcome.data.id.clone(),
            )
        })
        .collect();
    let mut pending = stream::iter(requests.into_iter().map(|(i, provider, id)| async move {
        let image = match backend.image(&provider, &id, cancel).await {
            Ok(Some(bytes)) => images::prepare(bytes, true)
                .await
                .map(Some)
                .map_err(|_| "人物头像无法解码或超过预算".to_owned()),
            Ok(None) => Ok(None),
            Err(error) => Err(error.message),
        };
        (i, image)
    }))
    .buffer_unordered(3);
    let deadline = tokio::time::Instant::now() + TOTAL_BUDGET;
    let mut bytes = 0usize;
    let mut finished = std::collections::HashSet::new();
    loop {
        let next = tokio::select! { biased; _=cancel.cancelled()=>return Err(Error::Cancelled), _=tokio::time::sleep_until(deadline)=>break, next=pending.next()=>next };
        let Some((i, image)) = next else {
            break;
        };
        finished.insert(i);
        match image {
            Ok(Some(image)) if bytes + image.len() <= ALL_IMAGE_BYTES => {
                bytes += image.len();
                rows[i].image = Some(image);
            }
            Ok(None) => {
                rows[i].outcome.state = "no_image".into();
                rows[i].outcome.message = "人物来源未提供可用头像".into();
            }
            Ok(Some(_)) => {
                rows[i].outcome.state = "failed".into();
                rows[i].outcome.message = "本片头像超过 8 MiB 暂存预算".into();
            }
            Err(message) => {
                rows[i].outcome.state = "failed".into();
                rows[i].outcome.message = message;
            }
        }
    }
    for (i, row) in rows.iter_mut().enumerate() {
        if row.outcome.state == "matched"
            && row.outcome.data.thumb.is_empty()
            && row.image.is_none()
            && !finished.contains(&i)
        {
            row.outcome.state = "timeout".into();
            row.outcome.message = "补充头像达到本片 40 秒查询等待上限".into();
        }
    }
    Ok(rows)
}

pub fn summary(outcomes: &[ActorOutcome]) -> String {
    let done = outcomes.iter().filter(|a| !a.data.thumb.is_empty()).count();
    let mut parts = vec![format!("演员头像 {done}/{}", outcomes.len())];
    for (state, label) in [
        ("unmatched", "未匹配"),
        ("timeout", "查询超时"),
        ("failed", "补充失败"),
        ("no_image", "来源无头像"),
    ] {
        let count = outcomes.iter().filter(|a| a.state == state).count();
        if count != 0 {
            parts.push(format!("{label} {count}"));
        }
    }
    if outcomes
        .iter()
        .any(|a| a.message.contains("简介") && a.data.biography.is_empty())
    {
        parts.push("部分人物简介未写入，详见记录".into());
    }
    parts.join("，")
}
#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::{Response, service::service_fn};
    use hyper_util::rt::TokioIo;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[tokio::test]
    async fn deadline_preserves_every_name_and_limits_queries_to_three() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend =
            Backend::new(&format!("http://{}/", listener.local_addr().unwrap()), None).unwrap();
        let maximum = peak.clone();
        let server = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let active = active.clone();
                let maximum = maximum.clone();
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(
                            TokioIo::new(socket),
                            service_fn(move |_| {
                                let active = active.clone();
                                let maximum = maximum.clone();
                                async move {
                                    let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                                    maximum.fetch_max(count, Ordering::SeqCst);
                                    tokio::time::sleep(Duration::from_millis(200)).await;
                                    active.fetch_sub(1, Ordering::SeqCst);
                                    Ok::<_, std::convert::Infallible>(Response::new(Full::new(
                                        Bytes::from_static(b"{\"data\":[]}"),
                                    )))
                                }
                            }),
                        )
                        .await;
                });
            }
        });
        let names: Vec<_> = (0..7).map(|i| format!("合成演员{i}")).collect();
        let started = std::time::Instant::now();
        let rows = enrich_with_budget(
            &backend,
            names.clone(),
            &CancellationToken::new(),
            Duration::from_millis(60),
        )
        .await
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            rows.iter()
                .map(|r| &r.outcome.data.name)
                .collect::<Vec<_>>(),
            names.iter().collect::<Vec<_>>()
        );
        assert!(
            rows.iter()
                .all(|r| r.outcome.state == "timeout" && r.image.is_none())
        );
        assert!(peak.load(Ordering::SeqCst) > 0 && peak.load(Ordering::SeqCst) <= 3);
        server.abort();
    }
    #[test]
    fn optional_biographies_cannot_break_valid_movie_metadata() {
        let movie = Movie {
            number: "ABC-123".into(),
            title: "完整片名".into(),
            actors: Some(vec!["演员甲".into()]),
            ..Default::default()
        };
        let mut rows = vec![Enriched {
            outcome: ActorOutcome {
                data: Actor {
                    name: "演员甲".into(),
                    biography: "a".repeat(crate::nfo::MAX_BYTES),
                    ..Default::default()
                },
                ..Default::default()
            },
            image: None,
        }];
        fit_nfo(&movie, &mut rows).unwrap();
        assert!(rows[0].outcome.data.biography.is_empty());
        assert_eq!(rows[0].outcome.data.name, "演员甲");
        assert!(rows[0].outcome.message.contains("简介"));
    }
}
