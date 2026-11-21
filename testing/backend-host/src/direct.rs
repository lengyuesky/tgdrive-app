//! 仅测试的原文件直传执行器：复用字节计划，按真实流消费发出开始/结束事件。
use super::*;
use tgdrive_contract::{
    ByteCount,
    events::{StreamFinishedEvent, StreamOutcome, StreamStartedEvent},
};

struct Transfer {
    host: MemoryHost,
    request_id: String,
    correlation_id: String,
    file: ContentRef,
    range: ByteWindow,
    lease_id: Option<String>,
    bytes_sent: u64,
    started: bool,
    finished: bool,
}
impl Transfer {
    fn start(&mut self) {
        if self.started {
            return;
        }
        self.started = true;
        let event = StreamStartedEvent {
            request_id: self.request_id.clone(),
            correlation_id: self.correlation_id.clone(),
            file: self.file.clone(),
            range: self.range.clone(),
            lease_id: self.lease_id.clone(),
        };
        let _ = self.host.apply(false, |state| {
            state.emit(event_name::STREAM_STARTED, serde_json::to_value(event)?);
            Ok(())
        });
    }
    fn finish(&mut self, outcome: StreamOutcome) {
        if !self.started || self.finished {
            return;
        }
        self.finished = true;
        let event = StreamFinishedEvent {
            request_id: self.request_id.clone(),
            correlation_id: self.correlation_id.clone(),
            file: self.file.clone(),
            bytes_sent: ByteCount(self.bytes_sent),
            outcome,
            error_code: None,
        };
        let _ = self.host.apply(false, |state| {
            state.emit(event_name::STREAM_FINISHED, serde_json::to_value(event)?);
            Ok(())
        });
    }
}
impl Drop for Transfer {
    fn drop(&mut self) {
        self.finish(StreamOutcome::Cancelled);
    }
}

impl MemoryHost {
    /// 测试代码执行后端控制指令；不是 HostClient 能力，不监听网络，也不启动宿主。
    pub fn direct_stream(
        &self,
        method: tgdrive_backend_sdk::http::Method,
        directive: StreamDirective,
        mut options: ReadOptions,
        request_id: String,
    ) -> Result<ByteResponse> {
        self.backend()?;
        if !matches!(
            method,
            tgdrive_backend_sdk::http::Method::GET | tgdrive_backend_sdk::http::Method::HEAD
        ) {
            return Err(Error::api(
                error_code::INVALID_BACKEND_RESPONSE,
                "直传仅允许 GET/HEAD",
            ));
        }
        options.head = method == tgdrive_backend_sdk::http::Method::HEAD;
        if directive.range == RangePolicy::Ignore {
            options.range = None;
        }
        let plan = self.apply(true, |state| {
            let size = state.content(&directive.file)?.node.size.0;
            validate_stream_directive(&directive, size)?;
            if let Some(id) = &directive.lease_id {
                data::lease(state, id)?;
            }
            let window = directive.window.clone().unwrap_or(ByteWindow {
                offset: ByteCount(0),
                length: ByteCount(size),
            });
            let etag = if directive.window.is_some() {
                format!(
                    "\"v{}:{}:{}\"",
                    directive.file.content_version, window.offset.0, window.length.0
                )
            } else {
                format!("\"v{}\"", directive.file.content_version)
            };
            let mut plan = data::plan(
                data::Source::File(directive.file.clone(), FileRepresentation::Original),
                window.length.0,
                etag,
                &options,
            )?;
            plan.offset += window.offset.0;
            plan.lease = directive.lease_id.clone();
            if directive.range == RangePolicy::Ignore {
                plan.headers
                    .insert("Accept-Ranges", "none".parse().unwrap());
            }
            if let Some(content_type) = &directive.content_type {
                plan.headers.insert(
                    "Content-Type",
                    content_type
                        .parse()
                        .map_err(|_| Error::Protocol("直传 MIME 无效"))?,
                );
            }
            Ok(plan)
        })?;
        let range = ByteWindow {
            offset: ByteCount(plan.offset),
            length: ByteCount(plan.length),
        };
        let response = self.response(plan);
        let Some(correlation_id) = directive
            .correlation_id
            .filter(|_| method == tgdrive_backend_sdk::http::Method::GET && range.length.0 > 0)
        else {
            return Ok(response);
        };
        let transfer = Transfer {
            host: self.clone(),
            request_id,
            correlation_id,
            file: directive.file,
            range,
            lease_id: directive.lease_id,
            bytes_sent: 0,
            started: false,
            finished: false,
        };
        let body = Box::pin(stream::unfold(
            Some((response.body, transfer)),
            |state| async {
                let (mut source, mut transfer) = state?;
                match source.next().await {
                    Some(Ok(bytes)) => {
                        if !bytes.is_empty() {
                            transfer.start();
                            transfer.bytes_sent += bytes.len() as u64;
                        }
                        Some((Ok(bytes), Some((source, transfer))))
                    }
                    Some(Err(error)) => {
                        transfer.finish(StreamOutcome::Cancelled);
                        Some((Err(error), None))
                    }
                    None => {
                        transfer.finish(StreamOutcome::Completed);
                        None
                    }
                }
            },
        ));
        Ok(ByteResponse {
            status: response.status,
            headers: response.headers,
            body,
        })
    }
}
