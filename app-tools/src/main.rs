use std::path::{Path, PathBuf};
use tgdrive_app_tools::{Result, build_catalog, check_catalog, pack, validate_elf, verify};
use tgdrive_contract::{http::MAX_PACKAGE_FILE_BYTES, manifest::PackageTarget};
fn target(value: &str) -> Result<PackageTarget> {
    Ok(serde_json::from_value(serde_json::Value::String(
        value.into(),
    ))?)
}
fn output<T: serde::Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str){
        Some("pack") if args.len()==4=>output(&pack(Path::new(&args[1]),Path::new(&args[2]),target(&args[3])?)?),
        Some("verify") if args.len()==2=>output(&verify(Path::new(&args[1]))?),
        Some("catalog") if args.len()>=3=>output(&build_catalog(&args[1],Path::new(&args[2]),&args[3..].iter().map(PathBuf::from).collect::<Vec<_>>())?),
        Some("catalog-check") if args.len()==2=>output(&check_catalog(Path::new(&args[1]))?),
        Some("elf") if args.len()==3=>{let file=std::fs::File::open(&args[1])?;use std::io::Read;let mut bytes=Vec::new();file.take(MAX_PACKAGE_FILE_BYTES+1).read_to_end(&mut bytes)?;if bytes.len() as u64>MAX_PACKAGE_FILE_BYTES{return Err("ELF 超过单文件上限".into());}output(&validate_elf(&bytes,target(&args[2])?)?)},
        _=>Err("用法：tgapp pack <编译后目录> <新输出目录> <target>；verify <包>；catalog <owner/repo> <新输出目录> [包...]；catalog-check <目录索引>；elf <可执行文件> <target>".into()),
    }
}
