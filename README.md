# tgdrive-app 官方插件仓库

tgdrive 官方独立插件库与扩展开发套件。包含短视频（Shorts）、图书（Books）、漫画（Comics）与影视（Cinema）四款官方插件，以及插件 SDK、独立打包分发工具与发布目录协议实现。

## 官方插件一览

| 插件 ID | 名称 | 版本 | API 版本 | 说明 |
|---|---|---|---|---|
| `shorts` | 短视频 | `1.0.3` | 2 | 随机播放网盘文件夹里的视频，支持滑动切换、收藏与下载 |
| `books` | 图书 | `1.1.4` | 2 | 阅读 TXT、EPUB 2/3 与中文字体 PDF，支持排版偏好、书签与跨设备进度 |
| `comics` | 漫画 | `1.0.8` | 2 | 连续滚动或左右单页翻阅图片目录与 CBZ/ZIP 漫画包 |
| `cinema` | 影视 | `1.1.2` | 2 | 命名媒体库、封面缓存优化、文本字幕、音轨切换与客户端 MKV 流式解封装 |

所有插件遵循统一沙箱规范，使用沙箱内 iframe 隔离运行，无服务器转码或外部 CDN 依赖。

## 目录结构

```
.
├── shorts/                # 短视频插件源码
├── books/                 # 图书插件源码（TXT/EPUB/PDF）
├── comics/                # 漫画插件源码（图片/CBZ/ZIP）
├── cinema/                # 影视插件源码（流式转封装/媒体库）
├── reader/                # 阅读器共用逻辑与样式（Range/归档/排版）
├── sdk/                   # 插件 SDK 运行时 (tgdrive-sdk.js) 与 TypeScript 类型
├── tests/
│   ├── unit/              # 独立单元测试（SDK、打包工具、发布目录）
│   ├── browser/           # 浏览器 E2E 回归测试与夹具
│   └── fixtures/          # 测试用例合成文件（中文 PDF、字体许可等）
├── docs/                  # 开发指南、SDK 协议、迁移与发布文档
├── build.mjs              # 插件构建主脚本（编译 Vite 插件并生成 catalog）
├── package.mjs            # 标准 ZIP .tgapp 打包脚本
├── catalog.mjs            # 目录生成、历史合并、严格校验与 SHA256SUMS 工具
├── release.mjs            # 完整历史查询、单调 tag 与草稿资产发布门禁
├── compatibility.json     # 宿主兼容性基线与本地集成规范
└── AGENTS.md              # 智能体工作守则与权限边界
```

## 快速开始

开发与构建环境要求 Node.js `>= 22.22.0`。

```bash
# 按锁文件安装依赖
npm ci

# 完整检查（类型检查与插件构建）
npm run check

# 运行单元测试与发布工具测试
npm test

# 构建全部插件与发布资产（输出至 ./catalog）
npm run build

# 校验目录规范与本地资产摘要
npm run catalog verify ./catalog/catalog.json
(cd catalog && sha256sum -c SHA256SUMS)
```

## 与宿主 (tgdrive) 的协作与集成

1. **宿主私有性与公开 CI**：
   - 宿主仓库 `lengyuesky/tgdrive` 为私有仓库（PRIVATE）。
   - 本公开仓库的 GitHub Actions CI 仅运行独立插件检查、单测和构建打包，**公开 CI 不检出宿主仓库，不配置任何跨仓库密钥，不上传宿主源码或构建产物**。
   - 外部贡献者无需拥有宿主仓库权限，即可在本机运行完整的语法、构建和单元测试。

2. **发布前本机跨库 E2E 集成测试**：
   - 在正式发布新版本插件前，开发者应在本机指定宿主路径运行端到端跨库测试：
     ```bash
     # 确保宿主前端已构建：npm --prefix /path/to/tgdrive/frontend run build
     # 在插件仓库先构建当前包；两端写入及其他夹具停止后再运行集成测试
     npm run check
     TGDRIVE_HOST_DIR=/path/to/tgdrive npm run test:e2e
     ```
   - 夹具将使用宿主的临时数据库与内存 Telegram 驱动，加载 `tgdrive-app` 打包生成的最新插件包，执行真实浏览器生命周期验收。

3. **兼容性记录 (`compatibility.json`)**：
   - 本仓库根目录的 `compatibility.json` 记录宿主 Git ref、目标宿主版本及支持的 API 版本。拆分起点 SHA 不等于集成验收；发布前由维护者填写实际通过本机集成的完整宿主提交 SHA。

## 发布资产与目录协议 (Catalog Protocol)

每次正式 Release 均通过稳定语义化标签（如 `v1.0.0`）触发，生成以下标准资产：
- `<id>-<version>.tgapp`（各插件打包文件，例如 `shorts-1.0.3.tgapp`、`books-1.1.4.tgapp`、`comics-1.0.8.tgapp`、`cinema-1.1.2.tgapp`）
- `catalog.json`（索引目录文件）
- `SHA256SUMS`（全资产校验清单）

发布目录入口为：`https://github.com/lengyuesky/tgdrive-app/releases/latest/download/catalog.json`。

发布工具严格保证：
- **历史合并**：自动保留历史插件版本，宿主可按 SemVer 选用最高兼容版本。
- **不可更换内容**：同一应用同一版本若出现不同摘要、完整 manifest 或包长度，发布工具直接阻断。
- **失败关闭与单调 tag**：历史 API/目录下载失败不能当首发；新稳定 tag 必须大于所有已发布稳定 tag。
- **公开资产不可覆盖**：已存在 Release（包括草稿）均不覆盖；失败残留由维护者检查处理。
- **草稿验证后发布**：下载资产的精确集合、长度及每个 SHA256（包括 `catalog.json` 与 `SHA256SUMS` 自身）须匹配上传前的本地快照，之后才正式转为 latest。

## 详细文档

- [SDK 接口规范与生命周期说明](docs/sdk.md)
- [本地开发与构建指南](docs/development.md)
- [从主仓库单体拆分迁移说明](docs/migration.md)
- [影视应用设计与限制说明](docs/cinema.md)
- [代码贡献指南](docs/contributing.md)
- [版本发布与目录维护说明](docs/release.md)
