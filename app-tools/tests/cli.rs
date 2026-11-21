use std::process::Command;

#[test]
fn cli_catalog_uses_real_release_packages_and_keeps_history() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let packages = temporary.path().join("packages");
    let output = temporary.path().join("catalog");
    std::fs::create_dir_all(source.join("page")).unwrap();
    std::fs::write(
        source.join("page/index.html"),
        "<!doctype html><title>测试</title>",
    )
    .unwrap();
    std::fs::write(source.join("app.json"), r#"{"id":"catalog-fixture","name":"目录工具测试","version":"1.0.0","contract":{"major":1,"minor":0},"description":"只用于自动化测试。","author":"开发者","page":{"entry":"page/index.html"}}"#).unwrap();
    let binary = env!("CARGO_BIN_EXE_tgapp");
    let pack = Command::new(binary)
        .args([
            "pack",
            source.to_str().unwrap(),
            packages.to_str().unwrap(),
            "web",
        ])
        .output()
        .unwrap();
    assert!(
        pack.status.success(),
        "{}",
        String::from_utf8_lossy(&pack.stderr)
    );
    let package = packages.join("catalog-fixture-1.0.0.tgapp");
    let build = Command::new(binary)
        .args([
            "catalog",
            "example/apps",
            output.to_str().unwrap(),
            package.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        build.status.success(),
        "{}",
        String::from_utf8_lossy(&build.stderr)
    );
    let checked = Command::new(binary)
        .args([
            "catalog-check",
            output.join("catalog.json").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        checked.status.success(),
        "{}",
        String::from_utf8_lossy(&checked.stderr)
    );
    assert!(output.join("catalog-history.json").is_file());
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(output.join("catalog.json")).unwrap()).unwrap();
    assert_eq!(
        value["entries"][0]["packages"]["web"]["url"],
        "https://github.com/example/apps/releases/download/catalog-fixture-v1.0.0/catalog-fixture-1.0.0.tgapp"
    );
    // 撤回不会清除历史；随后同版本换包仍会被拒绝。
    let withdrawn = Command::new(binary)
        .args(["catalog", "example/apps", output.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(withdrawn.status.success());
    std::fs::write(
        source.join("page/index.html"),
        "<!doctype html><title>不同内容</title>",
    )
    .unwrap();
    let different = temporary.path().join("different");
    assert!(
        Command::new(binary)
            .args([
                "pack",
                source.to_str().unwrap(),
                different.to_str().unwrap(),
                "web"
            ])
            .status()
            .unwrap()
            .success()
    );
    assert!(
        !Command::new(binary)
            .args([
                "catalog",
                "example/apps",
                output.to_str().unwrap(),
                different
                    .join("catalog-fixture-1.0.0.tgapp")
                    .to_str()
                    .unwrap()
            ])
            .status()
            .unwrap()
            .success()
    );
}
