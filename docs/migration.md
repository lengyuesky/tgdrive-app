# 架构拆分与迁移说明

本文档记录 `tgdrive` 主仓库与 `tgdrive-app` 插件仓库的架构拆分背景、边界划分与版本升级说明。

## 拆分背景与目标

在原有单体架构中，插件源码存放在主仓库的 `apps/` 目录下，与宿主前端代码共享同一套 Vite 工具链与依赖项。随着插件功能扩展，单体结构带来了以下痛点：
1. **依赖膨胀**：插件引入的音视频转封装（`mediabunny`）、PDF 渲染（`pdfjs-dist`）及富文本净化（`dompurify`）等大型依赖污染了宿主前端，导致宿主 Docker 构建变慢。
2. **发布耦合**：无法单独发布或回滚单个插件的新版本，插件的更新必须依赖整套宿主程序的发版。
3. **安全与可见性分级**：宿主仓库 `lengyuesky/tgdrive` 属于私有项目（PRIVATE），而官方插件生态期望作为公开项目开源演进。

## 统一划分边界

| 维度 | 宿主平台 (`tgdrive`) | 插件仓库 (`tgdrive-app`) |
|---|---|---|
| **代码定位** | 核心网盘服务端、Web 前端界面、应用管理中心、沙箱网关 | 官方插件实现、阅读器核心、页面 SDK、独立打包分发工具 |
| **私有性** | 私有仓库（PRIVATE），保持私密 | 公开仓库（Public） |
| **插件依赖** | 彻底移除 `@zip.js/zip.js`、`dompurify`、`mediabunny`、`pdfjs-dist` | 独立维护于根 `package.json`，独立生成锁文件 |
| **分发产物** | Docker 仅编译宿主前端与 Rust 后端，不内置实际插件包 | 根目录 `catalog.json` 索引、`SHA256SUMS` 与 `apps/` 最新插件包 |
| **运行期交互** | 通过远程/本地 Catalog 获取插件包，通过 `<iframe>` 沙箱加载运行 | 通过 `tgdrive-sdk.js` 经由 `MessageChannel` 与宿主进行 RPC 通信 |
| **测试归属** | PWA、侧栏导航、应用管理界面、自包含合成测试包 | 页面 SDK、阅读器/影院单元测试、插件浏览器行为回归测试 |

## 分发机制升级（Release -> 根目录直链分发）

用户已批准全面采用根目录 `catalog.json` + `apps/` 最新包直链分发，彻底移除 GitHub Release 工作流与发布门禁机制：
- **目录协议升级为 schema_version: 2**：顶层仅 `schema_version`、`repository`、`entries`；条目仅 `manifest`、`sha256`、`size`、`url`。移除了 `release_tag`，不新增 `branch`/`ref` 字段。
- **直链分发 URL**：
  - 索引：`https://raw.githubusercontent.com/<repository>/main/catalog.json`
  - 插件包：`https://raw.githubusercontent.com/<repository>/main/apps/<id>-<version>.tgapp`
- **单版本最新限制**：每个应用 ID 最多保留一条最新记录，`apps/` 仅保留最新四个官方包。
- **同版本不可篡改与升级保护**：同一应用相同版本不允许更换摘要或清单；新版本允许替换旧版本，不允许同 ID 版本倒退。

## 版本规范与当前基线

当前各官方插件基线版本：
- `shorts`: `1.0.3`
- `books`: `1.1.6`（阅读设置增加字号与行距的加减按钮调控）
- `comics`: `1.0.13`（同步阅读器共享模块与排版控制组件）
- `cinema`: `1.1.2`

协议兼容性：各插件的 `id`、`api_version: 2`、`min_host_version: "0.1.0"` 均严格保持不变，平滑兼容现有网盘数据库中的已安装记录与用户数据。

## 测试迁移与解耦

1. **宿主测试拆分**：
   - 原 `applications.spec.ts` 中涉及应用中心导航、未安装空状态引导、独立应用导入及权限拦截的用例留在宿主仓库，由宿主使用自包含合成插件验收。
   - 涉及短视频真实播放、收藏、设置及传输取消的回归用例保留在 `tgdrive-app`。
   - `pwa-navigation.spec.ts` 与 `mobile-navigation.spec.ts` 纯属宿主导航行为，不属于插件范围，已拆出移交宿主维护。
2. **跨库 E2E 参数化**：
   - 插件端 `test:e2e` 通过环境变量 `TGDRIVE_HOST_DIR` 显式定位宿主目录，不再对相对路径 `../tgdrive` 进行隐式猜测。

## 兼容性基线与公开 CI 规范

- 根目录的 `compatibility.json` 记录宿主 Git ref 与支持的 API 版本。拆分起点 ref 只说明源码基线，不代表拆分后的实现已通过集成；更新前由维护者完成本机跨库验收，并填写实际宿主的完整提交 SHA。
- **公开 CI 严禁检出私有宿主**：本仓库的 GitHub Actions 只进行插件自身的代码检查、类型校验、单元测试、根目录分发清单校验及校验和检查，不配置跨仓库凭据，不上传私有产物。跨库集成由获授权的维护者在本机环境执行。
