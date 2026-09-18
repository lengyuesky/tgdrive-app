# 插件分发与目录协议说明

本文档描述 `tgdrive-app` 的分发资产、根目录 `catalog.json` 协议（schema_version: 2）及完整性防护机制。宿主 `tgdrive` 为私有仓库；公开 CI 只检查插件自身，发布前的跨库集成由维护者在本机完成。

## 分发机制与资产结构

仓库已全面采用根目录 `catalog.json` 配合 `apps/` 目录最新包的分发方式，取代旧版 GitHub Release 机制。分发资产随 `main` 分支提交并在 GitHub 原始文件服务中直链托管。

根目录及包目录资产规范如下：
- `catalog.json`：根目录索引清单，schema_version 为 `2`。
- `SHA256SUMS`：全资产校验清单，列出 `catalog.json` 及带 `apps/` 路径的最新插件包摘要。
- `apps/`：包目录，**仅保留每个官方应用的最新版本包**（当前共四包）：
  - `apps/shorts-1.1.2.tgapp`
  - `apps/books-1.3.4.tgapp`
  - `apps/comics-1.2.4.tgapp`
  - `apps/cinema-1.2.4.tgapp`

所有包的完整 manifest 必须与对应源码 `app.json` 一致。`SHA256SUMS` 包含：

```
<sha256>  apps/books-1.3.4.tgapp
<sha256>  apps/cinema-1.2.4.tgapp
<sha256>  apps/comics-1.2.4.tgapp
<sha256>  apps/shorts-1.1.2.tgapp
<sha256>  catalog.json
```

## catalog 协议（schema_version: 2）

默认索引 URL：`https://raw.githubusercontent.com/lengyuesky/tgdrive-app/main/catalog.json`。
安装包 URL 格式：`https://raw.githubusercontent.com/lengyuesky/tgdrive-app/main/apps/<id>-<version>.tgapp`。

### 完整 JSON 结构

以下示例展示合法的 schema_version: 2 结构。条目信息由真实归档生成：

```json
{
  "schema_version": 2,
  "repository": "lengyuesky/tgdrive-app",
  "entries": [
    {
      "manifest": {
        "id": "books",
        "name": "图书",
        "version": "1.3.4",
        "api_version": 2,
        "min_host_version": "0.2.0",
        "description": "阅读网盘里的 TXT、EPUB 和 PDF，支持章节、排版设置、书签和跨设备阅读进度。",
        "author": "tgdrive",
        "entry": "index.html",
        "icon": "icon.svg",
        "permissions": ["files.read", "media.read"],
        "settings": [
          {
            "key": "source_dir",
            "label": "图书目录",
            "description": "过渡期保留作旧版配置迁移入口，新设置请在应用内管理来源；根目录表示整库。",
            "type": "directory",
            "default": "/"
          }
        ]
      },
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "size": 1024,
      "url": "https://raw.githubusercontent.com/lengyuesky/tgdrive-app/main/apps/books-1.3.4.tgapp"
    }
  ]
}
```

### 字段与大小约束

- **顶层字段**：仅允许 `schema_version`、`repository`、`entries` 三个字段。不允许包含 `release_tag`，亦不新增 `branch` 或 `ref` 字段。`schema_version` 固定为整数 `2`。
- **条目字段**：每个 entry 仅允许 `manifest`、`sha256`、`size`、`url` 四个字段，严禁多余字段。
- **单版本限制**：**每个应用 ID 最多一条最新记录**。禁止同一 ID 出现多个版本条目。
- **URL 规范**：条目 `url` 必须精确为 `https://raw.githubusercontent.com/<repository>/main/apps/<id>-<version>.tgapp`。拒绝任何其他域名、IP、端口、凭据、协议混淆（如 `http://`）或路径变体。
- **清单要求**：保留完整的 `AppManifest` 字段（`id`, `name`, `version`, `api_version`, `min_host_version`, `description`, `author`, `entry`, 可选 `icon`, `permissions`, `settings`）；`icon` 必须是包内以 `.svg` 结尾的合法资源路径。版本使用无前导零的合法稳定 SemVer `X.Y.Z`。
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
