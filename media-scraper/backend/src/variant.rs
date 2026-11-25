//! 同一番号的多个视频：从文件名识别版本（4K、中字、无码…）与分段（CD1、part2、A/B），
//! 给每个视频一个用于区分的标签。只解释文件名，不改名、不合并文件。
use crate::model::{normalized_number, number_matches, stem};
use regex::Regex;
use std::{collections::HashSet, sync::OnceLock};

/// 标签在标题里的固定顺序：清晰度、画面规格、内容版本，最后是字幕。
const ORDER: &[&str] = &[
    "8K", "4K", "2K", "1080P", "720P", "480P", "HDR", "H265", "AV1", "VR", "60帧", "无码", "流出",
    "中字",
];
const REST_CHARS: usize = 40;

/// 紧跟番号的单个字母或一两位数字。`-C` 可能是中文字幕也可能是第三段，
/// 要看同片其他文件是否构成从头开始的连续序列，单看一个文件名无法判断。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bare {
    Letter(u32),
    Digit(u32),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Variant {
    pub tags: Vec<&'static str>,
    /// 明确写出的分段序号：CD1、part2、pt3、disc1。
    pub part: Option<u32>,
    pub bare: Option<Bare>,
    /// 番号之后没有识别出含义的文字，只在标签相同、需要区分时使用。
    pub rest: String,
}

fn ascii_tags(token: &str) -> Option<&'static [&'static str]> {
    Some(match token {
        "8K" | "4320P" => &["8K"],
        "4K" | "2160P" | "UHD" => &["4K"],
        "2K" | "1440P" => &["2K"],
        "1080P" | "FHD" => &["1080P"],
        "720P" => &["720P"],
        "480P" => &["480P"],
        "HDR" | "HDR10" => &["HDR"],
        "HEVC" | "H265" | "X265" => &["H265"],
        "AV1" => &["AV1"],
        "VR" => &["VR"],
        "60FPS" => &["60帧"],
        "UNCENSORED" | "UNCEN" => &["无码"],
        "LEAK" | "LEAKED" => &["流出"],
        "CH" | "CHS" | "CHT" | "SUB" => &["中字"],
        "UC" | "CU" => &["无码", "中字"],
        _ => return None,
    })
}

/// 中文标记可以和其他文字连写（「高清中字」），按子串识别；长的在前，避免「中文字幕」只去掉一半。
const CHINESE: &[(&str, &str)] = &[
    ("中文字幕", "中字"),
    ("中字", "中字"),
    ("字幕", "中字"),
    ("无码", "无码"),
    ("無碼", "无码"),
    ("破解", "无码"),
    ("流出", "流出"),
];

fn part_token(token: &str) -> Option<u32> {
    static PART: OnceLock<Regex> = OnceLock::new();
    PART.get_or_init(|| {
        Regex::new(r"^(?:CD|PART|PT|DISC|DISK)([0-9]{1,2})$").expect("固定分段表达式有效")
    })
    .captures(token)
    .and_then(|found| found[1].parse().ok())
    .filter(|index| *index > 0)
}

fn small_number(token: &str) -> Option<u32> {
    (token.len() <= 2 && token.bytes().all(|b| b.is_ascii_digit()))
        .then(|| token.parse().ok())
        .flatten()
        .filter(|index| *index > 0)
}

impl Variant {
    /// `number` 是这部影片的番号。文件名里没有番号（番号来自所在目录）时，整个基本名都按番号之后的部分解释。
    pub fn parse(name: &str, number: &str) -> Self {
        let original = stem(name);
        let upper = original.to_ascii_uppercase();
        let expected = normalized_number(number);
        let span = number_matches(&upper)
            .into_iter()
            .find(|found| normalized_number(&found.0) == expected)
            .map(|found| (found.1, found.2));
        let (before, after) = match span {
            Some((start, end)) => (&original[..start], &original[end..]),
            None => ("", original),
        };
        let mut tags = HashSet::new();
        // 番号之前常是站点前缀，只认明确的版本词，不当作分段或剩余文字。
        for word in before.split(|c: char| !c.is_alphanumeric()) {
            let mut word = word.to_owned();
            for (marker, tag) in CHINESE {
                if word.contains(marker) {
                    tags.insert(*tag);
                    word = word.replace(marker, "");
                }
            }
            if let Some(found) = ascii_tags(&word.to_ascii_uppercase()) {
                tags.extend(found);
            }
        }
        let words: Vec<&str> = after
            .split(|c: char| !c.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .collect();
        let (mut part, mut bare, mut rest) = (None, None, Vec::new());
        let mut index = 0;
        while index < words.len() {
            let mut word = words[index].to_owned();
            for (marker, tag) in CHINESE {
                if word.contains(marker) {
                    tags.insert(*tag);
                    word = word.replace(marker, "");
                }
            }
            let token = word.to_ascii_uppercase();
            let first = index == 0;
            index += 1;
            if token.is_empty() {
                continue;
            }
            if let Some(found) = ascii_tags(&token) {
                tags.extend(found);
            } else if let Some(found) = part_token(&token) {
                part.get_or_insert(found);
            } else if matches!(token.as_str(), "CD" | "PART" | "PT" | "DISC" | "DISK")
                && let Some(found) = words.get(index).and_then(|next| small_number(next))
            {
                // 「part 2」这样分开写的序号。
                part.get_or_insert(found);
                index += 1;
            } else if first && token.len() == 1 && token.as_bytes()[0].is_ascii_uppercase() {
                bare = Some(Bare::Letter(u32::from(token.as_bytes()[0] - b'A') + 1));
            } else if first && let Some(found) = small_number(&token) {
                bare = Some(Bare::Digit(found));
            } else if token == "C" {
                tags.insert("中字");
            } else if token == "U" {
                tags.insert("无码");
            } else {
                rest.push(word);
            }
        }
        Self {
            tags: ORDER
                .iter()
                .copied()
                .filter(|tag| tags.contains(tag))
                .collect(),
            part,
            bare,
            rest: rest.join(" ").chars().take(REST_CHARS).collect(),
        }
    }
}

struct Settled {
    tags: Vec<&'static str>,
    part: Option<u32>,
    rest: String,
}

fn settle(variant: &Variant, peers: &[&Variant]) -> Settled {
    let mut settled = Settled {
        tags: variant.tags.clone(),
        part: variant.part,
        rest: variant.rest.clone(),
    };
    let Some(bare) = variant.bare.filter(|_| variant.part.is_none()) else {
        return settled;
    };
    let index = match bare {
        Bare::Letter(index) | Bare::Digit(index) => index,
    };
    // 同样写法、其余标签相同的文件里，序号从 1 起连续到几。
    let present: HashSet<u32> = peers
        .iter()
        .filter(|peer| peer.part.is_none() && peer.tags == variant.tags)
        .filter_map(|peer| match (peer.bare?, bare) {
            (Bare::Letter(index), Bare::Letter(_)) | (Bare::Digit(index), Bare::Digit(_)) => {
                Some(index)
            }
            _ => None,
        })
        .collect();
    let run = (1..).take_while(|index| present.contains(index)).count() as u32;
    if run >= 2 && index <= run {
        settled.part = Some(index);
        return settled;
    }
    let literal = match bare {
        Bare::Letter(3) => {
            settled.tags.push("中字");
            return ordered(settled);
        }
        Bare::Letter(21) => {
            settled.tags.push("无码");
            return ordered(settled);
        }
        Bare::Letter(index) => char::from(b'A' + (index - 1) as u8).to_string(),
        Bare::Digit(index) => index.to_string(),
    };
    settled.rest = format!("{literal} {}", settled.rest).trim().to_owned();
    settled
}

fn ordered(mut settled: Settled) -> Settled {
    settled.tags = ORDER
        .iter()
        .copied()
        .filter(|tag| settled.tags.contains(tag))
        .collect();
    settled
}

/// 给 `names` 里的每个视频（同一番号、同一处的全部视频）定出标签，返回与输入等长的结果。
///
/// 分段标签始终给出。版本标签只在这部影片有不止一个视频时给出：单独一个文件不需要靠
/// 清晰度区分，标题保持「番号 片名」。同基本名的不同封装格式算同一个视频。
pub fn labels(names: &[&str], number: &str) -> Vec<String> {
    let variants: Vec<Variant> = names
        .iter()
        .map(|name| Variant::parse(name, number))
        .collect();
    let stems: Vec<String> = names
        .iter()
        .map(|name| stem(name).to_ascii_lowercase())
        .collect();
    // 序列判断按基本名去重，同一视频的两种封装不能凑成「两段」。
    let mut seen = HashSet::new();
    let distinct: Vec<&Variant> = variants
        .iter()
        .zip(&stems)
        .filter(|(_, stem)| seen.insert(stem.as_str()))
        .map(|(variant, _)| variant)
        .collect();
    let settled: Vec<Settled> = variants
        .iter()
        .map(|variant| settle(variant, &distinct))
        .collect();
    let several = seen.len() > 1;
    let render = |row: &Settled| {
        let mut words: Vec<String> = if several {
            row.tags.iter().map(|tag| (*tag).to_owned()).collect()
        } else {
            Vec::new()
        };
        if let Some(part) = row.part {
            // 一部影片的分段到两位数时补零，按标题排序仍是播放顺序。
            let wide = settled
                .iter()
                .any(|other| other.tags == row.tags && other.part.is_some_and(|part| part >= 10));
            words.push(if wide {
                format!("第{part:02}段")
            } else {
                format!("第{part}段")
            });
        }
        words.join(" ")
    };
    let plain: Vec<String> = settled.iter().map(render).collect();
    plain
        .iter()
        .enumerate()
        .map(|(index, label)| {
            let collides = plain
                .iter()
                .zip(&stems)
                .any(|(other, stem)| other == label && *stem != stems[index]);
            let rest = &settled[index].rest;
            if collides && !rest.is_empty() {
                format!("{label} {rest}").trim().to_owned()
            } else {
                label.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(name: &str) -> Variant {
        Variant::parse(name, "ABC-123")
    }
    fn of(names: &[&str]) -> Vec<String> {
        labels(names, "ABC-123")
    }

    #[test]
    fn explicit_parts_and_version_words_are_read_from_the_name() {
        for (name, part) in [
            ("ABC-123-CD1.mp4", 1),
            ("abc-123.part2.mkv", 2),
            ("ABC-123 part 3.mp4", 3),
            ("ABC-123_pt4.mp4", 4),
            ("ABC-123-disc2.mp4", 2),
            ("ABC-123CD2.mp4", 2),
            ("ABC-123 part12.mp4", 12),
        ] {
            assert_eq!(one(name).part, Some(part), "{name}");
            assert_eq!(one(name).bare, None, "{name}");
        }
        for (name, tags) in [
            ("ABC-123-4K.mp4", vec!["4K"]),
            ("ABC-123.2160p.HEVC.mkv", vec!["4K", "H265"]),
            ("ABC-123-UC.mp4", vec!["无码", "中字"]),
            ("ABC-123 无码破解 中文字幕.mp4", vec!["无码", "中字"]),
            ("[中字]ABC-123.mp4", vec!["中字"]),
            ("ABC-123-4K-C.mp4", vec!["4K", "中字"]),
            ("ABC-123-leak.mp4", vec!["流出"]),
            ("ABC-123 高清中字.mp4", vec!["中字"]),
            ("hhd800.com@ABC-123.mp4", vec![]),
        ] {
            assert_eq!(one(name).tags, tags, "{name}");
        }
        assert_eq!(one("ABC-123 高清中字.mp4").rest, "高清");
        assert_eq!(one("ABC-123-remastered.mp4").rest, "remastered");
        // 番号来自目录时，整个基本名都是番号之后的部分。
        assert_eq!(one("cd2.mp4").part, Some(2));
        assert_eq!(one("4K.mp4").tags, vec!["4K"]);
    }

    #[test]
    fn a_lone_letter_is_a_part_only_inside_a_sequence_that_starts_at_the_beginning() {
        assert_eq!(
            of(&["ABC-123-A.mp4", "ABC-123-B.mp4", "ABC-123-C.mp4"]),
            ["第1段", "第2段", "第3段"]
        );
        assert_eq!(of(&["ABC-123A.mp4", "ABC-123B.mp4"]), ["第1段", "第2段"]);
        assert_eq!(of(&["ABC-123-1.mp4", "ABC-123-2.mp4"]), ["第1段", "第2段"]);
        // 没有 A、B 作伴的 -C 是中文字幕，-U 是无码。
        assert_eq!(of(&["ABC-123.mp4", "ABC-123-C.mp4"]), ["", "中字"]);
        assert_eq!(of(&["ABC-123.mp4", "ABC-123-U.mp4"]), ["", "无码"]);
        // 缺了 B：A 不成序列，C 仍是中文字幕；两者标签已经不同，A 不必再附字母。
        assert_eq!(of(&["ABC-123-A.mp4", "ABC-123-C.mp4"]), ["", "中字"]);
        // 字母与数字是两种写法，不能互相凑成序列。
        assert_eq!(of(&["ABC-123-A.mp4", "ABC-123-2.mp4"]), ["A", "2"]);
        // 同一视频的两种封装不是两段。
        assert_eq!(of(&["ABC-123-A.mp4", "ABC-123-A.mkv"]), ["", ""]);
        // 分段只在同一版本内成序列：4K 版的上下两段与单独的中字版。
        assert_eq!(
            of(&["ABC-123-A-4K.mp4", "ABC-123-B-4K.mp4", "ABC-123-C.mp4"]),
            ["4K 第1段", "4K 第2段", "中字"]
        );
    }

    #[test]
    fn version_words_only_appear_when_the_work_has_several_videos() {
        assert_eq!(of(&["ABC-123-4K.mp4"]), [""]);
        assert_eq!(of(&["ABC-123-4K.mp4", "ABC-123-4K.mkv"]), ["", ""]);
        assert_eq!(of(&["ABC-123.mp4", "ABC-123-4K.mp4"]), ["", "4K"]);
        assert_eq!(
            of(&["ABC-123-1080p.mp4", "ABC-123-4K-C.mp4", "ABC-123-UC.mp4"]),
            ["1080P", "4K 中字", "无码 中字"]
        );
        // 明确的分段即使只有一个文件也标出，它本来就不是完整影片。
        assert_eq!(of(&["ABC-123-cd2.mp4"]), ["第2段"]);
        assert_eq!(
            of(&["ABC-123-4K-cd1.mp4", "ABC-123-4K-cd2.mp4", "ABC-123.mp4"]),
            ["4K 第1段", "4K 第2段", ""]
        );
        let many: Vec<String> = (1..=10).map(|n| format!("ABC-123-cd{n}.mp4")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(of(&many)[0], "第01段");
        assert_eq!(of(&many)[9], "第10段");
    }

    #[test]
    fn unrecognized_words_separate_videos_whose_labels_would_be_identical() {
        assert_eq!(
            of(&["ABC-123.mp4", "ABC-123-remastered.mp4"]),
            ["", "remastered"]
        );
        assert_eq!(
            of(&["ABC-123-4K.mp4", "ABC-123-4K-remux.mp4"]),
            ["4K", "4K remux"]
        );
        // 标签已经不同就不附带其余文字。
        assert_eq!(
            of(&["ABC-123-4K-remux.mp4", "ABC-123-1080p.mp4"]),
            ["4K", "1080P"]
        );
    }
}
