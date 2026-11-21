use crate::{Result, invalid};
use serde::Serialize;
use tgdrive_contract::manifest::PackageTarget;

#[derive(Debug, Serialize)]
pub struct ElfReport {
    pub target: PackageTarget,
    pub static_linked: bool,
    pub pie: bool,
}
fn u16_at(bytes: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or_else(|| invalid("ELF 被截断"))?
            .try_into()?,
    ))
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or_else(|| invalid("ELF 被截断"))?
            .try_into()?,
    ))
}
fn u64_at(bytes: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(
        bytes
            .get(offset..offset + 8)
            .ok_or_else(|| invalid("ELF 被截断"))?
            .try_into()?,
    ))
}
fn region(bytes: &[u8], offset: u64, length: u64) -> Result<&[u8]> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| invalid("ELF 区间溢出"))?;
    let (offset, end) = (usize::try_from(offset)?, usize::try_from(end)?);
    bytes
        .get(offset..end)
        .ok_or_else(|| invalid("ELF 区间超出文件"))
}

/// 检查真实 ELF 程序头及动态表，不依赖容器恰好具有某个共享库。
pub fn validate_elf(bytes: &[u8], target: PackageTarget) -> Result<ElfReport> {
    if bytes.len() < 64
        || bytes.get(..4) != Some(b"\x7fELF")
        || bytes[4] != 2
        || bytes[5] != 1
        || bytes[6] != 1
        || !matches!(bytes[7], 0 | 3)
    {
        return Err(invalid("后端必须为 64 位小端 Linux ELF"));
    }
    let machine = match target {
        PackageTarget::LinuxAmd64 => 62,
        PackageTarget::LinuxArm64 => 183,
        PackageTarget::Web => return Err(invalid("页面包不得包含后端")),
    };
    let kind = u16_at(bytes, 16)?;
    if !matches!(kind, 2 | 3)
        || u16_at(bytes, 18)? != machine
        || u32_at(bytes, 20)? != 1
        || u16_at(bytes, 52)? != 64
        || u16_at(bytes, 54)? != 56
    {
        return Err(invalid("ELF 架构、类型或标头不匹配"));
    }
    let offset = u64_at(bytes, 32)?;
    let count = u16_at(bytes, 56)?;
    if count == 0 || count == u16::MAX {
        return Err(invalid("ELF 必须带普通程序头表"));
    }
    region(bytes, offset, u64::from(count) * 56)?;
    let mut load = false;
    for index in 0..u64::from(count) {
        let header = usize::try_from(offset + index * 56)?;
        let kind = u32_at(bytes, header)?;
        let file_offset = u64_at(bytes, header + 8)?;
        let file_size = u64_at(bytes, header + 32)?;
        let memory_size = u64_at(bytes, header + 40)?;
        let data = region(bytes, file_offset, file_size)?;
        if kind == 3 {
            return Err(invalid("ELF 含 PT_INTERP，不是静态链接"));
        }
        if kind == 1 {
            load = true;
            if memory_size < file_size {
                return Err(invalid("ELF 载入段长度无效"));
            }
        }
        if kind == 2 {
            if data.len() % 16 != 0 {
                return Err(invalid("ELF 动态表长度无效"));
            }
            let mut terminated = false;
            for entry in data.chunks_exact(16) {
                let tag = u64_at(entry, 0)?;
                if tag == 0 {
                    terminated = true;
                    break;
                }
                if tag == 1 {
                    return Err(invalid("ELF 含 DT_NEEDED 动态依赖"));
                }
            }
            if !terminated {
                return Err(invalid("ELF 动态表缺少终止项"));
            }
        }
    }
    if !load {
        return Err(invalid("ELF 没有可载入段"));
    }
    Ok(ElfReport {
        target,
        static_linked: true,
        pie: kind == 3,
    })
}

#[cfg(test)]
pub(crate) fn minimal_elf(target: PackageTarget) -> Vec<u8> {
    let mut bytes = vec![0; 120];
    bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    bytes[16..18].copy_from_slice(&2u16.to_le_bytes());
    bytes[18..20].copy_from_slice(
        &(if target == PackageTarget::LinuxAmd64 {
            62u16
        } else {
            183u16
        })
        .to_le_bytes(),
    );
    bytes[20..24].copy_from_slice(&1u32.to_le_bytes());
    bytes[32..40].copy_from_slice(&64u64.to_le_bytes());
    bytes[52..54].copy_from_slice(&64u16.to_le_bytes());
    bytes[54..56].copy_from_slice(&56u16.to_le_bytes());
    bytes[56..58].copy_from_slice(&1u16.to_le_bytes());
    bytes[64..68].copy_from_slice(&1u32.to_le_bytes());
    bytes[96..104].copy_from_slice(&120u64.to_le_bytes());
    bytes[104..112].copy_from_slice(&120u64.to_le_bytes());
    bytes
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn architecture_and_dynamic_dependencies_are_checked() {
        let mut bytes = minimal_elf(PackageTarget::LinuxArm64);
        assert!(
            validate_elf(&bytes, PackageTarget::LinuxArm64)
                .unwrap()
                .static_linked
        );
        assert!(validate_elf(&bytes, PackageTarget::LinuxAmd64).is_err());
        bytes[64..68].copy_from_slice(&3u32.to_le_bytes());
        assert!(validate_elf(&bytes, PackageTarget::LinuxArm64).is_err());
        let mut bytes = minimal_elf(PackageTarget::LinuxAmd64);
        bytes[16..18].copy_from_slice(&1u16.to_le_bytes());
        assert!(validate_elf(&bytes, PackageTarget::LinuxAmd64).is_err());
    }
}
