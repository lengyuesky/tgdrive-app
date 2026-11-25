//! NFO 生成保留已验收的业务字段；现有资料只做有界、安全的归属读取。
use crate::model::{Actor, Movie, normalized_number, valid_number};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fmt::Write};
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::error_code;

pub const MAX_BYTES: usize = 1024 * 1024;
fn escaped(value: &str) -> Result<String> {
    if value
        .chars()
        .any(|c| matches!(c as u32, 0..=8 | 11..=12 | 14..=31 | 0xfffe | 0xffff))
    {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "资料包含 XML 无法表示的字符，请选择其他来源",
        ));
    }
    Ok(value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;"))
}
fn strip_number_prefix<'a>(title: &'a str, number: &str) -> Option<&'a str> {
    let first = title.chars().next()?;
    let closing = match first {
        '[' => Some(']'),
        '(' => Some(')'),
        '{' => Some('}'),
        '【' => Some('】'),
        '（' => Some('）'),
        '「' => Some('」'),
        '『' => Some('』'),
        _ => None,
    };
    let (prefix, rest) = if let Some(closing) = closing {
        let inner = &title[first.len_utf8()..];
        let end = inner.find(closing)?;
        (&inner[..end], &inner[end + closing.len_utf8()..])
    } else {
        let end = title
            .find(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_'))
            .unwrap_or(title.len());
        (&title[..end], &title[end..])
    };
    let prefix = valid_number(prefix).ok()?;
    (normalized_number(&prefix) == normalized_number(number)).then_some(rest)
}
pub fn display_title(number: &str, original: &str) -> Result<String> {
    let number = valid_number(number)?;
    let mut title = original.trim();
    while let Some(rest) = strip_number_prefix(title, &number) {
        title = rest.trim_start();
    }
    Ok(if title.is_empty() {
        number
    } else {
        format!("{number} {title}")
    })
}
impl Movie {
    pub fn nfo(&self) -> Result<Vec<u8>> {
        self.nfo_with_actors(
            &self
                .actor_names()
                .into_iter()
                .enumerate()
                .map(|(i, name)| Actor {
                    name,
                    order: Some(i as u32),
                    ..Default::default()
                })
                .collect::<Vec<_>>(),
        )
    }
    pub fn nfo_with_actors(&self, actors: &[Actor]) -> Result<Vec<u8>> {
        let mut title = display_title(&self.number, &self.title)?;
        if !self.variant.is_empty() {
            // 同番号的多个视频各有一条影片记录，标题末尾的标签让它们在列表里分得开。
            write!(&mut title, " [{}]", self.variant).expect("字符串写入成功");
        }
        let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<movie>\n");
        let mut tag = |key: &str, value: &str| -> Result<()> {
            if !value.is_empty() {
                writeln!(&mut xml, "  <{key}>{}</{key}>", escaped(value)?).expect("字符串写入成功");
            }
            Ok(())
        };
        tag("num", &self.number)?;
        tag("title", &title)?;
        tag("originaltitle", &self.title)?;
        for (key, value) in [
            ("plot", &self.summary),
            ("director", &self.director),
            ("studio", &self.maker),
            ("label", &self.label),
        ] {
            if let Some(value) = value {
                tag(key, value)?;
            }
        }
        if let Some(date) = &self.release_date {
            tag("releasedate", date)?;
            if let Some(year) = date
                .get(..4)
                .filter(|s| s.bytes().all(|b| b.is_ascii_digit()))
            {
                tag("year", year)?;
            }
            if let Some(day) = date.get(..10) {
                tag("premiered", day)?;
            }
        }
        for genre in self.genres.iter().flatten() {
            tag("genre", genre)?;
            tag("tag", genre)?;
        }
        for actor in actors {
            write!(&mut xml, "  <actor><name>{}</name>", escaped(&actor.name)?)
                .expect("字符串写入成功");
            for (key, value) in [
                ("role", &actor.role),
                ("thumb", &actor.thumb),
                ("biography", &actor.biography),
            ] {
                if !value.is_empty() {
                    write!(&mut xml, "<{key}>{}</{key}>", escaped(value)?).expect("字符串写入成功");
                }
            }
            if let Some(order) = actor.order {
                write!(&mut xml, "<order>{order}</order>").expect("字符串写入成功");
            }
            if !actor.provider.is_empty() && !actor.id.is_empty() {
                write!(
                    &mut xml,
                    "<uniqueid type=\"metatube\" provider=\"{}\">{}</uniqueid>",
                    escaped(&actor.provider)?,
                    escaped(&actor.id)?
                )
                .expect("字符串写入成功");
            }
            xml.push_str("</actor>\n");
        }
        if let Some(series) = self.series.as_ref().filter(|s| !s.is_empty()) {
            writeln!(&mut xml, "  <set><name>{}</name></set>", escaped(series)?)
                .expect("字符串写入成功");
        }
        writeln!(&mut xml,"  <uniqueid type=\"number\" default=\"true\">{}</uniqueid>\n  <metatube provider=\"{}\" id=\"{}\"/>",escaped(&self.number)?,escaped(&self.provider)?,escaped(&self.id)?).expect("字符串写入成功");
        if let Some(score) = self.score.filter(|s| s.is_finite()) {
            writeln!(
                &mut xml,
                "  <metatube_score provider=\"{}\">{score}</metatube_score>",
                escaped(&self.provider)?
            )
            .expect("字符串写入成功");
        }
        xml.push_str("</movie>\n");
        if xml.len() > MAX_BYTES {
            return Err(Error::api(
                error_code::PAYLOAD_TOO_LARGE,
                "完整 NFO 超过 1 MiB，未截断也未写入",
            ));
        }
        Ok(xml.into_bytes())
    }
}
pub fn document(text: &str) -> Option<roxmltree::Document<'_>> {
    let upper = text.to_ascii_uppercase();
    if text.len() > MAX_BYTES || upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY") {
        return None;
    }
    let doc = roxmltree::Document::parse(text).ok()?;
    matches!(
        doc.root_element().tag_name().name(),
        "movie" | "episodedetails" | "tvshow"
    )
    .then_some(doc)
}
pub fn number(xml: &str) -> Option<String> {
    let doc = document(xml)?;
    doc.root_element()
        .children()
        .find(|n| n.has_tag_name("num"))
        .or_else(|| {
            doc.root_element()
                .children()
                .find(|n| n.has_tag_name("uniqueid") && n.attribute("type") == Some("number"))
        })
        .and_then(|n| n.text())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
pub fn poster_names(base: &str) -> Vec<String> {
    let mut names = vec![format!("{base}-poster.jpg"), format!("{base}-poster.jpeg")];
    for ext in ["jpg", "jpeg", "png", "webp"] {
        names.push(format!("{base}.{ext}"));
    }
    for base in ["poster", "folder", "cover"] {
        for ext in ["jpg", "jpeg", "png", "webp"] {
            names.push(format!("{base}.{ext}"));
        }
    }
    names
}
pub fn actor_image_prefix(base: &str) -> String {
    let hash = format!("{:x}", Sha256::digest(base.to_ascii_lowercase().as_bytes()));
    format!("tgdrive-actor-{}-", &hash[..32])
}
pub fn actor_image_name(base: &str, operation: &str, index: usize) -> String {
    let hash = format!("{:x}", Sha256::digest(operation.as_bytes()));
    format!("{}{}-{index}.jpg", actor_image_prefix(base), &hash[..32])
}
pub fn is_actor_image(name: &str, base: &str) -> bool {
    name.to_ascii_lowercase()
        .strip_prefix(&actor_image_prefix(base))
        .and_then(|s| s.strip_suffix(".jpg"))
        .and_then(|s| s.split_once('-'))
        .is_some_and(|(item, index)| {
            item.len() == 32
                && item.bytes().all(|b| b.is_ascii_hexdigit())
                && !index.is_empty()
                && index.bytes().all(|b| b.is_ascii_digit())
        })
}

/// 按文件名保守保留所有头像引用，包括其它影片的 NFO、相对路径和目录共用资料。
pub fn actor_image_references(xml: &str, base: &str) -> Option<HashSet<String>> {
    let doc = document(xml)?;
    Some(
        doc.descendants()
            .filter(|node| node.has_tag_name("thumb"))
            .filter_map(|node| node.text())
            .filter_map(|value| {
                let name = value
                    .trim()
                    .split(['?', '#'])
                    .next()?
                    .rsplit(['/', '\\'])
                    .next()?;
                is_actor_image(name, base).then(|| name.to_ascii_lowercase())
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefix_is_removed_only_when_it_is_the_complete_same_number() {
        for (number, original, expected) in [
            ("ABC-123", "影片名称", "ABC-123 影片名称"),
            ("ABC-123", "  影片名称  ", "ABC-123 影片名称"),
            ("ABC-123", "ABC-123 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "abc-123 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "abc123 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "ABC_123 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "[abc-123] 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "[ ABC-123 ]影片名称", "ABC-123 影片名称"),
            ("ABC-123", "(ABC-123)影片名称", "ABC-123 影片名称"),
            ("ABC-123", "{abc-123} 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "【abc-123】 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "（ABC-123） 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "「abc-123」 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "『ABC-123』 影片名称", "ABC-123 影片名称"),
            ("ABC-123", "ABC-123影片名称", "ABC-123 影片名称"),
            (
                "ABC-123",
                "ABC-123 [abc-123] ABC_123 影片名称",
                "ABC-123 影片名称",
            ),
            ("ABC-123", "ABC-123", "ABC-123"),
            ("ABC-123", "[abc-123]", "ABC-123"),
            ("ABC-123", "[abc-123] ABC-123", "ABC-123"),
            (
                "ABC-123",
                "讲述 ABC-123 的影片",
                "ABC-123 讲述 ABC-123 的影片",
            ),
            ("ABC-123", "DEF-456 影片名称", "ABC-123 DEF-456 影片名称"),
            ("ABC-123", "ABC-1234 影片名称", "ABC-123 ABC-1234 影片名称"),
            (
                "ABC-123",
                "ABC-123-CD1 影片名称",
                "ABC-123 ABC-123-CD1 影片名称",
            ),
            (
                "ABC-123",
                "[ABC-123 影片名称] 后续",
                "ABC-123 [ABC-123 影片名称] 后续",
            ),
            ("abc_123", "[ABC-123] 影片名称", "ABC_123 影片名称"),
            (
                "FC2-PPV-1234567",
                "[fc2_ppv_1234567] 影片名称",
                "FC2-PPV-1234567 影片名称",
            ),
            ("123456-001", "123456-001 影片名称", "123456-001 影片名称"),
        ] {
            assert_eq!(
                display_title(number, original).unwrap(),
                expected,
                "{original}"
            );
            let movie = Movie {
                number: number.into(),
                title: original.into(),
                ..Default::default()
            };
            let xml = String::from_utf8(movie.nfo().unwrap()).unwrap();
            let doc = document(&xml).unwrap();
            assert_eq!(
                doc.root_element()
                    .children()
                    .find(|n| n.has_tag_name("originaltitle"))
                    .and_then(|n| n.text()),
                Some(original)
            );
        }
    }
    #[test]
    fn generated_nfo_matches_cinema_reader_rules() {
        // 按 cinema/backend/src/nfo.rs 的直接子标签、num/uniqueid 与演员身份读取规则断言；不依赖另一个应用的源码。
        let movie = Movie {
            provider: "来源甲".into(),
            id: "条目1".into(),
            number: "ABC-123".into(),
            title: "甲 & 乙".into(),
            summary: Some("长简介。".repeat(4000)),
            director: Some("导演甲".into()),
            maker: Some("厂商".into()),
            label: Some("品牌".into()),
            series: Some("系列".into()),
            genres: Some(vec!["分类".into()]),
            score: Some(5.0),
            release_date: Some("2025-01-02T00:00:00Z".into()),
            ..Default::default()
        };
        let actors = vec![Actor {
            name: "演员甲 & 乙".into(),
            order: Some(0),
            thumb: "tgdrive-actor-one.jpg".into(),
            biography: "真实简介。".repeat(2000),
            provider: "Gfriends".into(),
            id: "演员甲".into(),
            ..Default::default()
        }];
        let xml = String::from_utf8(movie.nfo_with_actors(&actors).unwrap()).unwrap();
        let doc = document(&xml).unwrap();
        let root = doc.root_element();
        let text = |tag: &str| {
            root.children()
                .find(|n| n.has_tag_name(tag))
                .and_then(|n| n.text())
                .unwrap()
                .trim()
                .to_owned()
        };
        assert_eq!(text("title"), "ABC-123 甲 & 乙");
        assert_eq!(text("originaltitle"), movie.title);
        assert_eq!(text("plot"), movie.summary.unwrap());
        assert_eq!(text("year"), "2025");
        assert_eq!(text("premiered"), "2025-01-02");
        assert_eq!(number(&xml).as_deref(), Some("ABC-123"));
        assert_eq!(text("studio"), "厂商");
        assert_eq!(text("label"), "品牌");
        assert!(xml.contains("<set><name>系列</name></set>"));
        assert!(!xml.contains("<rating>"));
        assert_eq!(text("metatube_score"), "5");
        let actor = root.children().find(|n| n.has_tag_name("actor")).unwrap();
        let child = |tag: &str| {
            actor
                .children()
                .find(|n| n.has_tag_name(tag))
                .and_then(|n| n.text())
                .unwrap()
                .to_owned()
        };
        assert_eq!(child("name"), actors[0].name);
        assert_eq!(child("biography"), actors[0].biography);
        assert_eq!(child("order").parse::<u32>().unwrap(), 0);
        assert_eq!(child("thumb"), "tgdrive-actor-one.jpg");
        let id = actor
            .children()
            .find(|n| n.has_tag_name("uniqueid"))
            .unwrap();
        assert_eq!(id.attribute("type"), Some("metatube"));
        assert_eq!(id.attribute("provider"), Some("Gfriends"));
        assert_eq!(id.text(), Some("演员甲"));
    }
    #[test]
    fn rejects_xml_controls_external_entities_and_oversize_without_truncating() {
        let mut movie = Movie {
            number: "ABC-123".into(),
            title: "影片\u{0001}".into(),
            ..Default::default()
        };
        assert!(movie.nfo().is_err());
        movie.title = "正常".into();
        movie.summary = Some("a".repeat(MAX_BYTES));
        assert_eq!(
            movie.nfo().unwrap_err().code(),
            error_code::PAYLOAD_TOO_LARGE
        );
        for text in [
            "<!DOCTYPE movie><movie/>",
            "<!ENTITY x 'secret'><movie/>",
            "<movie><title></movie>",
        ] {
            assert!(document(text).is_none());
        }
    }
    #[test]
    fn actor_files_keep_the_video_group_and_never_reuse_rescrape_names() {
        let name = actor_image_name("ABC-123-4K", "synthetic-operation", 0);
        assert!(is_actor_image(&name, "abc-123-4k"));
        assert!(!is_actor_image(&name, "ABC-123"));
        assert_ne!(name, actor_image_name("ABC-123-4K", "new-operation", 0));
    }

    #[test]
    fn actor_references_preserve_paths_case_and_decoded_xml_text() {
        let name = actor_image_name("ABC-123", "旧头像", 0);
        let other = actor_image_name("DEF-456", "其他视频", 0);
        let encoded = name.replacen('t', "&#116;", 1);
        let xml = format!(
            "<movie><actor><thumb>./{}</thumb></actor><thumb>images\\{name}?v=1</thumb><actor><thumb>../{encoded}</thumb></actor><thumb>{other}</thumb></movie>",
            name.to_ascii_uppercase()
        );
        assert_eq!(
            actor_image_references(&xml, "ABC-123").unwrap(),
            HashSet::from([name])
        );
        assert!(actor_image_references("<movie><actor>", "ABC-123").is_none());
    }
}
