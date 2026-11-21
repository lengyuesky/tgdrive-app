use crate::{ElfReport, Result, invalid, protect_output, read_file, validate_elf, write_atomic};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::Path,
};
use tgdrive_contract::{ByteCount, PACKAGE_FORMAT, http::*, manifest::*, validation::*};

#[derive(Debug, Serialize)]
pub struct PackageReport {
    pub manifest: Manifest,
    pub package: PackageMetadata,
    pub filename: String,
    pub sha256: String,
    pub size: ByteCount,
    pub backend: Option<ElfReport>,
}
struct Entry {
    path: String,
    data: Vec<u8>,
    directory: bool,
}
fn target_name(target: PackageTarget) -> String {
    serde_json::to_value(target)
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}
fn canonical<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    parse_unique_json(&bytes)?;
    Ok(bytes)
}

pub fn pack(source: &Path, output: &Path, target: PackageTarget) -> Result<PackageReport> {
    protect_output(output)?;
    if !std::fs::symlink_metadata(source)?.is_dir() {
        return Err(invalid("打包输入必须为编译后的普通目录"));
    }
    let manifest = parse_manifest(&read_file(&source.join(MANIFEST_PATH), MAX_MANIFEST_BYTES)?)?;
    let metadata_path = source.join(PACKAGE_METADATA_PATH);
    let metadata = if metadata_path.exists() {
        let metadata = parse_package_metadata(&read_file(&metadata_path, MAX_MANIFEST_BYTES)?)?;
        if metadata.target != target {
            return Err(invalid("构建目标与已存在的 package.json 不匹配"));
        }
        metadata
    } else {
        PackageMetadata {
            format: PACKAGE_FORMAT,
            target,
            extra: Default::default(),
        }
    };
    let mut entries = Vec::new();
    collect(source, source, &mut entries)?;
    entries.retain(|entry| entry.path != MANIFEST_PATH && entry.path != PACKAGE_METADATA_PATH);
    entries.push(Entry {
        path: MANIFEST_PATH.into(),
        data: canonical(&manifest)?,
        directory: false,
    });
    entries.push(Entry {
        path: PACKAGE_METADATA_PATH.into(),
        data: canonical(&metadata)?,
        directory: false,
    });
    entries.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    let layout = entries
        .iter()
        .map(|entry| ArchiveEntry {
            path: entry.path.clone(),
            kind: if entry.directory {
                ArchiveEntryKind::Directory
            } else {
                ArchiveEntryKind::File
            },
            expanded_size: entry.data.len() as u64,
            compression: ArchiveCompression::Stored,
            encrypted: false,
        })
        .collect::<Vec<_>>();
    validate_archive_layout(&manifest, &metadata, &layout)?;
    let bytes = zip(&entries)?;
    let report = verify_bytes(&bytes)?;
    write_atomic(&output.join(&report.filename), &bytes, true)?;
    Ok(report)
}
fn collect(root: &Path, directory: &Path, entries: &mut Vec<Entry>) -> Result<()> {
    let mut children = std::fs::read_dir(directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        let path = entry.path();
        let name = path
            .strip_prefix(root)?
            .to_str()
            .ok_or_else(|| invalid("资源路径不是 UTF-8"))?
            .replace(std::path::MAIN_SEPARATOR, "/");
        if !valid_resource_path(&name) {
            return Err(invalid("资源路径不符合契约的 ASCII 段规则"));
        }
        let kind = std::fs::symlink_metadata(&path)?.file_type();
        if kind.is_dir() {
            entries.push(Entry {
                path: format!("{name}/"),
                data: Vec::new(),
                directory: true,
            });
            collect(root, &path, entries)?;
        } else if kind.is_file() {
            entries.push(Entry {
                path: name,
                data: read_file(&path, MAX_PACKAGE_FILE_BYTES)?,
                directory: false,
            });
        } else {
            return Err(invalid("包源不能包含链接、设备或其他特殊文件"));
        }
        if entries.len() > MAX_PACKAGE_ENTRIES as usize {
            return Err(invalid("包文件和目录总项数超限"));
        }
    }
    Ok(())
}
fn zip(entries: &[Entry]) -> Result<Vec<u8>> {
    let mut local = Vec::new();
    let mut central = Vec::new();
    for entry in entries {
        let name = entry.path.as_bytes();
        let size = u32::try_from(entry.data.len())?;
        let crc = crc32fast::hash(&entry.data);
        let offset = u32::try_from(local.len())?;
        // 压缩器版本由 Cargo.lock 固定；固定级别、不写时间/平台信息，许可文本和脚本不必膨胀分发包。
        use std::io::Write;
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(6));
        encoder.write_all(&entry.data)?;
        let compressed = encoder.finish()?;
        let (method, data) = if !entry.directory && compressed.len() < entry.data.len() {
            (8u16, compressed.as_slice())
        } else {
            (0u16, entry.data.as_slice())
        };
        let compressed_size = u32::try_from(data.len())?;
        let mut header = [0u8; 30];
        header[..4].copy_from_slice(&0x04034b50u32.to_le_bytes());
        header[4..6].copy_from_slice(&20u16.to_le_bytes());
        header[6..8].copy_from_slice(&0x800u16.to_le_bytes());
        header[8..10].copy_from_slice(&method.to_le_bytes());
        header[12..14].copy_from_slice(&33u16.to_le_bytes());
        header[14..18].copy_from_slice(&crc.to_le_bytes());
        header[18..22].copy_from_slice(&compressed_size.to_le_bytes());
        header[22..26].copy_from_slice(&size.to_le_bytes());
        header[26..28].copy_from_slice(&u16::try_from(name.len())?.to_le_bytes());
        local.extend_from_slice(&header);
        local.extend_from_slice(name);
        local.extend_from_slice(data);
        let mut directory = [0u8; 46];
        directory[..4].copy_from_slice(&0x02014b50u32.to_le_bytes());
        directory[4..6].copy_from_slice(&0x0314u16.to_le_bytes());
        directory[6..32].copy_from_slice(&header[4..30]);
        let mode = if entry.directory {
            0o040755u32
        } else if entry.path == BACKEND_ENTRY {
            0o100755u32
        } else {
            0o100644u32
        };
        directory[38..42].copy_from_slice(&(mode << 16).to_le_bytes());
        directory[42..46].copy_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(&directory);
        central.extend_from_slice(name);
    }
    let count = u16::try_from(entries.len())?;
    let mut end = [0u8; 22];
    end[..4].copy_from_slice(&0x06054b50u32.to_le_bytes());
    end[8..10].copy_from_slice(&count.to_le_bytes());
    end[10..12].copy_from_slice(&count.to_le_bytes());
    end[12..16].copy_from_slice(&u32::try_from(central.len())?.to_le_bytes());
    end[16..20].copy_from_slice(&u32::try_from(local.len())?.to_le_bytes());
    local.extend_from_slice(&central);
    local.extend_from_slice(&end);
    if local.len() as u64 > MAX_PACKAGE_BYTES {
        return Err(invalid("压缩包实际大小超过上限"));
    }
    Ok(local)
}
fn slice(bytes: &[u8], offset: usize, length: usize) -> Result<&[u8]> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| invalid("ZIP 区间溢出"))?;
    bytes.get(offset..end).ok_or_else(|| invalid("ZIP 被截断"))
}
fn u16_at(bytes: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(slice(bytes, offset, 2)?.try_into()?))
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(slice(bytes, offset, 4)?.try_into()?))
}
fn check_extra(bytes: &[u8]) -> Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let id = u16_at(bytes, offset)?;
        let size = usize::from(u16_at(bytes, offset + 2)?);
        slice(bytes, offset + 4, size)?;
        if id == 1 {
            return Err(invalid("不支持 ZIP64"));
        }
        offset += 4 + size;
    }
    Ok(())
}

pub fn verify(path: &Path) -> Result<PackageReport> {
    verify_bytes(&read_file(path, MAX_PACKAGE_BYTES)?)
}
pub fn verify_bytes(bytes: &[u8]) -> Result<PackageReport> {
    if bytes.len() < 22 || bytes.len() as u64 > MAX_PACKAGE_BYTES {
        return Err(invalid("ZIP 实际大小无效"));
    }
    let minimum = bytes.len().saturating_sub(22 + u16::MAX as usize);
    let end = (minimum..=bytes.len() - 22)
        .rev()
        .find(|offset| {
            bytes.get(*offset..*offset + 4) == Some(&0x06054b50u32.to_le_bytes())
                && u16_at(bytes, *offset + 20)
                    .is_ok_and(|size| *offset + 22 + usize::from(size) == bytes.len())
        })
        .ok_or_else(|| invalid("ZIP 缺少有效结束目录"))?;
    let count = u16_at(bytes, end + 10)?;
    let central_size = u32_at(bytes, end + 12)? as usize;
    let central_start = u32_at(bytes, end + 16)? as usize;
    if u16_at(bytes, end + 4)? != 0
        || u16_at(bytes, end + 6)? != 0
        || u16_at(bytes, end + 8)? != count
        || count == u16::MAX
        || central_size == u32::MAX as usize
        || central_start == u32::MAX as usize
        || central_start.checked_add(central_size) != Some(end)
        || u64::from(count) > MAX_PACKAGE_ENTRIES
    {
        return Err(invalid("ZIP 分卷、ZIP64、项数或目录位置无效"));
    }
    let mut offset = central_start;
    let mut layout = Vec::new();
    let mut files = BTreeMap::new();
    let mut paths = BTreeSet::new();
    let mut spans = Vec::new();
    let mut expanded = 0u64;
    for _ in 0..count {
        slice(bytes, offset, 46)?;
        if u32_at(bytes, offset)? != 0x02014b50 {
            return Err(invalid("ZIP 中央目录签名无效"));
        }
        let needed = u16_at(bytes, offset + 6)?;
        let flags = u16_at(bytes, offset + 8)?;
        let method = u16_at(bytes, offset + 10)?;
        let crc = u32_at(bytes, offset + 16)?;
        let compressed = u32_at(bytes, offset + 20)? as usize;
        let size = u32_at(bytes, offset + 24)? as usize;
        let name_size = usize::from(u16_at(bytes, offset + 28)?);
        let extra_size = usize::from(u16_at(bytes, offset + 30)?);
        let comment_size = usize::from(u16_at(bytes, offset + 32)?);
        let local = u32_at(bytes, offset + 42)? as usize;
        if needed > 20
            || flags & !0x806 != 0
            || !matches!(method, 0 | 8)
            || method == 0 && flags & 6 != 0
            || u16_at(bytes, offset + 34)? != 0
            || compressed == u32::MAX as usize
            || size == u32::MAX as usize
            || size as u64 > MAX_PACKAGE_FILE_BYTES
        {
            return Err(invalid(
                "ZIP 加密、数据描述符、版本、压缩方法或大小不受支持",
            ));
        }
        let name = slice(bytes, offset + 46, name_size)?;
        let path = std::str::from_utf8(name)?.to_owned();
        let folded = path.trim_end_matches('/').to_ascii_lowercase();
        if !paths.insert(folded) {
            return Err(invalid("ZIP 路径重复或存在大小写别名"));
        }
        check_extra(slice(bytes, offset + 46 + name_size, extra_size)?)?;
        slice(bytes, offset + 46 + name_size + extra_size, comment_size)?;
        slice(bytes, local, 30)?;
        if u32_at(bytes, local)? != 0x04034b50
            || u16_at(bytes, local + 4)? != needed
            || u16_at(bytes, local + 6)? != flags
            || u16_at(bytes, local + 8)? != method
            || u32_at(bytes, local + 14)? != crc
            || u32_at(bytes, local + 18)? as usize != compressed
            || u32_at(bytes, local + 22)? as usize != size
            || usize::from(u16_at(bytes, local + 26)?) != name_size
            || slice(bytes, local + 30, name_size)? != name
            || slice(bytes, local + 10, 4)? != slice(bytes, offset + 12, 4)?
        {
            return Err(invalid("ZIP 本地文件头与中央目录不一致"));
        }
        let local_extra = usize::from(u16_at(bytes, local + 28)?);
        check_extra(slice(bytes, local + 30 + name_size, local_extra)?)?;
        let start = local
            .checked_add(30 + name_size + local_extra)
            .ok_or_else(|| invalid("ZIP 数据区间溢出"))?;
        let data_end = start
            .checked_add(compressed)
            .ok_or_else(|| invalid("ZIP 数据区间溢出"))?;
        if data_end > central_start {
            return Err(invalid("ZIP 数据越过中央目录"));
        }
        let compressed_bytes = slice(bytes, start, compressed)?;
        let data = if method == 0 {
            compressed_bytes.to_vec()
        } else {
            let mut decoder = flate2::read::DeflateDecoder::new(compressed_bytes);
            let mut output = Vec::new();
            (&mut decoder)
                .take(MAX_PACKAGE_FILE_BYTES + 1)
                .read_to_end(&mut output)?;
            if decoder.total_in() != compressed as u64 {
                return Err(invalid("Deflate 正文含尾随数据"));
            }
            output
        };
        if data.len() != size || crc32fast::hash(&data) != crc {
            return Err(invalid("ZIP 实际解压长度或 CRC 不符"));
        }
        expanded = expanded
            .checked_add(data.len() as u64)
            .ok_or_else(|| invalid("ZIP 累计长度溢出"))?;
        if expanded > MAX_PACKAGE_EXPANDED_BYTES {
            return Err(invalid("ZIP 实际解压累计大小超限"));
        }
        let attributes = u32_at(bytes, offset + 38)?;
        let mode = attributes >> 16;
        let unix = u16_at(bytes, offset + 4)? >> 8 == 3;
        let file_type = mode & 0o170000;
        let directory = path.ends_with('/');
        let kind = if unix && !matches!(file_type, 0 | 0o100000 | 0o040000) {
            ArchiveEntryKind::LinkOrSpecial
        } else if directory {
            if unix && file_type == 0o100000 {
                return Err(invalid("ZIP 路径和类型不一致"));
            }
            ArchiveEntryKind::Directory
        } else {
            if unix && file_type == 0o040000 || attributes & 0x10 != 0 {
                return Err(invalid("ZIP 路径和目录属性不一致"));
            }
            ArchiveEntryKind::File
        };
        if kind == ArchiveEntryKind::LinkOrSpecial {
            return Err(invalid("ZIP 不得包含链接或特殊文件"));
        }
        layout.push(ArchiveEntry {
            path: path.clone(),
            kind,
            expanded_size: data.len() as u64,
            compression: if method == 0 {
                ArchiveCompression::Stored
            } else {
                ArchiveCompression::Deflate
            },
            encrypted: false,
        });
        if kind == ArchiveEntryKind::File {
            files.insert(path, data);
        }
        spans.push((local, data_end));
        offset += 46 + name_size + extra_size + comment_size;
    }
    if offset != end {
        return Err(invalid("ZIP 中央目录实际长度不符"));
    }
    spans.sort();
    let mut boundary = 0;
    for (start, end) in spans {
        if start != boundary {
            return Err(invalid("ZIP 本地数据重叠、存在空洞或未登记条目"));
        }
        boundary = end;
    }
    if boundary != central_start {
        return Err(invalid("ZIP 本地条目与中央目录边界不符"));
    }
    // 隐式目录也计数并检查大小写别名；不让没有目录条目的 ZIP 绕过总项数规则。
    let mut directories = BTreeMap::new();
    for entry in &layout {
        let path = entry.path.trim_end_matches('/');
        let mut parent = path.rsplit_once('/').map(|(parent, _)| parent);
        if entry.kind == ArchiveEntryKind::Directory {
            if directories
                .get(&path.to_ascii_lowercase())
                .is_some_and(|previous| previous != path)
            {
                return Err(invalid("ZIP 显式目录与隐式目录存在大小写别名"));
            }
            directories.insert(path.to_ascii_lowercase(), path.to_string());
        }
        while let Some(path) = parent {
            let folded = path.to_ascii_lowercase();
            if directories
                .get(&folded)
                .is_some_and(|previous| previous != path)
            {
                return Err(invalid("ZIP 隐式目录存在大小写别名"));
            }
            directories.insert(folded, path.to_owned());
            parent = path.rsplit_once('/').map(|(parent, _)| parent);
        }
    }
    for (folded, path) in directories {
        if !paths.contains(&folded) {
            layout.push(ArchiveEntry {
                path: format!("{path}/"),
                kind: ArchiveEntryKind::Directory,
                expanded_size: 0,
                compression: ArchiveCompression::Stored,
                encrypted: false,
            });
        }
    }
    let manifest = parse_manifest(
        files
            .get(MANIFEST_PATH)
            .ok_or_else(|| invalid("ZIP 缺少 app.json"))?,
    )?;
    let metadata = parse_package_metadata(
        files
            .get(PACKAGE_METADATA_PATH)
            .ok_or_else(|| invalid("ZIP 缺少 package.json"))?,
    )?;
    validate_archive_layout(&manifest, &metadata, &layout)?;
    let backend = if manifest.backend.is_some() {
        Some(validate_elf(
            files
                .get(BACKEND_ENTRY)
                .ok_or_else(|| invalid("缺少后端入口"))?,
            metadata.target,
        )?)
    } else {
        None
    };
    let filename = package_asset_name(
        &manifest.id,
        &manifest.version,
        &target_name(metadata.target),
    );
    Ok(PackageReport {
        manifest,
        package: metadata,
        filename,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size: ByteCount(bytes.len() as u64),
        backend,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> tempfile::TempDir {
        let source = tempfile::tempdir().unwrap();
        std::fs::create_dir(source.path().join("page")).unwrap();
        std::fs::write(
            source.path().join("page/index.html"),
            "<!doctype html><title>示例</title>",
        )
        .unwrap();
        std::fs::write(source.path().join("app.json"),r#"{"id":"example","name":"示例","version":"1.0.0","contract":{"major":1,"minor":0},"description":"测试","author":"开发者","page":{"entry":"page/index.html"}}"#).unwrap();
        source
    }
    #[test]
    fn deterministic_bytes_and_real_crc_checks() {
        let source = source();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = pack(source.path(), a.path(), PackageTarget::Web).unwrap();
        let second = pack(source.path(), b.path(), PackageTarget::Web).unwrap();
        assert_eq!(first.sha256, second.sha256);
        let mut bytes = read_file(&a.path().join(first.filename), MAX_PACKAGE_BYTES).unwrap();
        bytes[40] ^= 1;
        assert!(verify_bytes(&bytes).is_err());
    }
    fn packed_file(bytes: &[u8], path: &str) -> Vec<u8> {
        let mut offset = 0;
        while u32_at(bytes, offset).unwrap() == 0x04034b50 {
            let compressed_size = u32_at(bytes, offset + 18).unwrap() as usize;
            let name_size = usize::from(u16_at(bytes, offset + 26).unwrap());
            let extra_size = usize::from(u16_at(bytes, offset + 28).unwrap());
            let start = offset + 30 + name_size + extra_size;
            if slice(bytes, offset + 30, name_size).unwrap() == path.as_bytes() {
                let data = slice(bytes, start, compressed_size).unwrap();
                if u16_at(bytes, offset + 8).unwrap() == 0 {
                    return data.to_vec();
                }
                assert_eq!(u16_at(bytes, offset + 8).unwrap(), 8);
                let mut decoded = Vec::new();
                flate2::read::DeflateDecoder::new(data)
                    .read_to_end(&mut decoded)
                    .unwrap();
                return decoded;
            }
            offset = start + compressed_size;
        }
        panic!("归档缺少文件 {path}");
    }

    #[test]
    fn first_party_and_dependency_licenses_are_preserved_in_identical_packages() {
        let source = source();
        let license: &[u8] = include_bytes!("../../LICENSE");
        let dependency_license = "合成第三方许可文本，不被第一方 MIT 许可覆盖。\n".as_bytes();
        std::fs::write(source.path().join("LICENSE"), license).unwrap();
        std::fs::create_dir_all(source.path().join("licenses/example-dependency")).unwrap();
        std::fs::write(
            source.path().join("licenses/example-dependency/LICENSE"),
            dependency_license,
        )
        .unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = pack(source.path(), a.path(), PackageTarget::Web).unwrap();
        let second = pack(source.path(), b.path(), PackageTarget::Web).unwrap();
        let first_bytes = read_file(&a.path().join(first.filename), MAX_PACKAGE_BYTES).unwrap();
        let second_bytes = read_file(&b.path().join(second.filename), MAX_PACKAGE_BYTES).unwrap();
        assert_eq!(first_bytes, second_bytes);
        assert_eq!(first.sha256, second.sha256);
        assert_eq!(packed_file(&first_bytes, "LICENSE").as_slice(), license);
        assert_eq!(
            packed_file(&first_bytes, "licenses/example-dependency/LICENSE").as_slice(),
            dependency_license
        );
    }

    #[test]
    fn wrong_target_symlinks_and_metadata_are_rejected() {
        let source = source();
        let output = tempfile::tempdir().unwrap();
        assert!(pack(source.path(), output.path(), PackageTarget::LinuxArm64).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("index.html", source.path().join("page/link.html")).unwrap();
            assert!(pack(source.path(), output.path(), PackageTarget::Web).is_err());
        }
    }
    #[test]
    fn backend_architecture_is_not_trusted_from_metadata() {
        let source = source();
        std::fs::create_dir(source.path().join("backend")).unwrap();
        let mut manifest: Value = tgdrive_contract::validation::parse_unique_json(
            &std::fs::read(source.path().join("app.json")).unwrap(),
        )
        .unwrap();
        manifest["backend"] = serde_json::json!({"entry":"backend/app","run_mode":"resident"});
        std::fs::write(
            source.path().join("app.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::write(
            source.path().join("backend/app"),
            crate::elf::minimal_elf(PackageTarget::LinuxArm64),
        )
        .unwrap();
        let output = tempfile::tempdir().unwrap();
        assert!(pack(source.path(), output.path(), PackageTarget::LinuxAmd64).is_err());
        assert!(pack(source.path(), output.path(), PackageTarget::LinuxArm64).is_ok());
    }
    use serde_json::Value;
}
