//! 移植人物姓名、角色、排序、跨库作品、剧季集继承和资料即时失效回归。
mod common;
use common::*;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tgdrive_cinema::{covers, database::SqlResult, model::Library};
use tgdrive_contract::files::*;

fn portrait(color: [u8; 3]) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(120, 180, image::Rgb(color));
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85)
        .encode_image(&image)
        .unwrap();
    bytes
}
async fn cast(app: &std::sync::Arc<tgdrive_cinema::Application>, token: &str, id: &str) -> Value {
    let (status, value) = body(
        wire(
            app,
            false,
            "POST",
            &format!("/v/api/v1/person/list/{id}"),
            Some(token),
            json!({"page_size":200}),
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(status, 200, "{value}");
    value["data"].clone()
}
#[tokio::test]
async fn actor_roles_latest_profiles_cross_library_works_and_moved_nfo_fallback() {
    let bio = "完整人物简介。".repeat(4000);
    let old = format!(
        "<movie><actor><name> 演员甲 </name><role>角色甲</role><order>2</order><thumb>旧.jpg</thumb><biography>{bio}</biography></actor><actor><name>演员乙</name><order>0</order></actor><actor><name>演员甲</name><role>角色乙</role></actor><actor><name> </name></actor></movie>"
    );
    let(app,host,_)=configured(vec![root(),seed("3","2","第一部.mp4",NodeKind::File,b"synthetic"),seed("4","2","第一部.nfo",NodeKind::File,old.as_bytes()),seed("5","2","旧.jpg",NodeKind::File,&portrait([220,20,20])),seed("6","1","其它",NodeKind::Directory,b""),seed("7","6","第二部.mp4",NodeKind::File,b"synthetic"),seed("8","6","新.jpg",NodeKind::File,&portrait([20,220,20])),seed("9","6","第二部.nfo",NodeKind::File,"<movie><actor><name>演员甲</name><thumb>新.jpg</thumb><biography>较新人物简介</biography></actor></movie>".as_bytes()),seed("10","6","存档",NodeKind::Directory,b"")],"movie").await;
    let revision = app.db.settings().unwrap().revision;
    app.configure_libraries(
        &revision,
        vec![
            Library {
                id: LIBRARY.into(),
                name: "第一库".into(),
                kind: "movie".into(),
                root_id: "2".into(),
            },
            Library {
                id: "22222222222222222222222222222222".into(),
                name: "重叠库".into(),
                kind: "movie".into(),
                root_id: "2".into(),
            },
            Library {
                id: "33333333333333333333333333333333".into(),
                name: "另一库".into(),
                kind: "movie".into(),
                root_id: "6".into(),
            },
        ],
    )
    .await
    .unwrap();
    app.synchronize(true).await.unwrap();
    let token = login(&app).await;
    let e = app.db.entry("3").unwrap().unwrap();
    let rows = cast(&app, &token, &e.guid).await;
    assert_eq!(rows["total"], 2);
    assert_eq!(rows["list"][0]["name"], "演员乙");
    assert_eq!(rows["list"][0]["profile_path"], "");
    assert_eq!(rows["list"][1]["role"], "角色甲 / 角色乙");
    let id = rows["list"][1]["person_guid"].as_str().unwrap();
    let (_, detail) = body(
        wire(
            &app,
            false,
            "GET",
            &format!("/v/api/v1/person/{id}"),
            Some(&token),
            Value::Null,
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(detail["data"]["biography"], "较新人物简介");
    assert_eq!(detail["data"]["actor_item_total"], 2);
    let image = format!(
        "/v/api/v1/sys/img{}",
        detail["data"]["profile"].as_str().unwrap()
    );
    assert_eq!(
        wire(&app, false, "GET", &image, Some(&token), Value::Null, &[])
            .await
            .status(),
        200
    );
    host.change_node("9".into(), Some("10".into()), None, None, None)
        .unwrap();
    let (_, fallback) = body(
        wire(
            &app,
            false,
            "GET",
            &format!("/v/api/v1/person/{id}"),
            Some(&token),
            Value::Null,
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(fallback["data"]["biography"], bio);
    assert_eq!(fallback["data"]["actor_item_total"], 1);
    assert_eq!(
        wire(&app, false, "GET", &image, Some(&token), Value::Null, &[])
            .await
            .status(),
        404
    );
    host.change_node("4".into(), None, Some("存档.nfo".into()), None, None)
        .unwrap();
    assert_eq!(cast(&app, &token, &e.guid).await["total"], 0);
}
#[tokio::test]
async fn show_season_episode_cast_inheritance_and_guest_works_collapse_to_show() {
    let (app, host, token) = configured(
        vec![
            root(),
            seed("3", "2", "合成剧", NodeKind::Directory, b""),
            seed("4", "3", "Season01", NodeKind::Directory, b""),
            seed("5", "3", "Season02", NodeKind::Directory, b""),
            seed("6", "4", "S01E01.mp4", NodeKind::File, b"video"),
            seed("7", "4", "S01E02.mp4", NodeKind::File, b"video"),
            seed("8", "5", "S02E01.mp4", NodeKind::File, b"video"),
            seed(
                "9",
                "3",
                "tvshow.nfo",
                NodeKind::File,
                "<tvshow><actor><name>剧级演员</name><role>主演</role></actor></tvshow>".as_bytes(),
            ),
            seed(
                "10",
                "4",
                "S01E01.nfo",
                NodeKind::File,
                "<episodedetails><actor><name>单集客串</name></actor></episodedetails>".as_bytes(),
            ),
            seed(
                "11",
                "5",
                "S02E01.nfo",
                NodeKind::File,
                "<episodedetails><actor><name>第二季演员</name></actor></episodedetails>"
                    .as_bytes(),
            ),
            seed("12", "2", "存档", NodeKind::Directory, b""),
        ],
        "tv",
    )
    .await;
    let first = app.db.entry("6").unwrap().unwrap();
    let second = app.db.entry("7").unwrap().unwrap();
    assert_eq!(
        cast(&app, &token, &first.show_guid).await["list"][0]["name"],
        "剧级演员"
    );
    assert_eq!(
        cast(&app, &token, &first.season_guid()).await["list"][0]["name"],
        "剧级演员"
    );
    assert_eq!(
        cast(&app, &token, &second.guid).await["list"][0]["name"],
        "剧级演员"
    );
    let guest = cast(&app, &token, &first.guid).await;
    assert_eq!(guest["list"][0]["name"], "单集客串");
    let id = guest["list"][0]["person_guid"].as_str().unwrap();
    let (_, detail) = body(
        wire(
            &app,
            false,
            "GET",
            &format!("/v/api/v1/person/{id}"),
            Some(&token),
            Value::Null,
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(detail["data"]["actor_item_total"], 1);
    assert_eq!(detail["data"]["actor_item_list"][0]["type"], "TV");
    host.change_node("9".into(), Some("12".into()), None, None, None)
        .unwrap();
    let fallback = cast(&app, &token, &first.show_guid).await;
    assert_eq!(fallback["total"], 2);
    assert_eq!(cast(&app, &token, &second.guid).await["total"], 0);
}
#[tokio::test]
async fn shared_show_biography_is_stored_once_not_copied_into_each_episode() {
    let bio = "长人物简介。".repeat(5000);
    let mut nodes = vec![
        root(),
        seed("3", "2", "剧", NodeKind::Directory, b""),
        seed("4", "3", "Season01", NodeKind::Directory, b""),
        seed(
            "5",
            "3",
            "tvshow.nfo",
            NodeKind::File,
            format!(
                "<tvshow><actor><name>演员</name><biography>{bio}</biography></actor></tvshow>"
            )
            .as_bytes(),
        ),
    ];
    for i in 1..=256 {
        nodes.push(seed(
            &(i + 10).to_string(),
            "4",
            &format!("S01E{i:03}.mp4"),
            NodeKind::File,
            b"video",
        ));
    }
    let (app, _, _) = configured(nodes, "tv").await;
    let count = app
        .db
        .with(|db| {
            db.query_row("SELECT count(*) FROM actor_records", [], |r| {
                r.get::<_, i64>(0)
            })
            .app()
        })
        .unwrap();
    assert_eq!(count, 1);
    let pages = app
        .db
        .with(|db| {
            db.query_row("PRAGMA page_count", [], |r| r.get::<_, i64>(0))
                .app()
        })
        .unwrap();
    assert!(pages * 4096 < 8 * 1024 * 1024);
    assert_eq!(
        app.db.entry("11").unwrap().unwrap().show_actors[0]
            .data
            .biography,
        bio
    );
}
#[tokio::test]
async fn cached_poster_stream_stops_when_source_moves_within_still_authorized_library() {
    let mut state = 0x51f0a391_u32;
    let image = image::RgbImage::from_fn(256, 128, |_, _| {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        image::Rgb([state as u8, (state >> 8) as u8, (state >> 16) as u8])
    });
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let bytes = bytes.into_inner();
    assert!(bytes.len() > 65536);
    let (app, host, token) = configured(
        vec![
            root(),
            seed("3", "2", "clip.mp4", NodeKind::File, b"video"),
            seed("4", "2", "poster.png", NodeKind::File, &bytes),
            seed("5", "2", "另一目录", NodeKind::Directory, b""),
        ],
        "movie",
    )
    .await;
    covers::schedule(&app, false).unwrap();
    covers::process_next(&app).await.unwrap();
    let e = app.db.entry("3").unwrap().unwrap();
    let mut response = wire(
        &app,
        false,
        "GET",
        &format!("/tgdrive-poster/{}", e.cover.unwrap()),
        Some(&token),
        Value::Null,
        &[],
    )
    .await
    .into_body()
    .into_data_stream();
    assert_eq!(response.next().await.unwrap().unwrap().len(), 65536);
    host.change_node("4".into(), Some("5".into()), None, None, None)
        .unwrap();
    assert!(response.next().await.unwrap().is_err());
}
