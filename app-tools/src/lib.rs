//! 工具只处理应用开发者明确给出的本地输入，不下载、不上传、不发布 Release。
mod archive;
mod catalog;
mod elf;

pub use archive::{PackageReport, pack, verify, verify_bytes};
pub use catalog::{build_catalog, check_catalog};
pub use elf::{ElfReport, validate_elf};

use std::{io::Read, path::Path};
use tgdrive_contract::http::MAX_PACKAGE_BYTES;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub(crate) fn invalid(message: &str) -> Box<dyn std::error::Error + Send + Sync> {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message).into()
}
pub(crate) fn read_file(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(invalid("输入必须为大小受限的普通文件，不能是链接"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(invalid("输入不得为硬链接"));
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.len() > limit {
        return Err(invalid("打开后的输入不是受限普通文件"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.nlink() != 1 {
            return Err(invalid("打开后的输入不得为硬链接"));
        }
    }
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("实际读取大小超过上限"));
    }
    Ok(bytes)
}
pub(crate) fn protect_output(output: &Path) -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let absolute = if output.is_absolute() {
        output.to_path_buf()
    } else {
        std::env::current_dir()?.join(output)
    };
    // 工具绝不更新正在分发的旧根目录文件和 apps/。
    let mut normalized = std::path::PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut ancestor = normalized.clone();
    let mut tail = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| invalid("输出目录无效"))?
            .to_owned();
        tail.push(name);
        ancestor.pop();
    }
    let mut canonical = ancestor.canonicalize()?;
    for name in tail.into_iter().rev() {
        canonical.push(name);
    }
    if canonical == root || canonical.starts_with(root.join("apps")) {
        return Err(invalid("必须指定新的输出目录，不得覆盖根目录旧分发资产"));
    }
    Ok(())
}
pub(crate) fn write_atomic(path: &Path, bytes: &[u8], immutable: bool) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| invalid("输出路径没有目录"))?;
    std::fs::create_dir_all(parent)?;
    if immutable && path.exists() {
        if read_file(path, MAX_PACKAGE_BYTES)? == bytes {
            return Ok(());
        }
        return Err(invalid("同版本同目标的包不可变，修复必须升版本"));
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    if immutable {
        temp.persist_noclobber(path).map_err(|error| error.error)?;
    } else {
        if path.exists() {
            let metadata = std::fs::symlink_metadata(path)?;
            if !metadata.is_file() {
                return Err(invalid("目录输出目标不是普通文件"));
            }
        }
        temp.persist(path).map_err(|error| error.error)?;
    }
    Ok(())
}
