# 代码贡献指南

开发规则和自检步骤见 [docs/contributing.md](docs/contributing.md)，线上协议以 [docs/contract.md](docs/contract.md) 与 `contract/` 为准。新应用从 [应用开发指南](docs/app-development.md) 和两个最小示例开始，不依赖宿主源码。

阅读馆、短视频分别见 [阅读馆说明](docs/reader.md)、[短视频说明](docs/shorts.md)。

提交前使用 `npm run check:all -- --output <仓库外的新检查目录>` 执行全量门禁，使用 `npm run build:all -- --output <仓库外的新构建目录> --probe` 构建并核验全部六包。环境固定为 Node.js 22.22.0、Rust 1.99.1；输出目录不能已经存在。

CI 检查 main push 和 PR；发布仅由维护者手动触发 main 上的 `release.yml`。改动清单或包字节必须升应用版本，不覆盖同版本资产，不清空 `catalog-history.json`；不联网的 `release:dry-run` 演练、发布权限与失败重跑见 [应用开发指南「CI 与发布」](docs/app-development.md#8-ci-与发布)。
