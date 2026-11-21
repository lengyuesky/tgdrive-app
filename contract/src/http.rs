//! 地址、HTTP 约定、能力名称与统一限额。所有应用平台的宿主公网地址均位于 /admin 下。

use serde::Serialize;

pub const ADMIN_PREFIX: &str = "/admin";
pub const APP_API_PREFIX: &str = "/admin/api/apps/v1";
pub const SELF_API_BASE: &str = "/admin/api/apps/v1/self";
pub const APP_CENTER_BASE: &str = "/admin/api/app-center/v1";
pub const NATIVE_KV_BASE: &str = "/admin/api/native/apps/v1";
pub const ASSET_BASE: &str = "/admin/apps/assets";
pub const SERVICE_BASE: &str = "/admin/api/apps/v1/services";
/// 原文件/附件缩略图票据的同源相对路径基址，与调用方无关。
pub const MEDIA_TICKET_BASE: &str = "/admin/api/apps/v1/media";
/// 小对象缓存票据的同源相对路径基址，与调用方无关。
pub const CACHE_TICKET_BASE: &str = "/admin/api/apps/v1/cache-media";
/// 只在内部 loopback 监听器注册；本机地址在此前缀上另带绝对源。
pub const LOCAL_MEDIA_BASE: &str = "/admin/apps-local/v1";
pub const BACKEND_READY_PATH: &str = "/_tgdrive/ready";
pub const BACKEND_INTERNAL_PREFIX: &str = "/_tgdrive";
pub const CONTEXT_ARGUMENT: &str = "--tgdrive-context";
pub const FORWARD_CONTEXT_HEADER: &str = "X-Tgdrive-Context";
pub const STREAM_DIRECTIVE_HEADER: &str = "X-Tgdrive-Stream";
pub const STREAM_DIRECTIVE_PREFIX: &str = "v1;";
pub const CACHE_METADATA_HEADER: &str = "X-Tgdrive-Cache-Meta";
pub const IDEMPOTENCY_HEADER: &str = "Idempotency-Key";
pub const RESERVED_COOKIE_PREFIX: &str = "tgdrive_";

pub const EXTERNAL_CSP: &str = "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
pub const PAGE_CSP: &str = "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
pub const CORS_ALLOWED_HEADERS: &str = "Authorization, Content-Type, Range, If-None-Match, If-Range, Last-Event-ID, Idempotency-Key, X-Tgdrive-Cache-Meta";
pub const CORS_EXPOSED_HEADERS: &str = "Content-Length, Content-Range, Accept-Ranges, ETag, Retry-After, X-Tgdrive-Request-Id, X-Tgdrive-Cache-Meta";

/// 能力的唯一声明：名称与 v1 是否必备一起生成，不能把定义全集当成宿主实际宣告。
macro_rules! capabilities {
    ($( $name:literal => $required:literal ),+ $(,)?) => {
        pub const CAPABILITIES: &[&str] = &[$($name),+];
        pub const CAPABILITY_REQUIREMENTS: &[(&str, bool)] = &[$(($name, $required)),+];
    };
}

// 后端/界面能力按应用组成与调用方适用；kv.device 不在 v1 必备集合中。
capabilities! {
    "runtime.info" => true,
    "session.refresh" => true,
    "scope.read" => true,
    "files.stat" => true,
    "files.list" => true,
    "files.query" => true,
    "files.directories_with_files" => true,
    "files.random" => true,
    "files.changes" => true,
    "files.bytes" => true,
    "files.media_url" => true,
    "files.local_url" => true,
    "files.mutate" => true,
    "files.upload" => true,
    "read_leases" => true,
    "kv.cas" => true,
    "kv.device" => false,
    "events.sse" => true,
    "backend.proxy" => true,
    "backend.keepalive" => true,
    "backend.external" => true,
    "cache.objects" => true,
    "ui.set_immersive" => true,
    "ui.set_title" => true,
    "ui.pick_directory" => true,
    "ui.request_scope" => true,
    "ui.task" => true,
    "ui.close" => true,
    "ui.theme_changed" => true,
}

macro_rules! limits {
    ($( $name:ident => $value:expr ),+ $(,)?) => {
        $(pub const $name: u64 = $value;)+
        pub const LIMITS: &[(&str, u64)] = &[$((stringify!($name), $name)),+];
    };
}

limits! {
    MAX_MANIFEST_BYTES => 64 * 1024,
    MAX_MANIFEST_NAME_BYTES => 120,
    MAX_MANIFEST_DESCRIPTION_BYTES => 1600,
    MAX_MANIFEST_AUTHOR_BYTES => 160,
    MAX_VERSION_BYTES => 80,
    MAX_CAPABILITY_BYTES => 80,
    MAX_REQUIRED_CAPABILITIES => 64,
    MAX_REPOSITORY_OWNER_BYTES => 39,
    MAX_REPOSITORY_NAME_BYTES => 100,
    MAX_PACKAGE_TARGET_BYTES => 48,
    MAX_PACKAGE_TARGETS => 16,
    SHA256_HEX_BYTES => 64,
    MAX_UI_TITLE_BYTES => 120,
    MAX_AUTHORIZATION_REASON_BYTES => 800,
    MAX_TASK_TITLE_BYTES => 160,
    MAX_TASK_ID_BYTES => 64,
    MAX_TASK_PROGRESS => u32::MAX as u64,
    IMMERSIVE_COLOR_HEX_DIGITS => 6,
    IMMERSIVE_COLOR_BYTES => IMMERSIVE_COLOR_HEX_DIGITS + 1,
    MAX_NODE_ID => i64::MAX as u64,
    MAX_NODE_ID_DIGITS => 19,
    MAX_BYTE_COUNT => u64::MAX,
    MAX_BYTE_COUNT_DIGITS => 20,
    MAX_JSON_SAFE_INTEGER => 9_007_199_254_740_991,
    MAX_TIMESTAMP_MILLIS => MAX_JSON_SAFE_INTEGER,
    MAX_CONTRACT_VERSION_COMPONENT => u16::MAX as u64,
    MIN_IDEMPOTENCY_KEY_BYTES => 16,
    MAX_IDEMPOTENCY_KEY_BYTES => 128,
    MAX_OPERATION_ID_BYTES => 64,
    MAX_UNIX_SOCKET_PATH_BYTES => 107,
    MAX_CONTENT_TYPE_BYTES => 256,
    MAX_EXTENSION_BYTES => 40,
    DEFAULT_FILE_PAGE_LIMIT => 200,
    DEFAULT_KV_PAGE_LIMIT => 100,
    DEFAULT_RANDOM_LIMIT => 20,
    MIN_POSITIVE_LIMIT => 1,
    MIN_BACKEND_MEMORY_BYTES => 32 * 1024 * 1024,
    MAX_BACKEND_MEMORY_BYTES => 8 * 1024 * 1024 * 1024,
    MIN_BACKEND_CACHE_BYTES => 16 * 1024 * 1024,
    MAX_BACKEND_CACHE_BYTES => 16 * 1024 * 1024 * 1024,
    MIN_BACKEND_DATABASE_BYTES => 16 * 1024 * 1024,
    MAX_BACKEND_DATABASE_BYTES => 8 * 1024 * 1024 * 1024,
    MIN_BACKEND_CPU_MILLIS => 100,
    MAX_BACKEND_CPU_MILLIS => 32_000,
    MIN_BACKEND_PIDS => 16,
    MAX_BACKEND_PIDS => 512,
    MAX_CATALOG_BYTES => 4 * 1024 * 1024,
    MAX_CATALOG_ENTRIES => 512,
    MAX_PACKAGE_BYTES => 128 * 1024 * 1024,
    MAX_PACKAGE_EXPANDED_BYTES => 256 * 1024 * 1024,
    MAX_PACKAGE_FILE_BYTES => 128 * 1024 * 1024,
    MAX_PACKAGE_ENTRIES => 4096,
    MAX_ICON_BYTES => 256 * 1024,
    MAX_JSON_REQUEST_BYTES => 64 * 1024,
    MAX_JSON_RESPONSE_BYTES => 2 * 1024 * 1024,
    MIN_JSON_PAGE_BYTES => 64 * 1024,
    MAX_JSON_PAGE_BYTES => 512 * 1024,
    MAX_FILE_NODE_JSON_BYTES => 10 * 1024,
    MAX_OPAQUE_ID_BYTES => 128,
    MAX_PROXY_BODY_BYTES => 8 * 1024 * 1024,
    MAX_URI_BYTES => 8192,
    MAX_HEADER_BYTES => 32 * 1024,
    MAX_STREAM_DIRECTIVE_BYTES => 4096,
    MAX_APP_ID_BYTES => 64,
    MAX_RESOURCE_PATH_BYTES => 240,
    MAX_DRIVE_PATH_BYTES => 4096,
    MAX_NAME_BYTES => 255,
    MAX_QUERY_ROOTS => 128,
    MAX_QUERY_EXTENSIONS => 64,
    MAX_PAGE_LIMIT => 500,
    MAX_CURSOR_BYTES => 4096,
    PAGE_CURSOR_SECONDS => 60 * 60,
    MAX_MUTATION_OPERATIONS => 64,
    MAX_MUTATION_ASSERTIONS => 256,
    MAX_RANDOM_LIMIT => 64,
    MAX_RANDOM_CANDIDATE_STEPS => 4096,
    MAX_RANDOM_EXCLUSIONS => 512,
    MAX_KV_KEY_BYTES => 128,
    MAX_KV_VALUE_BYTES => 32 * 1024,
    DEFAULT_KV_ENTRIES => 100_000,
    DEFAULT_KV_BYTES => 64 * 1024 * 1024,
    MAX_KV_PAGE_LIMIT => 200,
    MAX_CACHE_OBJECT_BYTES => 2 * 1024 * 1024,
    MAX_CACHE_METADATA_BYTES => 4096,
    MAX_CACHE_ENTRY_HEADER_JSON_BYTES => 5 * 1024,
    MAX_CACHE_ENTRY_HEADER_BYTES => (MAX_CACHE_ENTRY_HEADER_JSON_BYTES * 4).div_ceil(3),
    MAX_CACHE_LOOKUP_KEYS => 64,
    MAX_CACHE_SOURCES => 16,
    CACHE_EVICTION_TARGET_PERCENT => 90,
    FILE_EVENT_DEBOUNCE_MILLIS => 250,
    MAX_FILE_EVENT_DELAY_MILLIS => 1000,
    CACHE_TICKET_SECONDS => 300,
    DEFAULT_PAGE_CACHE_BYTES => 256 * 1024 * 1024,
    DEFAULT_BACKEND_CACHE_BYTES => 1024 * 1024 * 1024,
    DEFAULT_BACKEND_DATABASE_BYTES => 512 * 1024 * 1024,
    DEFAULT_BACKEND_MEMORY_BYTES => 512 * 1024 * 1024,
    DEFAULT_BACKEND_CPU_MILLIS => 1000,
    DEFAULT_BACKEND_PIDS => 64,
    DEFAULT_BACKEND_OPEN_FILES => 1024,
    PAGE_CONTROL_CONCURRENCY => 16,
    BACKEND_CONTROL_CONCURRENCY => 32,
    PAGE_BYTE_CONCURRENCY => 8,
    BACKEND_BYTE_CONCURRENCY => 32,
    PAGE_CONTROL_RATE => 120,
    PAGE_CONTROL_BURST => 240,
    BACKEND_CONTROL_RATE => 300,
    BACKEND_CONTROL_BURST => 600,
    MAX_EVENT_CONNECTIONS_PER_CALLER => 2,
    MAX_READ_LEASES => 256,
    MAX_MEDIA_TICKETS => 8192,
    MAX_UPLOADS => 4,
    PAGE_SESSION_SECONDS => 6 * 60 * 60,
    DEFAULT_MEDIA_TICKET_SECONDS => 15 * 60,
    MAX_MEDIA_TICKET_SECONDS => 6 * 60 * 60,
    MAX_READ_LEASE_SECONDS => 24 * 60 * 60,
    DEFAULT_LOCAL_TICKET_SECONDS => 60,
    MAX_LOCAL_TICKET_SECONDS => 600,
    DEFAULT_LOCAL_BYTE_BUDGET => 16 * 1024 * 1024,
    MAX_LOCAL_BYTE_BUDGET => 1024 * 1024 * 1024,
    DEFAULT_LOCAL_REQUEST_BUDGET => 32,
    MAX_LOCAL_REQUEST_BUDGET => 256,
    UPLOAD_RETENTION_SECONDS => 24 * 60 * 60,
    MUTATION_RECEIPT_SECONDS => 7 * 24 * 60 * 60,
    MAX_EVENT_JOURNAL_ENTRIES => 4096,
    FILE_CHANGE_RETENTION_SECONDS => 7 * 24 * 60 * 60,
    MAX_FILE_CHANGE_JOURNAL_ENTRIES => 1_000_000,
    BACKEND_READY_SECONDS => 30,
    BACKEND_IDLE_SECONDS => 300,
    BACKEND_STOP_SECONDS => 10,
    BACKEND_KEEPALIVE_SECONDS => 300,
    MAX_BACKEND_RESTARTS => 5,
    BACKEND_RESTART_WINDOW_SECONDS => 600,
    CONTROL_TIMEOUT_SECONDS => 30,
    PROXY_FIRST_RESPONSE_SECONDS => 60,
    STREAM_IDLE_TIMEOUT_SECONDS => 60,
    UI_TIMEOUT_SECONDS => 300,
    UI_CLOSE_GRACE_MILLIS => 2000,
    SSE_HEARTBEAT_SECONDS => 15,
    MAX_UI_REQUESTS => 32,
    PACKAGE_STAGING_SECONDS => 60 * 60,
    INSTALL_PREVIEW_SECONDS => 10 * 60,
    CATALOG_CACHE_SECONDS => 300,
    CATALOG_MIN_CHECK_SECONDS => 30,
    CATALOG_TIMEOUT_SECONDS => 10,
    PACKAGE_DOWNLOAD_SECONDS => 120,
    MAX_DOWNLOAD_REDIRECTS => 5,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum EndpointAccess {
    Public,
    App,
    FileRead,
    FileWrite,
    BackendOnly,
    PageOnly,
    OwnerOnly,
    DeviceKv,
    Ticket,
    External,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct EndpointSpec {
    pub name: &'static str,
    pub methods: &'static [&'static str],
    pub path: &'static str,
    pub access: EndpointAccess,
    pub capability: Option<&'static str>,
    /// 是否在本应用的宿主套接字注册；不替代 access、能力及目录授权检查。
    /// 票据端点为 true 时，还只允许本应用当前后端启动轮次签发的票据。
    pub backend_socket: bool,
}

macro_rules! endpoints {
    ($( $name:literal, [$($method:literal),+], $path:literal, $access:ident, $cap:expr $(, $socket:literal)? );+ $(;)?) => {
        pub const ENDPOINTS: &[EndpointSpec] = &[$(
            EndpointSpec {
                name: $name,
                methods: &[$($method),+],
                path: $path,
                access: EndpointAccess::$access,
                capability: $cap,
                backend_socket: endpoints!(@socket $access $(, $socket)?),
            }
        ),+];
    };
    (@socket $access:ident, $enabled:literal) => { $enabled };
    (@socket $access:ident) => {
        matches!(
            EndpointAccess::$access,
            EndpointAccess::App | EndpointAccess::FileRead | EndpointAccess::FileWrite | EndpointAccess::BackendOnly
        )
    };
}

endpoints! {
    "runtime.info", ["GET"], "/admin/api/apps/v1/self/info", App, Some("runtime.info");
    "session.refresh", ["POST"], "/admin/api/apps/v1/self/session/refresh", PageOnly, Some("session.refresh");
    "session.close", ["DELETE"], "/admin/api/apps/v1/self/session", PageOnly, Some("session.refresh");
    "scope.read", ["GET"], "/admin/api/apps/v1/self/scope", App, Some("scope.read");
    "files.stat", ["POST"], "/admin/api/apps/v1/self/files/stat", FileRead, Some("files.stat");
    "files.list", ["POST"], "/admin/api/apps/v1/self/files/list", FileRead, Some("files.list");
    "files.query", ["POST"], "/admin/api/apps/v1/self/files/query", FileRead, Some("files.query");
    "files.directories_with_files", ["POST"], "/admin/api/apps/v1/self/files/directories-with-files", FileRead, Some("files.directories_with_files");
    "files.random", ["POST"], "/admin/api/apps/v1/self/files/random", FileRead, Some("files.random");
    "files.changes", ["POST"], "/admin/api/apps/v1/self/files/changes", FileRead, Some("files.changes");
    "files.bytes", ["GET", "HEAD"], "/admin/api/apps/v1/self/files/{id}/bytes", FileRead, Some("files.bytes");
    "files.media_url", ["POST"], "/admin/api/apps/v1/self/files/media-url", FileRead, Some("files.media_url");
    "files.local_url", ["POST"], "/admin/api/apps/v1/self/files/local-url", BackendOnly, Some("files.local_url");
    "files.local_url.revoke", ["DELETE"], "/admin/api/apps/v1/self/files/local-url/{id}", BackendOnly, Some("files.local_url");
    "files.mutate", ["POST"], "/admin/api/apps/v1/self/files/mutations", FileWrite, Some("files.mutate");
    "files.mutate.receipt", ["GET"], "/admin/api/apps/v1/self/files/mutations/{key}", App, Some("files.mutate");
    "files.upload.create", ["POST"], "/admin/api/apps/v1/self/uploads", FileWrite, Some("files.upload");
    "files.upload.body", ["PUT"], "/admin/api/apps/v1/self/uploads/{id}/body", FileWrite, Some("files.upload");
    "files.upload.status", ["GET"], "/admin/api/apps/v1/self/uploads/{id}", App, Some("files.upload");
    "files.upload.cancel", ["DELETE"], "/admin/api/apps/v1/self/uploads/{id}", App, Some("files.upload");
    "read_leases.create", ["POST"], "/admin/api/apps/v1/self/read-leases", FileRead, Some("read_leases");
    "read_leases.renew", ["PUT"], "/admin/api/apps/v1/self/read-leases/{id}", FileRead, Some("read_leases");
    "read_leases.revoke", ["DELETE"], "/admin/api/apps/v1/self/read-leases/{id}", App, Some("read_leases");
    "kv.get", ["GET"], "/admin/api/apps/v1/self/kv/{key}", App, Some("kv.cas");
    "kv.put", ["PUT"], "/admin/api/apps/v1/self/kv/{key}", App, Some("kv.cas");
    "kv.delete", ["DELETE"], "/admin/api/apps/v1/self/kv/{key}", App, Some("kv.cas");
    "kv.list", ["POST"], "/admin/api/apps/v1/self/kv/list", App, Some("kv.cas");
    "data.usage", ["GET"], "/admin/api/apps/v1/self/data/usage", App, Some("kv.cas");
    "events", ["GET"], "/admin/api/apps/v1/self/events", App, Some("events.sse");
    "backend.keepalive", ["POST"], "/admin/api/apps/v1/self/process/keepalive", BackendOnly, Some("backend.keepalive");
    "backend.proxy", ["*"], "/admin/api/apps/v1/self/backend/{path}", PageOnly, Some("backend.proxy");
    "cache.put", ["PUT"], "/admin/api/apps/v1/self/cache/{key}", App, Some("cache.objects");
    "cache.get", ["GET", "HEAD"], "/admin/api/apps/v1/self/cache/{key}", App, Some("cache.objects");
    "cache.delete", ["DELETE"], "/admin/api/apps/v1/self/cache/{key}", App, Some("cache.objects");
    "cache.lookup", ["POST"], "/admin/api/apps/v1/self/cache/lookup", App, Some("cache.objects");
    "native.kv.get", ["GET"], "/admin/api/native/apps/v1/{app_id}/kv/{key}", DeviceKv, Some("kv.device");
    "native.kv.put", ["PUT"], "/admin/api/native/apps/v1/{app_id}/kv/{key}", DeviceKv, Some("kv.device");
    "native.kv.delete", ["DELETE"], "/admin/api/native/apps/v1/{app_id}/kv/{key}", DeviceKv, Some("kv.device");
    "native.kv.list", ["POST"], "/admin/api/native/apps/v1/{app_id}/kv/list", DeviceKv, Some("kv.device");
    // 套接字上的票据必须由本应用当前启动轮次签发；不是跨应用或页面票据代理。
    "media.ticket", ["GET", "HEAD"], "/admin/api/apps/v1/media/{ticket}", Ticket, None, true;
    "cache.ticket", ["GET", "HEAD"], "/admin/api/apps/v1/cache-media/{ticket}", Ticket, None, true;
    "local.ticket", ["GET", "HEAD"], "/admin/apps-local/v1/{ticket}", Ticket, None;
    "assets", ["GET", "HEAD"], "/admin/apps/assets/{app_id}/{sha256}/{path}", Public, None;
    "external.prefix", ["*"], "/admin/api/apps/v1/services/{app_id}/{path}", External, Some("backend.external");
    "center.apps", ["GET"], "/admin/api/app-center/v1/apps", OwnerOnly, None;
    "center.app", ["GET"], "/admin/api/app-center/v1/apps/{app_id}", OwnerOnly, None;
    "center.catalog", ["GET"], "/admin/api/app-center/v1/catalog", OwnerOnly, None;
    "center.catalog.refresh", ["POST"], "/admin/api/app-center/v1/catalog/refresh", OwnerOnly, None;
    "center.package.upload", ["POST"], "/admin/api/app-center/v1/packages", OwnerOnly, None;
    "center.install.preview", ["POST"], "/admin/api/app-center/v1/install/preview", OwnerOnly, None;
    "center.install", ["POST"], "/admin/api/app-center/v1/install", OwnerOnly, None;
    "center.app.state", ["PATCH"], "/admin/api/app-center/v1/apps/{app_id}/state", OwnerOnly, None;
    "center.app.scope", ["PUT"], "/admin/api/app-center/v1/apps/{app_id}/scope", OwnerOnly, None;
    "center.app.uninstall", ["DELETE"], "/admin/api/app-center/v1/apps/{app_id}", OwnerOnly, None;
    "center.app.cache.clear", ["DELETE"], "/admin/api/app-center/v1/apps/{app_id}/cache", OwnerOnly, None;
    "center.app.restart", ["POST"], "/admin/api/app-center/v1/apps/{app_id}/backend/restart", OwnerOnly, None;
    "center.app.launch", ["POST"], "/admin/api/app-center/v1/apps/{app_id}/launch", OwnerOnly, None;
    "center.root.read", ["GET"], "/admin/api/app-center/v1/root-app", OwnerOnly, None;
    "center.root.update", ["PUT"], "/admin/api/app-center/v1/root-app", OwnerOnly, None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_is_required_and_device_kv_is_an_independent_extension() {
        let requirements: std::collections::BTreeMap<_, _> =
            CAPABILITY_REQUIREMENTS.iter().copied().collect();
        assert_eq!(requirements.len(), CAPABILITIES.len());
        assert!(requirements["cache.objects"]);
        assert!(!requirements["kv.device"]);
        assert!(!CAPABILITIES.contains(&"scope.request"));
        assert!(
            !ENDPOINTS
                .iter()
                .any(|endpoint| endpoint.path.ends_with("/scope/requests"))
        );
        for endpoint in ENDPOINTS
            .iter()
            .filter(|endpoint| endpoint.access == EndpointAccess::DeviceKv)
        {
            assert_eq!(endpoint.capability, Some("kv.device"));
        }
        assert!(PAGE_CSP.contains("connect-src 'self'"));
        assert_eq!(MAX_EVENT_JOURNAL_ENTRIES, 4096);
        assert_eq!(FILE_CHANGE_RETENTION_SECONDS, 7 * 24 * 60 * 60);
    }

    #[test]
    fn session_close_reuses_the_page_session_capability() {
        let endpoint = ENDPOINTS
            .iter()
            .find(|endpoint| endpoint.name == "session.close")
            .unwrap();
        assert_eq!(endpoint.path, "/admin/api/apps/v1/self/session");
        assert_eq!(endpoint.methods, &["DELETE"]);
        assert_eq!(endpoint.access, EndpointAccess::PageOnly);
        assert_eq!(endpoint.capability, Some("session.refresh"));
        assert!(!CAPABILITIES.contains(&"session.close"));
    }

    #[test]
    fn ticket_paths_and_runtime_info_use_the_registered_caller_boundaries() {
        for (name, base) in [
            ("media.ticket", crate::files::MediaUrl::TICKET_BASE),
            ("cache.ticket", crate::data::CacheHit::TICKET_BASE),
            ("local.ticket", LOCAL_MEDIA_BASE),
        ] {
            let endpoint = ENDPOINTS
                .iter()
                .find(|endpoint| endpoint.name == name)
                .unwrap();
            assert_eq!(endpoint.path, format!("{base}/{{ticket}}"));
            assert_eq!(endpoint.methods, &["GET", "HEAD"]);
            assert_eq!(endpoint.access, EndpointAccess::Ticket);
        }
        for name in ["runtime.info", "cache.lookup"] {
            let endpoint = ENDPOINTS
                .iter()
                .find(|endpoint| endpoint.name == name)
                .unwrap();
            assert_eq!(endpoint.access, EndpointAccess::App);
        }
        let media = ENDPOINTS
            .iter()
            .find(|endpoint| endpoint.name == "files.media_url")
            .unwrap();
        assert_eq!(media.access, EndpointAccess::FileRead);
        let local = ENDPOINTS
            .iter()
            .find(|endpoint| endpoint.name == "files.local_url.revoke")
            .unwrap();
        assert_eq!(local.methods, &["DELETE"]);
        assert_eq!(local.access, EndpointAccess::BackendOnly);
        assert_eq!(DEFAULT_LOCAL_BYTE_BUDGET, 16 * 1024 * 1024);
        assert_eq!(MAX_LOCAL_BYTE_BUDGET, 1024 * 1024 * 1024);
        assert_eq!(DEFAULT_LOCAL_REQUEST_BUDGET, 32);
        assert_eq!(MAX_LOCAL_REQUEST_BUDGET, 256);
    }

    #[test]
    fn backend_socket_exposes_only_the_two_registered_ticket_paths() {
        let ticket_names: Vec<_> = ENDPOINTS
            .iter()
            .filter(|endpoint| endpoint.access == EndpointAccess::Ticket && endpoint.backend_socket)
            .map(|endpoint| endpoint.name)
            .collect();
        assert_eq!(ticket_names, ["media.ticket", "cache.ticket"]);
        for endpoint in ENDPOINTS {
            match endpoint.access {
                EndpointAccess::App
                | EndpointAccess::FileRead
                | EndpointAccess::FileWrite
                | EndpointAccess::BackendOnly => assert!(endpoint.backend_socket),
                EndpointAccess::Public
                | EndpointAccess::PageOnly
                | EndpointAccess::OwnerOnly
                | EndpointAccess::DeviceKv
                | EndpointAccess::External => assert!(!endpoint.backend_socket),
                EndpointAccess::Ticket => {}
            }
        }
        assert!(
            !ENDPOINTS
                .iter()
                .find(|endpoint| endpoint.name == "local.ticket")
                .unwrap()
                .backend_socket
        );
    }

    #[test]
    fn endpoint_registry_has_no_duplicate_method_path_pairs() {
        let mut seen = std::collections::BTreeSet::new();
        for endpoint in ENDPOINTS {
            assert!(endpoint.path.starts_with("/admin/"));
            for method in endpoint.methods {
                assert!(
                    seen.insert((*method, endpoint.path)),
                    "重复接口 {} {}",
                    method,
                    endpoint.path
                );
            }
            if let Some(capability) = endpoint.capability {
                assert!(CAPABILITIES.contains(&capability));
            }
        }
    }
}
