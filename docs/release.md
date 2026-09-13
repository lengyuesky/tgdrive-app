# 版本发布与目录协议说明

本文档描述 `tgdrive-app` 的发布资产、catalog 协议及自动化门禁。宿主 `tgdrive` 为私有仓库；公开 CI 只检查插件，发布前的跨库集成由维护者在本机完成。

## 稳定标签与触发条件

- 仓库首次稳定发布必须为 `v1.0.0`。此后的稳定标签必须按 SemVer **大于所有已发布稳定标签**，不能通过回退 GitHub 的 latest 指针绕过顺序检查。
- `release_tag` 仅允许无前导零的 `vX.Y.Z`，不允许预发布或构建元信息，例如 `v01.0.0`、`v1.0.0-rc.1`、`v1.0.0+build` 均无效。
- 只有官方同仓库的 tag push 事件可进入发布工作流；tag 指向的构建提交必须为 `main` 的祖先。
- 全仓库共用一个发布并发组，不按 tag 分组；不自动取消运行中的发布。目标 Release 已存在时，包括残留草稿，均停止，绝不覆盖。

## 发布资产

每次 Release 恰好上传六个文件：四个当前插件包、`catalog.json` 与 `SHA256SUMS`。首发包为：

- `shorts-1.0.3.tgapp`
- `books-1.1.4.tgapp`
- `comics-1.0.8.tgapp`
- `cinema-1.1.2.tgapp`

包目录不能缺少当前版本或混入旧包；每个包的完整 manifest 必须与对应源码 `app.json` 一致。`SHA256SUMS` 列出四个包和 `catalog.json` 的摘要，不递归包含自身；草稿门禁另行比对 `SHA256SUMS` 自身的本地摘要。

## catalog 协议（schema_version: 1）

默认入口：`https://github.com/lengyuesky/tgdrive-app/releases/latest/download/catalog.json`。

### 完整 JSON 结构

以下示例包含完整 manifest；摘要与大小仅用于演示结构，发布时必须由真实归档生成，不能直接复制示例资产信息。

```json
{
  "schema_version": 1,
  "repository": "lengyuesky/tgdrive-app",
  "release_tag": "v1.0.0",
  "entries": [
    {
      "manifest": {
        "id": "books",
        "name": "图书",
        "version": "1.1.4",
        "api_version": 2,
        "min_host_version": "0.1.0",
        "description": "阅读网盘里的 TXT、EPUB 和 PDF，支持章节、排版设置、书签和跨设备阅读进度。",
        "author": "tgdrive",
        "entry": "index.html",
        "permissions": ["files.read", "media.read"],
        "settings": [
          {
            "key": "source_dir",
            "label": "图书目录",
            "description": "搜索此目录及子目录中的图书；根目录表示整库。",
            "type": "directory",
            "default": "/"
          }
        ]
      },
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "size": 1024,
      "url": "https://github.com/lengyuesky/tgdrive-app/releases/download/v1.0.0/books-1.1.4.tgapp",
      "release_tag": "v1.0.0"
    }
  ]
}
```

### 字段与大小约束

- 顶层、entry、manifest 和 setting 均严格校验已知字段与类型，不允许未知字段或用数组代替对象。`schema_version` 固定为整数 `1`。
- `repository` 为 ASCII 字母数字及 `._-` 组成的 `owner/repo`，两段非空，总长不超过 100，拒绝空白以及单独的 `.`、`..`；必须与当前发布仓库一致。
- `manifest.version` 仅允许无前导零的稳定 `X.Y.Z`；`min_host_version` 使用合法 SemVer，可含预发布与构建元信息。`api_version` 为正整数 u32。生成器保留 schema 合法的未来 API/宿主版本条目，不按本机兼容性删除历史。
- manifest 必须显式包含 `permissions` 和 `settings`。权限只允许不重复的 `files.read`、`media.read`、`favorites.write`；最多 24 项设置，键不可重复，类型为 `boolean`、`number`、`string` 或 `directory`，默认值必须匹配类型。`setting.description` 可省略。
- `number` 默认值必须有限；整数必须位于 JavaScript 安全整数范围（绝对值不超过 `9007199254740991`）。打包、读取目录和合并历史都会拒绝超范围整数，避免静默舍入。打包器不修改源文件，但包内 `app.json` 使用与目录相同的 JSON 序列化表示，例如 `1.0`、`1e0` 统一为 `1`，确保宿主完整清单比较一致。
- 文本按 UTF-8 字节计限：名称 120、简介 1600、作者 160，且非空、无控制字符；版本字段 80、入口路径 240、设置键 64、标签 160、设置说明 1200、文本默认值 2048。入口必须是包内合法 `.html` 路径，目录默认值不得越界。
- `entries` 最多 512 条，原始 JSON 及输出序列化结果均不得超过 1 MiB（含空白与末尾换行）。同一 `(id, version)` 重复记录即失败，即使摘要相同。
- entry 的 `release_tag` 不能晚于顶层 `release_tag`。`url` 必须精确匹配 `https://github.com/<repository>/releases/download/<release_tag>/<id>-<version>.tgapp`，不接受 query、fragment、端口、凭据或其他下载主机。
- `sha256` 为 64 位小写 hex；`size` 为真实压缩包字节数，正整数且不超过 16 MiB。包本身仍受 32 MiB 解压、8 MiB 单文件、256 条目的限制。
- SHA256 证明内容完整性，不代表 manifest 中的作者字段已获认证。

### 历史合并与防篡改

- 发布工具成功查询全部分页的 Release 列表后，按 SemVer 找到最高已发布稳定版本，并下载其 `catalog.json`。只有成功确认没有已发布稳定版本时才允许首发；网络、API、下载错误或缺少/损坏 catalog 均停止，不降级为本次四条。
- `catalog.mjs` 全量保留上一稳定目录中的旧记录，按应用 ID 升序、稳定版本数值降序输出。
- 相同 `(id, version)` 的摘要、完整 manifest 和压缩包长度均不可改变；相同内容复用原 `url` 和原 `release_tag`。复用前仍校验本次产物。
- 合并超过 512 条或 1 MiB 时失败，不截断历史。已有稳定版本目录的仓库/tag 不符时也失败。

本地 `npm run build` 只根据输出目录中的包生成开发用 catalog，**不会联网获取发布历史**。需要手动验证历史合并时显式指定文件：

```bash
node ./catalog.mjs generate ./catalog ./catalog --tag=v1.0.1 --repo=lengyuesky/tgdrive-app --previous=/path/to/previous-catalog.json
npm run catalog verify ./catalog/catalog.json
(cd catalog && sha256sum -c SHA256SUMS)
```

`--tag`、`--repo` 优先于 `TGDRIVE_APP_RELEASE_TAG`、`TGDRIVE_APP_GITHUB_REPO` 环境默认值。显式 `--previous` 缺失、空文件或无效 JSON 必须失败；不能忽略它重发首发目录。

## 自动化安全发布流程

`.github/workflows/release.yml` 固定 Node `22.22.0`，最小化权限，使用 `release.mjs` 执行以下门禁：

1. 检查稳定 tag 和 main 祖先，再执行 `npm ci`、`npm run check`、`npm test`、catalog 校验及本地 checksum。
2. 重查构建提交/tag/main，成功获取完整发布历史，检查首发或单调版本以及目标 Release 不存在。
3. 下载并严格验证上一稳定 catalog，与本地当前四个真实包合并，生成六个资产的本地期望集合、大小和 SHA256 快照。
4. 创建前再次查询历史，确认未变化，再创建草稿并上传资产；不使用覆盖选项。
5. 在隔离临时目录下载草稿资产，每次 `gh release` 调用显式使用 `--repo`，不依赖当前目录猜测仓库。
6. 与上传前本地快照核对**精确资产集合、每个字节数及每个 SHA256（包括 catalog 和 SHA256SUMS 自身）**。只信下载的 `SHA256SUMS` 不足以通过门禁。
7. 转正前再检查历史与草稿身份未变化，全部通过后才正式发布并设置 latest。

错误不转发可能含签名 URL 或凭据的 `gh` 原始输出。上传或验证失败可能留下草稿，工具不会自动删除或覆盖；维护者须检查残留后决定处理方式，再重新运行全部门禁。

离线单元测试会注入 Git/GitHub 命令执行器并使用真实 ZIP 夹具，覆盖首发、历史查询/下载失败、乱序 tag、历史变化及草稿资产篡改，不会创建真实 Release。

## 发布前本机集成验收

宿主为私有仓库；公开 CI 不检出宿主、不配置跨仓库凭据，也不上传宿主源码、构建产物或集成 trace。维护者推送稳定 tag 前必须完成：

```bash
# 在获授权的宿主工作区构建前端
npm --prefix /path/to/tgdrive/frontend run build

# 在插件工作区运行独立门禁与构建
cd /path/to/tgdrive-app
npm ci
npm run check
npm test
npm run catalog verify ./catalog/catalog.json
(cd catalog && sha256sum -c SHA256SUMS)

# 两端写入与其他夹具已停止后，运行临时数据库的完整集成测试
TGDRIVE_HOST_DIR=/path/to/tgdrive npm run test:e2e
```

夹具启动前检查两端构建产物；无宿主权限的贡献者可以完成独立门禁，但不能把未执行的跨库 E2E 记为通过。由维护者在验收后将实际宿主的完整提交 SHA 更新到 `compatibility.json`，再执行发布。
