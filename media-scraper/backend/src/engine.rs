//! 单任务顺序执行。任务在后端推进，页面只是观察者；不自动恢复中断任务。
use crate::{
    actors,
    database::{Database, SqlResult},
    images,
    metatube::{Backend, SourceFailure, wait_retry},
    model::*,
    nfo,
    planner::{self, Artifact, DirectoryCache, Plan},
    scan::{self, root_guard},
    writes::{self, Writer},
};
use rusqlite::params;
use tgdrive_backend_sdk::{Error, HostClient, Result};
use tgdrive_contract::{error_code, files::*};
use tokio_util::sync::CancellationToken;

pub fn fatal(error: &Error) -> bool {
    matches!(
        error.code(),
        error_code::SCOPE_DENIED
            | error_code::WRITE_NOT_DECLARED
            | error_code::SCOPE_CHANGED
            | error_code::APP_CHANGED
            | error_code::APP_DISABLED
            | error_code::UNAUTHORIZED
            | error_code::SESSION_EXPIRED
            | error_code::BACKEND_UNAVAILABLE
            | error_code::STORAGE_UNAVAILABLE
            | writes::NEEDS_VERIFICATION
    )
}
fn skipped(error: &Error) -> bool {
    matches!(
        error.code(),
        error_code::INVALID_REQUEST
            | error_code::INVALID_OPERATION
            | error_code::NOT_FOUND
            | error_code::NAME_CONFLICT
            | error_code::NODE_CHANGED
            | error_code::CHILDREN_CHANGED
            | error_code::CONTENT_CHANGED
            | error_code::PAYLOAD_TOO_LARGE
            | error_code::QUOTA_EXCEEDED
    )
}
pub fn finish_remaining(db: &Database, run: &str, message: &str) -> Result<()> {
    let mut after = -1i64;
    loop {
        let items = db.items(run, after, 200)?;
        if items.is_empty() {
            return Ok(());
        }
        for mut item in items {
            after = item.position;
            if matches!(item.state.as_str(), "pending" | "processing") {
                let unknown = db
                    .steps(&item.id)?
                    .iter()
                    .any(|s| writes::unsettled(&s.state));
                item.state = if unknown {
                    "needs_verification"
                } else {
                    "stopped"
                }
                .into();
                item.reason = message.into();
                db.save_item(&item)?;
            }
        }
    }
}
async fn select_movie(
    backend: &Backend,
    db: &Database,
    item: &Item,
    nfo_required: bool,
    cancel: &CancellationToken,
) -> Result<Movie> {
    if let Some(movie) = db.source(&item.run_id, &item.number)? {
        return Ok(movie);
    }
    let candidates = backend
        .search(&item.number, cancel, |error| {
            db.attempt(&item.id, "search", "MetaTube", &error.message)
        })
        .await?;
    if candidates.is_empty() {
        return Err(Error::api(
            error_code::INVALID_OPERATION,
            "没有与影片番号匹配的资料",
        ));
    }
    let mut retry: Vec<(Candidate, SourceFailure)> = Vec::new();
    let mut failures = Vec::new();
    // 第一遍依次尝试不同来源；只有全部未成功时才重试可重试来源一次。
    for round in 0..=1 {
        let current: Vec<_> = if round == 0 {
            candidates.iter().cloned().map(|c| (c, None)).collect()
        } else {
            retry
                .iter()
                .cloned()
                .map(|(c, e)| (c, Some(e.retry_after)))
                .collect()
        };
        for (candidate, delay) in current {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if let Some(delay) = delay {
                wait_retry(cancel, delay).await?;
            }
            match backend.movie_once(&candidate, cancel).await {
                Ok(mut movie) => {
                    movie.number = valid_number(&movie.number)?;
                    if nfo_required && let Err(error) = movie.nfo() {
                        db.attempt(&item.id, "nfo", &candidate.provider, &error.to_string())?;
                        failures.push(format!("{}：{}", candidate.provider, error));
                        continue;
                    }
                    db.adopt_source(&item.run_id, &movie)?;
                    return Ok(movie);
                }
                Err(error) => {
                    if cancel.is_cancelled() {
                        return Err(Error::Cancelled);
                    }
                    db.attempt(&item.id, "detail", &candidate.provider, &error.message)?;
                    failures.push(format!("{}：{}", candidate.provider, error.message));
                    if round == 0 && error.retryable {
                        retry.push((candidate, error));
                    }
                }
            }
        }
    }
    let mut summary = failures
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join("；");
    if failures.len() > 3 {
        summary.push_str(&format!(
            "；另有 {} 次来源失败，详见操作记录",
            failures.len() - 3
        ));
    }
    Err(Error::api(error_code::UPSTREAM_UNAVAILABLE, &summary))
}
async fn verify_previous(
    host: &dyn HostClient,
    db: &Database,
    process: &str,
    run: &Run,
    cancel: &CancellationToken,
) -> Result<()> {
    let Some(old_id) = &run.retry_of else {
        return Ok(());
    };
    let old = db.run(old_id)?;
    if !old.scan_complete {
        return Ok(());
    }
    let writer = Writer {
        host,
        db,
        process_id: process,
        scope: &run.scope_revision,
        cancel,
    };
    let mut after = -1i64;
    loop {
        let items = db.items(old_id, after, 200)?;
        if items.is_empty() {
            break;
        }
        for mut item in items {
            after = item.position;
            if item.state == "done" {
                continue;
            }
            let mut settled = true;
            for mut step in db.steps(&item.id)? {
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                settled &= writer.verify(&mut step).await?;
            }
            if !settled {
                item.state = "needs_verification".into();
                item.reason = "旧任务仍有未取得终态证据的写入，未开始补缺".into();
                db.save_item(&item)?;
                return Err(Error::api(writes::NEEDS_VERIFICATION, &item.reason));
            }
            // 原任务的已提交步骤只核实；后续新计划读取当前资料并采用补缺模式。
            if item.state == "needs_verification" {
                item.state = "failed".into();
                item.reason = "旧写入已核实，按当前文件补缺".into();
                db.save_item(&item)?;
            }
        }
    }
    if db.source_url(&run.id)? == db.source_url(old_id)? {
        db.with(|sql| { sql.execute("INSERT OR IGNORE INTO sources(run_id,number_key,movie) SELECT ?1,number_key,movie FROM sources WHERE run_id=?2",params![run.id,old_id]).app()?; Ok(()) })?;
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn prepare_actors(
    host: &dyn HostClient,
    db: &Database,
    backend: &Backend,
    run: &Run,
    item: &Item,
    movie: &Movie,
    plan: &Plan,
    cancel: &CancellationToken,
) -> Result<Vec<actors::Enriched>> {
    if let Some(old_run) = &run.retry_of
        && db.source_url(old_run)? == db.source_url(&run.id)?
        && let Some(first) = item.files.first()
        && let Some(previous) = db.previous_item(old_run, &first.id)?
        && !previous.actors.is_empty()
        && previous
            .actors
            .iter()
            .map(|a| a.data.name.clone())
            .collect::<Vec<_>>()
            == movie.actor_names()
    {
        let parent = plan.target.as_ref().unwrap_or(&plan.source);
        let steps = db.steps(&previous.id)?;
        let mut rows: Vec<_> = previous
            .actors
            .iter()
            .cloned()
            .map(|outcome| actors::Enriched {
                outcome,
                image: None,
            })
            .collect();
        for (i, row) in rows.iter_mut().enumerate() {
            row.outcome.data.thumb.clear();
            row.outcome.image_step = None;
            if let Some(step) = steps
                .iter()
                .rev()
                .find(|s| s.role == format!("actor_{i}") && s.state == "done")
                && let Some(file) = writes::confirmed_content(step)
                && let Ok(node) = planner::cancellable(
                    cancel,
                    host.stat(NodeReference::Id {
                        id: file.id,
                        content_version: Some(file.content_version),
                    }),
                )
                .await
                && node.parent_id.as_ref() == Some(&parent.id)
                && node.name == step.name
            {
                row.outcome.data.thumb = node.name;
                row.outcome.image_step = Some(step.id.clone());
                row.outcome.state = "matched".into();
            }
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        return actors::complete_known_images(backend, rows, cancel).await;
    }
    actors::enrich(backend, movie.actor_names(), cancel).await
}

#[allow(clippy::too_many_arguments)]
async fn process_item(
    host: &dyn HostClient,
    db: &Database,
    process: &str,
    backend: &Backend,
    run: &Run,
    item: &mut Item,
    cache: &mut DirectoryCache,
    cancel: &CancellationToken,
) -> Result<()> {
    let options = db.run_options(&run.id)?;
    let mut plan = planner::build(
        host,
        cache,
        &item.files,
        &item.number,
        &run.scope_revision,
        options,
        cancel,
    )
    .await?;
    let movie = if plan.needs_source {
        let movie = select_movie(backend, db, item, plan.nfo.action != "keep", cancel).await?;
        plan = planner::build(
            host,
            cache,
            &item.files,
            &movie.number,
            &run.scope_revision,
            options,
            cancel,
        )
        .await?;
        Some(movie)
    } else {
        None
    };
    item.number = plan.number.clone();
    item.target_id = plan.target.as_ref().map(|n| n.id.clone());
    db.save_item(item)?;
    let writer = Writer {
        host,
        db,
        process_id: process,
        scope: &run.scope_revision,
        cancel,
    };
    let root = root_guard(host, run, cancel).await?;
    let organized = writer.organize(item, &root, &plan).await?;
    item.target_id = organized.target_id.clone();
    db.save_item(item)?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if !plan.moving.is_empty() {
        let mut files = Vec::new();
        for previous in &plan.videos {
            let file = planner::cancellable(
                cancel,
                host.stat(NodeReference::Id {
                    id: previous.id.clone(),
                    content_version: previous.content_version.clone(),
                }),
            )
            .await?;
            files.push(file);
        }
        item.files = files;
        db.save_item(item)?;
        plan = planner::build(
            host,
            cache,
            &item.files,
            &plan.number,
            &run.scope_revision,
            options,
            cancel,
        )
        .await?;
    }
    let nfo_step = if plan.nfo.action == "keep" {
        writer.keep(item, "nfo", &plan.nfo)?
    } else {
        let movie = movie
            .as_ref()
            .ok_or(Error::Protocol("NFO 写入缺少影片资料"))?;
        let mut enriched =
            prepare_actors(host, db, backend, run, item, movie, &plan, cancel).await?;
        for (i, row) in enriched.iter_mut().enumerate() {
            if row.image.is_some() {
                row.outcome.data.thumb = nfo::actor_image_name(&plan.base, &item.id, i);
            }
        }
        actors::fit_nfo(movie, &mut enriched)?;
        let names: Vec<_> = enriched
            .iter()
            .map(|row| row.outcome.data.thumb.clone())
            .collect();
        for row in &mut enriched {
            if row.image.is_some() {
                row.outcome.data.thumb.clear();
            }
        }
        item.actors = enriched.iter().map(|row| row.outcome.clone()).collect();
        item.actors_summary = actors::summary(&item.actors);
        db.save_item(item)?;
        for (i, row) in enriched.into_iter().enumerate() {
            let Some(bytes) = row.image else {
                continue;
            };
            let root = root_guard(host, run, cancel).await?;
            let artifact = Artifact {
                action: "create".into(),
                name: names[i].clone(),
                existing: None,
            };
            match writer
                .upload(
                    item,
                    &root,
                    &plan,
                    cache,
                    &format!("actor_{i}"),
                    &artifact,
                    bytes,
                )
                .await
            {
                Ok(step) => {
                    item.actors[i].data.thumb = step.name.clone();
                    item.actors[i].image_step = Some(step.id);
                    item.actors[i].state = "matched".into();
                }
                Err(error) if fatal(&error) || matches!(error, Error::Cancelled) => {
                    return Err(error);
                }
                Err(error) => {
                    item.actors[i].state = "failed".into();
                    item.actors[i].message = error.to_string();
                    item.actors[i].data.thumb.clear();
                }
            }
            item.actors_summary = actors::summary(&item.actors);
            db.save_item(item)?;
        }
        let nfo = movie.nfo_with_actors(
            &item
                .actors
                .iter()
                .map(|a| a.data.clone())
                .collect::<Vec<_>>(),
        )?;
        let root = root_guard(host, run, cancel).await?;
        writer
            .upload(item, &root, &plan, cache, "nfo", &plan.nfo, nfo)
            .await?
    };
    writer
        .cleanup_actors(item, run, &plan, cache, &nfo_step)
        .await?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if plan.poster.action == "keep" {
        writer.keep(item, "poster", &plan.poster)?;
    } else {
        let movie = movie
            .as_ref()
            .ok_or(Error::Protocol("海报写入缺少影片资料"))?;
        let input = backend
            .image(&movie.provider, &movie.id, cancel)
            .await
            .map_err(|e| e.app())?
            .ok_or_else(|| Error::api(error_code::UPSTREAM_UNAVAILABLE, "海报来源返回 HTTP 404"))?;
        let poster = images::prepare(input, false).await.map_err(|_| {
            Error::api(
                error_code::UPSTREAM_UNAVAILABLE,
                "海报来源返回无法解码或超过像素预算的图片",
            )
        })?;
        let root = root_guard(host, run, cancel).await?;
        writer
            .upload(item, &root, &plan, cache, "poster", &plan.poster, poster)
            .await?;
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    item.state = "done".into();
    item.reason = item.actors_summary.clone();
    db.save_item(item)
}
pub async fn execute(
    host: &dyn HostClient,
    db: &Database,
    process: &str,
    run: &Run,
    cancel: &CancellationToken,
) -> Result<()> {
    verify_previous(host, db, process, run, cancel).await?;
    scan::scan(host, db, run, cancel).await?;
    let settings = db.settings()?;
    let backend = Backend::new(&settings.view.backend_url, settings.token)?;
    let mut cache = DirectoryCache::default();
    let mut after = -1i64;
    loop {
        let items = db.items(&run.id, after, 100)?;
        if items.is_empty() {
            return Ok(());
        }
        for mut item in items {
            after = item.position;
            if item.state == "skipped" {
                continue;
            }
            root_guard(host, run, cancel).await?;
            item.state = "processing".into();
            item.reason.clear();
            db.save_item(&item)?;
            db.run_state(
                &run.id,
                "running",
                &format!(
                    "正在处理 {} · {}",
                    item.number,
                    item.files.first().map(|n| n.name.as_str()).unwrap_or("")
                ),
            )?;
            if let Err(error) = process_item(
                host, db, process, &backend, run, &mut item, &mut cache, cancel,
            )
            .await
            {
                if matches!(error, Error::Cancelled) || fatal(&error) {
                    return Err(error);
                }
                item.state = if skipped(&error) { "skipped" } else { "failed" }.into();
                item.reason = error.to_string();
                db.save_item(&item)?;
                // 普通资料源/图片失败只结束本项；有界缓存继续通过变更游标核对。
            }
        }
    }
}
