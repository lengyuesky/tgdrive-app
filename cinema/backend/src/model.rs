//! 影视条目与网盘文件严格分开；持久身份只使用节点 ID 和内容版本。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tgdrive_contract::files::{ContentRef, FileNode};

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "m4v", "webm", "avi", "ts", "m2ts", "mts", "flv", "wmv", "ogv", "3gp",
];
pub const POSTER_LIMIT: u64 = 2 * 1024 * 1024;
pub const SUBTITLE_LIMIT: u64 = 512 * 1024;

pub fn guid(parts: &[&str]) -> String {
    format!("{:x}", Sha256::digest(parts.join("\0").as_bytes()))[..32].into()
}
pub fn random_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(9_007_199_254_740_991) as i64
}
pub fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}
pub fn stem(name: &str) -> &str {
    name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name)
}
pub fn within(path: &str, root: &str) -> bool {
    root == "/"
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| tail.starts_with('/'))
}
pub fn parent(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(p, _)| if p.is_empty() { "/" } else { p })
        .unwrap_or("/")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Library {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub root_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub version: String,
    pub name: String,
    pub path: String,
    pub parent_id: Option<String>,
    pub size: u64,
}
impl Source {
    pub fn from_node(node: &FileNode) -> Option<Self> {
        Some(Self {
            id: node.id.clone(),
            version: node.content_version.clone()?,
            name: node.name.clone(),
            path: node.path.clone(),
            parent_id: node.parent_id.clone(),
            size: node.size.0,
        })
    }
    pub fn file(&self) -> ContentRef {
        ContentRef {
            id: self.id.clone(),
            content_version: self.version.clone(),
        }
    }
    pub fn guid(&self, kind: &str) -> String {
        guid(&[kind, &self.id, &self.version])
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Actor {
    pub data: crate::nfo::Actor,
    pub metadata: Source,
    pub updated_at: i64,
    pub portrait: Option<Source>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub node_id: String,
    pub version: String,
    pub guid: String,
    pub media_guid: String,
    pub path: String,
    pub filename: String,
    pub size: u64,
    pub timestamp: i64,
    pub added_at: i64,
    pub title: String,
    pub overview: String,
    pub year: String,
    pub number: String,
    pub kind: String,
    pub libraries: Vec<String>,
    pub season: u32,
    pub episode: u32,
    pub show_guid: String,
    pub show_title: String,
    pub metadata_version: String,
    pub metadata: Option<Source>,
    pub posters: Vec<Source>,
    pub subtitles: Vec<Source>,
    pub actors: Vec<Actor>,
    pub show_actors: Vec<Actor>,
    pub show_nfo: Option<Source>,
    pub has_thumbnail: bool,
    pub thumbnail_revision: String,
    #[serde(default)]
    pub cover: Option<String>,
}
impl Entry {
    pub fn file(&self) -> ContentRef {
        ContentRef {
            id: self.node_id.clone(),
            content_version: self.version.clone(),
        }
    }
    pub fn season_guid(&self) -> String {
        guid(&["season", &self.show_guid, &self.season.to_string()])
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Progress {
    pub ts: f64,
    pub audio_guid: String,
    pub subtitle_guid: String,
    pub direct_link_audio_index: i64,
    pub updated_at: i64,
    pub duration: f64,
    pub completed: bool,
    pub page_audio: Option<u32>,
    pub page_subtitle: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CatalogItem {
    pub guid: String,
    pub kind: String,
    pub title: String,
    pub added_at: i64,
    pub modified_at: i64,
    pub parent_guid: String,
    pub show_guid: String,
    pub season: u32,
    pub episode: u32,
    pub representative: String,
    pub episodes: u64,
    pub seasons: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MediaInfo {
    pub version: String,
    pub wrapper: String,
    pub duration: f64,
    pub streams: Vec<Value>,
    pub policy_version: u32,
}
impl MediaInfo {
    pub fn video(&self) -> Option<&Value> {
        self.streams
            .iter()
            .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
    }
    pub fn valid(&self, entry: &Entry) -> bool {
        self.version == entry.version
            && self.duration.is_finite()
            && self.duration > 0.0
            && self.streams.len() <= 64
            && self.video().is_some()
            && self.policy_version == 1
    }
}

/// 仅采用明确 SxxExxx 名称；含糊名称仍是可播放的未识别视频。
pub fn episode_name(name: &str) -> Option<(String, u32, u32)> {
    let bytes = name.as_bytes();
    for start in 0..bytes.len() {
        if !matches!(bytes[start], b'S' | b's')
            || start > 0 && bytes[start - 1].is_ascii_alphanumeric()
        {
            continue;
        }
        let mut pos = start + 1;
        while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
            pos += 1;
        }
        if !(1..=2).contains(&(pos - start - 1))
            || !bytes.get(pos).is_some_and(|b| matches!(b, b'E' | b'e'))
        {
            continue;
        }
        let ep_start = pos + 1;
        pos = ep_start;
        while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
            pos += 1;
        }
        if !(1..=3).contains(&(pos - ep_start)) {
            continue;
        }
        let season = name[start + 1..ep_start - 1].parse().ok()?;
        let episode = name[ep_start..pos].parse().ok()?;
        if episode == 0 {
            continue;
        }
        let title = name[..start]
            .trim_matches(|c: char| c.is_whitespace() || matches!(c, '.' | '_' | '-'))
            .replace(['.', '_'], " ");
        return Some((title, season, episode));
    }
    None
}
