use super::*;
use crate::{ByteCount, Timestamp};

fn page_manifest() -> Manifest {
    parse_manifest(
        r#"{
        "id":"sample","name":"示例应用","version":"1.0.0","contract":{"major":1,"minor":0},
        "description":"通用契约测试","author":"开发者","files":{"read":true,"write":false},
        "page":{"entry":"page/index.html"}
    }"#
        .as_bytes(),
    )
    .unwrap()
}

fn backend_manifest() -> Manifest {
    let mut manifest = page_manifest();
    manifest.files.write = true;
    manifest.backend = Some(BackendManifest {
        entry: BACKEND_ENTRY.into(),
        run_mode: RunMode::Resident,
        external_service: true,
        extra: Extensions::new(),
    });
    manifest
}

fn catalog_entry(manifest: Manifest) -> CatalogEntry {
    let targets = if manifest.backend.is_some() {
        vec!["linux-amd64", "linux-arm64"]
    } else {
        vec!["web"]
    };
    let packages = targets
        .into_iter()
        .map(|target| {
            (
                target.into(),
                PackageArtifact {
                    url: package_release_url(
                        "example/apps",
                        &manifest.id,
                        &manifest.version,
                        target,
                    ),
                    sha256: "a".repeat(64),
                    size: ByteCount(100),
                    extra: Extensions::new(),
                },
            )
        })
        .collect();
    CatalogEntry {
        manifest,
        packages,
        extra: Extensions::new(),
    }
}

fn catalog(entries: Vec<CatalogEntry>) -> Catalog {
    Catalog {
        format: CATALOG_FORMAT,
        repository: "example/apps".into(),
        entries,
        extra: Extensions::new(),
    }
}

fn regular(path: &str, size: u64) -> ArchiveEntry {
    ArchiveEntry {
        path: path.into(),
        kind: ArchiveEntryKind::File,
        expanded_size: size,
        compression: ArchiveCompression::Deflate,
        encrypted: false,
    }
}

/// 已发布的旧包仍带资源请求：它只是普通扩展字段，原样保留，不影响安装也没有任何效力。
#[test]
fn legacy_backend_resource_request_is_an_inert_extension() {
    let raw = r#"{
        "id":"sample","name":"示例","version":"1.0.0","contract":{"major":1,"minor":0},
        "description":"测试","author":"开发者","files":{"read":true,"write":false},
        "backend":{"entry":"backend/app","run_mode":"resident","external_service":true,
            "resources":{"memory_bytes":"536870912","cpu_millis":1000,"pids":64}}
    }"#;
    let manifest = parse_manifest(raw.as_bytes()).unwrap();
    let backend = manifest.backend.as_ref().unwrap();
    assert_eq!(backend.extra["resources"]["memory_bytes"], "536870912");
    let roundtrip = parse_manifest(&serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert_eq!(roundtrip, manifest);
}

#[test]
fn manifest_keeps_unknown_optional_fields_without_granting_permissions() {
    let raw = r#"{
        "id":"sample","name":"示例","version":"1.0.0","contract":{"major":1,"minor":0},
        "description":"测试","author":"开发者","files":{"read":false,"future_write":true},
        "page":{"entry":"page/index.html","future_style":{"x":1}},"future_badge":"新能力"
    }"#;
    let manifest = parse_manifest(raw.as_bytes()).unwrap();
    assert!(!manifest.files.write);
    assert_eq!(manifest.files.extra["future_write"], true);
    assert_eq!(
        manifest.page.as_ref().unwrap().extra["future_style"]["x"],
        1
    );
    assert_eq!(manifest.extra["future_badge"], "新能力");
    let roundtrip = parse_manifest(&serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert_eq!(roundtrip, manifest);
}

#[test]
fn manifest_rejects_invalid_identity_entries_and_permission_combinations() {
    type ManifestChange = (&'static str, Box<dyn Fn(&mut Manifest)>);
    let cases: Vec<ManifestChange> = vec![
        ("id", Box::new(|manifest| manifest.id = "../host".into())),
        (
            "version",
            Box::new(|manifest| manifest.version = "01.0.0".into()),
        ),
        (
            "version",
            Box::new(|manifest| manifest.version = "1.0.0-beta".into()),
        ),
        (
            "version",
            Box::new(|manifest| manifest.version = "1.0.0+rebuild".into()),
        ),
        (
            "files",
            Box::new(|manifest| {
                manifest.files.read = false;
                manifest.files.write = true;
            }),
        ),
        (
            "page.entry",
            Box::new(|manifest| manifest.page.as_mut().unwrap().entry = "../index.html".into()),
        ),
        ("page/backend", Box::new(|manifest| manifest.page = None)),
        ("name", Box::new(|manifest| manifest.name = "\n".into())),
        (
            "open_with.extensions",
            Box::new(|manifest| manifest.open_with.extensions = vec!["epub".into(), "epub".into()]),
        ),
    ];
    for (field, update) in cases {
        let mut manifest = page_manifest();
        update(&mut manifest);
        assert_eq!(validate_manifest(&manifest).unwrap_err().field, field);
    }
    let mut manifest = backend_manifest();
    manifest.backend.as_mut().unwrap().entry = "page/script.js".into();
    assert!(validate_manifest(&manifest).is_err());
}

#[test]
fn duplicate_json_keys_and_unsafe_numbers_are_rejected_at_every_depth() {
    for raw in [
        r#"{"id":"sample","id":"other"}"#,
        r#"{"future":{"x":1,"x":2}}"#,
        r#"{"future":9007199254740993}"#,
        r#"{"future":1e99}"#,
        r#"{"future":18446744073709551616}"#,
        r#"{} {}"#,
    ] {
        assert!(parse_unique_json(raw.as_bytes()).is_err(), "不应接受 {raw}");
    }
    assert!(parse_unique_json(br#"{"x":9007199254740991,"y":1.5,"a":[true,null]}"#).is_ok());
    let raw = serde_json::json!(["sample", "示例", "1.0.0"]);
    assert!(parse_manifest(&serde_json::to_vec(&raw).unwrap()).is_err());
}

#[test]
fn compatibility_is_minimum_minor_plus_required_capabilities() {
    let mut manifest = page_manifest();
    assert!(
        check_manifest_compatibility(
            &manifest,
            ContractVersion { major: 1, minor: 5 },
            CAPABILITIES
        )
        .is_ok()
    );
    manifest.contract.minor = 1;
    assert_eq!(
        check_manifest_compatibility(&manifest, CONTRACT_VERSION, CAPABILITIES)
            .unwrap_err()
            .code,
        error_code::INCOMPATIBLE_CONTRACT
    );
    manifest.contract.minor = 0;
    manifest.required_capabilities.push("future.feature".into());
    assert!(validate_manifest(&manifest).is_ok());
    assert_eq!(
        check_manifest_compatibility(&manifest, CONTRACT_VERSION, CAPABILITIES)
            .unwrap_err()
            .code,
        error_code::CAPABILITY_UNAVAILABLE
    );
}

#[test]
fn catalog_requires_both_native_architectures_and_exact_release_urls() {
    let valid = catalog(vec![
        catalog_entry(backend_manifest()),
        catalog_entry({
            let mut page = page_manifest();
            page.id = "reader".into();
            page
        }),
    ]);
    validate_catalog(&valid).unwrap();
    let mut bad = valid.clone();
    bad.entries[0].packages.remove("linux-arm64");
    assert!(validate_catalog(&bad).is_err());
    let mut bad = valid.clone();
    bad.entries[0]
        .packages
        .get_mut("linux-amd64")
        .unwrap()
        .url
        .push_str("?token=x");
    assert!(validate_catalog(&bad).is_err());
    let mut bad = valid.clone();
    bad.entries[0]
        .packages
        .get_mut("linux-amd64")
        .unwrap()
        .sha256 = "A".repeat(64);
    assert!(validate_catalog(&bad).is_err());
    let mut bad = valid.clone();
    bad.entries[0].packages.get_mut("linux-amd64").unwrap().size = ByteCount(MAX_PACKAGE_BYTES + 1);
    assert!(validate_catalog(&bad).is_err());
    let mut bad = valid.clone();
    bad.entries.push(bad.entries[0].clone());
    assert!(validate_catalog(&bad).is_err());
}

#[test]
fn catalog_reader_skips_future_manifests_before_interpreting_their_fields() {
    let valid = catalog(vec![catalog_entry(page_manifest())]);
    let mut raw = serde_json::to_value(&valid).unwrap();
    let mut future = raw["entries"][0].clone();
    future["manifest"]["id"] = "future".into();
    future["manifest"]["contract"]["major"] = 2.into();
    future["manifest"]["page"] = serde_json::json!(["未来完全不同的页面格式"]);
    future["packages"]["web"]["url"] =
        package_release_url("example/apps", "future", "1.0.0", "web").into();
    future["packages"]["web"]["size"] = (MAX_PACKAGE_BYTES + 1).to_string().into();
    raw["entries"].as_array_mut().unwrap().push(future);
    let parsed = parse_catalog_for_host(
        &serde_json::to_vec(&raw).unwrap(),
        "example/apps",
        CONTRACT_VERSION,
        CAPABILITIES,
    )
    .unwrap();
    assert_eq!(parsed.catalog.entries.len(), 1);
    assert_eq!(parsed.incompatible[0].id, "future");
    assert_eq!(
        parsed.incompatible[0].reason,
        error_code::INCOMPATIBLE_CONTRACT
    );
    assert!(
        parse_catalog_for_host(
            &serde_json::to_vec(&raw).unwrap(),
            "other/apps",
            CONTRACT_VERSION,
            CAPABILITIES
        )
        .is_err()
    );
}

#[test]
fn catalog_preserves_older_versions_for_older_hosts() {
    let old = catalog_entry(page_manifest());
    let mut manifest = page_manifest();
    manifest.version = "2.0.0".into();
    manifest.contract.minor = 1;
    let new = catalog_entry(manifest);
    let all = catalog(vec![old, new]);
    validate_catalog(&all).unwrap();
    let parsed = parse_catalog_for_host(
        &serde_json::to_vec(&all).unwrap(),
        "example/apps",
        CONTRACT_VERSION,
        CAPABILITIES,
    )
    .unwrap();
    assert_eq!(parsed.catalog.entries.len(), 1);
    assert_eq!(parsed.catalog.entries[0].manifest.version, "1.0.0");
}

#[test]
fn same_version_is_immutable_including_unknown_manifest_fields() {
    let previous = catalog(vec![catalog_entry(page_manifest())]);
    let mut changed = previous.clone();
    changed.entries[0]
        .manifest
        .extra
        .insert("future_badge".into(), true.into());
    assert_eq!(
        validate_catalog_transition(&previous, &changed)
            .unwrap_err()
            .code,
        error_code::PACKAGE_CHANGED
    );
    let mut changed = previous.clone();
    changed.entries[0].packages.get_mut("web").unwrap().sha256 = "b".repeat(64);
    assert_eq!(
        validate_catalog_transition(&previous, &changed)
            .unwrap_err()
            .code,
        error_code::PACKAGE_CHANGED
    );
    let mut newer = page_manifest();
    newer.version = "1.1.0".into();
    let newer = catalog(vec![catalog_entry(newer)]);
    assert!(validate_catalog_transition(&previous, &newer).is_ok());
    assert!(validate_catalog_transition(&newer, &previous).is_err());
    assert!(validate_catalog_transition(&previous, &catalog(vec![])).is_ok());
}

#[test]
fn package_layout_rejects_link_bombs_duplicates_and_missing_entrypoints() {
    let manifest = page_manifest();
    let metadata = PackageMetadata {
        format: PACKAGE_FORMAT,
        target: PackageTarget::Web,
        extra: Extensions::new(),
    };
    let valid = vec![
        regular("app.json", 100),
        regular("package.json", 100),
        regular("page/index.html", 100),
    ];
    validate_archive_layout(&manifest, &metadata, &valid).unwrap();
    for entry in [
        regular("../host.db", 100),
        regular("page/INDEX.html", 100),
        regular("page/huge.bin", MAX_PACKAGE_FILE_BYTES + 1),
        ArchiveEntry {
            kind: ArchiveEntryKind::LinkOrSpecial,
            ..regular("page/link", 0)
        },
        ArchiveEntry {
            encrypted: true,
            ..regular("page/private", 10)
        },
        ArchiveEntry {
            compression: ArchiveCompression::Unsupported,
            ..regular("page/new", 10)
        },
    ] {
        let mut bad = valid.clone();
        bad.push(entry);
        assert!(validate_archive_layout(&manifest, &metadata, &bad).is_err());
    }
    let mut missing = valid.clone();
    missing.pop();
    assert!(validate_archive_layout(&manifest, &metadata, &missing).is_err());
    let wrong_target = PackageMetadata {
        target: PackageTarget::LinuxArm64,
        ..metadata.clone()
    };
    assert!(validate_archive_layout(&manifest, &wrong_target, &valid).is_err());
    let mut conflict = valid;
    conflict.push(regular("assets/file", 1));
    conflict.push(regular("assets/file/child", 1));
    assert!(validate_archive_layout(&manifest, &metadata, &conflict).is_err());
    let mut case_conflict = conflict;
    case_conflict.last_mut().unwrap().path = "assets/FILE/child".into();
    assert!(validate_archive_layout(&manifest, &metadata, &case_conflict).is_err());
}

#[test]
fn authorization_is_id_ancestry_not_path_prefix_and_overlaps_form_a_union() {
    let permissions = FilePermissions {
        read: true,
        write: true,
        extra: Extensions::new(),
    };
    let scope = DirectoryScope::Selected {
        directories: vec![
            DirectoryGrant {
                directory_id: "12".into(),
                access: AccessLevel::ReadOnly,
            },
            DirectoryGrant {
                directory_id: "34".into(),
                access: AccessLevel::ReadWrite,
            },
        ],
    };
    validate_scope(&scope, &permissions).unwrap();
    assert_eq!(
        effective_access(&scope, &permissions, &["35", "34", "12", "1"]),
        Some(AccessLevel::ReadWrite)
    );
    assert_eq!(
        effective_access(&scope, &permissions, &["36", "12", "1"]),
        Some(AccessLevel::ReadOnly)
    );
    assert_eq!(effective_access(&scope, &permissions, &["120", "1"]), None);
    assert_eq!(
        effective_access(&DirectoryScope::None, &permissions, &["12", "1"]),
        None
    );
    let read_only = FilePermissions {
        write: false,
        ..permissions.clone()
    };
    assert_eq!(
        validate_scope(&scope, &read_only).unwrap_err().code,
        error_code::WRITE_NOT_DECLARED
    );
    assert_eq!(
        effective_access(&scope, &read_only, &["35", "34", "12", "1"]),
        Some(AccessLevel::ReadOnly)
    );
    let empty = DirectoryScope::Selected {
        directories: vec![],
    };
    assert!(validate_scope(&empty, &permissions).is_err());
}

#[test]
fn query_filters_and_random_bounds_are_explicit() {
    let mut query: FileQuery = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(query.limit, 200);
    assert!(query.recursive);
    validate_file_query(&query).unwrap();
    query.limit = 501;
    assert!(validate_file_query(&query).is_err());
    query.limit = 200;
    query.filter.extensions = vec![".EPUB".into()];
    assert!(validate_file_query(&query).is_err());
    query.filter.extensions = vec!["epub".into(), "tar.gz".into()];
    query.filter.size = Some(SizeBounds {
        min: Some(ByteCount(20)),
        max: Some(ByteCount(10)),
    });
    assert!(validate_file_query(&query).is_err());
    query.filter.size = None;
    query.filter.created_at = Some(TimeBounds {
        from: Some(Timestamp(-1)),
        to: None,
    });
    assert!(validate_file_query(&query).is_err());
    let mut random: RandomFilesRequest = serde_json::from_value(serde_json::json!({})).unwrap();
    validate_random_request(&random).unwrap();
    random.limit = 65;
    assert!(validate_random_request(&random).is_err());
}

#[test]
fn ranges_cover_empty_open_suffix_clamping_and_overflow_cases() {
    assert_eq!(
        resolve_single_range(None, 0).unwrap(),
        ResolvedRange {
            start: 0,
            length: 0,
            partial: false
        }
    );
    assert_eq!(
        resolve_single_range(Some("bytes=2-5"), 10).unwrap(),
        ResolvedRange {
            start: 2,
            length: 4,
            partial: true
        }
    );
    assert_eq!(
        resolve_single_range(Some("bytes=8-99"), 10).unwrap().length,
        2
    );
    assert_eq!(resolve_single_range(Some("bytes=7-"), 10).unwrap().start, 7);
    assert_eq!(resolve_single_range(Some("bytes=-3"), 10).unwrap().start, 7);
    assert_eq!(
        resolve_single_range(Some("bytes=-99"), 10).unwrap().start,
        0
    );
    assert_eq!(
        resolve_single_range(Some("bytes=0-"), u64::MAX)
            .unwrap()
            .length,
        u64::MAX
    );
    for header in [
        "bytes=-0",
        "bytes=10-",
        "bytes=5-4",
        "bytes=0-1,5-6",
        "items=0-1",
        "bytes=+1-2",
        "bytes=18446744073709551616-",
    ] {
        assert_eq!(
            resolve_single_range(Some(header), 10).unwrap_err().code,
            error_code::RANGE_NOT_SATISFIABLE
        );
    }
    assert!(resolve_single_range(Some("bytes=0-0"), 0).is_err());
}

#[test]
fn local_ranges_clip_to_the_starting_balance_without_reserving_a_window() {
    for (header, size, budget, expected) in [
        (
            None,
            100,
            100,
            ResolvedRange {
                start: 0,
                length: 100,
                partial: false,
            },
        ),
        (
            None,
            100,
            10,
            ResolvedRange {
                start: 0,
                length: 10,
                partial: true,
            },
        ),
        (
            Some("bytes=0-"),
            100,
            10,
            ResolvedRange {
                start: 0,
                length: 10,
                partial: true,
            },
        ),
        (
            Some("bytes=50-"),
            100,
            10,
            ResolvedRange {
                start: 50,
                length: 10,
                partial: true,
            },
        ),
        (
            Some("bytes=90-99"),
            100,
            20,
            ResolvedRange {
                start: 90,
                length: 10,
                partial: true,
            },
        ),
        (
            Some("bytes=-20"),
            100,
            10,
            ResolvedRange {
                start: 80,
                length: 10,
                partial: true,
            },
        ),
        (
            None,
            0,
            1,
            ResolvedRange {
                start: 0,
                length: 0,
                partial: false,
            },
        ),
        (
            None,
            u64::MAX,
            u64::MAX,
            ResolvedRange {
                start: 0,
                length: u64::MAX,
                partial: false,
            },
        ),
    ] {
        assert_eq!(resolve_local_range(header, size, budget).unwrap(), expected);
    }
    let empty_budget = resolve_local_range(Some("bytes=0-"), 100, 0).unwrap_err();
    assert_eq!(empty_budget.code, error_code::QUOTA_EXCEEDED);
    assert_eq!(empty_budget.field, "byte_budget");
    for header in ["bytes=0-1,5-6", "bytes=100-", "bytes=-0"] {
        assert_eq!(
            resolve_local_range(Some(header), 100, 10).unwrap_err().code,
            error_code::RANGE_NOT_SATISFIABLE
        );
    }
}

#[test]
fn local_range_planning_allows_seek_while_an_open_window_still_exists() {
    let remaining = DEFAULT_LOCAL_BYTE_BUDGET;
    let size = remaining * 4;
    let open = resolve_local_range(Some("bytes=0-"), size, remaining).unwrap();
    assert_eq!(open.length, remaining);
    // 窗口只是响应头计划，不是余额预留；这里只模拟已拉取一小块之后的下一次规划。
    let after_one_block = remaining - 4096;
    let seek = resolve_local_range(Some("bytes=33554432-33558527"), size, after_one_block).unwrap();
    assert_eq!(seek.start, 33_554_432);
    assert_eq!(seek.length, 4096);
    assert!(seek.partial);
    assert_eq!(open.length, remaining);
}

#[test]
fn stream_directive_rejects_header_injection_and_invalid_windows() {
    let valid: StreamDirective = serde_json::from_value(serde_json::json!({
        "file":{"id":"42","content_version":"v1"},"content_type":"video/mp4", "filename":"演示.mp4",
        "window":{"offset":"10","length":"20"},"correlation_id":"play-1"
    }))
    .unwrap();
    validate_stream_directive(&valid, 30).unwrap();
    let mut invalid_reference = valid.clone();
    invalid_reference.file.id = "0".into();
    assert_eq!(
        validate_stream_directive(&invalid_reference, 30)
            .unwrap_err()
            .code,
        error_code::INVALID_BACKEND_RESPONSE
    );
    assert!(validate_stream_directive(&valid, 29).is_err());
    let mut bad = valid.clone();
    bad.filename = Some("x\r\nSet-Cookie: x".into());
    assert!(validate_stream_directive(&bad, 30).is_err());
    let mut bad = valid.clone();
    bad.content_type = Some("video/mp4\r\nX-Header: bad".into());
    assert!(validate_stream_directive(&bad, 30).is_err());
    let mut bad = valid;
    bad.window = Some(ByteWindow {
        offset: ByteCount(u64::MAX),
        length: ByteCount(1),
    });
    assert!(validate_stream_directive(&bad, u64::MAX).is_err());
}

#[test]
fn negotiation_accepts_old_backends_on_new_hosts() {
    let old = ContractVersion { major: 1, minor: 0 };
    let new = ContractVersion { major: 1, minor: 2 };
    assert_eq!(negotiate_contract(new, old, old).unwrap(), old);
    assert_eq!(negotiate_contract(old, new, old).unwrap(), old);
    assert!(negotiate_contract(old, new, new).is_err());
    assert!(negotiate_contract(new, ContractVersion { major: 2, minor: 0 }, old).is_err());
}

#[test]
fn package_metadata_is_object_shaped_and_extensible() {
    let metadata =
        parse_package_metadata(br#"{"format":{"major":1,"minor":1},"target":"web","future":true}"#)
            .unwrap();
    assert_eq!(metadata.extra["future"], true);
    for raw in [
        r#"{"format":{"major":1,"minor":0},"target":"web","target":"linux-amd64"}"#,
        r#"{"format":{"major":2,"minor":0},"target":"web"}"#,
        r#"{"format":[1,0],"target":"web"}"#,
        r#"[{"major":1,"minor":0},"web"]"#,
    ] {
        assert!(parse_package_metadata(raw.as_bytes()).is_err());
    }
}

#[test]
fn cache_response_header_uses_cache_entry_with_full_object_budget() {
    let entry = crate::data::CacheEntry {
        key: "k".repeat(128),
        content_type: format!("a/b;p=\"{}\"", "\\\\".repeat(123)),
        size: ByteCount(MAX_CACHE_OBJECT_BYTES),
        revision: "r".repeat(128),
        metadata: Value::String("x".repeat(MAX_CACHE_METADATA_BYTES as usize - 2)),
        updated_at: Timestamp(9_007_199_254_740_991),
    };
    validate_cache_entry_header(&entry).unwrap();
    let json = serde_json::to_vec(&entry).unwrap();
    assert!(json.len() > MAX_CACHE_METADATA_BYTES as usize);
    assert!(json.len() <= MAX_CACHE_ENTRY_HEADER_JSON_BYTES as usize);
    assert!((json.len() * 4).div_ceil(3) <= MAX_CACHE_ENTRY_HEADER_BYTES as usize);
    assert_eq!(
        crate::data::CacheEntry::METADATA_HEADER,
        CACHE_METADATA_HEADER
    );
    assert_eq!(crate::data::CacheEntry::HEADER_JSON_MAX_BYTES, 5120);
    assert_eq!(crate::data::CacheEntry::HEADER_VALUE_MAX_BYTES, 6827);
    let decoded: crate::data::CacheEntry = serde_json::from_slice(&json).unwrap();
    assert_eq!(decoded, entry);
    let hit = crate::data::CacheHit {
        entry: entry.clone(),
        url: "/admin/api/apps/v1/cache-media/test-ticket".into(),
        expires_at: Timestamp(1),
    };
    assert_eq!(
        serde_json::to_value(&hit).unwrap()["entry"],
        serde_json::to_value(&entry).unwrap()
    );
}

#[test]
fn cache_header_limits_count_utf8_and_reject_invalid_entry_fields() {
    let valid = crate::data::CacheEntry {
        key: "entry-1".into(),
        content_type: "image/png".into(),
        size: ByteCount(1),
        revision: "r1".into(),
        metadata: Value::String("汉".repeat(1364)),
        updated_at: Timestamp(1),
    };
    validate_cache_entry_header(&valid).unwrap();
    let mut oversized = valid.clone();
    oversized.metadata = Value::String("汉".repeat(1365));
    assert_eq!(
        validate_cache_entry_header(&oversized).unwrap_err().code,
        error_code::PAYLOAD_TOO_LARGE
    );
    let mut bad_revision = valid.clone();
    bad_revision.revision = "r".repeat(129);
    assert!(validate_cache_entry_header(&bad_revision).is_err());
    let mut bad_mime = valid;
    bad_mime.content_type = "image/png\r\nX-Bad: true".into();
    assert!(validate_cache_entry_header(&bad_mime).is_err());
}

#[test]
fn json_request_response_and_page_budgets_are_separate() {
    let larger_than_request = serde_json::json!({"payload":"x".repeat(70 * 1024)});
    assert_eq!(
        validate_json_request(&larger_than_request)
            .unwrap_err()
            .code,
        error_code::PAYLOAD_TOO_LARGE
    );
    validate_json_response(&larger_than_request).unwrap();
    let over_response = Value::String("x".repeat(MAX_JSON_RESPONSE_BYTES as usize));
    assert_eq!(
        validate_json_response(&over_response).unwrap_err().code,
        error_code::PAYLOAD_TOO_LARGE
    );
    let single_over_page = [Value::String("x".repeat(MAX_JSON_PAGE_BYTES as usize))];
    assert_eq!(
        json_page_prefix_count(&single_over_page, 1, MAX_JSON_PAGE_BYTES)
            .unwrap_err()
            .code,
        error_code::PAYLOAD_TOO_LARGE
    );
    assert_eq!(MAX_JSON_REQUEST_BYTES, 65_536);
    assert_eq!(MAX_JSON_RESPONSE_BYTES, 2_097_152);
    assert_eq!(MAX_JSON_PAGE_BYTES, 524_288);
}

#[test]
fn kv_byte_pages_return_a_continuous_prefix_not_a_truncated_list() {
    let records: Vec<_> = (0..200)
        .map(|index| crate::data::KvRecord {
            key: format!("key-{index:04}"),
            value: Value::String("x".repeat(MAX_KV_VALUE_BYTES as usize - 2)),
            revision: "r".repeat(128),
            updated_at: Timestamp(1),
        })
        .collect();
    let count = json_page_prefix_count(&records, 200, MAX_JSON_PAGE_BYTES).unwrap();
    assert_eq!(
        json_page_prefix_count(&records, 200, MIN_JSON_PAGE_BYTES).unwrap(),
        1
    );
    assert!(json_page_prefix_count(&records, 200, MIN_JSON_PAGE_BYTES - 1).is_err());
    assert_eq!(count, 15);
    validate_json_page(&records[..count], MAX_JSON_PAGE_BYTES).unwrap();
    assert!(validate_json_page(&records[..count + 1], MAX_JSON_PAGE_BYTES).is_err());
    let next_count = json_page_prefix_count(&records[count..], 200, MAX_JSON_PAGE_BYTES).unwrap();
    assert_eq!(records[count].key, "key-0015");
    assert_eq!(next_count, 15);
    let page = crate::data::KvPage {
        records: records[..count].to_vec(),
        next_cursor: Some("next-key-0014".into()),
    };
    validate_json_response(&page).unwrap();
}

#[test]
fn maximum_file_nodes_and_scope_envelopes_fit_the_response_budget() {
    let component = "\"".repeat(255);
    let path = format!("/{}", vec![component.clone(); 16].join("/"));
    assert_eq!(path.len(), 4096);
    let node = FileNode {
        id: i64::MAX.to_string(),
        parent_id: Some((i64::MAX - 1).to_string()),
        name: component,
        path,
        kind: NodeKind::File,
        size: ByteCount(i64::MAX as u64),
        created_at: Timestamp(9_007_199_254_740_991),
        modified_at: Timestamp(9_007_199_254_740_991),
        revision: "r".repeat(128),
        content_version: Some("v".repeat(128)),
        children_revision: None,
        has_thumbnail: false,
    };
    validate_file_node_size(&node).unwrap();
    let nodes = vec![node.clone(); 500];
    let count = json_page_prefix_count(&nodes, 500, MAX_JSON_PAGE_BYTES).unwrap();
    assert!((1..500).contains(&count));
    let page = FilePage {
        items: nodes[..count].to_vec(),
        next_cursor: Some("\u{0}".repeat(4096)),
        scan_cursor: "\u{0}".repeat(4096),
        scope_revision: "s".repeat(128),
    };
    validate_json_response(&page).unwrap();
    let roots: Vec<_> = (0..128)
        .map(|index| {
            let mut directory = node.clone();
            directory.id = (i64::MAX - index).to_string();
            directory.kind = NodeKind::Directory;
            directory.size = ByteCount(0);
            directory.content_version = None;
            directory.children_revision = Some("c".repeat(128));
            AuthorizedRoot {
                directory_id: directory.id.clone(),
                access: AccessLevel::ReadOnly,
                node: Some(directory),
            }
        })
        .collect();
    let scope = ScopeInfo {
        revision: "s".repeat(128),
        scope: DirectoryScope::Selected {
            directories: roots
                .iter()
                .map(|root| DirectoryGrant {
                    directory_id: root.directory_id.clone(),
                    access: root.access,
                })
                .collect(),
        },
        roots,
    };
    validate_json_response(&scope).unwrap();
    let envelope = serde_json::json!({"scope":scope,"files":{"read":true,"write":false,"extra_padding":"x".repeat(64 * 1024)},"padding":"x".repeat(64 * 1024)});
    validate_json_response(&envelope).unwrap();
}

#[test]
fn ui_inputs_share_exported_byte_bounds_and_u32_progress_type() {
    use crate::ui::*;
    let title = UiRequest::SetTitle(TitleRequest {
        title: "汉".repeat(MAX_UI_TITLE_BYTES as usize / 3),
    });
    validate_ui_request(&title).unwrap();
    assert!(
        validate_ui_request(&UiRequest::SetTitle(TitleRequest {
            title: "汉".repeat(MAX_UI_TITLE_BYTES as usize / 3 + 1)
        }))
        .is_err()
    );
    let reason = UiRequest::RequestScope(ScopeAuthorizationRequest {
        reason: "r".repeat(MAX_AUTHORIZATION_REASON_BYTES as usize),
        preferred_access: AccessLevel::ReadOnly,
    });
    validate_ui_request(&reason).unwrap();
    assert!(
        validate_ui_request(&UiRequest::RequestScope(ScopeAuthorizationRequest {
            reason: "r".repeat(MAX_AUTHORIZATION_REASON_BYTES as usize + 1),
            preferred_access: AccessLevel::ReadOnly
        }))
        .is_err()
    );
    let task = TaskProgress {
        id: "t".repeat(MAX_TASK_ID_BYTES as usize),
        title: "t".repeat(MAX_TASK_TITLE_BYTES as usize),
        completed: MAX_TASK_PROGRESS as u32,
        total: Some(MAX_TASK_PROGRESS as u32),
        state: TaskState::Completed,
        cancellable: false,
    };
    validate_ui_request(&UiRequest::Task(task.clone())).unwrap();
    let mut bad_id = task.clone();
    bad_id.id.push('t');
    assert!(validate_ui_request(&UiRequest::Task(bad_id)).is_err());
    let mut bad_title = task.clone();
    bad_title.title.push('t');
    assert!(validate_ui_request(&UiRequest::Task(bad_title)).is_err());
    let mut overflow = serde_json::to_value(task).unwrap();
    overflow["completed"] = Value::from(MAX_TASK_PROGRESS + 1);
    assert!(serde_json::from_value::<TaskProgress>(overflow).is_err());
    validate_ui_request(&UiRequest::SetImmersive(ImmersiveRequest {
        active: true,
        background: Some("#012aFF".into()),
    }))
    .unwrap();
    assert!(
        validate_ui_request(&UiRequest::SetImmersive(ImmersiveRequest {
            active: true,
            background: Some("#012AFF00".into())
        }))
        .is_err()
    );
}

#[test]
fn identifiers_use_one_exported_numeric_and_length_bound() {
    assert!(valid_node_id(&MAX_NODE_ID.to_string()));
    assert!(!valid_node_id(&(MAX_NODE_ID + 1).to_string()));
    assert!(valid_opaque_id(&"x".repeat(MAX_OPAQUE_ID_BYTES as usize)));
    assert!(!valid_opaque_id(
        &"x".repeat(MAX_OPAQUE_ID_BYTES as usize + 1)
    ));
    assert!(valid_operation_id(
        &"x".repeat(MAX_OPERATION_ID_BYTES as usize)
    ));
    assert!(!valid_operation_id(
        &"x".repeat(MAX_OPERATION_ID_BYTES as usize + 1)
    ));
    assert!(valid_idempotency_key(
        &"x".repeat(MIN_IDEMPOTENCY_KEY_BYTES as usize)
    ));
    assert!(!valid_idempotency_key(
        &"x".repeat(MIN_IDEMPOTENCY_KEY_BYTES as usize - 1)
    ));
    assert!(valid_extension(&"x".repeat(MAX_EXTENSION_BYTES as usize)));
    assert!(!valid_extension(
        &"x".repeat(MAX_EXTENSION_BYTES as usize + 1)
    ));
    assert_eq!(default_page_limit(), DEFAULT_FILE_PAGE_LIMIT as u16);
    let kv: crate::data::KvListRequest = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(kv.limit, DEFAULT_KV_PAGE_LIMIT as u16);
}

#[test]
fn ticket_paths_are_same_origin_for_all_callers_while_local_input_is_absolute() {
    for path in [
        "/admin/api/apps/v1/media/t1",
        "/admin/api/apps/v1/cache-media/t1",
        "/admin/api/apps/v1/media/t1?disposition=inline",
        "/admin/api/apps/v1/media/%E7%A5%A8%E6%8D%AE",
    ] {
        assert!(valid_same_origin_path(path));
    }
    for path in [
        "https://drive.invalid/admin/api/apps/v1/media/t1",
        "//other.invalid/media/t1",
        "/\\\\other.invalid/t1",
        "relative/t1",
        "/admin/t1#fragment",
        "/admin/ticket with space",
        "/admin/票据",
        "/admin/%",
        "/admin/%a",
        "/admin/%zz",
        "/admin/t1\r\n",
    ] {
        assert!(!valid_same_origin_path(path));
    }
    let max_path = format!("/{}", "t".repeat(MAX_URI_BYTES as usize - 1));
    assert!(valid_same_origin_path(&max_path));
    assert!(!valid_same_origin_path(&format!("{max_path}t")));
    let media = MediaUrl {
        url: "/admin/api/apps/v1/media/t1".into(),
        expires_at: Timestamp(1),
        file: ContentRef {
            id: "1".into(),
            content_version: "v1".into(),
        },
        representation: FileRepresentation::Original,
    };
    assert_eq!(
        serde_json::from_value::<MediaUrl>(serde_json::to_value(&media).unwrap()).unwrap(),
        media
    );
    let local = LocalFileUrl {
        id: "l1".into(),
        url: "http://127.0.0.1:12345/admin/apps-local/v1/l1".into(),
        expires_at: Timestamp(1),
        byte_budget: ByteCount(1),
        request_budget: 1,
    };
    assert!(!valid_same_origin_path(&local.url));
    assert_eq!(
        serde_json::from_value::<LocalFileUrl>(serde_json::to_value(&local).unwrap()).unwrap(),
        local
    );
}

#[test]
fn path_validation_is_canonical_and_unicode_aware() {
    for path in ["/", "/书库/示例.epub", "/a-b/a_1.tar.gz"] {
        assert!(valid_drive_path(path));
    }
    for path in [
        "a/b", "/a//b", "/a/../b", "/a/./b", "/a/", "/a\\b", "/\u{0}",
    ] {
        assert!(!valid_drive_path(path), "不应接受 {path}");
    }
    assert!(valid_node_id("9223372036854775807"));
    for id in ["0", "01", "-1", "9223372036854775808"] {
        assert!(!valid_node_id(id));
    }
}
