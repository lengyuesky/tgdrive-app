//! 仅供 Node 测试库调用的 stdin/stdout 工作进程；不是宿主，不创建套接字或 HTTP 服务。
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use tgdrive_backend_sdk::{
    HostClient, ReadOptions, Result, byte_stream, collect_bytes, decode_json,
};
use tgdrive_contract::{
    ApiError, ErrorResponse, error_http_status, http::MAX_PACKAGE_EXPANDED_BYTES,
};
use tgdrive_test_host::{MemoryHost, SeedNode};

#[derive(Deserialize, serde::Serialize)]
struct Command {
    id: u64,
    method: String,
    #[serde(default)]
    key: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    bytes: Vec<u8>,
    #[serde(default)]
    options: Options,
}
#[derive(Default, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    range: Option<String>,
    if_none_match: Option<String>,
    if_range: Option<String>,
    #[serde(default)]
    head: bool,
}
impl From<Options> for ReadOptions {
    fn from(value: Options) -> Self {
        Self {
            range: value.range,
            if_none_match: value.if_none_match,
            if_range: value.if_range,
            head: value.head,
        }
    }
}
fn args<T: serde::de::DeserializeOwned + serde::Serialize>(value: Value) -> Result<T> {
    decode_json(&serde_json::to_vec(&value)?)
}
async fn binary(response: tgdrive_backend_sdk::ByteResponse) -> Result<Value> {
    let headers = response
        .headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    Ok(
        json!({"status":response.status.as_u16(),"headers":headers,"bytes":collect_bytes(response.body, MAX_PACKAGE_EXPANDED_BYTES).await?.to_vec()}),
    )
}
async fn execute(host: &mut Option<MemoryHost>, command: Command) -> Result<Value> {
    if command.method == "$init" {
        *host = Some(MemoryHost::new(args(command.args)?)?);
        return Ok(Value::Null);
    }
    let host = host.as_ref().ok_or(tgdrive_backend_sdk::Error::Protocol(
        "测试工作进程尚未初始化",
    ))?;
    macro_rules! output {
        ($value:expr) => {
            serde_json::to_value($value).map_err(Into::into)
        };
    }
    match command.method.as_str() {
        "$scope" => output!(host.set_scope(args(command.args)?)?),
        "$add" => output!(host.add_node(args::<SeedNode>(command.args)?)?),
        "$advance" => {
            host.advance(
                command
                    .args
                    .as_i64()
                    .ok_or(tgdrive_backend_sdk::Error::Protocol("测试时间无效"))?,
            )?;
            Ok(Value::Null)
        }
        "$enabled" => {
            host.set_enabled(
                command
                    .args
                    .as_bool()
                    .ok_or(tgdrive_backend_sdk::Error::Protocol("启用参数无效"))?,
            )?;
            Ok(Value::Null)
        }
        "$reinstall" => {
            host.reinstall()?;
            Ok(Value::Null)
        }
        "$restart" => {
            host.restart()?;
            Ok(Value::Null)
        }
        "$events" => output!(host.events_snapshot(command.args.as_str().map(str::to_owned))?),
        "$change" => {
            #[derive(Deserialize, serde::Serialize)]
            struct Change {
                id: String,
                parent: Option<String>,
                name: Option<String>,
                bytes: Option<Vec<u8>>,
                visible: Option<bool>,
            }
            let change: Change = args(command.args)?;
            output!(host.change_node(
                change.id,
                change.parent,
                change.name,
                change.bytes,
                change.visible
            )?)
        }
        "$ticket" => binary(host.read_ticket(command.key, command.options.into())?).await,
        "session.close" => {
            host.close_page_session()?;
            Ok(Value::Null)
        }
        "runtime.info" => output!(host.runtime_info().await?),
        "scope.read" => output!(host.scope().await?),
        "files.stat" => output!(host.stat(args(command.args)?).await?),
        "files.list" => output!(host.list(args(command.args)?).await?),
        "files.query" => output!(host.query(args(command.args)?).await?),
        "files.directories_with_files" => {
            output!(host.directories_with_files(args(command.args)?).await?)
        }
        "files.random" => output!(host.random(args(command.args)?).await?),
        "files.changes" => output!(host.changes(args(command.args)?).await?),
        "files.bytes" => {
            binary(
                host.bytes(args(command.args)?, command.options.into())
                    .await?,
            )
            .await
        }
        "files.media_url" => output!(host.media_url(args(command.args)?).await?),
        "files.local_url" => output!(host.local_url(args(command.args)?).await?),
        "files.local_url.revoke" => {
            host.revoke_local_url(command.key).await?;
            Ok(Value::Null)
        }
        "read_leases.create" => output!(host.create_read_lease(args(command.args)?).await?),
        "read_leases.renew" => output!(
            host.renew_read_lease(command.key, args(command.args)?)
                .await?
        ),
        "read_leases.revoke" => {
            host.revoke_read_lease(command.key).await?;
            Ok(Value::Null)
        }
        "files.mutate" => output!(host.mutate(command.key, args(command.args)?).await?),
        "files.mutate.receipt" => output!(host.mutation_receipt(command.key).await?),
        "files.upload.create" => {
            output!(host.create_upload(command.key, args(command.args)?).await?)
        }
        "files.upload.body" => output!(
            host.upload_body(command.key, byte_stream(command.bytes), None)
                .await?
        ),
        "files.upload.status" => output!(host.upload_status(command.key).await?),
        "files.upload.cancel" => {
            host.cancel_upload(command.key).await?;
            Ok(Value::Null)
        }
        "kv.get" => output!(host.kv_get(command.key).await?),
        "kv.put" => output!(host.kv_put(command.key, args(command.args)?).await?),
        "kv.delete" => {
            host.kv_delete(command.key, args(command.args)?).await?;
            Ok(Value::Null)
        }
        "kv.list" => output!(host.kv_list(args(command.args)?).await?),
        "data.usage" => output!(host.data_usage().await?),
        "cache.put" => {
            #[derive(Deserialize, serde::Serialize)]
            struct Cache {
                content_type: String,
                metadata: tgdrive_contract::data::CachePutMetadata,
            }
            let cache: Cache = args(command.args)?;
            output!(
                host.cache_put(
                    command.key,
                    byte_stream(command.bytes),
                    cache.content_type,
                    cache.metadata
                )
                .await?
            )
        }
        "cache.get" => binary(host.cache_get(command.key, command.options.into()).await?).await,
        "cache.delete" => {
            host.cache_delete(command.key).await?;
            Ok(Value::Null)
        }
        "cache.lookup" => output!(host.cache_lookup(args(command.args)?).await?),
        "backend.keepalive" => {
            host.keepalive(args(command.args)?).await?;
            Ok(Value::Null)
        }
        _ => Err(tgdrive_backend_sdk::Error::Protocol("测试命令不存在")),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    let mut host = None;
    for line in stdin.lock().lines() {
        let line = line?;
        let command: Command = decode_json(line.as_bytes())?;
        let id = command.id;
        let result = match execute(&mut host, command).await {
            Ok(value) => json!({"id":id,"result":value}),
            Err(error) => {
                let status = error_http_status(error.code()).unwrap_or(500);
                let response = ErrorResponse {
                    error: ApiError {
                        code: error.code().into(),
                        message: error.to_string(),
                        request_id: format!("test-{id}"),
                        details: None,
                        retry_after_ms: None,
                    },
                };
                json!({"id":id,"error":{"status":status,"response":response}})
            }
        };
        serde_json::to_writer(&mut stdout, &result)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
