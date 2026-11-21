//! 官方客户端实测的影视 JSON 表示；时间戳为毫秒，观看位置固定为整数秒。
use crate::{Application, model::*};
use serde_json::{Value, json};
use tgdrive_backend_sdk::Result;

pub fn resolution(info: &MediaInfo) -> String {
    info.video()
        .and_then(|v| v["height"].as_u64())
        .map(|h| h.to_string())
        .unwrap_or_default()
}
pub fn color(info: &MediaInfo) -> String {
    match info.video().and_then(|v| v["color_transfer"].as_str()) {
        Some("smpte2084") => "HDR10",
        Some("arib-std-b67") => "HLG",
        Some("bt709" | "smpte170m" | "iec61966-2-1") => "SDR",
        _ => "",
    }
    .into()
}
pub fn track_guid(entry: &Entry, stream: &Value) -> String {
    guid(&["track", &entry.media_guid, &stream["index"].to_string()])
}
pub fn poster(entry: &Entry) -> String {
    entry
        .cover
        .as_ref()
        .map(|s| format!("/tgdrive-poster/{s}"))
        .unwrap_or_default()
}
pub fn watched(app: &Application, entry: &Entry) -> Result<bool> {
    let progress = app.db.progress(entry)?;
    let (_, watched) = app.db.flags(&entry.guid)?;
    Ok(if let Some(watched) = watched {
        watched
    } else if entry.kind == "Episode" {
        app.db
            .flags(&entry.season_guid())?
            .1
            .or(app.db.flags(&entry.show_guid)?.1)
            .unwrap_or(progress.completed)
    } else {
        progress.completed
    })
}
pub fn item(app: &Application, entry: &Entry, info: Option<&MediaInfo>) -> Result<Value> {
    let progress = app.db.progress(entry)?;
    let (favorite, _) = app.db.flags(&entry.guid)?;
    let watched = watched(app, entry)?;
    let library = app
        .db
        .libraries()?
        .into_iter()
        .find(|l| entry.libraries.contains(&l.id));
    let library_id = library.as_ref().map(|l| l.id.as_str()).unwrap_or("");
    let parent = if entry.kind == "Episode" {
        entry.season_guid()
    } else {
        library_id.into()
    };
    let poster = poster(entry);
    let mut value = json!({"guid":entry.guid,"title":entry.title,"type":entry.kind,"lan":"zh-CN","tv_title":entry.show_title,"parent_title":"","original_title":"","imdb_id":"","trim_id":"","poster":poster,"posters":poster,"backdrops":"","vote_average":"0","genres":[],"release_date":entry.year,"overview":entry.overview,"is_favorite":u8::from(favorite),"is_watched":u8::from(watched),"watched":u8::from(watched),"watched_ts":progress.ts as u64,"season_number":entry.season,"episode_number":entry.episode,"number_of_seasons":0,"number_of_episodes":0,"local_number_of_episodes":0,"local_number_of_seasons":0});
    value.as_object_mut().unwrap().extend(json!({"can_play":1,"play_error":"","parent_guid":parent,"grand_guid":entry.show_guid,"ancestor_guid":library_id,"ancestor_name":library.as_ref().map(|l|l.name.as_str()).unwrap_or(""),"ancestor_category":library.as_ref().map(|l|if l.kind=="movie"{"Movie"}else{"TV"}).unwrap_or(""),"play_item_guid":entry.guid,"media_guid":entry.media_guid,"duration":info.map(|m|m.duration.round()as u64).unwrap_or(0),"logic_type":0,"single_child_guid":"","file_name":entry.filename,"create_time":entry.added_at,"update_time":entry.timestamp,"first_air_date":"","last_air_date":"","air_date":"","status":"","douban_id":0,"poster_list":if poster.is_empty(){Vec::<String>::new()}else{vec![poster]},"media_stream":{"resolutions":info.map(resolution).filter(|s|!s.is_empty()).into_iter().collect::<Vec<_>>(),"audio_type":null,"color_range_type":info.map(color).filter(|s|!s.is_empty()).into_iter().collect::<Vec<_>>()}}).as_object().unwrap().clone());
    Ok(value)
}
pub fn catalog_item(app: &Application, reference: &str) -> Result<Option<Value>> {
    let Some(catalog) = app.db.catalog(reference)? else {
        return Ok(None);
    };
    let Some(entry) = app.db.entry(&catalog.representative)? else {
        return Ok(None);
    };
    let info = crate::media::cached_sync(app, &entry)?;
    let mut value = item(app, &entry, info.as_ref())?;
    if matches!(catalog.kind.as_str(), "TV" | "Season") {
        let representative=app.db.with(|db|{use crate::database::SqlResult;use rusqlite::OptionalExtension;let group=if catalog.kind=="TV"{"show_guid"}else{"season_guid"};db.query_row(&format!("SELECT e.node_id FROM entries e JOIN cover_states c ON c.media_guid=e.media_guid WHERE e.{group}=?1 AND c.state='ready' ORDER BY e.season,e.episode,e.guid LIMIT 1"),[reference],|r|r.get::<_,String>(0)).optional().app()})?;
        let image = representative
            .map(|id| app.db.entry(&id))
            .transpose()?
            .flatten()
            .map(|e| poster(&e))
            .unwrap_or_default();
        let (favorite, watched) = app.db.flags(reference)?;
        value["guid"] = json!(catalog.guid);
        value["type"] = json!(catalog.kind);
        value["title"] = json!(catalog.title);
        value["parent_guid"] = json!(catalog.parent_guid);
        value["create_time"] = json!(catalog.added_at);
        value["update_time"] = json!(catalog.modified_at);
        value["poster"] = json!(image);
        value["posters"] = json!(image);
        value["poster_list"] = json!(if image.is_empty() {
            Vec::<String>::new()
        } else {
            vec![image]
        });
        value["number_of_episodes"] = json!(catalog.episodes);
        value["local_number_of_episodes"] = json!(catalog.episodes);
        value["number_of_seasons"] = json!(catalog.seasons);
        value["local_number_of_seasons"] = json!(catalog.seasons);
        value["is_favorite"] = json!(u8::from(favorite));
        value["is_watched"] = json!(u8::from(watched.unwrap_or(false)));
        value["watched"] = value["is_watched"].clone();
        value["can_play"] = json!(0);
    }
    Ok(Some(value))
}
pub fn file(entry: &Entry) -> Value {
    json!({"guid":entry.media_guid,"path":entry.path,"file_name":entry.filename,"size":entry.size,"timestamp":entry.timestamp,"type":1,"can_play":1,"play_error":"","create_time":entry.added_at,"update_time":entry.timestamp,"file_birth_time":entry.added_at,"progress_thumb_hash_dir":""})
}
pub fn streams(entry: &Entry, info: &MediaInfo) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let (mut videos, mut audios, mut subtitles) = (Vec::new(), Vec::new(), Vec::new());
    for stream in &info.streams {
        let mut row = stream.as_object().cloned().unwrap_or_default();
        for (key, value) in [
            ("media_guid", json!(entry.media_guid)),
            ("guid", json!(track_guid(entry, stream))),
            ("duration", json!(info.duration.round() as u64)),
            ("create_time", json!(entry.added_at)),
            ("update_time", json!(entry.timestamp)),
            (
                "title",
                json!(stream["tags"]["title"].as_str().unwrap_or("")),
            ),
        ] {
            row.insert(key.into(), value);
        }
        row.insert(
            "bps".into(),
            json!(
                stream["bit_rate"]
                    .as_str()
                    .or_else(|| stream["tags"]["BPS"].as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0)
            ),
        );
        match stream["codec_type"].as_str() {
            Some("video") => {
                if stream["disposition"]["attached_pic"] == 1 {
                    continue;
                }
                row.insert("resolution_type".into(), json!(resolution(info)));
                row.insert("color_range_type".into(), json!(color(info)));
                row.insert("wrapper".into(), json!(info.wrapper));
                row.insert(
                    "progressive".into(),
                    json!(u8::from(stream["field_order"] == "progressive")),
                );
                row.insert(
                    "level".into(),
                    json!(
                        stream["level"]
                            .as_i64()
                            .map(|v| v.to_string())
                            .unwrap_or_default()
                    ),
                );
                let side = stream["side_data_list"].as_array();
                row.insert(
                    "rotation".into(),
                    json!(
                        side.and_then(|l| l.iter().find_map(|s| s["rotation"].as_i64()))
                            .unwrap_or(0)
                    ),
                );
                row.insert(
                    "dv_profile".into(),
                    json!(
                        side.and_then(|l| l.iter().find_map(|s| s["dv_profile"].as_u64()))
                            .unwrap_or(0)
                    ),
                );
                row.insert("ext1".into(), json!(0));
                row.insert("is_bluray".into(), json!(false));
                videos.push(Value::Object(row));
            }
            Some("audio") => {
                row.insert(
                    "audio_type".into(),
                    json!(if stream["channels"] == 2 {
                        "Stereo"
                    } else {
                        ""
                    }),
                );
                row.insert(
                    "language".into(),
                    json!(stream["tags"]["language"].as_str().unwrap_or("und")),
                );
                row.insert(
                    "is_default".into(),
                    json!(stream["disposition"]["default"].as_i64().unwrap_or(0)),
                );
                row.insert("is_fake".into(), json!(false));
                audios.push(Value::Object(row));
            }
            Some("subtitle") => {
                row.insert(
                    "language".into(),
                    json!(stream["tags"]["language"].as_str().unwrap_or("und")),
                );
                row.insert(
                    "is_default".into(),
                    json!(stream["disposition"]["default"].as_i64().unwrap_or(0)),
                );
                row.insert(
                    "forced".into(),
                    json!(stream["disposition"]["forced"].as_i64().unwrap_or(0)),
                );
                row.insert("is_external".into(), json!(0));
                row.insert(
                    "is_bitmap".into(),
                    json!(u8::from(matches!(
                        stream["codec_name"].as_str(),
                        Some("hdmv_pgs_subtitle" | "dvd_subtitle")
                    ))),
                );
                subtitles.push(Value::Object(row));
            }
            _ => {}
        }
    }
    for (index, source) in entry.subtitles.iter().enumerate() {
        let ext = extension(&source.name);
        subtitles.push(json!({"media_guid":entry.media_guid,"guid":source.guid("subtitle"),"title":source.name,"codec_name":if ext=="srt"{"subrip"}else{ext.as_str()},"codec_type":"subtitle","language":"und","forced":0,"index":index,"is_default":0,"is_external":1,"format":ext,"trim_id":"","source_id":"","Source":"","create_time":entry.added_at,"update_time":entry.timestamp,"extra_file":0,"is_bitmap":0,"file_size":source.size}));
    }
    (videos, audios, subtitles)
}
