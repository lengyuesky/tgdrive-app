//! 直传替身的开始/结束与窗口规则，不需要真实宿主或监听器。
use futures_util::StreamExt;
use tgdrive_backend_sdk::{HostClient, ReadOptions, http::Method};
use tgdrive_contract::{
    ByteCount, Timestamp,
    events::event_name,
    files::*,
    manifest::FilePermissions,
    runtime::{AppIdentity, RuntimeCaller},
};
use tgdrive_test_host::{MemoryConfig, MemoryHost, SeedNode};

fn host() -> MemoryHost {
    MemoryHost::new(MemoryConfig {
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
            name: "file.bin".into(),
            kind: NodeKind::File,
            bytes: vec![7; 200_000],
            thumbnail: None,
        }],
        caller: RuntimeCaller::Backend,
        now: Timestamp(1),
        has_backend: true,
    })
    .unwrap()
}
async fn directive(host: &MemoryHost) -> StreamDirective {
    let node = host
        .stat(NodeReference::Id {
            id: "2".into(),
            content_version: None,
        })
        .await
        .unwrap();
    let lease = host
        .create_read_lease(CreateReadLeaseRequest { ttl_seconds: 60 })
        .await
        .unwrap();
    StreamDirective {
        file: ContentRef {
            id: "2".into(),
            content_version: node.content_version.unwrap(),
        },
        window: None,
        range: RangePolicy::Client,
        disposition: Disposition::Inline,
        filename: None,
        content_type: None,
        cache: StreamCachePolicy::NoStore,
        lease_id: Some(lease.id),
        correlation_id: Some("play-1".into()),
    }
}
#[tokio::test]
async fn direct_events_require_consumed_nonempty_get_and_revocation_finishes_it() {
    let host = host();
    let directive = directive(&host).await;
    let cursor = host.events_snapshot(None).unwrap()[0].cursor.clone();
    let mut response = host
        .direct_stream(
            Method::GET,
            directive.clone(),
            ReadOptions::default(),
            "request-1".into(),
        )
        .unwrap();
    assert!(
        host.events_snapshot(Some(cursor.clone()))
            .unwrap()
            .is_empty()
    );
    assert_eq!(response.body.next().await.unwrap().unwrap().len(), 65536);
    assert_eq!(
        host.events_snapshot(Some(cursor.clone()))
            .unwrap()
            .iter()
            .filter(|e| e.event == event_name::STREAM_STARTED)
            .count(),
        1
    );
    host.revoke_read_lease(directive.lease_id.unwrap())
        .await
        .unwrap();
    assert!(response.body.next().await.unwrap().is_err());
    let events = host.events_snapshot(Some(cursor)).unwrap();
    assert_eq!(events.last().unwrap().event, event_name::STREAM_FINISHED);
    assert_eq!(events.last().unwrap().data["bytes_sent"], "65536");
}
#[tokio::test]
async fn head_304_and_window_coordinates_do_not_fake_starts() {
    let host = host();
    let mut directive = directive(&host).await;
    directive.window = Some(ByteWindow {
        offset: ByteCount(100),
        length: ByteCount(200),
    });
    let cursor = host.events_snapshot(None).unwrap()[0].cursor.clone();
    let mut head = host
        .direct_stream(
            Method::HEAD,
            directive.clone(),
            ReadOptions {
                range: Some("bytes=2-4".into()),
                ..Default::default()
            },
            "head".into(),
        )
        .unwrap();
    assert_eq!(head.status, 206);
    assert_eq!(head.headers["Content-Range"], "bytes 2-4/200");
    assert!(head.body.next().await.is_none());
    let mut cached = host
        .direct_stream(
            Method::GET,
            directive.clone(),
            ReadOptions {
                if_none_match: Some(head.headers["ETag"].to_str().unwrap().into()),
                ..Default::default()
            },
            "cached".into(),
        )
        .unwrap();
    assert_eq!(cached.status, 304);
    assert!(cached.body.next().await.is_none());
    assert!(
        host.events_snapshot(Some(cursor.clone()))
            .unwrap()
            .is_empty()
    );
    let mut get = host
        .direct_stream(
            Method::GET,
            directive,
            ReadOptions {
                range: Some("bytes=2-4".into()),
                ..Default::default()
            },
            "get".into(),
        )
        .unwrap();
    assert_eq!(get.body.next().await.unwrap().unwrap().as_ref(), &[7, 7, 7]);
    assert!(get.body.next().await.is_none());
    let events = host.events_snapshot(Some(cursor)).unwrap();
    assert_eq!(events[0].data["range"]["offset"], "102");
    assert_eq!(events[0].data["range"]["length"], "3");
    assert_eq!(events[1].data["outcome"], "completed");
}
