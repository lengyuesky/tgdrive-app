# TGDrive 应用与开发套件

宿主与应用分别维护。宿主只提供内容无关的通用能力；应用自己组织书籍、视频与影视资料。新平台不兼容旧 SDK、旧包或旧应用数据。

## 开发入口

- [宿主与应用契约](docs/contract.md) 与 `contract/` 是唯一线上依据；TypeScript 类型由 Rust 定义生成，不手工维护另一套协议。
- [应用开发指南](docs/app-development.md) 说明两个 SDK、测试替身、构建与包校验。
- 页面使用锁定依赖 `@tgdrive/page-sdk`，在沙箱 iframe 内直接 `fetch` 宿主；后端使用 `tgdrive-backend-sdk`，通过独享 Unix 套接字调用宿主。
- `@tgdrive/ui` 提供共享 `base.css` 和线性图标，源码保持在 `ui/`；应用按包名引用，不跨应用引用源码。
- `testing/page-host/` 与 `testing/backend-host/` 共用 Rust 内存核心。业务测试只构造合成网盘，不需要检出或启动宿主。
- 最小参照是 `examples/page-app/` 和 `examples/backend-app/`，示例不进入发布目录。

## 应用

| ID | 名称 | 形态 |
|---|---|---|
| `reader` | [阅读馆 2.0.0](docs/reader.md) | 纯页面，通用索引发现书籍与直属图片目录，KV 条件保存阅读数据 |
| `shorts` | [短视频 2.0.0](docs/shorts.md) | 纯页面，授权范围内随机抽样，KV 设置与应用收藏 |
| `cinema` | [影视](docs/cinema-installation.md) | 页面与原生后端，合并飞牛影视兼容服务 |
| `media-scraper` | 影视刮削 | 页面与原生后端，自行联网获取资料 |

旧管线已移除。阅读馆、短视频、影视和影视刮削的页面均已接入根目录类型检查与单测，Rust 工作区检查应用后端。阅读馆与短视频使用 `tools-v1/build-pages.mjs <reader|shorts|all> <仓库外的新目录>` 编译、打包和校验；带后端的影视与影视刮削分别使用 `tools-v1/build-cinema.mjs` 和 `tools-v1/build-media-scraper.mjs`，页面随包携带，只构建 `linux-amd64` 与 `linux-arm64`。飞牛兼容服务已合并到影视，不保留独立 `fntv` 发布入口。

## 环境与检查

Node.js 固定使用 22.22.0，Rust 固定 1.99.1（`rust-toolchain.toml`）；Rust 命令将 cargo 加入 PATH。全量 Rust 测试需要 PATH 中可执行的 `ffmpeg` 和 `ffprobe`（Ubuntu：`sudo apt-get install ffmpeg`；macOS：`brew install ffmpeg`），用于生成合成视频并验证真实探测与取帧，不可因缺少依赖而跳过这些测试。使用 Python 时优先使用 uv 虚拟环境。

```bash
fnm use 22.22.0
npm ci
npm run typecheck
npm test
npm run contract:check
PATH="$HOME/.cargo/bin:$PATH" cargo test --workspace --locked --all-features
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --workspace --locked --all-targets --all-features -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo fmt --all --check
```

`npm test` 构建测试工作进程并运行全部已接入工作区与构建发布管线测试，`test:readers`、`test:shorts`、`test:formats` 运行对应单测。`test:formats:browser`、`test:pictures:browser` 保留独立漫画与图片窗口的真实 Chromium 回归；短视频当前没有真实浏览器自动化。测试替身和独立浏览器用例均不证明真实 Telegram、宿主 CSP/隔离或官方客户端已经验收；依赖旧全局 SDK 的全应用浏览器夹具已删除。

## 构建与分发

先把应用编译到一个新的独立目录，再使用 `tools-v1/` 与 `app-tools/` 的 `tgapp` 打包和校验。纯页面包目标为 `web`，原生包分别为 `linux-amd64`、`linux-arm64`。同一版本同一目标的完整清单、字节、摘要与大小不可替换，修复必须升应用版本。

全部四款应用通过一个入口构建到仓库外的新输出目录：

```bash
npm run build:all -- --output "$NEW_OUTPUT" --probe
# 分目标构建：--target web、linux-amd64 或 linux-arm64。
```

`packages/` 内共有六包，逐个核验真实 ZIP/ELF；`catalog/catalog.json` 由 `tgapp catalog` 生成并通过 `catalog-check`。页面与原生构建收集实际依赖许可，示例不入目录；`--probe` 在隔离容器里验证四个真实后端包启动与退出，不代替真实宿主或官方客户端联调。已有完整原生产物可通过 `--reuse-native` 明确复用，仍核对版本、工具链、真实 ELF 与 musl 许可。

目录位于 main 根目录 `catalog.json`，包只放同仓库 GitHub Release，不在 main 保存安装包。`catalog-history.json` 与目录同一提交永久跟踪不可变绑定；初始目录为空，首次手动发布后填入真实版本。CI 在 main push 和 PR 时全量检查与原生双架构构建；**发布只能手动触发** `release.yml`，push/tag 不自动发布，也不覆盖同版本资产。

本地统一门禁为 `npm run check:all -- --output "$NEW_CHECK_OUTPUT"`；不联网的完整演练为 `npm run release:dry-run -- --output "$NEW_REHEARSAL_OUTPUT"`，需要预先准备工具链、依赖与 Docker 镜像缓存。构建布局、升版规则、发布权限和失败重跑见 [应用开发指南「CI 与发布」](docs/app-development.md#8-ci-与发布)。

本仓库第一方代码与文档统一采用 **MIT 许可**，见根目录 [LICENSE](LICENSE)。第三方依赖保留各自的原始许可和 NOTICE，并随包收集。提交、推送、标签与 Release 均需维护者明确授权。

更多规则见 [AGENTS.md](AGENTS.md) 和 [贡献指南](docs/contributing.md)。
