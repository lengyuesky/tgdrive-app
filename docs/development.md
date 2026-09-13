# 本地开发与构建指南

本文档介绍如何在本地配置、构建、测试与调试 `tgdrive-app` 仓库中的插件。

## 环境要求

- **Node.js**：`>= 22.22.0`（CI 环境统一固定为 `22.22.0`）
- **npm**：`>= 10.0.0`
- **可选工具**：
  - `ffmpeg`：用于生成测试用合成视频文件
  - Chromium 浏览器：用于运行 Playwright 浏览器端到端测试

## 依赖管理与安装

本仓库为完全解耦的独立工具链，不依赖外部宿主工程的 `node_modules`。

```bash
# 纯净安装依赖
npm install

# 或在 CI 环境使用严格安装
npm ci
```

核心运行时依赖：
- `@zip.js/zip.js (2.14.0)`：ZIP 归档解压与流式读取，供漫画（CBZ）与图书（EPUB）使用。
- `dompurify (3.4.15)`：HTML 富文本净化，防止 EPUB 正文中潜在的 XSS 攻击。
- `mediabunny (1.56.1)`：纯 TypeScript 容器解封装工具，用于影视插件的 MKV 客户端流式解封装与音轨探测。
- `pdfjs-dist (6.3.289)`：PDF 渲染器，随包携带字体（standard_fonts）与 CMap 资源。

## 常用命令与工作流

### 1. 代码检查与构建 (`npm run check`)

此命令会先执行严格的 TypeScript 类型检查，随后触发各插件编译与打包：

```bash
npm run check
```

- `npm run typecheck`：运行 `tsc --noEmit`，校验 `books`、`cinema`、`comics`、`reader`、`sdk` 和 `tests` 的类型定义。
- `npm run build`：执行 `build.mjs`。

### 2. 运行独立单元测试 (`npm test`)

使用 `vitest run` 运行所有独立单元测试（包括 SDK 消息协议、阅读器排版计算、影视媒体库状态管理、打包工具、发布目录生成与草稿发布门禁），不开放测试服务器：

```bash
npm test
```

测试执行于 Node 环境的内存 JSDOM 中，提供对 `localStorage`、`ResizeObserver` 及视口尺寸的仿真。

### 3. 构建发布产物 (`npm run build`)

```bash
npm run build
```

该脚本执行流程：
1. 直接将静态插件 `shorts/` 打包为 `catalog/shorts-1.0.3.tgapp`。
2. 使用 Vite 对 `books/`、`comics/`、`cinema/` 进行独立生产编译，输出至 `.build/<name>/`。
3. 自动向产物中复制各第三方依赖的开源许可证及 PDF 所需字型文件。
4. 调用 `package.mjs`，将编译结果压缩为标准规范的 `.tgapp` 归档。
5. 扫描所有产物，生成严格符合发布协议的 `catalog/catalog.json` 和 `catalog/SHA256SUMS`。

可通过环境变量重定向输出路径：
```bash
TGDRIVE_APP_BUILD_OUTPUT=/path/to/custom-dir npm run build
```

### 4. 校验发布目录 (`npm run catalog`)

单独校验某个 `catalog.json` 是否满足协议要求（包括完整 manifest、稳定版本、URL 映射、大小上限与记录唯一性），再核对本地资产摘要：

```bash
npm run catalog verify ./catalog/catalog.json
(cd catalog && sha256sum -c SHA256SUMS)
```

`verify` 只校验目录 schema；历史防篡改由合并时检查，本地资产完整性由 checksum 检查。普通构建不联网读取发布历史，正式发布的历史查询、合并及草稿资产校验见 [发布说明](release.md)。

## 插件架构细节

- **`shorts/`**：原生纯 JavaScript 页面，体积轻量，无需打包工具介入，由 `package.mjs` 直出。
- **`books/`**：依赖 `reader/` 共享模块，支持长文本分段分页、EPUB 解压净化与 PDF 适宽渲染。
- **`comics/`**：依赖 `reader/` 共享模块，支持垂直连续滚动（虚拟滑动窗口）与横向单页翻阅。
- **`cinema/`**：深色模式影院，内建本地媒体库缓存索引与 MKV 容器流式解封装（MSE 喂流）。
- **`reader/`**：阅读器共用基础库，抽象了 Range 字节调度器、虚拟 DOM 视口渲染器、触摸手势判断与进度同步。

## 运行跨库 E2E 集成测试

由于宿主 `tgdrive` 属于私有仓库，本公开仓库的 CI 不会执行跨库 E2E 测试。但在正式发布或重大改动前，开发者可在本地执行完整的真实浏览器回归测试：

```bash
# 1. 确保宿主前端已构建完成（在宿主工作目录中）
cd /path/to/tgdrive/frontend && npm run build

# 2. 返回插件仓库，先构建当前插件，再显式指定宿主运行 E2E
cd /path/to/tgdrive-app
npm run check
TGDRIVE_HOST_DIR=/path/to/tgdrive npm run test:e2e
```

`tests/browser/fixture.mjs` 会：
1. 在启动外部进程前检查宿主 `${TGDRIVE_HOST_DIR}/frontend/dist/index.html` 和四个当前插件包；缺失、空文件或只有旧版包时直接提示先构建。
2. 使用 `ffmpeg` 自动合成测试视频和阅读/影视夹具文件。
3. 启动宿主内置的 `apps::tests::browser_fixture` 测试夹具服务（监听 `127.0.0.1:4187`），显式传入绝对包目录。
4. 加载本仓库打包出的真实插件包，启动 Playwright 进行真实浏览器场景回归。

`TGDRIVE_APP_CATALOG_DIR` 可指定自定义包目录，但仍需包含四个当前版本的包。检查只确认构建产物存在，不代替完整集成测试。发布前须由维护者记录实际验证宿主的完整 Git SHA 到 `compatibility.json`；拆分起点 SHA 不代表拆分后集成已经通过。

### 隔离验证与临时目录

- 测试仅使用临时数据库、内存 Telegram 和合成文件，不读取真实 `.env` 或生产网盘。写入前会核验 `/__apps_fixture` 的身份。
- 运行前确认两端源码写入及其他测试已停止，不抢占端口 `4187`，不复用未知服务。宿主仍在修改时推迟跨库 E2E。
- 若系统临时目录有配额限制，可设置 `TMPDIR` 与 `PLAYWRIGHT_APPS_OUTPUT_DIR` 指向有空间的本机隔离目录，例如：

  ```bash
  mkdir -p /path/to/test-tmp /path/to/test-results
  TMPDIR=/path/to/test-tmp PLAYWRIGHT_APPS_OUTPUT_DIR=/path/to/test-results TGDRIVE_HOST_DIR=/path/to/tgdrive npm run test:e2e
  ```

- 集成日志、截图和 trace 仅在获授权的本机保留，不上传公开 CI；没有宿主权限时运行独立门禁，不把未执行的 E2E 声称为通过。
