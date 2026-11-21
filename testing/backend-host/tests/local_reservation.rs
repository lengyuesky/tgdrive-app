//! 本机读取取消归还未拉取的预留，撤销票据本身中止在途字节。
use futures_util::StreamExt;
use tgdrive_backend_sdk::{HostClient, ReadOptions};
use tgdrive_contract::{
    ByteCount, Timestamp,
    files::*,
    manifest::FilePermissions,
    runtime::{AppIdentity, RuntimeCaller},
};
use tgdrive_test_host::{MemoryConfig, MemoryHost, SeedNode};

#[tokio::test]
async fn local_cancellation_returns_unused_reservation_and_revocation_stops_unleased_flow() {
    let host = MemoryHost::new(MemoryConfig {
        app: AppIdentity {
            id: "test".into(),
            name: "合成".into(),
            version: "1.0.0".into(),
            generation: "g1".into(),
        },
        files: FilePermissions {
            read: true,
            write: false,
            ..Default::default()
        },
        scope: DirectoryScope::All {
            access: AccessLevel::ReadOnly,
        },
        nodes: vec![SeedNode {
            id: "2".into(),
            parent_id: "1".into(),
            name: "video.bin".into(),
            kind: NodeKind::File,
            bytes: vec![7; 200_000],
            thumbnail: None,
        }],
        caller: RuntimeCaller::Backend,
        now: Timestamp(1),
        has_backend: true,
    })
    .unwrap();
    let node = host
        .stat(NodeReference::Id {
            id: "2".into(),
            content_version: None,
        })
        .await
        .unwrap();
    let ticket = host
        .local_url(LocalFileUrlRequest {
            file: ContentRef {
                id: "2".into(),
                content_version: node.content_version.unwrap(),
            },
            ttl_seconds: Some(60),
            byte_budget: Some(ByteCount(150_000)),
            request_budget: Some(8),
            lease_id: None,
        })
        .await
        .unwrap();
    let mut first = host
        .read_ticket(ticket.url.clone(), ReadOptions::default())
        .unwrap();
    assert_eq!(first.headers["Content-Length"], "150000");
    assert_eq!(first.body.next().await.unwrap().unwrap().len(), 65536);
    drop(first);
    let mut second = host
        .read_ticket(ticket.url.clone(), ReadOptions::default())
        .unwrap();
    assert_eq!(second.headers["Content-Length"], "84464");
    assert_eq!(second.body.next().await.unwrap().unwrap().len(), 65536);
    host.revoke_local_url(ticket.id).await.unwrap();
    assert!(second.body.next().await.unwrap().is_err());
}
