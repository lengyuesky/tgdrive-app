//! 番号与资料身份是应用业务概念，不由宿主推断。
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::OnceLock};
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::{error_code, files::FileNode};

pub const DEFAULT_URL: &str = "https://metatube-server.hf.space/";
pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "m4v", "mov", "webm", "ogv", "avi", "wmv", "flv", "ts", "mts", "m2ts", "3gp",
];
pub const RETENTION_MILLIS: i64 = 30 * 86400 * 1000;
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(tgdrive_contract::http::MAX_TIMESTAMP_MILLIS as u128) as i64
}
pub fn random_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}
pub fn stem(name: &str) -> &str {
    name.rsplit_once('.').map(|(base, _)| base).unwrap_or(name)
}
pub fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}
pub fn video_name(name: &str) -> bool {
    VIDEO_EXTENSIONS.contains(&extension(name).as_str())
}
pub fn joined(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}
pub fn inside(root: &str, path: &str) -> bool {
    root == "/"
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}
pub fn normalized_number(value: &str) -> String {
    value
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(|b| char::from(b.to_ascii_uppercase()))
        .collect()
}
pub fn valid_number(value: &str) -> Result<String> {
    let value = value.trim().to_ascii_uppercase();
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        || !value.bytes().any(|b| b.is_ascii_digit())
        || value.starts_with(['-', '_'])
        || value.ends_with(['-', '_'])
    {
        return Err(Error::api(error_code::INVALID_REQUEST, "作品番号格式无效"));
    }
    Ok(value)
}

/// 番号后面可以直接连写的版本或分段标记：ABC-123A、ABC-123C、ABC-123UC、ABC-123CD1。
/// 其余紧跟的字母数字仍说明这不是一个完整的番号（例如 FHD-1080P）。
fn attached_marker(rest: &str) -> bool {
    static MARKER: OnceLock<Regex> = OnceLock::new();
    MARKER
        .get_or_init(|| {
            Regex::new(r"^(?:CD[0-9]{1,2}|UC|CH|[A-HU])(?:[^A-Z0-9]|$)")
                .expect("固定标记表达式有效")
        })
        .is_match(rest)
}

/// 与旧业务规则相同的五类编号；显式检查 ASCII 边界，不把画质和季集当成番号。
pub fn numbers(name: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    number_matches(&stem(name).to_ascii_uppercase())
        .into_iter()
        .map(|found| found.0)
        .filter(|number| seen.insert(number.clone()))
        .collect()
}

/// 在已转成大写的基本名里找出全部番号及其起止位置；同一番号出现多次时逐次列出。
pub fn number_matches(value: &str) -> Vec<(String, usize, usize)> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"FC2[ _-]*(?:PPV[ _-]*)?([0-9]{5,9})",
            r"([A-Z]{2,12})[ _-]+([0-9]{2,8})",
            r"([A-Z]{2,10})([0-9]{3,8})",
            r"([0-9]{2,4}[A-Z]{2,10})[ _-]?([0-9]{2,8})",
            r"([0-9]{6})[_-]([0-9]{2,4})",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("固定番号表达式有效"))
        .collect()
    });
    let mut result = Vec::new();
    for (kind, pattern) in patterns.iter().enumerate() {
        for matched in pattern.captures_iter(value) {
            let whole = matched.get(0).expect("完整匹配存在");
            if whole.start() > 0 && value.as_bytes()[whole.start() - 1].is_ascii_alphanumeric()
                || value
                    .as_bytes()
                    .get(whole.end())
                    .is_some_and(u8::is_ascii_alphanumeric)
                    && !attached_marker(&value[whole.end()..])
            {
                continue;
            }
            let first = &matched[1];
            if kind == 1
                && [
                    "FC", "PPV", "HEVC", "H264", "H265", "X264", "X265", "WEB", "BLURAY",
                ]
                .contains(&first)
                || kind == 2 && ["FC", "HEVC", "H", "X", "WEB"].contains(&first)
            {
                continue;
            }
            let number = match kind {
                0 => format!("FC2-PPV-{first}"),
                4 => format!("{first}_{}", &matched[2]),
                _ => format!("{first}-{}", &matched[2]),
            };
            result.push((number, whole.start(), whole.end()));
        }
    }
    // 连写的标记可能被另一类表达式从中间读成编号（ABC-123CD12 里的 123CD-12）；
    // 两处重叠时以靠前开始的为准。
    let spans: Vec<(usize, usize)> = result.iter().map(|found| (found.1, found.2)).collect();
    result.retain(|found| {
        !spans
            .iter()
            .any(|(start, end)| *start < found.1 && found.1 < *end)
    });
    result
}
pub fn infer_number(file: &FileNode) -> String {
    let own = numbers(&file.name);
    if own.len() == 1 {
        return own[0].clone();
    }
    if !own.is_empty() {
        return String::new();
    }
    let parent = file
        .path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    // 目录名不是文件名，附加一个后缀，避免把编号里的点当作扩展名剥掉。
    let folder = parent.rsplit('/').next().unwrap_or("");
    let values = numbers(&format!("{folder}.directory"));
    if values.len() == 1 {
        values[0].clone()
    } else {
        String::new()
    }
}
pub fn identity(provider: &str, id: &str) -> Result<()> {
    if [provider, id].iter().any(|s| {
        s.trim().is_empty()
            || s.len() > 200
            || matches!(*s, "." | "..")
            || s.chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\' | '?' | '#'))
    }) {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "资料来源或条目 ID 无效",
        ));
    }
    Ok(())
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Candidate {
    pub provider: String,
    pub id: String,
    pub number: String,
    pub title: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Movie {
    pub provider: String,
    pub id: String,
    pub number: String,
    pub title: String,
    pub summary: Option<String>,
    pub actors: Option<Vec<String>>,
    pub director: Option<String>,
    pub maker: Option<String>,
    pub label: Option<String>,
    pub series: Option<String>,
    pub genres: Option<Vec<String>>,
    pub score: Option<f64>,
    pub release_date: Option<String>,
    /// 本次写入的视频在同番号文件里的区分标签（版本、分段），写在标题末尾。
    /// 它描述文件而不是作品，不来自资料源，也不随采用的来源保存。
    #[serde(skip)]
    pub variant: String,
}
impl Movie {
    pub fn actor_names(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        self.actors
            .iter()
            .flatten()
            .map(|name| name.trim())
            .filter(|name| !name.is_empty() && seen.insert((*name).to_owned()))
            .map(str::to_owned)
            .collect()
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Person {
    pub name: String,
    pub provider: String,
    pub id: String,
    pub summary: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Actor {
    pub name: String,
    pub role: String,
    pub order: Option<u32>,
    pub thumb: String,
    pub biography: String,
    pub provider: String,
    pub id: String,
}
pub fn exact_candidates(candidates: Vec<Candidate>, number: &str) -> Vec<Candidate> {
    let expected = normalized_number(number);
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|c| {
            !expected.is_empty()
                && identity(&c.provider, &c.id).is_ok()
                && normalized_number(&c.number) == expected
                && seen.insert((c.provider.clone(), c.id.clone()))
        })
        .collect()
}
pub fn exact_person(candidates: Vec<Person>, name: &str) -> Option<Person> {
    let mut seen = HashSet::new();
    let mut exact = candidates.into_iter().filter(|c| {
        c.name.trim() == name.trim()
            && identity(&c.provider, &c.id).is_ok()
            && seen.insert((c.provider.clone(), c.id.clone()))
    });
    let first = exact.next()?;
    exact.next().is_none().then_some(first)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SettingsView {
    pub revision: String,
    pub backend_url: String,
    pub token_configured: bool,
    pub overwrite_nfo: bool,
    pub overwrite_poster: bool,
    pub directory: Option<FileNode>,
}
#[derive(Clone)]
pub struct Settings {
    pub view: SettingsView,
    pub token: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigureRequest {
    pub revision: String,
    pub backend_url: String,
    pub token: Option<String>,
    pub overwrite_nfo: bool,
    pub overwrite_poster: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StartRequest {
    pub request_id: String,
    pub directory_id: String,
    pub retry_of: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Counts {
    pub total: u32,
    pub processed: u32,
    pub done: u32,
    pub skipped: u32,
    pub failed: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub root: FileNode,
    pub scope_revision: String,
    pub state: String,
    pub message: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub scan_complete: bool,
    pub counts: Counts,
    pub retry_of: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub run_id: String,
    pub position: i64,
    pub files: Vec<FileNode>,
    pub number: String,
    pub state: String,
    pub reason: String,
    pub target_id: Option<String>,
    pub actors: Vec<ActorOutcome>,
    pub actors_summary: String,
    /// 从文件名识别出的版本与分段标签；旧记录没有这个字段。
    #[serde(default)]
    pub variant: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ActorOutcome {
    pub data: Actor,
    pub state: String,
    pub message: String,
    pub image_step: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Attempt {
    pub sequence: i64,
    pub stage: String,
    pub provider: String,
    pub reason: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Step {
    pub id: String,
    pub process_id: String,
    pub before: Vec<FileNode>,
    pub run_id: String,
    pub item_id: String,
    pub role: String,
    pub state: String,
    pub name: String,
    pub target_id: Option<String>,
    pub sha256: Option<String>,
    pub size: Option<u64>,
    pub create_key: Option<String>,
    pub create_request: Option<tgdrive_contract::files::CreateUploadRequest>,
    pub upload: Option<tgdrive_contract::files::UploadInfo>,
    pub mutation_key: Option<String>,
    pub mutation_request: Option<tgdrive_contract::files::FileMutationRequest>,
    pub receipt: Option<tgdrive_contract::files::MutationReceipt>,
    pub file: Option<FileNode>,
    pub message: String,
    pub created_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn number_boundaries_and_quality_suffixes() {
        for (name, expected) in [
            ("ipx-001-4K.mp4", "IPX-001"),
            ("IPX001-CD1.mkv", "IPX-001"),
            ("FC2-PPV-1234567.mp4", "FC2-PPV-1234567"),
            ("200GANA-1234.mp4", "200GANA-1234"),
            ("123456_001.mp4", "123456_001"),
            ("SONE-614.mp4", "SONE-614"),
        ] {
            assert_eq!(numbers(name), vec![expected], "{name}");
        }
        for name in [
            "S01E03.1080p.H265.mkv",
            "HEVC-265.mp4",
            "H264-1080.mp4",
            "BLURAY-1080.mp4",
            "普通电影.mp4",
        ] {
            assert!(numbers(name).is_empty(), "{name}");
        }
        assert_eq!(numbers("ABC-123-DEF-456.mp4"), vec!["ABC-123", "DEF-456"]);
    }
    #[test]
    fn markers_written_directly_after_the_number_do_not_hide_it() {
        for name in [
            "ABC-123A.mp4",
            "abc-123b.mkv",
            "ABC-123C.mp4",
            "ABC123C.mp4",
            "ABC-123UC.mp4",
            "ABC-123ch.mp4",
            "ABC-123CD1.mp4",
            "ABC-123cd12 4K.mp4",
        ] {
            assert_eq!(numbers(name), vec!["ABC-123"], "{name}");
        }
        assert_eq!(numbers("FC2-PPV-1234567A.mp4"), vec!["FC2-PPV-1234567"]);
        // 其余连写仍不是番号：清晰度、更长的单词、非标记字母。
        for name in [
            "FHD-1080P.mp4",
            "UHD-2160P.mp4",
            "ABC-123K.mp4",
            "ABC-123AB.mp4",
            "ABC-123CDX.mp4",
            "ABC-123A1.mp4",
        ] {
            assert!(numbers(name).is_empty(), "{name}");
        }
        // 同一番号在文件名里出现两次仍是唯一番号。
        assert_eq!(numbers("ABC-123 [ABC-123] 4K.mp4"), vec!["ABC-123"]);
    }
    #[test]
    fn exact_sources_keep_order_and_deduplicate() {
        let c = |provider: &str, number: &str| Candidate {
            provider: provider.into(),
            id: "id".into(),
            number: number.into(),
            ..Default::default()
        };
        assert_eq!(
            exact_candidates(
                vec![
                    c("B", "ABC123"),
                    c("A", "ABC-123"),
                    c("B", "ABC123"),
                    c("C", "ABC-124"),
                    c("", "ABC-123")
                ],
                "abc_123"
            )
            .iter()
            .map(|c| c.provider.as_str())
            .collect::<Vec<_>>(),
            vec!["B", "A"]
        );
    }
    #[test]
    fn person_identity_must_be_uniquely_exact() {
        let p = |id: &str, name: &str| Person {
            provider: "Fixture".into(),
            id: id.into(),
            name: name.into(),
            ..Default::default()
        };
        assert!(exact_person(vec![p("1", "甲"), p("2", "甲")], "甲").is_none());
        assert_eq!(
            exact_person(vec![p("1", " 甲 "), p("1", "甲"), p("3", "甲乙")], "甲")
                .unwrap()
                .id,
            "1"
        );
        assert!(exact_person(vec![p("../escape", "甲")], "甲").is_none());
    }
}
