//! 读取网盘中的视频专属资料和目录共用资料，不执行外部实体或网络引用。
pub const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct Actor {
    pub name: String,
    pub role: String,
    pub order: Option<u32>,
    pub thumb: String,
    pub biography: String,
    pub provider: String,
    pub id: String,
}
fn node_text(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    let child = node.children().find(|n| n.has_tag_name(tag))?;
    let value: String = child
        .children()
        .filter(|n| n.is_text())
        .filter_map(|n| n.text())
        .collect();
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}
pub fn document(text: &str) -> Option<roxmltree::Document<'_>> {
    if text.len() > MAX_BYTES
        || text.to_ascii_uppercase().contains("<!DOCTYPE")
        || text.to_ascii_uppercase().contains("<!ENTITY")
    {
        return None;
    }
    let doc = roxmltree::Document::parse(text).ok()?;
    matches!(
        doc.root_element().tag_name().name(),
        "movie" | "episodedetails" | "tvshow"
    )
    .then_some(doc)
}
pub fn text(xml: &str, tag: &str) -> Option<String> {
    node_text(document(xml)?.root_element(), tag)
}
pub fn number(xml: &str) -> Option<String> {
    let doc = document(xml)?;
    let root = doc.root_element();
    root.children()
        .find(|n| n.has_tag_name("num"))
        .or_else(|| {
            root.children()
                .find(|n| n.has_tag_name("uniqueid") && n.attribute("type") == Some("number"))
        })
        .and_then(|n| n.text())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
/// 原始顺序与角色属于作品关系；同名或来源身份的归并由人物索引处理。
pub fn actors(xml: &str) -> Vec<Actor> {
    let Some(doc) = document(xml) else {
        return Vec::new();
    };
    doc.root_element()
        .children()
        .filter(|n| n.has_tag_name("actor"))
        .filter_map(|node| {
            let name = node_text(node, "name")?;
            let identity = node
                .children()
                .filter(|n| n.has_tag_name("uniqueid"))
                .filter_map(|n| {
                    let kind = n.attribute("type")?.trim();
                    let provider = if kind.eq_ignore_ascii_case("metatube") {
                        n.attribute("provider")?.trim()
                    } else {
                        kind
                    };
                    let id = n.text()?.trim();
                    (!provider.is_empty() && !id.is_empty())
                        .then(|| (n.attribute("default") == Some("true"), provider, id))
                })
                .max_by_key(|(preferred, _, _)| *preferred);
            Some(Actor {
                name,
                role: node_text(node, "role").unwrap_or_default(),
                order: node_text(node, "order").and_then(|s| s.parse().ok()),
                thumb: node_text(node, "thumb").unwrap_or_default(),
                biography: node_text(node, "biography")
                    .or_else(|| node_text(node, "description"))
                    .unwrap_or_default(),
                provider: identity.map(|(_, p, _)| p.to_owned()).unwrap_or_default(),
                id: identity.map(|(_, _, id)| id.to_owned()).unwrap_or_default(),
            })
        })
        .collect()
}
/// 只解析资料目录内及其后代的网盘相对路径。
pub fn local_actor_path(directory: &str, reference: &str) -> Option<String> {
    let reference = reference.trim();
    if reference.is_empty()
        || reference.starts_with('/')
        || reference
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':' | '?' | '#'))
    {
        return None;
    }
    let mut components: Vec<_> = directory.split('/').filter(|s| !s.is_empty()).collect();
    let boundary = components.len();
    for part in reference.split('/') {
        match part {
            "" | "." => {}
            ".." if components.len() > boundary => {
                components.pop();
            }
            ".." => return None,
            name => components.push(name),
        }
    }
    (components.len() > boundary).then(|| format!("/{}", components.join("/")))
}
pub fn poster_names(base: &str) -> Vec<String> {
    let mut names = vec![format!("{base}-poster.jpg"), format!("{base}-poster.jpeg")];
    for ext in ["jpg", "jpeg", "png", "webp"] {
        names.push(format!("{base}.{ext}"));
    }
    for common in ["poster", "folder", "cover"] {
        for ext in ["jpg", "jpeg", "png", "webp"] {
            names.push(format!("{common}.{ext}"));
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_long_unicode_and_decodes_xml_once() {
        let plot = "长简介与原始文字。".repeat(2500);
        let xml =
            format!("<movie><title>甲 &amp; 乙</title><plot><![CDATA[{plot}]]></plot></movie>");
        assert_eq!(text(&xml, "title").as_deref(), Some("甲 & 乙"));
        assert_eq!(text(&xml, "plot").as_deref(), Some(plot.as_str()));
        assert_eq!(
            text("<movie><title>&amp;lt;</title></movie>", "title").as_deref(),
            Some("&lt;")
        );
    }
    #[test]
    fn rejects_entities_malformed_xml_and_oversize() {
        assert!(document("<!DOCTYPE movie [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><movie><title>&x;</title></movie>").is_none());
        assert!(document("<movie><title>缺少闭合</movie>").is_none());
        assert!(
            document(&format!(
                "<movie><plot>{}</plot></movie>",
                "a".repeat(MAX_BYTES)
            ))
            .is_none()
        );
    }
    #[test]
    fn nested_actors_keep_roles_order_and_full_biography() {
        let bio = "人物简介。".repeat(3000);
        let xml = format!(
            "<movie><actor><name> 演员甲 &amp; 乙 </name><role>角色</role><order>2</order><thumb>actors/肖像.jpg</thumb><biography><![CDATA[{bio}]]></biography><uniqueid type='metatube' provider='Gfriends'>演员甲</uniqueid></actor><actor><name> </name></actor><actor><name>演员丙</name><order>-1</order></actor></movie>"
        );
        let rows = actors(&xml);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "演员甲 & 乙");
        assert_eq!(rows[0].order, Some(2));
        assert_eq!(rows[0].biography, bio);
        assert_eq!(rows[1].order, None);
    }
    #[test]
    fn actor_paths_stay_in_metadata_directory() {
        assert_eq!(
            local_actor_path("/影视/甲", "actors/../演员.jpg").as_deref(),
            Some("/影视/甲/演员.jpg")
        );
        for path in [
            "https://example.invalid/a.jpg",
            "//example.invalid/a.jpg",
            "../私有/a.jpg",
            "actors/../../a.jpg",
            "/私有/a.jpg",
            "a.jpg?token=secret",
            "a\\b.jpg",
        ] {
            assert!(local_actor_path("/影视/甲", path).is_none(), "{path}");
        }
    }
}
