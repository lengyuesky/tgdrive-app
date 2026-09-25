# tgdrive-app 官方插件仓库

tgdrive 官方独立插件库与扩展开发套件。包含短视频（Shorts）、图书（Books）、漫画（Comics）与影视（Cinema）四款官方插件，以及插件 SDK、独立打包分发工具与目录协议实现。

## 官方插件一览

| 插件 ID | 名称 | 版本 | API 版本 | 说明 |
|---|---|---|---|---|
| `shorts` | 短视频 | `1.1.4` | 2 | 随机播放网盘文件夹里的视频，支持滑动切换、收藏与下载 |
| `books` | 图书 | `1.3.10` | 2 | 阅读 TXT、EPUB 2/3 与中文字体 PDF，支持排版偏好、书签与跨设备进度 |
| `comics` | 漫画 | `1.2.13` | 2 | 连续滚动或左右单页翻阅图片目录与 CBZ/ZIP 漫画包 |
| `cinema` | 影视 | `1.2.7` | 2 | 命名媒体库、封面缓存优化、文本字幕、音轨切换与客户端 MKV 流式解封装 |

所有插件遵循统一沙箱规范，使用沙箱内 iframe 隔离运行，无服务器转码或外部 CDN 依赖。宿主声明 `media.bytes` 能力时，阅读器走票据直连的字节数据面（Range 读取不经宿主页面二次缓冲）；旧宿主自动降级到消息通道。

## 目录结构

```
.
├── apps/                  # 最新版插件安装包（apps/<id>-<version>.tgapp）
├── shorts/                # 短视频插件源码
├── books/                 # 图书插件源码（TXT/EPUB/PDF）
├── comics/                # 漫画插件源码（图片/CBZ/ZIP）
├── cinema/                # 影视插件源码（流式转封装/媒体库）
├── reader/                # 阅读器共用逻辑与样式（Range/归档/排版）
├── sdk/                   # 插件 SDK 运行时 (tgdrive-sdk.js) 与 TypeScript 类型
├── tests/
│   ├── unit/              # 独立单元测试（SDK、打包工具、应用目录）
│   ├── browser/           # 跨库浏览器 E2E 回归测试与夹具
│   ├── standalone/        # 无宿主的漫画滚动浏览器回归
│   └── fixtures/          # 测试用例合成文件（中文 PDF、字体许可等）
├── docs/                  # 开发指南、SDK 协议、迁移与分发协议文档
├── build.mjs              # 插件构建主脚本（编译 Vite 插件并生成 apps/ 与根目录分发资产）
├── package.mjs            # 标准 ZIP .tgapp 打包脚本
├── catalog.mjs            # 根目录索引生成、更新校验、本地包核验与 SHA256SUMS 工具
├── catalog.json           # 根目录应用索引清单（schema_version: 2）
├── SHA256SUMS             # 全资产校验清单
├── compatibility.json     # 宿主兼容性基线与本地集成规范
└── AGENTS.md              # 智能体工作守则与权限边界
```

## 快速开始

开发运行要求 Node.js `>= 22.22.0`；构建与校验分发资产固定使用 `22.22.0`，与 CI 保持一致，避免压缩字节差异。

```bash
# 按锁文件安装依赖
npm ci

# 完整检查（类型检查与插件构建）
npm run check

# 运行独立单元测试
npm test

# 构建全部插件与分发资产（输出至 apps/、catalog.json、SHA256SUMS）
npm run build

# 校验目录规范与本地资产摘要
npm run catalog verify ./catalog.json
sha256sum -c SHA256SUMS
```

漫画滚动另有无需宿主的真实浏览器回归：安装 Chromium 后运行 `npm run test:comics`，步骤见[开发指南](docs/development.md#漫画独立浏览器回归)。

## 与宿主 (tgdrive) 的协作与集成

1. **宿主私有性与公开 CI**：
   - 宿主仓库 `lengyuesky/tgdrive` 为私有仓库（PRIVATE）。
   - 本公开仓库的 GitHub Actions CI 仅运行独立插件检查、单测和构建打包，**公开 CI 不检出宿主仓库，不配置任何跨仓库密钥，不上传宿主源码或构建产物**。
   - 外部贡献者无需拥有宿主仓库权限，即可在本机运行完整的语法、构建和单元测试。

2. **发布前本机跨库 E2E 集成测试**：
   - 在更新插件前，开发者应在本机指定宿主路径运行端到端跨库测试：
     ```bash
     # 确保宿主前端已构建：npm --prefix /path/to/tgdrive/frontend run build
     # 在插件仓库先构建当前包；两端写入及其他夹具停止后再运行集成测试
     npm run check
     TGDRIVE_HOST_DIR=/path/to/tgdrive npm run test:e2e
     ```
   - 夹具将使用宿主的临时数据库与内存 Telegram 驱动，加载 `tgdrive-app` 打包生成的最新插件包，执行真实浏览器生命周期验收。

3. **兼容性记录 (`compatibility.json`)**：
   - 本仓库根目录的 `compatibility.json` 记录宿主 Git ref、目标宿主版本及支持的 API 版本。拆分起点 SHA 不等于集成验收；发布前由维护者填写实际通过本机集成的完整宿主提交 SHA。

## 分发资产与目录协议 (Catalog Protocol)

本仓库采用根目录 `catalog.json`（schema_version: 2）与 `apps/` 目录直链分发机制：
- `apps/<id>-<version>.tgapp`（各官方插件最新打包文件，例如 `shorts-1.1.4.tgapp`、`books-1.3.10.tgapp`、`comics-1.2.13.tgapp`、`cinema-1.2.7.tgapp`）
- `catalog.json`（根目录索引文件，schema_version 为 2）
- `SHA256SUMS`（全资产校验清单，包含 `apps/` 路径）

默认直链分发入口：
- 目录索引：`https://raw.githubusercontent.com/lengyuesky/tgdrive-app/main/catalog.json`
- 插件安装包：`https://raw.githubusercontent.com/lengyuesky/tgdrive-app/main/apps/<id>-<version>.tgapp`

分发协议与工具保证：
- **单版本最新**：每个插件 ID 仅保留一条最新版本记录，`apps/` 仅保留最新四个包。
- **不可更换内容**：同一应用同一版本若出现不同摘要、完整 manifest 或包长度，直接阻断，禁止静默覆盖；如需变更必须升级版本。
- **禁止版本倒退**：同应用 ID 不允许倒退版本。
- **允许升级与移除**：允许新版本替换旧版本，允许目录中移除插件。
- **安全构建隔离**：`build.mjs` 在临时 staging 目录中完成全部编译打包与同版本不可篡改校验后，才转入目标分发目录。

## 详细文档

- [SDK 接口规范与生命周期说明](docs/sdk.md)
- [本地开发与构建指南](docs/development.md)
- [从主仓库单体拆分迁移说明](docs/migration.md)
- [影视应用设计与限制说明](docs/cinema.md)
- [代码贡献指南](docs/contributing.md)
- [插件分发与目录协议说明](docs/release.md)
