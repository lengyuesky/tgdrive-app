//! 从 Rust 定义生成页面类型；检查模式只比较字节，不更新文件。

use std::any::TypeId;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use tgdrive_contract::{
    data::*, events::*, files::*, http::*, manifest::*, runtime::*, ui::*, validation::*, *,
};
use ts_rs::{TS, TypeVisitor};

#[derive(Default)]
struct Registry {
    visited: HashSet<TypeId>,
    declarations: BTreeMap<String, String>,
}

impl TypeVisitor for Registry {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if !self.visited.insert(TypeId::of::<T>()) {
            return;
        }
        if T::output_path().is_some() {
            let name = T::ident();
            let mut declaration = String::new();
            if let Some(docs) = T::docs() {
                declaration.push_str(&docs);
                declaration.push('\n');
            }
            declaration.push_str("export ");
            declaration.push_str(&T::decl());
            if let Some(old) = self.declarations.insert(name.clone(), declaration.clone()) {
                assert_eq!(old, declaration, "重复的类型名称 {name}");
            }
        }
        T::visit_dependencies(self);
    }
}

fn registry() -> Registry {
    let mut registry = Registry::default();
    macro_rules! register {
        ($($ty:ty),+ $(,)?) => { $(registry.visit::<$ty>();)+ };
    }
    // 只列不被其他响应/请求引用的根类型，其字段和依赖由派生实现递归遍历。
    register!(
        ContractVersion,
        ByteCount,
        Timestamp,
        EmptyResponse,
        ErrorResponse,
        Manifest,
        PackageMetadata,
        Catalog,
        RawCatalog,
        CatalogCompatibility,
        CatalogReadResult,
        CatalogStatus,
        NodeReference,
        ListDirectoryRequest,
        FileQuery,
        FileBytesQuery,
        FilePage,
        DirectoryPage,
        DirectoriesWithFilesQuery,
        RandomFilesRequest,
        RandomFilesResponse,
        FileChangesRequest,
        FileChangesPage,
        FileMutationRequest,
        MutationReceipt,
        CreateUploadRequest,
        UploadInfo,
        MediaUrlRequest,
        MediaUrl,
        LocalFileUrlRequest,
        LocalFileUrl,
        CreateReadLeaseRequest,
        ReadLease,
        StreamDirective,
        KvGetResponse,
        DeviceAppDataGrant,
        KvPutRequest,
        KvDeleteRequest,
        KvListRequest,
        KvPage,
        DataUsage,
        CachePutMetadata,
        CacheEntry,
        CacheLookupRequest,
        CacheLookupResponse,
        RuntimeInfo,
        PageBootstrap,
        SessionRefreshResponse,
        BackendStartContext,
        BackendReadyResponse,
        BackendKeepaliveRequest,
        ForwardContext,
        InstalledAppsResponse,
        CatalogResponse,
        CatalogRefreshRequest,
        PackageUploadReceipt,
        InstallPreviewRequest,
        InstallPreview,
        InstallRequest,
        AppStatePatch,
        ScopeUpdateRequest,
        RootAppUpdateRequest,
        AppResourceLimits,
        AppResourceLimitsUpdateRequest,
        LaunchPageRequest,
        LaunchPageResponse,
        HostEvent,
        KnownHostEvent,
        UiMessage,
        ValidationError,
        EndpointSpec,
    );
    registry
}

fn check_type_inventory(
    path: &Path,
    registry: &Registry,
) -> Result<(), Box<dyn std::error::Error>> {
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            if entry.file_name() != "bin" {
                check_type_inventory(&entry.path(), registry)?;
            }
            continue;
        }
        if entry.path().extension().and_then(|value| value.to_str()) != Some("rs") {
            continue;
        }
        let source = std::fs::read_to_string(entry.path())?;
        let mut derived = false;
        for line in source.lines() {
            if line.contains("derive(ts_rs::TS)") {
                derived = true;
            }
            let trimmed = line.trim();
            let declaration = trimmed
                .strip_prefix("pub struct ")
                .or_else(|| trimmed.strip_prefix("pub enum "));
            if let Some(declaration) = declaration {
                let name: String = declaration
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                if derived && !registry.declarations.contains_key(&name) {
                    return Err(format!("公开类型 {name} 没有进入类型注册表，请补充根类型").into());
                }
                derived = false;
            }
        }
    }
    Ok(())
}

fn constant(
    out: &mut String,
    name: &str,
    value: impl serde::Serialize,
) -> Result<(), serde_json::Error> {
    out.push_str(&format!(
        "export const {name} = {} as const;\n",
        serde_json::to_string_pretty(&value)?
    ));
    Ok(())
}

fn check_documentation(document: &str) -> Result<(), Box<dyn std::error::Error>> {
    let normalized = document
        .replace("<path>", "{path}")
        .replace("<app_id>", "{app_id}");
    for endpoint in ENDPOINTS {
        if !normalized.contains(endpoint.path) {
            return Err(format!("契约文档缺少接口路径 {}", endpoint.path).into());
        }
    }
    for capability in CAPABILITIES {
        if !document.contains(&format!("`{capability}`")) {
            return Err(format!("契约文档缺少能力 {capability}").into());
        }
    }
    for event in EVENT_NAMES {
        if !document.contains(&format!("`{event}`")) {
            return Err(format!("契约文档缺少事件 {event}").into());
        }
    }
    for (code, _) in ERROR_CODES {
        if !document.contains(&format!("`{code}`")) {
            return Err(format!("契约文档缺少错误码 {code}").into());
        }
    }
    Ok(())
}

fn verify_freshness(existing: &str, generated: &str) -> Result<(), Box<dyn std::error::Error>> {
    if existing != generated {
        return Err("生成类型已过期，请运行 npm run contract:generate 并提交更新".into());
    }
    Ok(())
}

fn generate() -> Result<String, Box<dyn std::error::Error>> {
    let registry = registry();
    check_type_inventory(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &registry,
    )?;
    let document =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"))?;
    check_documentation(&document)?;
    let mut out = String::from(
        "// 此文件由 Rust 契约生成，请勿手工修改。\n// 更新：npm run contract:generate；检查：npm run contract:check。\n\n",
    );
    for declaration in tgdrive_contract::typescript_aliases() {
        out.push_str(&declaration);
        out.push('\n');
    }
    out.push('\n');
    for declaration in registry.declarations.values() {
        out.push_str(declaration);
        out.push_str("\n\n");
    }
    macro_rules! constants {
        ($($name:ident),+ $(,)?) => { $(constant(&mut out, stringify!($name), $name)?;)+ };
    }
    constants!(
        CONTRACT_VERSION,
        PACKAGE_FORMAT,
        CATALOG_FORMAT,
        UI_CHANNEL,
        BOOTSTRAP_FRAGMENT_KEY,
        ADMIN_PREFIX,
        APP_API_PREFIX,
        SELF_API_BASE,
        APP_CENTER_BASE,
        NATIVE_KV_BASE,
        ASSET_BASE,
        SERVICE_BASE,
        MEDIA_TICKET_BASE,
        CACHE_TICKET_BASE,
        LOCAL_MEDIA_BASE,
        BACKEND_READY_PATH,
        BACKEND_INTERNAL_PREFIX,
        CONTEXT_ARGUMENT,
        FORWARD_CONTEXT_HEADER,
        STREAM_DIRECTIVE_HEADER,
        STREAM_DIRECTIVE_PREFIX,
        CACHE_METADATA_HEADER,
        IDEMPOTENCY_HEADER,
        RESERVED_COOKIE_PREFIX,
        EXTERNAL_CSP,
        PAGE_CSP,
        CORS_ALLOWED_HEADERS,
        CORS_EXPOSED_HEADERS,
        MANIFEST_PATH,
        PACKAGE_METADATA_PATH,
        BACKEND_ENTRY,
        DATABASE_RELATIVE_PATH,
        CACHE_RELATIVE_PATH,
        HOST_SOCKET_RELATIVE_PATH,
        BACKEND_SOCKET_RELATIVE_PATH,
        PACKAGE_TARGETS,
        CAPABILITIES,
        EVENT_NAMES,
    );
    let errors: BTreeMap<_, _> = ERROR_CODES.iter().copied().collect();
    // 超出 JavaScript 安全整数的上界用十进制字符串导出，不能让 JSON/TS 静默舍入。
    let limits: BTreeMap<_, _> = LIMITS
        .iter()
        .map(|(name, value)| {
            (
                *name,
                if *value > MAX_JSON_SAFE_INTEGER {
                    serde_json::Value::String(value.to_string())
                } else {
                    serde_json::Value::from(*value)
                },
            )
        })
        .collect();
    constant(&mut out, "ERROR_CODES", errors)?;
    let capability_requirements: BTreeMap<_, _> = CAPABILITY_REQUIREMENTS.iter().copied().collect();
    constant(&mut out, "CAPABILITY_REQUIREMENTS", capability_requirements)?;
    constant(&mut out, "LIMITS", limits)?;
    constant(&mut out, "ENDPOINTS", ENDPOINTS)?;
    // 派生器的内联文档可能产生行尾空格；统一归一化，生成结果也遵守仓库空白门禁。
    let mut normalized = out
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    normalized.push('\n');
    Ok(normalized)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let check = match args.as_slice() {
        [] => false,
        [arg] if arg == "--check" => true,
        _ => return Err("只接受 --check 参数".into()),
    };
    let output = Path::new(env!("CARGO_MANIFEST_DIR")).join("types/contract.ts");
    let generated = generate()?;
    if check {
        let existing = std::fs::read_to_string(&output)
            .map_err(|_| "生成类型缺失，请运行 npm run contract:generate")?;
        verify_freshness(&existing, &generated)?;
        println!("Rust 与 TypeScript 类型一致");
    } else {
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(output, generated)?;
        println!("已生成页面契约类型");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_generated_types_fail_instead_of_being_overwritten() {
        assert!(verify_freshness("新类型\n", "新类型\n").is_ok());
        assert!(verify_freshness("旧类型\n", "新类型\n").is_err());
        assert!(verify_freshness("新类型", "新类型\n").is_err());
    }

    #[test]
    fn cookie_boundaries_are_documented_per_forwarding_entry() {
        let document = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"),
        )
        .unwrap();
        assert!(document.contains("**页面入口**：剥除全部 Cookie 与应用会话 Authorization"));
        assert!(document.contains("**固定前缀入口**：剥除全部 Cookie"));
        assert!(document.contains("**页面入口**：剥除全部 Set-Cookie"));
        assert!(document.contains("**固定前缀入口**：剥除全部 Set-Cookie"));
        assert!(document.contains("**Path 强制为 `/`、删除 Domain**"));
        assert!(document.contains("**无论其 Path/Domain 是什么**"));
        assert!(!document.contains("其余 Set-Cookie 原样转交"));
        assert_eq!(RESERVED_COOKIE_PREFIX, "tgdrive_");
    }

    #[test]
    fn session_close_lifecycle_is_documented_without_installation_revocation() {
        let document = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"),
        )
        .unwrap();
        assert!(document.contains("DELETE /admin/api/apps/v1/self/session"));
        assert!(document.contains("仅接受当前页面会话 Bearer"));
        assert!(document.contains("成功返回 **204**"));
        assert!(document.contains("媒体票据、缓存票据、读取租约"));
        assert!(document.contains("不轮换安装 generation"));
        assert!(document.contains("续签保持页面令牌值不变"));
        assert!(document.contains("401 session_expired 或 unauthorized"));
        assert!(document.contains("LaunchPageResponse.bootstrap.session_token"));
    }

    #[test]
    fn host_bearer_credentials_are_removed_by_verified_issuer_not_shape() {
        let document = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"),
        )
        .unwrap();
        assert!(document.contains("根地址入口与固定前缀入口转发前"));
        assert!(document.contains("必须剔除经校验确属宿主自己签发的 Authorization"));
        assert!(document.contains("验证签名或命中自己的令牌存储"));
        assert!(document.contains("不是按字符串形态猜测"));
        assert!(document.contains("校验不通过的 Authorization 视为应用自己的协议凭据原样保留"));
        assert!(document.contains("剔除后请求仍是 external"));
    }

    #[test]
    fn cache_read_header_has_one_entry_representation_and_full_size_limit() {
        let document = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"),
        )
        .unwrap();
        assert!(document.contains("响应头类型只有 CacheEntry 一种表示"));
        assert!(document.contains("base64url(UTF-8 JSON CacheEntry)"));
        assert!(document.contains("完整 CacheEntry JSON 上限为 5120 字节"));
        assert!(document.contains("响应头值上限为 6827"));
        assert_eq!(CacheEntry::METADATA_HEADER, CACHE_METADATA_HEADER);
        assert_eq!(
            CacheEntry::HEADER_JSON_MAX_BYTES,
            MAX_CACHE_ENTRY_HEADER_JSON_BYTES
        );
        assert_eq!(
            CacheEntry::HEADER_VALUE_MAX_BYTES,
            MAX_CACHE_ENTRY_HEADER_BYTES
        );
    }

    #[test]
    fn json_directions_and_internal_host_route_boundary_are_explicit() {
        let document = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"),
        )
        .unwrap();
        assert!(document.contains("JSON 请求正文上限为 64 KiB"));
        assert!(document.contains("JSON 响应上限为 2 MiB"));
        assert!(document.contains("512 KiB"));
        assert!(document.contains("凡是应用会调用的必须在契约里，只有宿主自己的前端调用的不必"));
        assert_eq!(MAX_JSON_REQUEST_BYTES, 65_536);
        assert_eq!(MAX_JSON_RESPONSE_BYTES, 2_097_152);
        assert_eq!(MAX_JSON_PAGE_BYTES, 524_288);
        let generated = generate().unwrap();
        assert!(generated.contains("json_request_bytes"));
        assert!(generated.contains("json_response_bytes"));
        assert!(!generated.contains("json_body_bytes"));
        assert!(!generated.contains("MAX_JSON_BODY_BYTES"));
    }

    #[test]
    fn exported_input_bounds_preserve_large_identifiers_as_decimal_strings() {
        let generated = generate().unwrap();
        assert!(generated.contains("\"MAX_NODE_ID\": \"9223372036854775807\""));
        assert!(generated.contains("\"MAX_BYTE_COUNT\": \"18446744073709551615\""));
        assert!(generated.contains("\"MAX_TASK_PROGRESS\": 4294967295"));
        for name in [
            "MAX_UI_TITLE_BYTES",
            "MAX_AUTHORIZATION_REASON_BYTES",
            "MAX_TASK_TITLE_BYTES",
            "MAX_TASK_ID_BYTES",
            "MAX_OPAQUE_ID_BYTES",
            "MIN_JSON_PAGE_BYTES",
            "MAX_CONTENT_TYPE_BYTES",
            "MAX_EXTENSION_BYTES",
        ] {
            assert!(generated.contains(name));
        }
        let document = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"),
        )
        .unwrap();
        assert!(document.contains("每页至少返回一项"));
        assert!(document.contains("页内项数少于 limit 不代表结束"));
        assert!(document.contains("next_cursor=null"));
        assert!(document.contains("has_more=false"));
    }

    #[test]
    fn ticket_origin_and_external_entry_information_are_explicit() {
        let document = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"),
        )
        .unwrap();
        assert!(document.contains("票据 URL 只有一种形式"));
        assert!(document.contains("对所有调用方"));
        assert!(document.contains("ForwardContext.public_origin"));
        assert!(document.contains("root_url/prefix_url 都为 null"));
        assert!(document.contains("external_service.changed"));
        assert!(document.contains("根归属变更本身不轮换安装 generation，不发送 app.changed"));
        let missing_event = document.replace("`external_service.changed`", "`missing.changed`");
        assert!(check_documentation(&missing_event).is_err());
        let generated = generate().unwrap();
        assert!(generated.contains("export type ExternalServiceInfo"));
        assert!(generated.contains("public_origin: string"));
        assert!(generated.contains("export const MEDIA_TICKET_BASE"));
        assert!(generated.contains("export const CACHE_TICKET_BASE"));
    }

    #[test]
    fn socket_ticket_reads_do_not_depend_on_a_public_origin() {
        let document = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"),
        )
        .unwrap();
        let media = document
            .split("### 9.2")
            .nth(1)
            .unwrap()
            .split("### 9.3")
            .next()
            .unwrap();
        assert!(media.contains("媒体票据地址在应用后端的 host.sock 上同样可达"));
        assert!(media.contains("不经公网、不拼 public_origin"));
        assert!(media.contains("只接受该应用自己这一启动轮次签发的票据"));
        assert!(media.contains("Range、HEAD 和条件请求"));
        let cache = document
            .split("## 11.")
            .nth(1)
            .unwrap()
            .split("## 12.")
            .next()
            .unwrap();
        assert!(cache.contains("缓存票据地址在应用后端的 host.sock 上同样可达"));
        assert!(cache.contains("只接受该应用自己这一启动轮次签发的票据"));
        assert!(cache.contains("只支持 GET/HEAD 与 If-None-Match"));
        assert!(cache.contains("不支持 Range 与 If-Range，不提供 206 或 416 响应"));
        let cache_endpoint = cache
            .lines()
            .find(|line| line.contains("`/admin/api/apps/v1/cache-media/{ticket}`"))
            .unwrap();
        assert!(cache_endpoint.contains("200/304"));
        assert!(cache_endpoint.contains("If-None-Match"));
        for unsupported in ["Range", "206", "416"] {
            assert!(
                !cache_endpoint.contains(unsupported),
                "缓存票据表不能扩展 {unsupported}"
            );
        }
        assert!(cache.contains("所有缓存 GET/HEAD 的 200/304 响应"));
        assert!(!cache.contains("均支持单 Range"));
        assert!(document.contains("拒绝其他应用、页面签发及旧启动轮次票据"));
        let generated = generate().unwrap();
        assert!(generated.contains("backend_socket: boolean"));
        assert!(generated.contains("不支持 Range/If-Range，不提供 206 或 416 响应"));
        for name in ["media.ticket", "cache.ticket"] {
            assert!(
                ENDPOINTS
                    .iter()
                    .find(|endpoint| endpoint.name == name)
                    .unwrap()
                    .backend_socket
            );
        }
    }

    #[test]
    fn local_budget_billing_and_real_tool_conformance_are_explicit() {
        let document = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/contract.md"),
        )
        .unwrap();
        let local = document
            .split("### 9.3")
            .nth(1)
            .unwrap()
            .split("### 9.4")
            .next()
            .unwrap();
        for rule in [
            "字节预算按块计费，不做整段预留",
            "每从上游拉取一个有界块时原子扣减",
            "对齐/预取",
            "每个请求的响应窗口只按请求开始时的剩余预算裁剪",
            "取消或对端关闭后不再继续拉取",
            "不追加 JSON 或其他正文",
            "只有请求开始时剩余字节预算为零才返回 quota_exceeded",
            "请求数预算按请求计、不归还",
            "全部在途读取并关闭上游，不论是否带读取租约",
        ] {
            assert!(local.contains(rule), "本机输入规则缺少 {rule}");
        }
        let conformance = document
            .split("## 16.")
            .nth(1)
            .unwrap()
            .split("## 17.")
            .next()
            .unwrap();
        assert!(conformance.contains("连接尚未关闭时立即发起 seek 请求"));
        assert!(conformance.contains("用同一地址先执行 ffprobe，再执行 ffmpeg"));
        assert!(conformance.contains("带租约和不带租约两种场景均验证"));
        let generated = generate().unwrap();
        assert!(generated.contains("并发请求按块共享扣减，不预留整段"));
        assert!(generated.contains("取消或失败不归还"));
    }

    #[test]
    fn shared_backend_limits_and_object_cache_capacity_are_exported_without_per_app_caps() {
        let generated = generate().unwrap();
        let declarations = registry().declarations;
        let enforcement = &declarations["BackendLimitEnforcement"];
        assert!(enforcement.contains("memory: boolean"));
        assert!(enforcement.contains("cpu: boolean"));
        for removed in ["pids:", "open_files:"] {
            assert!(!enforcement.contains(removed));
        }
        let backend = &declarations["BackendResourceLimits"];
        assert!(backend.contains("memory_bytes: ByteCount"));
        assert!(backend.contains("cpu_millis: number"));
        assert!(backend.contains("enforced: BackendLimitEnforcement"));
        for removed in ["pids:", "open_files:", "cache_bytes:", "database_bytes:"] {
            assert!(!backend.contains(removed));
        }
        let usage = &declarations["DataUsage"];
        assert!(usage.contains("database_bytes: ByteCount | null"));
        assert!(!usage.contains("database_byte_limit:"));
        assert!(generated.contains("\"DEFAULT_CACHE_BYTES\": 1073741824"));
        for removed in [
            "DEFAULT_PAGE_CACHE_BYTES",
            "DEFAULT_BACKEND_CACHE_BYTES",
            "DEFAULT_BACKEND_DATABASE_BYTES",
            "DEFAULT_BACKEND_PIDS",
            "DEFAULT_BACKEND_OPEN_FILES",
        ] {
            assert!(!generated.contains(removed));
        }
    }

    #[test]
    fn documentation_and_all_public_wire_types_are_covered() {
        let generated = generate().unwrap();
        assert!(generated.contains("export type FileBytesQuery"));
        assert!(generated.contains("export type DeviceAppDataGrant"));
        assert!(generated.contains("export type ScopeAuthorizationRequest"));
        assert!(generated.contains("export type BackendLimitEnforcement"));
        assert!(generated.contains("export const CAPABILITY_REQUIREMENTS"));
        assert!(!generated.contains("export type ScopeRequest"));
        assert!(!generated.contains("DiskQuotaEnforcement"));
        assert!(!generated.contains("EVENT_RETENTION_SECONDS"));
        assert!(generated.lines().all(|line| line == line.trim_end()));
        assert!(check_documentation("缺少接口的文档").is_err());
    }
}
