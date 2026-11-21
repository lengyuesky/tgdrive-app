use crate::{
    Error, EventStream, Result, UnixHostClient,
    client::{incoming_stream, retry_delay, retryable},
    collect_bytes, decode_json,
};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use std::{
    collections::{BTreeSet, VecDeque},
    pin::Pin,
    task::{Context, Poll},
};
use tgdrive_contract::{
    ErrorResponse,
    events::HostEvent,
    http::{MAX_EVENT_JOURNAL_ENTRIES, MAX_JSON_RESPONSE_BYTES},
};
use tokio::{sync::mpsc, task::JoinHandle};

/// SSE 行可以横跨任意网络块，CRLF 的两字节也可以分开到达。
#[derive(Default)]
pub(crate) struct Decoder {
    pending: Vec<u8>,
    data: String,
    id: Option<String>,
}
impl Decoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<(String, String)>> {
        self.pending.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some(index) = self
            .pending
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r')
        {
            let cr = self.pending[index] == b'\r';
            if cr && index + 1 == self.pending.len() {
                break;
            }
            let line = String::from_utf8(self.pending[..index].to_vec())
                .map_err(|_| Error::Protocol("SSE 不是 UTF-8"))?;
            let length = index + 1 + usize::from(cr && self.pending.get(index + 1) == Some(&b'\n'));
            self.pending.drain(..length);
            if line.is_empty() {
                if !self.data.is_empty() {
                    frames.push((
                        self.id.clone().unwrap_or_default(),
                        std::mem::take(&mut self.data),
                    ));
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((&line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "data" => {
                    if !self.data.is_empty() {
                        self.data.push('\n');
                    }
                    self.data.push_str(value);
                }
                "id" if !value.contains('\0') => self.id = Some(value.into()),
                _ => {}
            }
            if self.data.len() as u64 > MAX_JSON_RESPONSE_BYTES {
                return Err(Error::Protocol("SSE 帧过大"));
            }
        }
        if self.pending.len() as u64 > MAX_JSON_RESPONSE_BYTES {
            return Err(Error::Protocol("SSE 行过大"));
        }
        Ok(frames)
    }
}

struct Subscription {
    receiver: mpsc::Receiver<Result<HostEvent>>,
    task: JoinHandle<()>,
}
impl Stream for Subscription {
    type Item = Result<HostEvent>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx)
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(crate) async fn subscribe(
    client: UnixHostClient,
    cursor: Option<String>,
) -> Result<EventStream> {
    let (sender, receiver) = mpsc::channel(MAX_EVENT_JOURNAL_ENTRIES as usize);
    let task = tokio::spawn(async move {
        if let Err(error) = run(client, cursor, &sender).await {
            let _ = sender.send(Err(error)).await;
        }
    });
    Ok(Box::pin(Subscription { receiver, task }))
}

async fn run(
    client: UnixHostClient,
    mut cursor: Option<String>,
    sender: &mpsc::Sender<Result<HostEvent>>,
) -> Result<()> {
    let mut seen = BTreeSet::new();
    let mut recent = VecDeque::new();
    let mut failures = 0;
    loop {
        let raw = match client.event_response(cursor.as_deref()).await {
            Ok(raw) => raw,
            Err(error) if retryable(&error) && failures < 5 => {
                tokio::time::sleep(retry_delay(&error, failures.min(2))).await;
                failures += 1;
                continue;
            }
            Err(error) => return Err(error),
        };
        let status = raw.response.status().as_u16();
        if status != 200 {
            let bytes = collect_bytes(
                incoming_stream(raw.response.into_body(), raw.permit),
                MAX_JSON_RESPONSE_BYTES,
            )
            .await?;
            let response: ErrorResponse = decode_json(&bytes)?;
            let error = Error::Api {
                status,
                error: response.error,
            };
            if retryable(&error) && failures < 5 {
                tokio::time::sleep(retry_delay(&error, failures.min(2))).await;
                failures += 1;
                continue;
            }
            return Err(error);
        }
        if raw
            .response
            .headers()
            .get("Content-Type")
            .and_then(|value| value.to_str().ok())
            .is_none_or(|value| value.split(';').next() != Some("text/event-stream"))
        {
            return Err(Error::Protocol("事件流 Content-Type 无效"));
        }
        let mut body = incoming_stream(raw.response.into_body(), raw.permit);
        let mut decoder = Decoder::default();
        let mut interrupted = Error::Transport;
        while let Some(chunk) = body.next().await {
            let chunk: Bytes = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    interrupted = error;
                    break;
                }
            };
            for (id, data) in decoder.feed(&chunk)? {
                let event: HostEvent = decode_json(data.as_bytes())?;
                if id != event.cursor || id.is_empty() {
                    return Err(Error::Protocol("SSE id 与事件游标不符"));
                }
                // 不解析未知业务 data，但仍推进恢复游标。
                cursor = Some(event.cursor.clone());
                failures = 0;
                if !seen.insert(event.cursor.clone()) {
                    continue;
                }
                recent.push_back(event.cursor.clone());
                if recent.len() > MAX_EVENT_JOURNAL_ENTRIES as usize {
                    seen.remove(&recent.pop_front().unwrap());
                }
                if sender.send(Ok(event)).await.is_err() {
                    return Ok(());
                }
            }
        }
        if failures >= 5 {
            return Err(interrupted);
        }
        tokio::time::sleep(retry_delay(&interrupted, failures.min(2))).await;
        failures += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_utf8_and_crlf_are_preserved() {
        let mut decoder = Decoder::default();
        let source = "id: e1\r\ndata: {\"文字\":\"示例\"}\r\n\r\n".as_bytes();
        let mut output = Vec::new();
        for byte in source {
            output.extend(decoder.feed(&[*byte]).unwrap());
        }
        assert_eq!(output, vec![("e1".into(), "{\"文字\":\"示例\"}".into())]);
    }
}
