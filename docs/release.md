# 插件分发与目录协议说明

本文档描述 `tgdrive-app` 的分发资产、根目录 `catalog.json` 协议（schema_version: 2）及完整性防护机制。宿主 `tgdrive` 为独立仓库；公开 CI 只检查插件自身，发布前的跨库集成由维护者在本机完成。

## 分发机制与资产结构

仓库已全面采用根目录 `catalog.json` 配合 `apps/` 目录最新包的分发方式，取代旧版 GitHub Release 机制。分发资产随 `main` 分支提交并在 GitHub 原始文件服务中直链托管。

根目录及包目录资产规范如下：
- `catalog.json`：根目录索引清单，schema_version 为 `2`。
- `SHA256SUMS`：全资产校验清单，列出 `catalog.json` 及带 `apps/` 路径的最新插件包摘要。
- `apps/`：包目录，**仅保留每个官方应用的最新版本包**（当前共四包）：
  - `apps/shorts-1.5.0.tgapp`
  - `apps/reader-1.1.0.tgapp`
  - `apps/cinema-1.5.0.tgapp`
  - `apps/fntv-0.1.3.tgapp`

飞牛影视服务 `0.1.1` 加入公开目录，最低宿主为 `0.3.6`，提供独立影视账号、电影和电视剧媒体库、目录授权及服务启停。升级本地候选 `0.1.0` 时保留业务数据和运行状态，已有客户端需重新登录。此前公共 SDK 已加入可选飞牛服务接口；原三款插件因此各提升一个修订版本，避免覆盖同版本摘要，最低宿主、页面及数据格式保留。包、目录及摘要在同一提交中发布；构建与实际宿主集成见 [0.1.1 发布记录](fntv-0.1.1-release.md)。

飞牛 `0.1.2` 要求宿主 `0.3.7`，加入无海报视频后台补图、管理页封面状态及现有刷新入口的缺图重试。此次其他三款插件包字节保持一致；FNTV 包、目录及摘要在同一提交中更新。飞牛 `0.1.3` 只改管理页界面（跟随主站深浅色、手机沉浸、状态置顶与复制地址），服务能力、最低宿主和数据不变。指定官方客户端画面与已提交宿主的完整集成证据见 [0.1.2 验收记录](fntv-0.1.2-local-validation.md)。

根目录分发阅读馆为 reader 1.1.0、影视 1.5.0、短视频 1.5.0，完成 iPhone 主屏幕界面改版（见各应用说明），数据格式与最低宿主不变；阅读馆随包携带三张新版截图（home、mobile-library、mobile-reading），旧抽屉截图 mobile-sidebar 已移除。阅读馆继续保留 1.0.4 的 iOS 漫画滚动修复：高度变化完全被占位补偿吸收后不回写旧滚动坐标，换窗及图片尺寸修改前先保护滚动范围，保留原生惯性与有界预读。升级保留书库、分组、阅读进度、书签和自定义偏好。滚动修复的历史验收见 [1.0.4 发布验收记录](reader-1.0.4-release.md)。手动目录书库、紧凑筛选、漫画默认适宽和首次替换旧 books/comics 的确认边界保留。

所有包的完整 manifest 必须与对应源码 `app.json` 一致。`SHA256SUMS` 包含：

```
<sha256>  apps/cinema-1.5.0.tgapp
<sha256>  apps/fntv-0.1.3.tgapp
<sha256>  apps/reader-1.1.0.tgapp
<sha256>  apps/shorts-1.5.0.tgapp
<sha256>  catalog.json
```

`books`、`comics` 不再生成独立官方包，解析器源码继续保留；reader 包必须同时带齐 ZIP、DOMPurify、PDF worker、cmaps、standard_fonts 及全部对应许可证和 NOTICE。最终构建须在真实截图完成后执行。

## catalog 协议（schema_version: 2）

默认索引 URL：`https://raw.githubusercontent.com/lengyuesky/tgdrive-app/main/catalog.json`。
安装包 URL 格式：`https://raw.githubusercontent.com/lengyuesky/tgdrive-app/main/apps/<id>-<version>.tgapp`。

### 完整 JSON 结构

以下示例展示合法的 schema_version: 2 结构。manifest 对应 reader 源清单；示例摘要和大小仅为合法占位，发布时必须从真实归档计算：

```json
{
  "schema_version": 2,
  "repository": "lengyuesky/tgdrive-app",
  "entries": [
    {
      "manifest": {
        "id": "reader",
        "name": "阅读馆",
        "version": "1.1.0",
        "api_version": 2,
        "min_host_version": "0.3.3",
        "description": "在同一个书库阅读图书与漫画，支持继续阅读、想读、收藏、作品分组与跨设备阅读进度。",
        "author": "tgdrive",
        "entry": "index.html",
        "icon": "icon.svg",
        "permissions": [
          "files.read",
          "media.read"
        ],
        "settings": [],
        "integration": {
          "file_types": [
            "txt",
            "epub",
            "pdf",
            "cbz",
            "zip"
          ],
          "directories": true,
          "changelog": "iPhone 主屏幕界面改版：手机打开即沉浸并自带返回网盘；正文跟手翻页、左右边缘留给系统返回手势；工具栏改为图标与可拖动进度条，排版分两级、四种主题；长条漫自动连续滚动；书库去掉抽屉，改为顶部筛选标签。升级保留书库、分组、阅读进度、书签及自定义偏好。",
          "formats": [
            "TXT",
            "EPUB 2/3",
            "PDF",
            "CBZ",
            "ZIP",
            "图片目录"
          ],
          "limitations": [
            "支持无 DRM 的 EPUB；不执行书内脚本或外部资源。",
            "支持 TXT 64 MiB、EPUB 128 MiB、PDF 512 MiB；大文件采用按需读取。",
            "不支持加密归档、RAR、CBR 或 7Z；漫画归档上限 2 GiB，图片章最多 10000 页。"
          ],
          "homepage": "https://github.com/lengyuesky/tgdrive-app",
          "support": "https://github.com/lengyuesky/tgdrive-app/issues",
          "screenshots": [
            "screenshots/home.png",
            "screenshots/mobile-library.png",
            "screenshots/mobile-reading.png"
          ],
          "data_schema": 1
        }
      },
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "size": 1024,
      "url": "https://raw.githubusercontent.com/lengyuesky/tgdrive-app/main/apps/reader-1.1.0.tgapp"
    }
  ]
}
```

### 字段与大小约束

- **顶层字段**：仅允许 `schema_version`、`repository`、`entries` 三个字段。不允许包含 `release_tag`，亦不新增 `branch` 或 `ref` 字段。`schema_version` 固定为整数 `2`。
- **条目字段**：每个 entry 仅允许 `manifest`、`sha256`、`size`、`url` 四个字段，严禁多余字段。
- **单版本限制**：**每个应用 ID 最多一条最新记录**。禁止同一 ID 出现多个版本条目。
- **URL 规范**：条目 `url` 必须精确为 `https://raw.githubusercontent.com/<repository>/main/apps/<id>-<version>.tgapp`。拒绝任何其他域名、IP、端口、凭据、协议混淆（如 `http://`）或路径变体。
- **清单要求**：保留完整的 `AppManifest` 字段（`id`, `name`, `version`, `api_version`, `min_host_version`, `description`, `author`, `entry`, 可选 `icon`、`integration`, `permissions`, `settings`）；`icon` 必须是包内以 `.svg` 结尾的合法资源路径。版本使用无前导零的合法稳定 SemVer `X.Y.Z`。
- **数值与安全**：`number` 默认值必须在 JavaScript 安全整数范围（绝对值不超过 `9007199254740991`）。
- **容量上限**：`entries` 最多 512 条；目录序列化后大小不得超过 1 MiB。单个插件包不超过 16 MiB（解压后不超过 32 MiB，单文件不超过 8 MiB，总文件数不超过 256）。

### 版本升级与同版本防篡改保护

- **同版本内容不可变更**：若现有目录中已存在相同 `id` 与 `version` 的插件，其 `sha256` 摘要、压缩包 `size` 及完整 `manifest` 必须严格一致。若代码或配置发生修改，必须提升版本号，禁止同版本静默覆盖。
- **禁止版本倒退**：同应用 ID 的新版本必须按数值大于现有记录版本，禁止同 ID 版本回退。
- **允许升级与移除**：允许新版本直接替换同 ID 旧版本；允许目录移除不再维护的插件。
- **安全构建隔离**：`build.mjs` 优先在隔离的临时 staging 目录中完成全部编译、打包与完整性核验。只有当所有包与现有快照校验完全通过后，才转入根目录 `apps/`、`catalog.json` 与 `SHA256SUMS`，避免编译或校验失败覆盖原有资产。转入是多步文件操作，并非文件系统级原子事务；若磁盘写入或进程中断导致失败，须重新构建并校验后再提交，不能发布部分产物。

## 本地与 CI 验证命令

分发构建固定使用 **Node.js 22.22.0**，与 CI 一致。其他 Node/zlib 版本可能产生不同的压缩字节；遇到同版本摘要冲突时应先核对工具链，不得删除现有索引来绕过保护。

在提交与交付前，必须依次执行：

```bash
npm ci
npm run check
npm test
npm run catalog verify ./catalog.json
sha256sum -c SHA256SUMS
```

`catalog.mjs verify` 会同时核验 `catalog.json` 的 schema 格式与本地 `apps/` 目录中真实插件包的摘要、大小与完整 manifest；包目录缺失或不可读时失败，不降级为只校验 JSON。

手动生成目录可执行 `npm run catalog generate ./apps .`，包目录必须位于分发输出目录内。生成器自动读取目标已有索引并检查版本与内容绑定；显式 `--previous` 只能增加基线校验，不能绕过目标目录已有记录。索引、校验清单与安装包必须在同一次 Git 提交中更新。

## 系统集成版本

`integration` 的字段与能力参见 [平台集成说明](platform-integration.md)。本版支持包内真实截图、文件入口和数据版本；完整清单仍参与同版本摘要绑定，新增字段必须随新版本发布。
