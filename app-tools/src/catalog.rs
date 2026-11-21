use crate::{Result, invalid, protect_output, read_file, verify, write_atomic};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
use tgdrive_contract::{CATALOG_FORMAT, CONTRACT_VERSION, http::*, manifest::*, validation::*};

/// 私有发布历史不进入目录索引；撤回的绑定仍保存，避免删除后复用同版本。
#[derive(Serialize, Deserialize)]
struct History {
    repository: String,
    entries: Vec<CatalogEntry>,
}

pub fn check_catalog(path: &Path) -> Result<CatalogReadResult> {
    let bytes = read_file(path, MAX_CATALOG_BYTES)?;
    let value = parse_unique_json(&bytes)?;
    let repository = value
        .get("repository")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| invalid("目录缺少仓库标识"))?;
    Ok(parse_catalog_for_host(
        &bytes,
        repository,
        CONTRACT_VERSION,
        CAPABILITIES,
    )?)
}
fn read_history(path: &Path, repository: &str) -> Result<History> {
    if !path.exists() {
        return Ok(History {
            repository: repository.into(),
            entries: Vec::new(),
        });
    }
    let bytes = read_file(path, MAX_PACKAGE_EXPANDED_BYTES)?;
    let value = parse_unique_json(&bytes)?;
    if !value.is_object() {
        return Err(invalid("发布历史必须是对象"));
    }
    let history: History = serde_json::from_value(value)?;
    if history.repository != repository {
        return Err(invalid("发布历史属于其他仓库"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for entry in &history.entries {
        if !seen.insert((entry.manifest.id.clone(), entry.manifest.version.clone())) {
            return Err(invalid("发布历史包含重复版本"));
        }
    }
    for entries in history.entries.chunks(MAX_CATALOG_ENTRIES as usize) {
        validate_catalog(&Catalog {
            format: CATALOG_FORMAT,
            repository: repository.into(),
            entries: entries.to_vec(),
            extra: Default::default(),
        })?;
    }
    Ok(history)
}
fn transition(history: &History, catalog: &Catalog) -> Result<()> {
    for entries in history.entries.chunks(MAX_CATALOG_ENTRIES as usize) {
        validate_catalog_transition(
            &Catalog {
                format: CATALOG_FORMAT,
                repository: history.repository.clone(),
                entries: entries.to_vec(),
                extra: Default::default(),
            },
            catalog,
        )?;
    }
    Ok(())
}
fn previous_bindings_unchanged(history: &History, catalog: &Catalog) -> Result<()> {
    // 历史可能先于目录写入新版本；这里只检查已有身份绑定，不能用旧快照判断最高版本回退。
    for entry in &catalog.entries {
        if let Some(known) = history.entries.iter().find(|known| {
            known.manifest.id == entry.manifest.id
                && known.manifest.version == entry.manifest.version
        }) {
            validate_catalog_transition(
                &Catalog {
                    format: CATALOG_FORMAT,
                    repository: history.repository.clone(),
                    entries: vec![known.clone()],
                    extra: Default::default(),
                },
                &Catalog {
                    format: CATALOG_FORMAT,
                    repository: catalog.repository.clone(),
                    entries: vec![entry.clone()],
                    extra: Default::default(),
                },
            )?;
        }
    }
    Ok(())
}
fn remember(history: &mut History, catalog: &Catalog) {
    for entry in &catalog.entries {
        if let Some(previous) = history.entries.iter_mut().find(|previous| {
            previous.manifest.id == entry.manifest.id
                && previous.manifest.version == entry.manifest.version
        }) {
            previous.packages.extend(entry.packages.clone());
        } else {
            history.entries.push(entry.clone());
        }
    }
    history.entries.sort_by(|a, b| {
        a.manifest.id.cmp(&b.manifest.id).then_with(|| {
            stable_version(&a.manifest.version)
                .unwrap()
                .cmp(&stable_version(&b.manifest.version).unwrap())
        })
    });
}

pub fn build_catalog(
    repository: &str,
    output: &Path,
    packages: &[std::path::PathBuf],
) -> Result<Catalog> {
    protect_output(output)?;
    if !valid_repository(repository) {
        return Err(invalid("仓库标识必须为合法 GitHub owner/repo"));
    }
    let history_path = output.join("catalog-history.json");
    let catalog_path = output.join("catalog.json");
    let mut history = read_history(&history_path, repository)?;
    if catalog_path.exists() {
        let previous = check_catalog(&catalog_path)?;
        if !previous.incompatible.is_empty() {
            return Err(invalid("当前工具不能改写含未来契约版本条目的目录"));
        }
        if previous.catalog.repository != repository {
            return Err(invalid("既有目录属于其他仓库"));
        }
        previous_bindings_unchanged(&history, &previous.catalog)?;
        remember(&mut history, &previous.catalog);
    }
    let mut entries = BTreeMap::<(String, String), CatalogEntry>::new();
    for path in packages {
        let package = verify(path)?;
        if path.file_name().and_then(|name| name.to_str()) != Some(&package.filename) {
            return Err(invalid("包文件名与清单、版本和构建目标不匹配"));
        }
        let target = serde_json::to_value(package.package.target)?
            .as_str()
            .unwrap()
            .to_owned();
        let artifact = PackageArtifact {
            url: package_release_url(
                repository,
                &package.manifest.id,
                &package.manifest.version,
                &target,
            ),
            sha256: package.sha256,
            size: package.size,
            extra: Default::default(),
        };
        let key = (
            package.manifest.id.clone(),
            package.manifest.version.clone(),
        );
        let entry = entries.entry(key).or_insert_with(|| CatalogEntry {
            manifest: package.manifest.clone(),
            packages: BTreeMap::new(),
            extra: Default::default(),
        });
        if entry.manifest != package.manifest {
            return Err(invalid("同版本的不同架构必须有相同完整 app.json"));
        }
        if entry.packages.insert(target, artifact).is_some() {
            return Err(invalid("输入重复提供同版本同架构的包"));
        }
    }
    let catalog = Catalog {
        format: CATALOG_FORMAT,
        repository: repository.into(),
        entries: entries.into_values().collect(),
        extra: Default::default(),
    };
    validate_catalog(&catalog)?;
    transition(&history, &catalog)?;
    let mut bytes = serde_json::to_vec_pretty(&catalog)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err(invalid("规范化目录超过大小上限"));
    }
    remember(&mut history, &catalog);
    let mut historical = serde_json::to_vec_pretty(&history)?;
    historical.push(b'\n');
    // 先保存不可变绑定再更新目录；中途失败只会保守地记住新版本，不会遗失防篡改历史。
    write_atomic(&history_path, &historical, false)?;
    write_atomic(&catalog_path, &bytes, false)?;
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tgdrive_contract::ByteCount;
    fn entry(version: &str, digest: &str) -> CatalogEntry {
        let raw = format!(
            r#"{{"id":"example","name":"示例","version":"{version}","contract":{{"major":1,"minor":0}},"description":"测试","author":"开发者","page":{{"entry":"page/index.html"}}}}"#
        );
        CatalogEntry {
            manifest: parse_manifest(raw.as_bytes()).unwrap(),
            packages: BTreeMap::from([(
                "web".into(),
                PackageArtifact {
                    url: package_release_url("example/apps", "example", version, "web"),
                    sha256: digest.into(),
                    size: ByteCount(100),
                    extra: Default::default(),
                },
            )]),
            extra: Default::default(),
        }
    }
    struct RecoveryFixture {
        _temporary: tempfile::TempDir,
        expected: std::path::PathBuf,
        half: std::path::PathBuf,
        old_package: std::path::PathBuf,
        new_package: std::path::PathBuf,
        changed_package: std::path::PathBuf,
    }
    fn test_package(root: &Path, label: &str, version: &str, text: &str) -> std::path::PathBuf {
        let stage = root.join(format!("{label}-stage"));
        std::fs::create_dir_all(stage.join("page")).unwrap();
        std::fs::write(stage.join("page/index.html"), text).unwrap();
        std::fs::write(stage.join("app.json"), format!(r#"{{"id":"example","name":"目录恢复测试","version":"{version}","contract":{{"major":1,"minor":0}},"description":"只用于自动化恢复测试。","author":"开发者","page":{{"entry":"page/index.html"}}}}"#)).unwrap();
        let output = root.join(label);
        crate::pack(&stage, &output, PackageTarget::Web).unwrap();
        output.join(format!("example-{version}.tgapp"))
    }
    fn recovery_fixture() -> RecoveryFixture {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let old_package = test_package(root, "old-package", "1.0.0", "旧版本");
        let new_package = test_package(root, "new-package", "2.0.0", "新版本");
        let changed_package = test_package(root, "changed-package", "2.0.0", "不同字节的新版本");
        let baseline = root.join("baseline");
        build_catalog(
            "example/apps",
            &baseline,
            std::slice::from_ref(&old_package),
        )
        .unwrap();
        let expected = root.join("expected");
        std::fs::create_dir(&expected).unwrap();
        for name in ["catalog.json", "catalog-history.json"] {
            std::fs::copy(baseline.join(name), expected.join(name)).unwrap();
        }
        build_catalog(
            "example/apps",
            &expected,
            std::slice::from_ref(&new_package),
        )
        .unwrap();
        let half = root.join("half");
        std::fs::create_dir(&half).unwrap();
        // 模拟新历史已原子保存，但目录仍停在上一个版本。
        std::fs::copy(baseline.join("catalog.json"), half.join("catalog.json")).unwrap();
        std::fs::copy(
            expected.join("catalog-history.json"),
            half.join("catalog-history.json"),
        )
        .unwrap();
        RecoveryFixture {
            _temporary: temporary,
            expected,
            half,
            old_package,
            new_package,
            changed_package,
        }
    }
    #[test]
    fn retry_same_package_recovers_history_ahead_of_catalog_byte_for_byte() {
        let fixture = recovery_fixture();
        build_catalog(
            "example/apps",
            &fixture.half,
            std::slice::from_ref(&fixture.new_package),
        )
        .unwrap();
        for name in ["catalog.json", "catalog-history.json"] {
            assert_eq!(
                std::fs::read(fixture.half.join(name)).unwrap(),
                std::fs::read(fixture.expected.join(name)).unwrap()
            );
        }
    }
    #[test]
    fn history_ahead_of_catalog_still_rejects_changed_same_version_package() {
        let fixture = recovery_fixture();
        let before_catalog = std::fs::read(fixture.half.join("catalog.json")).unwrap();
        let before_history = std::fs::read(fixture.half.join("catalog-history.json")).unwrap();
        assert!(
            build_catalog(
                "example/apps",
                &fixture.half,
                std::slice::from_ref(&fixture.changed_package)
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read(fixture.half.join("catalog.json")).unwrap(),
            before_catalog
        );
        assert_eq!(
            std::fs::read(fixture.half.join("catalog-history.json")).unwrap(),
            before_history
        );
    }
    #[test]
    fn final_candidate_below_historical_highest_is_rejected_after_partial_write() {
        let fixture = recovery_fixture();
        assert!(
            build_catalog(
                "example/apps",
                &fixture.half,
                std::slice::from_ref(&fixture.old_package)
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read(fixture.half.join("catalog-history.json")).unwrap(),
            std::fs::read(fixture.expected.join("catalog-history.json")).unwrap()
        );
    }
    #[test]
    fn removed_bindings_remain_immutable_and_highest_never_regresses() {
        let old = entry("2.0.0", &"a".repeat(64));
        let history = History {
            repository: "example/apps".into(),
            entries: vec![old.clone()],
        };
        let mut catalog = Catalog {
            format: CATALOG_FORMAT,
            repository: "example/apps".into(),
            entries: Vec::new(),
            extra: Default::default(),
        };
        assert!(transition(&history, &catalog).is_ok());
        catalog.entries.push(entry("1.0.0", &"b".repeat(64)));
        assert!(transition(&history, &catalog).is_err());
        catalog.entries = vec![entry("2.0.0", &"b".repeat(64))];
        assert!(transition(&history, &catalog).is_err());
        catalog.entries = vec![old];
        assert!(transition(&history, &catalog).is_ok());
    }
}
