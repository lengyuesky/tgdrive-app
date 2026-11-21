use crate::{Error, Result, decode_json, http};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};
use tgdrive_contract::{
    CONTRACT_VERSION, ContractVersion, error_code, http::*, runtime::*, validation::*,
};

/// 只在完成私有数据库迁移后创建服务，ready 才会对宿主宣告可用。
#[derive(Clone, Debug)]
pub struct StartContext {
    pub context: BackendStartContext,
    pub negotiated: ContractVersion,
}

impl StartContext {
    pub fn from_args(
        args: impl IntoIterator<Item = OsString>,
        minimum: ContractVersion,
    ) -> Result<Self> {
        let mut args = args.into_iter();
        let _program = args.next();
        if args.next().as_deref() != Some(std::ffi::OsStr::new(CONTEXT_ARGUMENT)) {
            return Err(Error::Protocol(
                "启动参数必须为 --tgdrive-context <绝对路径>",
            ));
        }
        let path = PathBuf::from(args.next().ok_or(Error::Protocol("缺少上下文路径"))?);
        if args.next().is_some() || !path.is_absolute() {
            return Err(Error::Protocol("启动参数或上下文路径无效"));
        }
        let file = std::fs::File::open(&path)?;
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(MAX_JSON_REQUEST_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_JSON_REQUEST_BYTES {
            return Err(Error::Protocol("启动上下文过大"));
        }
        Self::parse(&bytes, minimum)
    }

    pub fn parse(bytes: &[u8], minimum: ContractVersion) -> Result<Self> {
        let context: BackendStartContext = decode_json(bytes)?;
        if !valid_app_id(&context.app.id)
            || stable_version(&context.app.version).is_none()
            || !valid_opaque_id(&context.app.generation)
            || !valid_opaque_id(&context.run_id)
        {
            return Err(Error::Protocol("启动身份无效"));
        }
        for path in [
            &context.host_socket,
            &context.listen_socket,
            &context.data_dir,
            &context.database_path,
            &context.cache_dir,
            &context.temp_dir,
            &context.ffmpeg_path,
            &context.ffprobe_path,
        ] {
            if !Path::new(path).is_absolute() || path.contains('\0') {
                return Err(Error::Protocol("启动路径必须为绝对路径"));
            }
        }
        // Linux sockaddr_un.sun_path 的终止 NUL 也占一字节，不能截断身份路径。
        if context.host_socket.len() as u64 > MAX_UNIX_SOCKET_PATH_BYTES
            || context.listen_socket.len() as u64 > MAX_UNIX_SOCKET_PATH_BYTES
            || context.host_socket == context.listen_socket
        {
            return Err(Error::Protocol("Unix 套接字路径无效"));
        }
        let negotiated = negotiate_contract(context.contract, CONTRACT_VERSION, minimum)?;
        Ok(Self {
            context,
            negotiated,
        })
    }

    pub fn ready(&self) -> BackendReadyResponse {
        BackendReadyResponse {
            contract: self.negotiated,
            app_id: self.context.app.id.clone(),
            version: self.context.app.version.clone(),
            generation: self.context.app.generation.clone(),
            run_id: self.context.run_id.clone(),
        }
    }
}

pub fn parse_forward_context(
    headers: &http::HeaderMap,
    start: &StartContext,
) -> Result<Option<ForwardContext>> {
    let values = headers
        .get_all(FORWARD_CONTEXT_HEADER)
        .iter()
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Ok(None);
    }
    if values.len() != 1 {
        return Err(Error::api(error_code::UNAUTHORIZED, "转发上下文必须唯一"));
    }
    let header = values[0]
        .to_str()
        .map_err(|_| Error::Protocol("上下文头无效"))?;
    if header.len() as u64 > MAX_HEADER_BYTES {
        return Err(Error::Protocol("上下文头过大"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(header)
        .map_err(|_| Error::Protocol("上下文编码无效"))?;
    // 解码后重编码保证无 padding、无可替代的非规范编码。
    if URL_SAFE_NO_PAD.encode(&bytes) != header {
        return Err(Error::Protocol("上下文编码不是规范形式"));
    }
    let context: ForwardContext = decode_json(&bytes)?;
    if context.app_id != start.context.app.id
        || context.contract != start.negotiated
        || !valid_opaque_id(&context.request_id)
        || !matches!(
            (context.caller, context.entry),
            (ForwardCaller::Owner, ForwardEntry::Page)
                | (
                    ForwardCaller::External,
                    ForwardEntry::Root | ForwardEntry::Prefix
                )
        )
    {
        return Err(Error::api(error_code::UNAUTHORIZED, "转发身份不匹配"));
    }
    let uri: http::Uri = context
        .original_uri
        .parse()
        .map_err(|_| Error::Protocol("原始 URI 无效"))?;
    let public: http::Uri = context
        .public_base_url
        .parse()
        .map_err(|_| Error::Protocol("公开基地址无效"))?;
    let origin: http::Uri = context
        .public_origin
        .parse()
        .map_err(|_| Error::Protocol("公开源无效"))?;
    if !matches!(origin.scheme_str(), Some("http" | "https"))
        || origin
            .authority()
            .is_none_or(|authority| authority.as_str().contains('@'))
        || context.public_origin.len() as u64 > MAX_URI_BYTES
        || context.public_origin
            != format!(
                "{}://{}",
                origin.scheme_str().unwrap_or_default(),
                origin
                    .authority()
                    .map(|authority| authority.as_str())
                    .unwrap_or_default()
            )
        || public.scheme() != origin.scheme()
        || public.authority() != origin.authority()
        || context.entry == ForwardEntry::Root && context.public_base_url != context.public_origin
    {
        return Err(Error::Protocol("公开源必须为与转发基地址一致的无路径源"));
    }
    if uri.scheme().is_some()
        || uri.authority().is_some()
        || !uri.path().starts_with('/')
        || uri.path().starts_with("//")
        || context.original_uri.contains('#')
        || context.original_uri.len() as u64 > MAX_URI_BYTES
        || !matches!(public.scheme_str(), Some("http" | "https"))
        || public
            .authority()
            .is_none_or(|authority| authority.as_str().contains('@'))
        || public.query().is_some()
        || context.public_base_url.contains('#')
        || context.public_base_url.ends_with('/')
        || context
            .client_ip
            .as_ref()
            .is_some_and(|ip| ip.parse::<std::net::IpAddr>().is_err())
    {
        return Err(Error::Protocol("转发地址无效"));
    }
    Ok(Some(context))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn start() -> StartContext {
        let raw = serde_json::json!({"contract":{"major":1,"minor":2},"app":{"id":"example","name":"示例","version":"1.0.0","generation":"g1"},"run_id":"run1","host_socket":"/tmp/host.sock","listen_socket":"/tmp/backend.sock","data_dir":"/tmp/data","database_path":"/tmp/data/state/app.sqlite3","cache_dir":"/tmp/data/cache","temp_dir":"/tmp/data/tmp","ffmpeg_path":"/bin/ffmpeg","ffprobe_path":"/bin/ffprobe","limits":{"memory_bytes":"536870912","cpu_millis":1000,"pids":64,"open_files":1024,"cache_bytes":"1073741824","database_bytes":"536870912","enforced":{"memory":false,"cpu":false,"pids":true,"open_files":true}}});
        StartContext::parse(&serde_json::to_vec(&raw).unwrap(), CONTRACT_VERSION).unwrap()
    }
    #[test]
    fn absent_is_never_owner_and_versions_are_negotiated() {
        let start = start();
        assert_eq!(start.ready().contract, CONTRACT_VERSION);
        assert!(
            parse_forward_context(&http::HeaderMap::new(), &start)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn public_origin_is_pathless_and_matches_the_forward_base() {
        let start = start();
        let mut value = serde_json::json!({"contract":{"major":1,"minor":0},"app_id":"example","caller":"external","entry":"prefix","request_id":"r1","original_uri":"/api","public_origin":"https://example.invalid","public_base_url":"https://example.invalid/admin/api/apps/v1/services/example","client_ip":null});
        let parse = |value: &serde_json::Value| {
            let mut headers = http::HeaderMap::new();
            headers.insert(
                FORWARD_CONTEXT_HEADER,
                URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(value).unwrap())
                    .parse()
                    .unwrap(),
            );
            parse_forward_context(&headers, &start)
        };
        assert!(parse(&value).is_ok());
        for invalid in [
            "https://other.invalid",
            "http://example.invalid",
            "https://example.invalid/",
            "https://example.invalid/path",
            "https://example.invalid?q=1",
            "https://example.invalid#fragment",
            "https://user@example.invalid",
            "//example.invalid",
            "file:///tmp/input",
        ] {
            value["public_origin"] = invalid.into();
            assert!(parse(&value).is_err(), "{invalid}");
        }
        value["public_origin"] = "https://example.invalid".into();
        value["entry"] = "root".into();
        assert!(parse(&value).is_err());
        value["public_base_url"] = "https://example.invalid".into();
        assert!(parse(&value).is_ok());
    }
    #[test]
    fn rejects_duplicates_and_external_owner_impersonation() {
        let start = start();
        let mut value = serde_json::json!({"contract":{"major":1,"minor":0},"app_id":"example","caller":"owner","entry":"root","request_id":"r1","original_uri":"/api","public_origin":"https://example.invalid","public_base_url":"https://example.invalid","client_ip":null});
        let mut headers = http::HeaderMap::new();
        headers.insert(
            FORWARD_CONTEXT_HEADER,
            URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
                .parse()
                .unwrap(),
        );
        assert!(parse_forward_context(&headers, &start).is_err());
        value["entry"] = "page".into();
        headers.insert(
            FORWARD_CONTEXT_HEADER,
            URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
                .parse()
                .unwrap(),
        );
        assert_eq!(
            parse_forward_context(&headers, &start)
                .unwrap()
                .unwrap()
                .caller,
            ForwardCaller::Owner
        );
        let header = headers[FORWARD_CONTEXT_HEADER].clone();
        headers.append(FORWARD_CONTEXT_HEADER, header);
        assert!(parse_forward_context(&headers, &start).is_err());
    }
}
