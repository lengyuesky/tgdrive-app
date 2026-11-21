#![allow(dead_code)]
//! 只包装共享 MemoryHost 来注入传输故障与并发修改，不重写宿主语义。
use futures_util::StreamExt;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tgdrive_backend_sdk::{
    ByteResponse, ByteStream, Error, EventStream, HostClient, HostFuture, ReadOptions, Result,
};
use tgdrive_contract::{data::*, files::*, runtime::*};
use tgdrive_test_host::MemoryHost;

pub type MutationHook = Arc<dyn Fn(&FileMutationRequest, &MemoryHost) -> Result<()> + Send + Sync>;
pub type MutationFilter = Arc<dyn Fn(&FileMutationRequest) -> bool + Send + Sync>;
pub type MutationBlock = (
    MutationFilter,
    Arc<tokio::sync::Notify>,
    Arc<tokio::sync::Notify>,
);
pub type QueryHook = Arc<dyn Fn(&FileQuery, &MemoryHost) + Send + Sync>;
pub type BodyHook = Arc<dyn Fn(&str, &MemoryHost) + Send + Sync>;
pub type BodyBlock = (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);
pub struct SpyHost {
    pub memory: MemoryHost,
    pub events: Mutex<Vec<String>>,
    pub queries: AtomicUsize,
    pub lists: AtomicUsize,
    pub before_mutate: Mutex<Option<MutationHook>>,
    pub fail_after: Mutex<Option<MutationFilter>>,
    pub fail_before: Mutex<Option<MutationFilter>>,
    pub hide_receipts: AtomicBool,
    pub block_mutation: Mutex<Option<MutationBlock>>,
    pub before_query: Mutex<Option<QueryHook>>,
    pub before_body: Mutex<Option<BodyHook>>,
    pub block_body: Mutex<Option<BodyBlock>>,
    pub keepalives: AtomicUsize,
}
impl SpyHost {
    pub fn new(memory: MemoryHost) -> Self {
        Self {
            memory,
            events: Mutex::new(Vec::new()),
            queries: AtomicUsize::new(0),
            lists: AtomicUsize::new(0),
            before_mutate: Mutex::new(None),
            fail_after: Mutex::new(None),
            fail_before: Mutex::new(None),
            hide_receipts: AtomicBool::new(false),
            block_mutation: Mutex::new(None),
            before_query: Mutex::new(None),
            before_body: Mutex::new(None),
            block_body: Mutex::new(None),
            keepalives: AtomicUsize::new(0),
        }
    }
}
macro_rules! pass {
    ($( $name:ident($($argument:ident:$kind:ty),*) -> $output:ty; )*)=>{
        $( fn $name(&self,$($argument:$kind),*) -> HostFuture<'_,$output> { self.memory.$name($($argument),*) } )*
    }
}
impl HostClient for SpyHost {
    pass! {
        runtime_info()->RuntimeInfo;
        scope()->ScopeInfo;
        stat(request:NodeReference)->FileNode;
        directories_with_files(request:DirectoriesWithFilesQuery)->FilePage;
        random(request:RandomFilesRequest)->RandomFilesResponse;
        changes(request:FileChangesRequest)->FileChangesPage;
        bytes(file:ContentRef,options:ReadOptions)->ByteResponse;
        ticket_bytes(url:String,options:ReadOptions)->ByteResponse;
        media_url(request:MediaUrlRequest)->MediaUrl;
        local_url(request:LocalFileUrlRequest)->LocalFileUrl;
        revoke_local_url(id:String)->();
        create_read_lease(request:CreateReadLeaseRequest)->ReadLease;
        renew_read_lease(id:String,request:CreateReadLeaseRequest)->ReadLease;
        revoke_read_lease(id:String)->();
        upload_status(id:String)->UploadInfo;
        cancel_upload(id:String)->();
        kv_get(key:String)->KvGetResponse;
        kv_put(key:String,request:KvPutRequest)->KvRecord;
        kv_delete(key:String,request:KvDeleteRequest)->();
        kv_list(request:KvListRequest)->KvPage;
        data_usage()->DataUsage;
        cache_put(key:String,body:ByteStream,content_type:String,metadata:CachePutMetadata)->CacheEntry;
        cache_get(key:String,options:ReadOptions)->ByteResponse;
        cache_delete(key:String)->();
        cache_lookup(request:CacheLookupRequest)->CacheLookupResponse;
        events(cursor:Option<String>)->EventStream;
    }
    fn query(&self, request: FileQuery) -> HostFuture<'_, FilePage> {
        self.queries.fetch_add(1, Ordering::SeqCst);
        self.events.lock().unwrap().push(format!(
            "query:{}",
            request.cursor.as_deref().unwrap_or("first")
        ));
        if let Some(hook) = self.before_query.lock().unwrap().clone() {
            hook(&request, &self.memory);
        }
        self.memory.query(request)
    }
    fn list(&self, request: ListDirectoryRequest) -> HostFuture<'_, DirectoryPage> {
        self.lists.fetch_add(1, Ordering::SeqCst);
        self.memory.list(request)
    }
    fn mutate(&self, key: String, request: FileMutationRequest) -> HostFuture<'_, MutationReceipt> {
        Box::pin(async move {
            self.events.lock().unwrap().push(format!("mutate:{key}"));
            let hook = self.before_mutate.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook(&request, &self.memory)?;
            }
            let block = self.block_mutation.lock().unwrap().clone();
            if let Some((filter, entered, release)) = block
                && filter(&request)
            {
                entered.notify_one();
                release.notified().await;
            }
            let fail_before = self.fail_before.lock().unwrap().clone();
            if fail_before.is_some_and(|filter| filter(&request)) {
                return Err(Error::Transport);
            }
            let receipt = self.memory.mutate(key, request.clone()).await?;
            let fail_after = self.fail_after.lock().unwrap().clone();
            if fail_after.is_some_and(|filter| filter(&request)) {
                return Err(Error::Transport);
            }
            Ok(receipt)
        })
    }
    fn mutation_receipt(&self, key: String) -> HostFuture<'_, MutationReceipt> {
        if self.hide_receipts.load(Ordering::SeqCst) {
            Box::pin(async {
                Err(Error::api(
                    tgdrive_contract::error_code::NOT_FOUND,
                    "合成回执暂时不可达",
                ))
            })
        } else {
            self.memory.mutation_receipt(key)
        }
    }
    fn create_upload(
        &self,
        key: String,
        request: CreateUploadRequest,
    ) -> HostFuture<'_, UploadInfo> {
        self.events.lock().unwrap().push(format!("upload:{key}"));
        self.memory.create_upload(key, request)
    }
    fn upload_body(
        &self,
        id: String,
        body: ByteStream,
        length: Option<u64>,
    ) -> HostFuture<'_, UploadInfo> {
        if let Some(hook) = self.before_body.lock().unwrap().clone() {
            hook(&id, &self.memory);
        }
        let block = self.block_body.lock().unwrap().take();
        let body: ByteStream = if let Some((entered, release)) = block {
            Box::pin(futures_util::stream::unfold(
                (body, false),
                move |(mut body, started)| {
                    let entered = entered.clone();
                    let release = release.clone();
                    async move {
                        if !started {
                            entered.notify_one();
                            release.notified().await;
                        }
                        body.next().await.map(|chunk| (chunk, (body, true)))
                    }
                },
            ))
        } else {
            body
        };
        self.memory.upload_body(id, body, length)
    }
    fn keepalive(&self, request: BackendKeepaliveRequest) -> HostFuture<'_, ()> {
        self.keepalives.fetch_add(1, Ordering::SeqCst);
        self.memory.keepalive(request)
    }
}
