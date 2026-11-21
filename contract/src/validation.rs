//! 跨仓库共享校验：清单、目录、归档布局和无状态的范围/授权判定。
//! 校验不访问网络、文件系统、SQLite 或 Telegram，宿主负责动态状态与实际字节校验。

use crate::data::CacheEntry;
use crate::files::*;
use crate::http::*;
use crate::manifest::*;
use crate::{CATALOG_FORMAT, CONTRACT_VERSION, ContractVersion, PACKAGE_FORMAT, error_code};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ValidationError {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}：{}", self.field, self.message)
    }
}
impl std::error::Error for ValidationError {}

type Result<T> = std::result::Result<T, ValidationError>;

fn invalid(code: &str, field: impl Into<String>, message: impl Into<String>) -> ValidationError {
    ValidationError {
        code: code.into(),
        field: field.into(),
        message: message.into(),
    }
}
fn manifest_error(field: impl Into<String>, message: impl Into<String>) -> ValidationError {
    invalid(error_code::INVALID_MANIFEST, field, message)
}
fn catalog_error(field: impl Into<String>, message: impl Into<String>) -> ValidationError {
    invalid(error_code::INVALID_CATALOG, field, message)
}

fn bounded_json_size<T: Serialize + ?Sized>(value: &T, limit: u64, field: &str) -> Result<usize> {
    struct Counter {
        bytes: usize,
        limit: usize,
        exceeded: bool,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes) {
                self.exceeded = true;
                return Err(std::io::Error::other("JSON 字节预算耗尽"));
            }
            self.bytes += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        bytes: 0,
        limit: limit as usize,
        exceeded: false,
    };
    if serde_json::to_writer(&mut counter, value).is_err() {
        return Err(invalid(
            if counter.exceeded {
                error_code::PAYLOAD_TOO_LARGE
            } else {
                error_code::INVALID_REQUEST
            },
            field,
            "JSON 不能序列化或超过字节预算",
        ));
    }
    Ok(counter.bytes)
}

/// 64 KiB 只约束 JSON 请求；使用计数写入器，校验时不另建完整正文缓冲。
pub fn validate_json_request<T: Serialize + ?Sized>(value: &T) -> Result<()> {
    bounded_json_size(value, MAX_JSON_REQUEST_BYTES, "request_body").map(|_| ())
}

/// 应用调用宿主能力的标准 JSON 响应预算；不用于主人管理/内部或应用自定代理协议。
pub fn validate_json_response<T: Serialize + ?Sized>(value: &T) -> Result<()> {
    bounded_json_size(value, MAX_JSON_RESPONSE_BYTES, "response_body").map(|_| ())
}

/// 单节点合法字段的保守 JSON 上界；不替代宿主的节点可见性与目录授权判定。
pub fn validate_file_node_size(node: &FileNode) -> Result<()> {
    bounded_json_size(node, MAX_FILE_NODE_JSON_BYTES, "file_node").map(|_| ())
}

/// 分页数组的独立预算，不包括外层游标/目录元信息；外层仍需校验响应总预算。
pub fn validate_json_page<T: Serialize>(items: &[T], byte_limit: u64) -> Result<()> {
    if !(MIN_JSON_PAGE_BYTES..=MAX_JSON_PAGE_BYTES).contains(&byte_limit) {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "page_bytes",
            "分页字节预算无效",
        ));
    }
    bounded_json_size(items, byte_limit, "page_items").map(|_| ())
}

/// 返回能装入一页的连续前缀长度；宿主用最后返回项签发游标，不跳过下一项。
pub fn json_page_prefix_count<T: Serialize>(
    items: &[T],
    max_items: usize,
    byte_limit: u64,
) -> Result<usize> {
    if max_items == 0
        || max_items > MAX_PAGE_LIMIT as usize
        || !(MIN_JSON_PAGE_BYTES..=MAX_JSON_PAGE_BYTES).contains(&byte_limit)
    {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "page",
            "分页条数或字节预算无效",
        ));
    }
    let mut used = 2usize;
    let mut count = 0usize;
    for item in items.iter().take(max_items) {
        let size = bounded_json_size(item, byte_limit, "page_item")?;
        let next = used + size + usize::from(count > 0);
        if next > byte_limit as usize {
            if count == 0 {
                return Err(invalid(
                    error_code::PAYLOAD_TOO_LARGE,
                    "page_item",
                    "单项无法装入分页预算",
                ));
            }
            break;
        }
        used = next;
        count += 1;
    }
    Ok(count)
}

pub fn valid_operation_id(value: &str) -> bool {
    valid_opaque_id(value) && value.len() <= MAX_OPERATION_ID_BYTES as usize
}

pub fn valid_idempotency_key(value: &str) -> bool {
    valid_opaque_id(value)
        && (MIN_IDEMPOTENCY_KEY_BYTES as usize..=MAX_IDEMPOTENCY_KEY_BYTES as usize)
            .contains(&value.len())
}

/// 界面请求的静态输入校验；调用方仍须验证当前 iframe/nonce 与目录写入声明。
pub fn validate_ui_request(request: &crate::ui::UiRequest) -> Result<()> {
    use crate::ui::UiRequest;
    let failure = |field, message| invalid(error_code::INVALID_REQUEST, field, message);
    match request {
        UiRequest::SetImmersive(value) => {
            if value.background.as_ref().is_some_and(|color| {
                color.len() != IMMERSIVE_COLOR_BYTES as usize
                    || !color.starts_with('#')
                    || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            }) {
                return Err(failure(
                    "ui.background",
                    "沉浸背景必须是六位十六进制不透明颜色",
                ));
            }
        }
        UiRequest::SetTitle(value) => {
            if !text(&value.title, MAX_UI_TITLE_BYTES as usize, false) {
                return Err(failure(
                    "ui.title",
                    "界面标题为空、含控制字符或超过字节上限",
                ));
            }
        }
        UiRequest::PickDirectory(value) => {
            if value
                .initial_id
                .as_ref()
                .is_some_and(|id| !valid_node_id(id))
            {
                return Err(failure("ui.initial_id", "目录节点 ID 无效"));
            }
        }
        UiRequest::RequestScope(value) => {
            if !text(
                &value.reason,
                MAX_AUTHORIZATION_REASON_BYTES as usize,
                false,
            ) {
                return Err(failure(
                    "ui.reason",
                    "授权理由为空、含控制字符或超过字节上限",
                ));
            }
        }
        UiRequest::Task(value) => {
            if !valid_opaque_id(&value.id) || value.id.len() > MAX_TASK_ID_BYTES as usize {
                return Err(failure("ui.task.id", "任务 ID 无效或超过字节上限"));
            }
            if !text(&value.title, MAX_TASK_TITLE_BYTES as usize, false) {
                return Err(failure(
                    "ui.task.title",
                    "任务标题为空、含控制字符或超过字节上限",
                ));
            }
            // completed/total 的上界由 u32 类型强制；MAX_TASK_PROGRESS 来自同一类型。
            if value.total.is_some_and(|total| total < value.completed) {
                return Err(failure("ui.task.total", "任务总量不能小于完成量"));
            }
        }
        UiRequest::Closed { close_id } => {
            if !valid_opaque_id(close_id) {
                return Err(failure("ui.close_id", "关闭确认标识无效"));
            }
        }
        UiRequest::Close => {}
    }
    Ok(())
}

/// 合法的同源相对 URI 路径，可带查询但不带片段；不允许 scheme/authority 或反斜线导航。
/// 非 ASCII 字符与其他保留字符必须经过百分号编码，不依赖浏览器修复非法 URI。
pub fn valid_same_origin_path(value: &str) -> bool {
    if !value.starts_with('/') || value.starts_with("//") || value.len() > MAX_URI_BYTES as usize {
        return false;
    }
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            if !bytes.next().is_some_and(|next| next.is_ascii_hexdigit())
                || !bytes.next().is_some_and(|next| next.is_ascii_hexdigit())
            {
                return false;
            }
        } else if !byte.is_ascii_alphanumeric() && !b"-._~!$&'()*+,;=:@/?".contains(&byte) {
            return false;
        }
    }
    true
}

pub fn valid_app_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_APP_ID_BYTES as usize
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn valid_node_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_NODE_ID_DIGITS as usize
        && !value.starts_with('0')
        && value.bytes().all(|b| b.is_ascii_digit())
        && value
            .parse::<u64>()
            .is_ok_and(|id| (MIN_POSITIVE_LIMIT..=MAX_NODE_ID).contains(&id))
}

pub fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPAQUE_ID_BYTES as usize
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

pub fn valid_resource_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_RESOURCE_PATH_BYTES as usize
        && value.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}

pub fn valid_drive_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_NAME_BYTES as usize
        && !matches!(value, "." | "..")
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
}

pub fn valid_drive_path(value: &str) -> bool {
    value == "/"
        || (value.starts_with('/')
            && value.len() <= MAX_DRIVE_PATH_BYTES as usize
            && value[1..].split('/').all(valid_drive_name))
}

pub fn valid_extension(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_EXTENSION_BYTES as usize
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._+-".contains(&b))
}

pub fn valid_kv_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_KV_KEY_BYTES as usize
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
}

pub fn valid_repository(value: &str) -> bool {
    let Some((owner, repo)) = value.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && owner.len() <= MAX_REPOSITORY_OWNER_BYTES as usize
        && !owner.starts_with('-')
        && !owner.ends_with('-')
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !repo.is_empty()
        && repo.len() <= MAX_REPOSITORY_NAME_BYTES as usize
        && !matches!(repo, "." | "..")
        && repo
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub fn valid_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX_BYTES as usize
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn stable_version(value: &str) -> Option<semver::Version> {
    if value.len() > MAX_VERSION_BYTES as usize {
        return None;
    }
    semver::Version::parse(value)
        .ok()
        .filter(|version| version.pre.is_empty() && version.build.is_empty())
}

fn valid_capability(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CAPABILITY_BYTES as usize
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

fn text(value: &str, max: usize, allow_empty: bool) -> bool {
    value.len() <= max
        && (allow_empty || !value.trim().is_empty())
        && !value.chars().any(char::is_control)
}

fn validate_extra(extra: &Extensions, known: &[&str], field: &str) -> Result<()> {
    if extra.keys().any(|key| known.contains(&key.as_str())) {
        return Err(manifest_error(field, "扩展字段不能覆盖已定义字段"));
    }
    Ok(())
}

fn validate_capabilities(values: &[String], field: &str) -> Result<()> {
    let mut seen = BTreeSet::new();
    if values.len() > MAX_REQUIRED_CAPABILITIES as usize
        || values
            .iter()
            .any(|value| !valid_capability(value) || !seen.insert(value))
    {
        return Err(manifest_error(field, "能力名称无效、重复或超过 64 项"));
    }
    Ok(())
}

pub fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if !valid_app_id(&manifest.id) {
        return Err(manifest_error("id", "应用 ID 无效"));
    }
    if stable_version(&manifest.version).is_none() {
        return Err(manifest_error("version", "版本必须为无前导零的稳定 X.Y.Z"));
    }
    if manifest.contract.major != CONTRACT_VERSION.major {
        return Err(invalid(
            error_code::INCOMPATIBLE_CONTRACT,
            "contract.major",
            "此库只校验契约主版本 1 的完整清单",
        ));
    }
    for (field, value, max) in [
        (
            "name",
            manifest.name.as_str(),
            MAX_MANIFEST_NAME_BYTES as usize,
        ),
        (
            "description",
            manifest.description.as_str(),
            MAX_MANIFEST_DESCRIPTION_BYTES as usize,
        ),
        (
            "author",
            manifest.author.as_str(),
            MAX_MANIFEST_AUTHOR_BYTES as usize,
        ),
    ] {
        if !text(value, max, false) {
            return Err(manifest_error(field, "文本为空、含控制字符或超过字节上限"));
        }
    }
    if manifest.page.is_none() && manifest.backend.is_none() {
        return Err(manifest_error(
            "page/backend",
            "至少提供应用页面或应用后端之一",
        ));
    }
    if manifest.files.write && !manifest.files.read {
        return Err(manifest_error("files", "声明写入必须同时声明读取"));
    }
    validate_extra(
        &manifest.extra,
        &[
            "id",
            "name",
            "version",
            "contract",
            "description",
            "author",
            "files",
            "page",
            "backend",
            "icon",
            "required_capabilities",
            "open_with",
        ],
        "manifest.extra",
    )?;
    validate_extra(&manifest.files.extra, &["read", "write"], "files.extra")?;
    validate_capabilities(&manifest.required_capabilities, "required_capabilities")?;
    if let Some(page) = &manifest.page {
        if !valid_resource_path(&page.entry)
            || !page.entry.starts_with("page/")
            || !page.entry.ends_with(".html")
        {
            return Err(manifest_error(
                "page.entry",
                "页面入口必须是 page/ 下的 HTML 文件",
            ));
        }
        validate_extra(&page.extra, &["entry"], "page.extra")?;
    }
    if let Some(backend) = &manifest.backend {
        if backend.entry != BACKEND_ENTRY {
            return Err(manifest_error(
                "backend.entry",
                "后端入口固定为 backend/app",
            ));
        }
        validate_extra(
            &backend.extra,
            &["entry", "run_mode", "external_service", "resources"],
            "backend.extra",
        )?;
        let resources = &backend.resources;
        validate_extra(
            &resources.extra,
            &[
                "memory_bytes",
                "cache_bytes",
                "database_bytes",
                "cpu_millis",
                "pids",
            ],
            "backend.resources.extra",
        )?;
        for (name, value, min, max) in [
            (
                "memory_bytes",
                resources.memory_bytes,
                MIN_BACKEND_MEMORY_BYTES,
                MAX_BACKEND_MEMORY_BYTES,
            ),
            (
                "cache_bytes",
                resources.cache_bytes,
                MIN_BACKEND_CACHE_BYTES,
                MAX_BACKEND_CACHE_BYTES,
            ),
            (
                "database_bytes",
                resources.database_bytes,
                MIN_BACKEND_DATABASE_BYTES,
                MAX_BACKEND_DATABASE_BYTES,
            ),
        ] {
            if value.is_some_and(|value| !(min..=max).contains(&value.0)) {
                return Err(manifest_error(
                    format!("backend.resources.{name}"),
                    "资源请求超过允许区间",
                ));
            }
        }
        if resources.cpu_millis.is_some_and(|value| {
            !(MIN_BACKEND_CPU_MILLIS..=MAX_BACKEND_CPU_MILLIS).contains(&u64::from(value))
        }) {
            return Err(manifest_error(
                "backend.resources.cpu_millis",
                "CPU 请求超过允许区间",
            ));
        }
        if resources
            .pids
            .is_some_and(|value| !(MIN_BACKEND_PIDS..=MAX_BACKEND_PIDS).contains(&u64::from(value)))
        {
            return Err(manifest_error(
                "backend.resources.pids",
                "进程数请求超过允许区间",
            ));
        }
    }
    if let Some(icon) = &manifest.icon {
        if !valid_resource_path(icon)
            || !(icon.starts_with("assets/") || icon.starts_with("page/"))
            || ![".svg", ".png", ".webp"]
                .iter()
                .any(|ext| icon.ends_with(ext))
        {
            return Err(manifest_error(
                "icon",
                "图标必须为 assets/ 或 page/ 下的 SVG、PNG、WebP",
            ));
        }
    }
    validate_extra(
        &manifest.open_with.extra,
        &["extensions", "directories"],
        "open_with.extra",
    )?;
    let mut extensions = BTreeSet::new();
    if manifest.open_with.extensions.len() > MAX_QUERY_EXTENSIONS as usize
        || manifest
            .open_with
            .extensions
            .iter()
            .any(|extension| !valid_extension(extension) || !extensions.insert(extension))
    {
        return Err(manifest_error(
            "open_with.extensions",
            "后缀无效、重复或超过 64 项",
        ));
    }
    if (!manifest.open_with.extensions.is_empty() || manifest.open_with.directories)
        && !manifest.files.read
    {
        return Err(manifest_error(
            "open_with",
            "文件或目录入口必须声明文件读取",
        ));
    }
    let encoded =
        serde_json::to_vec(manifest).map_err(|_| manifest_error("manifest", "清单不能序列化"))?;
    if encoded.len() > MAX_MANIFEST_BYTES as usize {
        return Err(manifest_error("manifest", "清单超过 64 KiB"));
    }
    // 程序构造的扩展数据也必须遵守同样的 JSON 数字与重复字段规则。
    parse_unique_json(&encoded)
        .map_err(|_| manifest_error("manifest", "清单 JSON 不能无损传输"))?;
    Ok(())
}

/// 后端就绪版本取两端同主版本的共同最高 minor；不强迫旧应用报告宿主的新 minor。
pub fn negotiate_contract(
    host: ContractVersion,
    application: ContractVersion,
    minimum: ContractVersion,
) -> Result<ContractVersion> {
    if host.major == 0 || host.major != application.major || host.major != minimum.major {
        return Err(invalid(
            error_code::INCOMPATIBLE_CONTRACT,
            "contract",
            "没有共同的契约主版本",
        ));
    }
    let negotiated = ContractVersion {
        major: host.major,
        minor: host.minor.min(application.minor),
    };
    if negotiated.minor < minimum.minor {
        return Err(invalid(
            error_code::INCOMPATIBLE_CONTRACT,
            "contract",
            "共同版本低于应用要求",
        ));
    }
    Ok(negotiated)
}

pub fn check_manifest_compatibility(
    manifest: &Manifest,
    host: ContractVersion,
    capabilities: &[&str],
) -> Result<()> {
    check_compatibility(
        &CatalogCompatibility {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            contract: manifest.contract,
            required_capabilities: manifest.required_capabilities.clone(),
        },
        host,
        capabilities,
    )
}

fn check_compatibility(
    header: &CatalogCompatibility,
    host: ContractVersion,
    capabilities: &[&str],
) -> Result<()> {
    if header.contract.major != host.major || header.contract.minor > host.minor {
        return Err(invalid(
            error_code::INCOMPATIBLE_CONTRACT,
            "contract",
            "宿主不支持所需最低契约版本",
        ));
    }
    if let Some(missing) = header
        .required_capabilities
        .iter()
        .find(|name| !capabilities.contains(&name.as_str()))
    {
        return Err(invalid(
            error_code::CAPABILITY_UNAVAILABLE,
            "required_capabilities",
            format!("宿主未提供必需能力 {missing}"),
        ));
    }
    Ok(())
}

fn require_manifest_objects(value: &Value) -> Result<()> {
    if !value.is_object() {
        return Err(manifest_error("manifest", "清单必须为 JSON 对象"));
    }
    for key in ["files", "open_with"] {
        if value.get(key).is_some_and(|value| !value.is_object()) {
            return Err(manifest_error(key, "此字段必须为 JSON 对象"));
        }
    }
    for key in ["page", "backend"] {
        if value
            .get(key)
            .is_some_and(|value| !value.is_null() && !value.is_object())
        {
            return Err(manifest_error(key, "此字段必须为 JSON 对象或 null"));
        }
    }
    if !value.get("contract").is_some_and(Value::is_object) {
        return Err(manifest_error("contract", "最低契约必须为 JSON 对象"));
    }
    if value
        .get("backend")
        .and_then(|backend| backend.get("resources"))
        .is_some_and(|value| !value.is_object())
    {
        return Err(manifest_error(
            "backend.resources",
            "资源请求必须为 JSON 对象",
        ));
    }
    Ok(())
}

pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest> {
    if bytes.is_empty() || bytes.len() > MAX_MANIFEST_BYTES as usize {
        return Err(manifest_error("manifest", "清单为空或超过 64 KiB"));
    }
    let value =
        parse_unique_json(bytes).map_err(|error| manifest_error("manifest", error.to_string()))?;
    require_manifest_objects(&value)?;
    let manifest: Manifest = serde_json::from_value(value)
        .map_err(|error| manifest_error("manifest", error.to_string()))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn valid_target_name(value: &str) -> bool {
    value == "web"
        || (value.starts_with("linux-")
            && value.len() <= MAX_PACKAGE_TARGET_BYTES as usize
            && value
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

pub fn parse_package_metadata(bytes: &[u8]) -> Result<PackageMetadata> {
    let error = |message: &str| invalid(error_code::INVALID_PACKAGE, "package.json", message);
    if bytes.is_empty() || bytes.len() > MAX_MANIFEST_BYTES as usize {
        return Err(error("构建目标元数据为空或超过 64 KiB"));
    }
    let value = parse_unique_json(bytes).map_err(|_| error("构建目标元数据 JSON 无效"))?;
    if !value.is_object() || !value.get("format").is_some_and(Value::is_object) {
        return Err(error("构建目标与版本必须使用 JSON 对象"));
    }
    let metadata: PackageMetadata =
        serde_json::from_value(value).map_err(|_| error("构建目标字段无效"))?;
    if metadata.format.major != PACKAGE_FORMAT.major {
        return Err(error("不支持的包格式主版本"));
    }
    Ok(metadata)
}

pub fn package_asset_name(id: &str, version: &str, target: &str) -> String {
    if target == "web" {
        format!("{id}-{version}.tgapp")
    } else {
        format!("{id}-{version}-{target}.tgapp")
    }
}

pub fn package_release_url(repository: &str, id: &str, version: &str, target: &str) -> String {
    format!(
        "https://github.com/{repository}/releases/download/{id}-v{version}/{}",
        package_asset_name(id, version, target)
    )
}

fn validate_artifacts(
    repository: &str,
    header: &CatalogCompatibility,
    packages: &BTreeMap<String, PackageArtifact>,
    package_byte_limit: u64,
) -> Result<()> {
    if packages.is_empty() || packages.len() > MAX_PACKAGE_TARGETS as usize {
        return Err(catalog_error("packages", "必须包含 1..=16 个架构条目"));
    }
    for (target, artifact) in packages {
        if !valid_target_name(target) {
            return Err(catalog_error("packages", "目标名称无效"));
        }
        if !valid_sha256(&artifact.sha256)
            || artifact.size.0 == 0
            || artifact.size.0 > package_byte_limit
        {
            return Err(catalog_error(
                format!("packages.{target}"),
                "摘要或压缩包大小无效",
            ));
        }
        if artifact.url != package_release_url(repository, &header.id, &header.version, target) {
            return Err(catalog_error(
                format!("packages.{target}.url"),
                "下载地址必须精确指向同仓库、同应用、同版本的 GitHub Release",
            ));
        }
        if artifact
            .extra
            .keys()
            .any(|key| ["url", "sha256", "size"].contains(&key.as_str()))
        {
            return Err(catalog_error(
                format!("packages.{target}"),
                "扩展字段不能覆盖下载元数据",
            ));
        }
    }
    Ok(())
}

fn validate_catalog_entry(repository: &str, entry: &CatalogEntry) -> Result<()> {
    validate_manifest(&entry.manifest)?;
    let header = CatalogCompatibility {
        id: entry.manifest.id.clone(),
        version: entry.manifest.version.clone(),
        contract: entry.manifest.contract,
        required_capabilities: entry.manifest.required_capabilities.clone(),
    };
    validate_artifacts(repository, &header, &entry.packages, MAX_PACKAGE_BYTES)?;
    if entry.manifest.backend.is_some() {
        if !entry.packages.contains_key("linux-amd64")
            || !entry.packages.contains_key("linux-arm64")
            || entry.packages.contains_key("web")
        {
            return Err(catalog_error(
                "packages",
                "带后端应用必须同时提供 amd64、arm64，不能声明 web 包",
            ));
        }
    } else if entry.packages.len() != 1 || !entry.packages.contains_key("web") {
        return Err(catalog_error(
            "packages",
            "页面应用只能提供一个架构无关的 web 包",
        ));
    }
    if entry
        .extra
        .keys()
        .any(|key| ["manifest", "packages"].contains(&key.as_str()))
    {
        return Err(catalog_error("entry.extra", "扩展字段不能覆盖条目"));
    }
    Ok(())
}

pub fn validate_catalog(catalog: &Catalog) -> Result<()> {
    if catalog.format.major != CATALOG_FORMAT.major {
        return Err(catalog_error("format", "不支持的目录主版本"));
    }
    if !valid_repository(&catalog.repository) {
        return Err(catalog_error("repository", "仓库名称无效"));
    }
    if catalog.entries.len() > MAX_CATALOG_ENTRIES as usize {
        return Err(catalog_error("entries", "目录超过 512 条"));
    }
    if catalog
        .extra
        .keys()
        .any(|key| ["format", "repository", "entries"].contains(&key.as_str()))
    {
        return Err(catalog_error("extra", "扩展字段不能覆盖目录"));
    }
    let mut seen = BTreeSet::new();
    for entry in &catalog.entries {
        if !seen.insert((&entry.manifest.id, &entry.manifest.version)) {
            return Err(catalog_error("entries", "同一 ID 与版本不能重复"));
        }
        validate_catalog_entry(&catalog.repository, entry)?;
    }
    let bytes =
        serde_json::to_vec(catalog).map_err(|_| catalog_error("catalog", "目录不能序列化"))?;
    if bytes.len() > MAX_CATALOG_BYTES as usize {
        return Err(catalog_error("catalog", "目录超过 4 MiB"));
    }
    parse_unique_json(&bytes).map_err(|_| catalog_error("catalog", "目录 JSON 不能无损传输"))?;
    Ok(())
}

/// 必须先检查原始条目的兼容性；未来主版本的清单形状不会拖垮其他兼容条目。
pub fn parse_catalog_for_host(
    bytes: &[u8],
    expected_repository: &str,
    host: ContractVersion,
    capabilities: &[&str],
) -> Result<CatalogReadResult> {
    if host.major != CONTRACT_VERSION.major {
        return Err(catalog_error("host", "该读取器仅服务契约主版本 1"));
    }
    if bytes.is_empty() || bytes.len() > MAX_CATALOG_BYTES as usize {
        return Err(catalog_error("catalog", "目录为空或超过 4 MiB"));
    }
    let value =
        parse_unique_json(bytes).map_err(|error| catalog_error("catalog", error.to_string()))?;
    if !value.is_object()
        || !value.get("format").is_some_and(Value::is_object)
        || !value
            .get("entries")
            .and_then(Value::as_array)
            .is_some_and(|entries| {
                entries.iter().all(|entry| {
                    entry.is_object()
                        && entry.get("manifest").is_some_and(Value::is_object)
                        && entry
                            .get("packages")
                            .and_then(Value::as_object)
                            .is_some_and(|packages| packages.values().all(Value::is_object))
                })
            })
    {
        return Err(catalog_error(
            "catalog",
            "目录、格式版本、条目、清单与架构元数据必须使用对象",
        ));
    }
    let raw: RawCatalog = serde_json::from_value(value)
        .map_err(|error| catalog_error("catalog", error.to_string()))?;
    if raw.format.major != CATALOG_FORMAT.major
        || !valid_repository(expected_repository)
        || raw.repository != expected_repository
    {
        return Err(catalog_error("format/repository", "目录主版本或仓库不符"));
    }
    if raw.entries.len() > MAX_CATALOG_ENTRIES as usize {
        return Err(catalog_error("entries", "目录超过 512 条"));
    }
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    let mut incompatible = Vec::new();
    for entry in raw.entries {
        if !entry.manifest.is_object()
            || !entry.manifest.get("contract").is_some_and(Value::is_object)
        {
            return Err(catalog_error("manifest", "身份与最低契约必须使用对象"));
        }
        let header: CatalogCompatibility = serde_json::from_value(entry.manifest.clone())
            .map_err(|error| catalog_error("manifest", error.to_string()))?;
        if !valid_app_id(&header.id)
            || stable_version(&header.version).is_none()
            || header.contract.major == 0
        {
            return Err(catalog_error("manifest", "ID、稳定版本或最低契约无效"));
        }
        validate_capabilities(&header.required_capabilities, "required_capabilities")?;
        if !seen.insert((header.id.clone(), header.version.clone())) {
            return Err(catalog_error("entries", "同一 ID 与版本不能重复"));
        }
        let compatibility = check_compatibility(&header, host, capabilities);
        // 不兼容条目不下载：仍验证地址/摘要/正长度，但不能用旧包上限拖垮未来条目。
        let package_limit = if compatibility.is_ok() {
            MAX_PACKAGE_BYTES
        } else {
            u64::MAX
        };
        validate_artifacts(expected_repository, &header, &entry.packages, package_limit)?;
        if let Err(error) = compatibility {
            incompatible.push(IncompatibleEntry {
                id: header.id,
                version: header.version,
                reason: error.code,
            });
            continue;
        }
        require_manifest_objects(&entry.manifest)?;
        let manifest = serde_json::from_value(entry.manifest)
            .map_err(|error| catalog_error("manifest", error.to_string()))?;
        let parsed = CatalogEntry {
            manifest,
            packages: entry.packages,
            extra: entry.extra,
        };
        validate_catalog_entry(expected_repository, &parsed)?;
        entries.push(parsed);
    }
    Ok(CatalogReadResult {
        catalog: Catalog {
            format: raw.format,
            repository: raw.repository,
            entries,
            extra: raw.extra,
        },
        incompatible,
    })
}

/// 校验已知历史；宿主还必须长期保存被移出目录的版本绑定，不能只比较相邻两个快照。
pub fn validate_catalog_transition(previous: &Catalog, current: &Catalog) -> Result<()> {
    validate_catalog(previous)?;
    validate_catalog(current)?;
    if previous.repository != current.repository {
        return Err(catalog_error("repository", "不能跨仓库比较发布历史"));
    }
    let old: BTreeMap<_, _> = previous
        .entries
        .iter()
        .map(|entry| {
            (
                (entry.manifest.id.as_str(), entry.manifest.version.as_str()),
                entry,
            )
        })
        .collect();
    let mut maxima = BTreeMap::<&str, semver::Version>::new();
    for entry in &previous.entries {
        let version = stable_version(&entry.manifest.version).expect("已校验稳定版本");
        maxima
            .entry(&entry.manifest.id)
            .and_modify(|max| *max = std::cmp::max(max.clone(), version.clone()))
            .or_insert(version);
    }
    let mut next_maxima = BTreeMap::<&str, semver::Version>::new();
    for entry in &current.entries {
        let version = stable_version(&entry.manifest.version).expect("已校验稳定版本");
        next_maxima
            .entry(&entry.manifest.id)
            .and_modify(|max| *max = std::cmp::max(max.clone(), version.clone()))
            .or_insert(version);
        if let Some(old) = old.get(&(entry.manifest.id.as_str(), entry.manifest.version.as_str())) {
            if old.manifest != entry.manifest {
                return Err(invalid(
                    error_code::PACKAGE_CHANGED,
                    "manifest",
                    "相同应用版本的完整清单不可变",
                ));
            }
            for (target, artifact) in &old.packages {
                if entry.packages.get(target) != Some(artifact) {
                    return Err(invalid(
                        error_code::PACKAGE_CHANGED,
                        format!("packages.{target}"),
                        "相同应用、版本和架构的地址、摘要与大小不可变",
                    ));
                }
            }
        }
    }
    for (id, next) in next_maxima {
        if maxima.get(id).is_some_and(|old| next < *old) {
            return Err(catalog_error(
                "entries",
                "保留该应用时不能倒退其最高发布版本",
            ));
        }
    }
    Ok(())
}

pub fn validate_archive_layout(
    manifest: &Manifest,
    metadata: &PackageMetadata,
    entries: &[ArchiveEntry],
) -> Result<()> {
    validate_manifest(manifest)?;
    if metadata
        .extra
        .keys()
        .any(|key| ["format", "target"].contains(&key.as_str()))
    {
        return Err(invalid(
            error_code::INVALID_PACKAGE,
            "package.json",
            "扩展字段不能覆盖构建目标",
        ));
    }
    if metadata.format.major != PACKAGE_FORMAT.major
        || (manifest.backend.is_some() == (metadata.target == PackageTarget::Web))
    {
        return Err(invalid(
            error_code::INVALID_PACKAGE,
            "package.json",
            "包主版本或构建目标与清单不符",
        ));
    }
    if entries.len() > MAX_PACKAGE_ENTRIES as usize {
        return Err(invalid(
            error_code::INVALID_PACKAGE,
            "archive",
            "归档超过 4096 条",
        ));
    }
    let mut paths = BTreeSet::new();
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    for entry in entries {
        let path = if entry.kind == ArchiveEntryKind::Directory {
            entry.path.strip_suffix('/').unwrap_or(&entry.path)
        } else {
            &entry.path
        };
        if !valid_resource_path(path)
            || !paths.insert(path.to_ascii_lowercase())
            || entry.encrypted
            || entry.kind == ArchiveEntryKind::LinkOrSpecial
            || entry.compression == ArchiveCompression::Unsupported
        {
            return Err(invalid(
                error_code::INVALID_PACKAGE,
                "archive",
                "包含非法/重复路径、链接、特殊文件、加密或不支持的压缩方式",
            ));
        }
        if entry.kind == ArchiveEntryKind::Directory {
            if !["page", "backend", "assets", "licenses"].contains(&path)
                && !["page/", "backend/", "assets/", "licenses/"]
                    .iter()
                    .any(|prefix| path.starts_with(prefix))
            {
                return Err(invalid(
                    error_code::INVALID_PACKAGE,
                    "archive",
                    "目录条目不在规定布局内",
                ));
            }
            if entry.expanded_size != 0 {
                return Err(invalid(
                    error_code::INVALID_PACKAGE,
                    "archive",
                    "目录条目不能包含正文",
                ));
            }
            continue;
        }
        if entry.expanded_size > MAX_PACKAGE_FILE_BYTES {
            return Err(invalid(
                error_code::INVALID_PACKAGE,
                "archive",
                "单文件超过 128 MiB",
            ));
        }
        total = total
            .checked_add(entry.expanded_size)
            .ok_or_else(|| invalid(error_code::INVALID_PACKAGE, "archive", "解压大小溢出"))?;
        if total > MAX_PACKAGE_EXPANDED_BYTES {
            return Err(invalid(
                error_code::INVALID_PACKAGE,
                "archive",
                "解压总量超过 256 MiB",
            ));
        }
        if ![MANIFEST_PATH, PACKAGE_METADATA_PATH].contains(&path)
            && !["page/", "backend/", "assets/", "licenses/"]
                .iter()
                .any(|prefix| path.starts_with(prefix))
            && !["LICENSE", "NOTICE"].contains(&path)
        {
            return Err(invalid(
                error_code::INVALID_PACKAGE,
                "archive",
                "包顶层只接受规定目录、清单、许可与 NOTICE",
            ));
        }
        files.insert(path, entry.expanded_size);
    }
    for path in [MANIFEST_PATH, PACKAGE_METADATA_PATH] {
        if !files
            .get(path)
            .is_some_and(|size| *size > 0 && *size <= MAX_MANIFEST_BYTES)
        {
            return Err(invalid(
                error_code::INVALID_PACKAGE,
                path,
                "包元数据必须存在、非空且不超过 64 KiB",
            ));
        }
    }
    if let Some(page) = &manifest.page {
        if !files.get(page.entry.as_str()).is_some_and(|size| *size > 0) {
            return Err(invalid(
                error_code::INVALID_PACKAGE,
                "page.entry",
                "页面入口不存在或为空",
            ));
        }
    }
    if let Some(backend) = &manifest.backend {
        if !files
            .get(backend.entry.as_str())
            .is_some_and(|size| *size > 0)
        {
            return Err(invalid(
                error_code::INVALID_PACKAGE,
                "backend.entry",
                "后端可执行文件不存在或为空",
            ));
        }
    } else if files.keys().any(|path| path.starts_with("backend/")) {
        return Err(invalid(
            error_code::INVALID_PACKAGE,
            "backend",
            "页面应用不能夹带后端文件",
        ));
    }
    if let Some(icon) = &manifest.icon {
        if !files
            .get(icon.as_str())
            .is_some_and(|size| *size > 0 && *size <= MAX_ICON_BYTES)
        {
            return Err(invalid(
                error_code::INVALID_PACKAGE,
                "icon",
                "图标不存在、为空或超过 256 KiB",
            ));
        }
    }
    // a 是文件时不能再有 a/b；隐式目录也按大小写折叠检查，避免文件/目录别名。
    let folded_files: BTreeSet<_> = files.keys().map(|path| path.to_ascii_lowercase()).collect();
    for path in &folded_files {
        let mut parent = path.rsplit_once('/').map(|(parent, _)| parent);
        while let Some(value) = parent {
            if folded_files.contains(value) {
                return Err(invalid(
                    error_code::INVALID_PACKAGE,
                    "archive",
                    "文件与目录路径互相覆盖",
                ));
            }
            parent = value.rsplit_once('/').map(|(parent, _)| parent);
        }
    }
    Ok(())
}

pub fn validate_scope(scope: &DirectoryScope, permissions: &FilePermissions) -> Result<()> {
    let grants: Vec<_> = match scope {
        DirectoryScope::None => return Ok(()),
        DirectoryScope::All { access } => vec![("1", *access)],
        DirectoryScope::Selected { directories } => {
            if directories.is_empty() || directories.len() > MAX_QUERY_ROOTS as usize {
                return Err(invalid(
                    error_code::INVALID_REQUEST,
                    "scope",
                    "指定目录必须为 1..=128 项；空授权使用 none",
                ));
            }
            directories
                .iter()
                .map(|grant| (grant.directory_id.as_str(), grant.access))
                .collect()
        }
    };
    if !permissions.read {
        return Err(invalid(
            error_code::SCOPE_DENIED,
            "scope",
            "未声明文件读取不能获得目录授权",
        ));
    }
    let mut seen = BTreeSet::new();
    for (id, access) in grants {
        if !valid_node_id(id) || !seen.insert(id) {
            return Err(invalid(
                error_code::INVALID_REQUEST,
                "scope",
                "目录 ID 无效或重复",
            ));
        }
        if access == AccessLevel::ReadWrite && !permissions.write {
            return Err(invalid(
                error_code::WRITE_NOT_DECLARED,
                "scope",
                "未声明写入不能获得读写授权",
            ));
        }
    }
    Ok(())
}

/// ancestors 必须来自宿主最新可见目录树，包含节点自身；应用不能提供这条链。
pub fn effective_access(
    scope: &DirectoryScope,
    permissions: &FilePermissions,
    ancestors: &[&str],
) -> Option<AccessLevel> {
    if !permissions.read {
        return None;
    }
    let requested = match scope {
        DirectoryScope::None => return None,
        DirectoryScope::All { access } => Some(*access),
        DirectoryScope::Selected { directories } => directories
            .iter()
            .filter(|grant| ancestors.contains(&grant.directory_id.as_str()))
            .map(|grant| grant.access)
            .max_by_key(|access| match access {
                AccessLevel::ReadOnly => 0,
                AccessLevel::ReadWrite => 1,
            }),
    }?;
    Some(
        if requested == AccessLevel::ReadWrite && !permissions.write {
            AccessLevel::ReadOnly
        } else {
            requested
        },
    )
}

fn validate_filter(filter: &FileFilter) -> Result<()> {
    if filter
        .name_contains
        .as_ref()
        .is_some_and(|value| !text(value, MAX_NAME_BYTES as usize, true))
    {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "filter.name_contains",
            "名称子串过长或含控制字符",
        ));
    }
    let mut seen = BTreeSet::new();
    if filter.extensions.len() > MAX_QUERY_EXTENSIONS as usize
        || filter
            .extensions
            .iter()
            .any(|extension| !valid_extension(extension) || !seen.insert(extension))
    {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "filter.extensions",
            "后缀无效、重复或超过 64 项",
        ));
    }
    if let Some(bounds) = &filter.size {
        if bounds.min.is_some_and(|value| value.0 > i64::MAX as u64)
            || bounds.max.is_some_and(|value| value.0 > i64::MAX as u64)
            || matches!((bounds.min, bounds.max), (Some(min), Some(max)) if min > max)
        {
            return Err(invalid(
                error_code::INVALID_REQUEST,
                "filter.size",
                "大小区间无效",
            ));
        }
    }
    for (name, bounds) in [
        ("created_at", &filter.created_at),
        ("modified_at", &filter.modified_at),
    ] {
        if let Some(bounds) = bounds {
            if bounds
                .from
                .is_some_and(|value| !(0..=MAX_TIMESTAMP_MILLIS as i64).contains(&value.0))
                || bounds
                    .to
                    .is_some_and(|value| !(0..=MAX_TIMESTAMP_MILLIS as i64).contains(&value.0))
                || matches!((bounds.from, bounds.to), (Some(from), Some(to)) if from > to)
            {
                return Err(invalid(
                    error_code::INVALID_REQUEST,
                    format!("filter.{name}"),
                    "时间区间无效",
                ));
            }
        }
    }
    Ok(())
}

fn validate_roots(roots: &[String]) -> Result<()> {
    let mut seen = BTreeSet::new();
    if roots.len() > MAX_QUERY_ROOTS as usize
        || roots
            .iter()
            .any(|id| !valid_node_id(id) || !seen.insert(id))
    {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "roots",
            "根目录 ID 无效、重复或超过 128 项",
        ));
    }
    Ok(())
}

fn validate_page(limit: u16, cursor: Option<&str>) -> Result<()> {
    if limit == 0 || u64::from(limit) > MAX_PAGE_LIMIT {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "limit",
            "页大小必须为 1..=500",
        ));
    }
    if cursor.is_some_and(|cursor| cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES as usize) {
        return Err(invalid(
            error_code::INVALID_CURSOR,
            "cursor",
            "游标为空或超过 4096 字节",
        ));
    }
    Ok(())
}

pub fn validate_file_query(query: &FileQuery) -> Result<()> {
    validate_roots(&query.roots)?;
    validate_filter(&query.filter)?;
    validate_page(query.limit, query.cursor.as_deref())
}

pub fn validate_directories_query(query: &DirectoriesWithFilesQuery) -> Result<()> {
    validate_roots(&query.roots)?;
    validate_filter(&query.file_filter)?;
    validate_page(query.limit, query.cursor.as_deref())?;
    if query.file_filter.kind != QueryKind::File || query.file_filter.extensions.is_empty() {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "file_filter",
            "直属匹配文件必须使用 file 和非空后缀集合",
        ));
    }
    if query
        .directory_name_contains
        .as_ref()
        .is_some_and(|value| !text(value, MAX_NAME_BYTES as usize, true))
    {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "directory_name_contains",
            "目录名称子串无效",
        ));
    }
    Ok(())
}

pub fn validate_random_request(request: &RandomFilesRequest) -> Result<()> {
    validate_roots(&request.roots)?;
    validate_filter(&request.filter)?;
    if request.filter.kind != QueryKind::File
        || request.limit == 0
        || u64::from(request.limit) > MAX_RANDOM_LIMIT
    {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "limit/filter",
            "随机抽样只接受文件，数量必须为 1..=64",
        ));
    }
    let mut seen = BTreeSet::new();
    if request.exclude_ids.len() > MAX_RANDOM_EXCLUSIONS as usize
        || request
            .exclude_ids
            .iter()
            .any(|id| !valid_node_id(id) || !seen.insert(id))
    {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "exclude_ids",
            "排除 ID 无效、重复或超过 512 项",
        ));
    }
    Ok(())
}

pub fn validate_content_ref(reference: &ContentRef) -> Result<()> {
    if !valid_node_id(&reference.id) || !valid_opaque_id(&reference.content_version) {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "file",
            "节点 ID 或内容版本无效",
        ));
    }
    Ok(())
}

pub fn valid_content_type(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_CONTENT_TYPE_BYTES as usize
        || !value.bytes().all(|b| (32..=126).contains(&b))
    {
        return false;
    }
    let essence = value.split(';').next().unwrap_or_default().trim();
    let Some((major, minor)) = essence.split_once('/') else {
        return false;
    };
    [major, minor].iter().all(|value| {
        !value.is_empty()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    })
}

/// 校验既有 CacheEntry 作为缓存响应头的完整表示；具体 base64url 编码由调用方完成。
pub fn validate_cache_entry_header(entry: &CacheEntry) -> Result<()> {
    if !valid_kv_key(&entry.key)
        || !valid_content_type(&entry.content_type)
        || !valid_opaque_id(&entry.revision)
    {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "cache_entry",
            "缓存键、MIME 或修订标识超限/无效",
        ));
    }
    if entry.size.0 > MAX_CACHE_OBJECT_BYTES
        || !(0..=MAX_TIMESTAMP_MILLIS as i64).contains(&entry.updated_at.0)
    {
        return Err(invalid(
            error_code::INVALID_REQUEST,
            "cache_entry",
            "缓存大小或时间无效",
        ));
    }
    let metadata = serde_json::to_vec(&entry.metadata).map_err(|_| {
        invalid(
            error_code::INVALID_REQUEST,
            "cache_entry.metadata",
            "缓存元数据不能序列化",
        )
    })?;
    if metadata.len() > MAX_CACHE_METADATA_BYTES as usize {
        return Err(invalid(
            error_code::PAYLOAD_TOO_LARGE,
            "cache_entry.metadata",
            "缓存元数据超过 4096 字节",
        ));
    }
    let json = serde_json::to_vec(entry).map_err(|_| {
        invalid(
            error_code::INVALID_REQUEST,
            "cache_entry",
            "缓存条目不能序列化",
        )
    })?;
    parse_unique_json(&json).map_err(|_| {
        invalid(
            error_code::INVALID_REQUEST,
            "cache_entry",
            "缓存条目 JSON 数值不能无损传输",
        )
    })?;
    if json.len() > MAX_CACHE_ENTRY_HEADER_JSON_BYTES as usize {
        return Err(invalid(
            error_code::PAYLOAD_TOO_LARGE,
            "cache_entry",
            "缓存条目响应头 JSON 超过 5120 字节",
        ));
    }
    Ok(())
}

pub fn validate_stream_directive(directive: &StreamDirective, file_size: u64) -> Result<()> {
    validate_content_ref(&directive.file).map_err(|error| {
        invalid(
            error_code::INVALID_BACKEND_RESPONSE,
            error.field,
            error.message,
        )
    })?;
    if directive
        .filename
        .as_ref()
        .is_some_and(|value| !valid_drive_name(value))
    {
        return Err(invalid(
            error_code::INVALID_BACKEND_RESPONSE,
            "filename",
            "文件名不能含路径、控制字符或超过 255 字节",
        ));
    }
    if directive
        .content_type
        .as_ref()
        .is_some_and(|value| !valid_content_type(value))
    {
        return Err(invalid(
            error_code::INVALID_BACKEND_RESPONSE,
            "content_type",
            "Content-Type 无效",
        ));
    }
    for (name, value) in [
        ("lease_id", &directive.lease_id),
        ("correlation_id", &directive.correlation_id),
    ] {
        if value.as_ref().is_some_and(|value| !valid_opaque_id(value)) {
            return Err(invalid(
                error_code::INVALID_BACKEND_RESPONSE,
                name,
                "标识必须为 1..=128 字节的 ASCII 字母、数字、下划线或短横线",
            ));
        }
    }
    if directive.window.as_ref().is_some_and(|window| {
        window
            .offset
            .0
            .checked_add(window.length.0)
            .is_none_or(|end| end > file_size)
    }) {
        return Err(invalid(
            error_code::INVALID_BACKEND_RESPONSE,
            "window",
            "直传区间溢出或超出文件",
        ));
    }
    let size = serde_json::to_vec(directive)
        .map_err(|_| {
            invalid(
                error_code::INVALID_BACKEND_RESPONSE,
                "directive",
                "不能序列化指令",
            )
        })?
        .len();
    if size > MAX_STREAM_DIRECTIVE_BYTES as usize {
        return Err(invalid(
            error_code::INVALID_BACKEND_RESPONSE,
            "directive",
            "指令 JSON 超过 4096 字节",
        ));
    }
    Ok(())
}

/// 仅支持单一 bytes 范围；无 Range 返回 200，合法范围（即便覆盖全文件）返回 206。
pub fn resolve_single_range(header: Option<&str>, size: u64) -> Result<ResolvedRange> {
    let Some(header) = header else {
        return Ok(ResolvedRange {
            start: 0,
            length: size,
            partial: false,
        });
    };
    let error = || {
        invalid(
            error_code::RANGE_NOT_SATISFIABLE,
            "Range",
            "只支持有效的单一 bytes 范围",
        )
    };
    let value = header.trim().strip_prefix("bytes=").ok_or_else(error)?;
    if value.contains(',') || size == 0 {
        return Err(error());
    }
    let (start, end) = value.split_once('-').ok_or_else(error)?;
    let number = |value: &str| -> Result<u64> {
        if value.is_empty()
            || value.len() > MAX_BYTE_COUNT_DIGITS as usize
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(error());
        }
        value.parse::<u64>().map_err(|_| error())
    };
    let (start, end) = if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 {
            return Err(error());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = number(start)?;
        let end = if end.is_empty() {
            size - 1
        } else {
            number(end)?.min(size - 1)
        };
        if start >= size || end < start {
            return Err(error());
        }
        (start, end)
    };
    Ok(ResolvedRange {
        start,
        length: end - start + 1,
        partial: true,
    })
}

/// 本机输入的响应窗口按请求开始时的共享余额裁剪；此函数不扣减或预留字节。
/// 宿主仍须在每次拉取有界上游块时原子扣减，预算在响应途中耗尽时只中断字节流。
pub fn resolve_local_range(
    header: Option<&str>,
    size: u64,
    remaining_byte_budget: u64,
) -> Result<ResolvedRange> {
    if remaining_byte_budget == 0 {
        return Err(invalid(
            error_code::QUOTA_EXCEEDED,
            "byte_budget",
            "本机地址在请求开始时已无剩余字节预算",
        ));
    }
    let mut range = resolve_single_range(header, size)?;
    if range.length > remaining_byte_budget {
        range.length = remaining_byte_budget;
        range.partial = true;
    }
    Ok(range)
}

/// 严格 JSON 读取：所有层级拒绝重复键，所有数值整型必须处于 JavaScript 安全整数范围。
/// 未来可选字段不能借重复键改变实际身份、权限或摘要；大整数应使用协议规定的字符串。
pub fn parse_unique_json(bytes: &[u8]) -> std::result::Result<Value, serde_json::Error> {
    struct UniqueValue(Value);
    struct UniqueVisitor;
    impl<'de> serde::de::Visitor<'de> for UniqueVisitor {
        type Value = UniqueValue;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("无重复字段且数值无损的 JSON")
        }
        fn visit_bool<E: serde::de::Error>(
            self,
            value: bool,
        ) -> std::result::Result<UniqueValue, E> {
            Ok(UniqueValue(Value::Bool(value)))
        }
        fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<UniqueValue, E> {
            Ok(UniqueValue(Value::Null))
        }
        fn visit_none<E: serde::de::Error>(self) -> std::result::Result<UniqueValue, E> {
            Ok(UniqueValue(Value::Null))
        }
        fn visit_str<E: serde::de::Error>(
            self,
            value: &str,
        ) -> std::result::Result<UniqueValue, E> {
            Ok(UniqueValue(Value::String(value.into())))
        }
        fn visit_string<E: serde::de::Error>(
            self,
            value: String,
        ) -> std::result::Result<UniqueValue, E> {
            Ok(UniqueValue(Value::String(value)))
        }
        fn visit_i64<E: serde::de::Error>(self, value: i64) -> std::result::Result<UniqueValue, E> {
            if !(-(MAX_JSON_SAFE_INTEGER as i64)..=MAX_JSON_SAFE_INTEGER as i64).contains(&value) {
                return Err(E::custom("JSON 整数超出安全范围"));
            }
            Ok(UniqueValue(Value::Number(value.into())))
        }
        fn visit_u64<E: serde::de::Error>(self, value: u64) -> std::result::Result<UniqueValue, E> {
            if value > MAX_JSON_SAFE_INTEGER {
                return Err(E::custom("JSON 整数超出安全范围"));
            }
            Ok(UniqueValue(Value::Number(value.into())))
        }
        fn visit_f64<E: serde::de::Error>(self, value: f64) -> std::result::Result<UniqueValue, E> {
            if !value.is_finite()
                || (value.fract() == 0.0 && value.abs() > MAX_JSON_SAFE_INTEGER as f64)
            {
                return Err(E::custom("JSON 数值不能无损传输"));
            }
            serde_json::Number::from_f64(value)
                .map(|value| UniqueValue(Value::Number(value)))
                .ok_or_else(|| E::custom("JSON 数值无效"))
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut seq: A,
        ) -> std::result::Result<UniqueValue, A::Error> {
            let mut values = Vec::new();
            while let Some(value) = seq.next_element::<UniqueValue>()? {
                values.push(value.0);
            }
            Ok(UniqueValue(Value::Array(values)))
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<UniqueValue, A::Error> {
            let mut values = serde_json::Map::new();
            while let Some(key) = map.next_key::<String>()? {
                if values.contains_key(&key) {
                    return Err(serde::de::Error::custom("JSON 包含重复字段"));
                }
                let value = map.next_value::<UniqueValue>()?;
                values.insert(key, value.0);
            }
            Ok(UniqueValue(Value::Object(values)))
        }
    }
    impl<'de> Deserialize<'de> for UniqueValue {
        fn deserialize<D: serde::Deserializer<'de>>(
            deserializer: D,
        ) -> std::result::Result<Self, D::Error> {
            deserializer.deserialize_any(UniqueVisitor)
        }
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = UniqueValue::deserialize(&mut deserializer)?.0;
    deserializer.end()?;
    Ok(value)
}

#[cfg(test)]
mod tests;
