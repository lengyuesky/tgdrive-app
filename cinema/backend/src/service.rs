//! 影视登录会话、播放会话和通用读取租约分别管理；详情查询不取得播放权威。
use crate::{
    database::Database,
    model::{Entry, guid, now, random_id},
};
use std::{collections::HashMap, sync::Mutex, time::Instant};
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::{error_code, events::StreamStartedEvent, files::ReadLease};
use tokio_util::sync::CancellationToken;

const LOGIN_TTL: i64 = 6 * 60 * 60 * 1000;
#[derive(Clone)]
pub struct Session {
    pub lease: ReadLease,
    pub cancel: CancellationToken,
    pub expires_at: i64,
    pub epoch: i64,
}
#[derive(Clone)]
struct Play {
    correlation: String,
    serial: Option<i64>,
    link: Option<String>,
    ended: bool,
    ambiguous: bool,
}
struct State {
    epoch: i64,
    cancel: CancellationToken,
    sessions: HashMap<String, Session>,
    plays: HashMap<(String, String), Play>,
    links: HashMap<(String, String), (String, i64)>,
    correlations: HashMap<String, (String, String)>,
    foreground: HashMap<String, String>,
    login_window: Instant,
    login_count: u16,
    background: Option<CancellationToken>,
}
pub struct Service {
    state: Mutex<State>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                epoch: 1,
                cancel: CancellationToken::new(),
                sessions: HashMap::new(),
                plays: HashMap::new(),
                links: HashMap::new(),
                correlations: HashMap::new(),
                foreground: HashMap::new(),
                login_window: Instant::now(),
                login_count: 0,
                background: None,
            }),
        }
    }
}
impl Service {
    pub fn epoch(&self) -> i64 {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).epoch
    }
    pub fn login_budget(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.login_window.elapsed().as_secs() >= 60 {
            state.login_window = Instant::now();
            state.login_count = 0;
        }
        state.login_count = state.login_count.saturating_add(1);
        if state.login_count > 20 {
            return Err(Error::api(
                error_code::RATE_LIMITED,
                "影视登录过于频繁，请一分钟后重试",
            ));
        }
        if state.sessions.len() >= 32 {
            return Err(Error::api(
                error_code::QUOTA_EXCEEDED,
                "影视登录会话已达到 32 个，请退出旧连接",
            ));
        }
        Ok(())
    }
    pub fn login(&self, epoch: i64, lease: ReadLease) -> Result<String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.epoch != epoch {
            return Err(Error::api(error_code::UNAUTHORIZED, "影视登录配置已改变"));
        }
        if state.sessions.len() >= 32 {
            return Err(Error::api(error_code::QUOTA_EXCEEDED, "影视登录会话已满"));
        }
        let token = format!(
            "{:032x}{:016x}",
            rand::random::<u128>(),
            rand::random::<i64>()
        );
        let session = Session {
            lease,
            cancel: state.cancel.child_token(),
            expires_at: now() + LOGIN_TTL,
            epoch,
        };
        state.sessions.insert(token.clone(), session);
        Ok(token)
    }
    pub fn authenticate(&self, token: &str) -> Result<Session> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .sessions
            .get(token)
            .filter(|s| s.epoch == state.epoch && !s.cancel.is_cancelled() && s.expires_at > now())
            .cloned()
            .ok_or_else(|| Error::api(error_code::UNAUTHORIZED, "请使用影视连接账号登录"))
    }
    pub fn invalidate(&self) -> Vec<String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.cancel.cancel();
        state.epoch = state.epoch.wrapping_add(1);
        state.cancel = CancellationToken::new();
        if let Some(background) = state.background.take() {
            background.cancel();
        }
        let leases = state.sessions.drain().map(|(_, s)| s.lease.id).collect();
        state.plays.clear();
        state.links.clear();
        state.correlations.clear();
        state.foreground.clear();
        leases
    }
    pub fn logout(&self, token: &str) -> Option<String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let session = state.sessions.remove(token)?;
        session.cancel.cancel();
        state.plays.retain(|(t, _), _| t != token);
        state.links.retain(|(t, _), _| t != token);
        state.correlations.retain(|_, (t, _)| t != token);
        Some(session.lease.id)
    }
    pub fn expired(&self) -> Vec<String> {
        let tokens: Vec<_> = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .iter()
            .filter(|(_, s)| s.expires_at <= now())
            .map(|(t, _)| t.clone())
            .collect();
        tokens.iter().filter_map(|t| self.logout(t)).collect()
    }
    pub fn select(&self, token: &str, media: &str) -> Result<()> {
        self.authenticate(token)?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.plays.retain(|_, p| !p.ended);
        let key = (token.into(), media.into());
        if state.plays.len() >= 128 && !state.plays.contains_key(&key) {
            return Err(Error::api(
                error_code::QUOTA_EXCEEDED,
                "进行中的播放会话过多",
            ));
        }
        let previous = state.plays.get(&key);
        let ambiguous =
            previous.is_some_and(|p| p.serial.is_some() && p.link.is_none() && !p.ended);
        let correlation = random_id();
        state.plays.insert(
            key.clone(),
            Play {
                correlation: correlation.clone(),
                serial: None,
                link: None,
                ended: false,
                ambiguous,
            },
        );
        state.correlations.retain(|_, owner| owner != &key);
        state.correlations.insert(correlation, key);
        Ok(())
    }
    pub fn correlation(&self, token: &str, entry: &Entry) -> Result<String> {
        self.authenticate(token)?;
        let key = (token.into(), entry.media_guid.clone());
        let existing = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .plays
            .get(&key)
            .filter(|p| !p.ended)
            .map(|p| p.correlation.clone());
        if let Some(correlation) = existing {
            return Ok(correlation);
        }
        self.select(token, &entry.media_guid)?;
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .plays
            .get(&key)
            .map(|p| p.correlation.clone())
            .ok_or(Error::Cancelled)
    }
    pub fn started(
        &self,
        database: &Database,
        event: &StreamStartedEvent,
        occurred_at: i64,
    ) -> Result<bool> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(key) = state.correlations.get(&event.correlation_id).cloned() else {
            return Ok(false);
        };
        let Some(session) = state.sessions.get(&key.0) else {
            return Ok(false);
        };
        if session.cancel.is_cancelled()
            || session.expires_at <= now()
            || event.lease_id.as_deref() != Some(session.lease.id.as_str())
        {
            return Ok(false);
        }
        let entry = database
            .entry(&key.1)?
            .ok_or_else(|| Error::api(error_code::NOT_FOUND, "直传条目已不在索引中"))?;
        if entry.file() != event.file || event.range.length.0 == 0 {
            return Ok(false);
        }
        if let Some(task) = &state.background {
            task.cancel();
        }
        state
            .foreground
            .insert(event.request_id.clone(), event.correlation_id.clone());
        if let Some(play) = state.plays.get_mut(&key)
            && !play.ended
            && play.correlation == event.correlation_id
            && play.serial.is_none()
        {
            play.serial = database.activate_at(&key.1, occurred_at)?;
            if play.serial.is_none() {
                play.ended = true;
            }
            return Ok(play.serial.is_some());
        }
        Ok(false)
    }
    pub fn finished(&self, request: &str) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .foreground
            .remove(request);
    }
    pub fn bind_link(&self, token: &str, media: &str, link: &str) -> Result<Option<i64>> {
        self.authenticate(token)?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let key = (token.into(), media.into());
        let Some(play) = state.plays.get(&key).cloned() else {
            return Ok(None);
        };
        let Some(serial) = play.serial.filter(|_| !play.ended && !play.ambiguous) else {
            return Ok(None);
        };
        let link_key = (token.into(), guid(&["play-link", link]));
        if let Some((old_media, old_serial)) = state.links.get(&link_key) {
            return Ok((old_media == media && *old_serial == serial).then_some(serial));
        }
        if play.link.is_some() {
            return Ok(None);
        }
        if state.links.len() >= 512 {
            return Err(Error::api(
                error_code::QUOTA_EXCEEDED,
                "播放关联达到上限，请重新登录影视账号",
            ));
        }
        state.links.insert(link_key.clone(), (media.into(), serial));
        state.plays.get_mut(&key).unwrap().link = Some(link_key.1);
        Ok(Some(serial))
    }
    pub fn quit(&self, token: &str, link: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let key = (token.into(), guid(&["play-link", link]));
        if let Some((media, serial)) = state.links.get(&key).cloned()
            && let Some(play) = state.plays.get_mut(&(token.into(), media))
            && play.serial == Some(serial)
        {
            play.ended = true;
        }
    }
    pub fn background(&self) -> Option<CancellationToken> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.foreground.is_empty() {
            return None;
        }
        let cancel = state.cancel.child_token();
        state.background = Some(cancel.clone());
        Some(cancel)
    }
    pub fn pause_background(&self) {
        if let Some(task) = &self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .background
        {
            task.cancel();
        }
    }
}
