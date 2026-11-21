//! 最小带后端应用：主人配置一个文件，外部客户端用应用自己的 Bearer 鉴权后原文件直传。
//! SQLite 是本应用主动选择的业务依赖，也用于验证交叉构建可以编译内置 C 源码。
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tgdrive_backend_sdk::{Error, HostClient, HttpResponse, Result, http::Method, stream_response};
use tgdrive_contract::{error_code, files::*};

pub struct Application {
    pub host: Arc<dyn HostClient>,
    database: Mutex<Option<Connection>>,
}
#[derive(Serialize, Deserialize)]
pub struct ConfigureRequest {
    pub file: ContentRef,
    pub token: String,
}
#[derive(Serialize, Deserialize)]
pub struct DirectoryRequest {
    pub parent_id: String,
    pub name: String,
    pub idempotency_key: String,
}
#[derive(Serialize)]
pub struct Configuration {
    pub file: Option<ContentRef>,
    pub configured: bool,
}

impl Application {
    pub fn new(host: Arc<dyn HostClient>, connection: Connection) -> Result<Self> {
        connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS configuration (singleton INTEGER PRIMARY KEY CHECK(singleton=1), file_id TEXT NOT NULL, content_version TEXT NOT NULL, token_hash BLOB NOT NULL);")
            .map_err(|_| Error::Protocol("应用数据库初始化失败"))?;
        Ok(Self {
            host,
            database: Mutex::new(Some(connection)),
        })
    }
    pub async fn configure(&self, request: ConfigureRequest) -> Result<Configuration> {
        // 主人页面仍不能绕过目录授权；先用宿主核对可见节点和稳定内容版本。
        self.host
            .stat(NodeReference::Id {
                id: request.file.id.clone(),
                content_version: Some(request.file.content_version.clone()),
            })
            .await?;
        if request.token.len() < 32
            || request.token.len() > 128
            || !request
                .token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        {
            return Err(Error::api(
                error_code::INVALID_REQUEST,
                "应用服务令牌应为至少 32 字节的随机 ASCII 标识",
            ));
        }
        let digest = Sha256::digest(request.token.as_bytes());
        self.database.lock().unwrap().as_ref().ok_or(Error::Protocol("应用正在停止"))?
            .execute("INSERT INTO configuration (singleton,file_id,content_version,token_hash) VALUES (1,?1,?2,?3) ON CONFLICT(singleton) DO UPDATE SET file_id=excluded.file_id,content_version=excluded.content_version,token_hash=excluded.token_hash",params![request.file.id,request.file.content_version,digest.as_slice()])
            .map_err(|_|Error::Protocol("保存应用配置失败"))?;
        self.configuration()
    }
    pub fn configuration(&self) -> Result<Configuration> {
        let file = self
            .database
            .lock()
            .unwrap()
            .as_ref()
            .ok_or(Error::Protocol("应用正在停止"))?
            .query_row(
                "SELECT file_id,content_version FROM configuration WHERE singleton=1",
                [],
                |row| {
                    Ok(ContentRef {
                        id: row.get(0)?,
                        content_version: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(|_| Error::Protocol("读取应用配置失败"))?;
        Ok(Configuration {
            configured: file.is_some(),
            file,
        })
    }
    pub async fn external_file(
        &self,
        method: &Method,
        authorization: Option<&str>,
    ) -> Result<HttpResponse> {
        let token = authorization
            .and_then(|header| header.strip_prefix("Bearer "))
            .ok_or_else(|| Error::api(error_code::UNAUTHORIZED, "缺少应用服务鉴权"))?;
        let config = self
            .database
            .lock()
            .unwrap()
            .as_ref()
            .ok_or(Error::Protocol("应用正在停止"))?
            .query_row(
                "SELECT file_id,content_version,token_hash FROM configuration WHERE singleton=1",
                [],
                |row| {
                    Ok((
                        ContentRef {
                            id: row.get(0)?,
                            content_version: row.get(1)?,
                        },
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| Error::Protocol("读取应用配置失败"))?
            .ok_or_else(|| Error::api(error_code::UNAUTHORIZED, "应用服务尚未配置"))?;
        let digest = Sha256::digest(token.as_bytes());
        if config.1.len() != digest.len()
            || config
                .1
                .iter()
                .zip(digest)
                .fold(0u8, |difference, (a, b)| difference | (a ^ b))
                != 0
        {
            return Err(Error::api(error_code::UNAUTHORIZED, "应用服务鉴权失败"));
        }
        let node = self
            .host
            .stat(NodeReference::Id {
                id: config.0.id.clone(),
                content_version: Some(config.0.content_version.clone()),
            })
            .await?;
        let directive = StreamDirective {
            file: config.0,
            window: None,
            range: RangePolicy::Client,
            disposition: Disposition::Inline,
            filename: Some(node.name),
            content_type: None,
            cache: StreamCachePolicy::NoStore,
            lease_id: None,
            correlation_id: None,
        };
        stream_response(method, &directive, node.size.0)
    }
    pub async fn directory(&self, request: DirectoryRequest) -> Result<MutationReceipt> {
        let parent = self
            .host
            .stat(NodeReference::Id {
                id: request.parent_id.clone(),
                content_version: None,
            })
            .await?;
        let scope = self.host.scope().await?;
        let children_revision = parent
            .children_revision
            .ok_or_else(|| Error::api(error_code::NOT_DIRECTORY, "新建位置不是目录"))?;
        self.host
            .mutate(
                request.idempotency_key,
                FileMutationRequest {
                    scope_revision: scope.revision,
                    assertions: vec![FileAssertion::Children {
                        directory_id: request.parent_id.clone(),
                        children_revision,
                    }],
                    operations: vec![FileOperation::Mkdir {
                        operation_id: "create".into(),
                        parent: DirectoryTarget::Existing {
                            id: request.parent_id,
                        },
                        name: request.name,
                    }],
                },
            )
            .await
    }
    pub fn shutdown(&self) {
        if let Some(connection) = self.database.lock().unwrap().take() {
            let _ = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
            let _ = connection.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tgdrive_contract::{
        Timestamp,
        http::STREAM_DIRECTIVE_HEADER,
        manifest::FilePermissions,
        runtime::{AppIdentity, RuntimeCaller},
    };
    use tgdrive_test_host::{MemoryConfig, MemoryHost, SeedNode};
    fn application() -> Application {
        let host = MemoryHost::new(MemoryConfig {
            app: AppIdentity {
                id: "example-backend".into(),
                name: "示例".into(),
                version: "1.0.0".into(),
                generation: "g1".into(),
            },
            files: FilePermissions {
                read: true,
                write: true,
                ..Default::default()
            },
            scope: DirectoryScope::All {
                access: AccessLevel::ReadWrite,
            },
            nodes: vec![SeedNode {
                id: "2".into(),
                parent_id: "1".into(),
                name: "file.bin".into(),
                kind: NodeKind::File,
                bytes: vec![1, 2, 3],
                thumbnail: None,
            }],
            caller: RuntimeCaller::Backend,
            now: Timestamp(1),
            has_backend: true,
        })
        .unwrap();
        Application::new(Arc::new(host), Connection::open_in_memory().unwrap()).unwrap()
    }
    #[tokio::test]
    async fn external_auth_stream_and_owner_conditional_write() {
        let app = application();
        let node = app
            .host
            .stat(NodeReference::Id {
                id: "2".into(),
                content_version: None,
            })
            .await
            .unwrap();
        let token = "0123456789abcdef0123456789abcdef";
        app.configure(ConfigureRequest {
            file: ContentRef {
                id: node.id,
                content_version: node.content_version.unwrap(),
            },
            token: token.into(),
        })
        .await
        .unwrap();
        assert_eq!(
            app.external_file(&Method::GET, None)
                .await
                .err()
                .unwrap()
                .code(),
            error_code::UNAUTHORIZED
        );
        assert_eq!(
            app.external_file(&Method::GET, Some("Bearer wrong"))
                .await
                .err()
                .unwrap()
                .code(),
            error_code::UNAUTHORIZED
        );
        let response = app
            .external_file(&Method::HEAD, Some(&format!("Bearer {token}")))
            .await
            .unwrap();
        assert_eq!(response.status(), 204);
        assert!(response.headers().contains_key(STREAM_DIRECTIVE_HEADER));
        let receipt = app
            .directory(DirectoryRequest {
                parent_id: "1".into(),
                name: "created".into(),
                idempotency_key: "example-directory-write-key".into(),
            })
            .await
            .unwrap();
        assert_eq!(receipt.results.len(), 1);
        assert_eq!(
            app.host
                .stat(NodeReference::Id {
                    id: receipt.results[0].node_id.clone(),
                    content_version: None
                })
                .await
                .unwrap()
                .kind,
            NodeKind::Directory
        );
        app.shutdown();
    }
}
