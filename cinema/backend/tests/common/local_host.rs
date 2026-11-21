//! 仅影视媒体测试用的回环适配器，把内存宿主的有界票据交给真实媒体子进程。
use futures_util::StreamExt;
use hyper::{Request, body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tgdrive_backend_sdk::{
    ByteResponse, ByteStream, Error, EventStream, HostClient, HostFuture, ReadOptions, stream_body,
};
use tgdrive_contract::{data::*, files::*, runtime::*};
use tgdrive_test_host::MemoryHost;

pub struct LocalHost {
    pub memory: MemoryHost,
    pub reads: Arc<AtomicU64>,
    pub requests: Arc<AtomicU64>,
    servers: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}
impl LocalHost {
    pub fn new(memory: MemoryHost) -> Self {
        Self {
            memory,
            reads: Arc::new(AtomicU64::new(0)),
            requests: Arc::new(AtomicU64::new(0)),
            servers: Mutex::new(HashMap::new()),
        }
    }
    pub fn active(&self) -> usize {
        self.servers.lock().unwrap().len()
    }
}
impl Drop for LocalHost {
    fn drop(&mut self) {
        for (_, task) in self.servers.get_mut().unwrap().drain() {
            task.abort();
        }
    }
}
macro_rules! delegate {($(fn $name:ident($($arg:ident:$type:ty),*)->$output:ty;)* )=>{$(fn $name(&self,$($arg:$type),*)->HostFuture<'_,$output>{self.memory.$name($($arg),*)})*};}
impl HostClient for LocalHost {
    delegate! {
        fn runtime_info()->RuntimeInfo; fn scope()->ScopeInfo;
        fn stat(request:NodeReference)->FileNode; fn list(request:ListDirectoryRequest)->DirectoryPage;
        fn query(request:FileQuery)->FilePage; fn directories_with_files(request:DirectoriesWithFilesQuery)->FilePage;
        fn random(request:RandomFilesRequest)->RandomFilesResponse; fn changes(request:FileChangesRequest)->FileChangesPage;
        fn bytes(file:ContentRef,options:ReadOptions)->ByteResponse; fn media_url(request:MediaUrlRequest)->MediaUrl;
        fn ticket_bytes(url:String,options:ReadOptions)->ByteResponse;
        fn create_read_lease(request:CreateReadLeaseRequest)->ReadLease;fn renew_read_lease(id:String,request:CreateReadLeaseRequest)->ReadLease;fn revoke_read_lease(id:String)->();
        fn mutate(key:String,request:FileMutationRequest)->MutationReceipt;fn mutation_receipt(key:String)->MutationReceipt;
        fn create_upload(key:String,request:CreateUploadRequest)->UploadInfo;fn upload_body(id:String,body:ByteStream,length:Option<u64>)->UploadInfo;fn upload_status(id:String)->UploadInfo;fn cancel_upload(id:String)->();
        fn kv_get(key:String)->KvGetResponse;fn kv_put(key:String,request:KvPutRequest)->KvRecord;fn kv_delete(key:String,request:KvDeleteRequest)->();fn kv_list(request:KvListRequest)->KvPage;fn data_usage()->DataUsage;
        fn cache_put(key:String,body:ByteStream,content_type:String,metadata:CachePutMetadata)->CacheEntry;fn cache_get(key:String,options:ReadOptions)->ByteResponse;fn cache_delete(key:String)->();fn cache_lookup(request:CacheLookupRequest)->CacheLookupResponse;
        fn events(cursor:Option<String>)->EventStream;fn keepalive(request:BackendKeepaliveRequest)->();
    }
    fn local_url(&self, request: LocalFileUrlRequest) -> HostFuture<'_, LocalFileUrl> {
        Box::pin(async move {
            let mut ticket = self.memory.local_url(request).await?;
            let original = ticket.url.clone();
            let uri: tgdrive_backend_sdk::http::Uri = original.parse().unwrap();
            let path = uri.path().to_owned();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let address = listener.local_addr()?;
            ticket.url = format!("http://{address}{path}");
            let host = self.memory.clone();
            let reads = self.reads.clone();
            let requests = self.requests.clone();
            let server = tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {accepted=listener.accept()=>{let Ok((socket,_))=accepted else{break;};let(host,original,path,reads,requests)=(host.clone(),original.clone(),path.clone(),reads.clone(),requests.clone());connections.spawn(async move{
                        let service=service_fn(move|request:Request<Incoming>|{let(host,original,path,reads,requests)=(host.clone(),original.clone(),path.clone(),reads.clone(),requests.clone());async move{
                            requests.fetch_add(1,Ordering::Relaxed);
                            let result=if request.uri().path()!=path||!matches!(request.method().as_str(),"GET"|"HEAD"){Err(Error::Protocol("媒体测试路径不匹配"))}else{host.read_ticket(original,ReadOptions{head:request.method()=="HEAD",range:request.headers().get("Range").and_then(|h|h.to_str().ok()).map(str::to_owned),..Default::default()})};
                            let response=match result{Ok(response)=>{let mut output=tgdrive_backend_sdk::http::Response::builder().status(response.status).body(stream_body(Box::pin(response.body.map(move|chunk|{if let Ok(bytes)=&chunk{reads.fetch_add(bytes.len()as u64,Ordering::Relaxed);}chunk})))).unwrap();*output.headers_mut()=response.headers;output},Err(error)=>error.response("media-test")};Ok::<_,std::convert::Infallible>(response)
                        }});
                        let _=http1::Builder::new().serve_connection(TokioIo::new(socket),service).await;
                    });},_=connections.join_next(),if !connections.is_empty()=>{}}
                }
            });
            self.servers
                .lock()
                .unwrap()
                .insert(ticket.id.clone(), server);
            Ok(ticket)
        })
    }
    fn revoke_local_url(&self, id: String) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.memory.revoke_local_url(id.clone()).await?;
            if let Some(server) = self.servers.lock().unwrap().remove(&id) {
                server.abort();
            }
            Ok(())
        })
    }
}
