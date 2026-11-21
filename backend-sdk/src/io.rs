use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tgdrive_contract::http::STREAM_IDLE_TIMEOUT_SECONDS;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    time::{Instant, Sleep},
};

/// 网络读写分别按“连续没有实际字节”计时，不把大上传误判成普通控制总超时。
pub(crate) struct IdleIo<T> {
    inner: T,
    read: Timer,
    write: Timer,
}
struct Timer {
    sleep: Pin<Box<Sleep>>,
    waiting: bool,
}
impl Timer {
    fn new() -> Self {
        Self {
            sleep: Box::pin(tokio::time::sleep(Duration::from_secs(
                STREAM_IDLE_TIMEOUT_SECONDS,
            ))),
            waiting: false,
        }
    }
    fn progress(&mut self) {
        self.waiting = false;
    }
    fn pending(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if !self.waiting {
            self.waiting = true;
            self.sleep
                .as_mut()
                .reset(Instant::now() + Duration::from_secs(STREAM_IDLE_TIMEOUT_SECONDS));
        }
        match self.sleep.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "应用字节通道空闲超时",
            ))),
            Poll::Pending => Poll::Pending,
        }
    }
}
impl<T> IdleIo<T> {
    pub fn new(inner: T) -> Self {
        Self {
            inner,
            read: Timer::new(),
            write: Timer::new(),
        }
    }
}
impl<T: AsyncRead + Unpin> AsyncRead for IdleIo<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buffer.filled().len();
        match Pin::new(&mut this.inner).poll_read(cx, buffer) {
            Poll::Ready(result) => {
                if buffer.filled().len() > before {
                    this.read.progress();
                }
                Poll::Ready(result)
            }
            Poll::Pending => this.read.pending(cx),
        }
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for IdleIo<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_write(cx, buffer) {
            Poll::Ready(result) => {
                if result.as_ref().is_ok_and(|bytes| *bytes > 0) {
                    this.write.progress();
                }
                Poll::Ready(result)
            }
            Poll::Pending => match this.write.pending(cx) {
                Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
                _ => Poll::Pending,
            },
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_flush(cx) {
            Poll::Ready(result) => Poll::Ready(result),
            Poll::Pending => this.write.pending(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}
