# 应用开发指南：契约第 1 版

本文仅说明新平台。唯一线上依据是 [宿主与应用契约](contract.md) 和 `contract/`；四款正式应用、两个 SDK、测试替身与打包工具都进入全量检查。旧 SDK、旧包与旧应用数据不接入新平台。

## 1. 从一个最小应用开始

- 页面应用参考 `examples/page-app/`：分页列出授权文件，读取开头最多 8 字节，用 KV CAS 保存选择。
- 带后端应用参考 `examples/backend-app/`：页面走可信 owner 入口配置文件和应用服务令牌；外部客户端鉴权后，后端返回空正文直传控制响应；主人页面还可以执行一次条件新建目录。
- 这两个示例不进入目录索引，也不发布 Release。

环境固定为 Node.js 22.22.0 与 Rust 1.99.1（`rust-toolchain.toml`）；原生构建镜像使用相同的 Rust 补丁版本。Rust 命令需要把 cargo 加入 PATH。后端 SDK 自身最低 Rust 为 workspace 声明的版本，示例的 SQLite 依赖要求 Rust 1.89 或更新版本。

```bash
fnm use 22.22.0
npm ci
PATH="$HOME/.cargo/bin:$PATH" cargo build -p tgdrive-test-host --bin tgdrive-test-worker
npm run build --workspace @tgdrive/page-sdk
npm run sdk:check
```

### 清单与编译后的目录

应用源码可以使用自己的布局。交给 `tgapp pack` 的必须是独立的、编译完成的目录，不是整个源码仓库。

```text
app.json
page/index.html
page/assets/app.js
backend/app                 # 只有带后端应用才有
assets/icon.svg             # 可选
licenses/依赖许可文件
LICENSE
NOTICE
```

清单采用契约的 `Manifest`。页面入口在 `page/` 下；后端入口固定为 `backend/app`。`package.json` 是构建目标元数据，由新工具生成，不能把 Node.js 的 package.json 混进分发包。清单的 files.read/files.write 只是能力声明，新安装的目录授权仍为 none。

## 2. 页面 SDK 是普通锁定依赖

源码依赖 `@tgdrive/page-sdk` 的确定版本，随页面一起编译。当前仓库使用 npm workspace 和根 package-lock.json 锁定 1.0.0；独立应用也应提交自己的锁文件。不能在运行时加载 CDN，也不由打包器注入 SDK 或宿主源码。

```json
{ "dependencies": { "@tgdrive/page-sdk": "1.0.0" } }
```

```ts
import { createPageApp } from '@tgdrive/page-sdk'

const app = createPageApp()
const page = await app.host.query({
  roots: [], recursive: true,
  filter: { kind: 'file', extensions: [], include_hidden: false },
  sort: 'name', order: 'asc', limit: 200,
})
```

SDK 使用生成 TypeScript 的规范化请求类型。需要默认行为时传完整对象，或在应用自己的取材函数里统一构造请求；不要另建一套线上 DTO。线上类型还可以从 `@tgdrive/page-sdk/contract` 导入。

SDK 从地址片段读取 PageBootstrap，立即清除片段。令牌不出现在返回的 context 中，只在 Session 的私有内存字段里保存。提前续签保持令牌值不变，只更新有效期。`app.refreshSession()` 可显式续签；`app.closeSession()` 通过契约的 DELETE 关闭本页，然后清理 SDK。宿主外壳也能用启动时的同一令牌独立关闭会话。`dispose()` 只做本地取消和清理，不伪装为已成功撤销宿主会话。

### 公开接口

`HostClient` 是应用业务依赖的接口，`HttpHostClient` 是直接 fetch 实现。

| 分类 | 方法 |
|---|---|
| 运行时与授权 | runtimeInfo、scope、closeSession |
| 查询 | stat、list、query、directoriesWithFiles、random、changes |
| 字节与票据 | bytes、readRange、mediaUrl、renewMediaUrl、createReadLease、renewReadLease、revokeReadLease |
| 条件写入 | mutate、mutationReceipt、createUpload、uploadBody、uploadStatus、cancelUpload |
| 应用数据 | kvGet、kvPut、kvDelete、kvList、dataUsage |
| 小对象缓存 | cachePut、cacheGet、cacheDelete、cacheLookup |
| 流与后端 | events、backend |

`app.ui` 覆盖 setImmersive、setTitle、pickDirectory、requestScope、task、close、closedAck，并提供 onNotice、beforeClose。目录选择不授予目录权限。所有消息核对父窗口、宿主源与 nonce；消息不携带 HTTP、文件字节或会话续签。

```ts
app.ui.beforeClose(async signal => {
  // 通过直接 HTTP 保存，必须尊重宿主给出的关闭期限。
  await saveProgress(signal)
})
```

### 传输与错误

- 所有宿主 fetch 都使用应用 Bearer、credentials:omit、redirect:error；页面令牌不能传给自己的后端。
- 控制、原文件字节、宿主事件连接分开计槽，队列有上限，支持 AbortSignal。取消未消费的流也释放读取槽。
- 只读宿主请求最多重试两次，遵守 429 提示与有界退避；写请求、媒体票据签发、读取租约创建以及所有应用后端代理请求不自动重放。
- 后端代理的普通错误响应保留应用协议正文，不能强行当作 ErrorResponse 解码。
- HostError 保留开放 code、HTTP status、requestId、details、retryAfterMs。未知错误码必须有通用处理分支。
- bytes 返回流，不把完整文件变成 Blob。readRange 会校验 206、Content-Range、Content-Length 和实际正文长度；忽略 Range 的整文件 200 不会被当成所需小段。
- 条件请求使用内容版本的强 ETag，不用重命名时的 modified_at 判断内容变化。
- cacheGet 返回 CacheResponse，其中 entry 从 CacheEntry 响应头严格解码；PUT 的 CachePutMetadata 和 GET/HEAD 的 CacheEntry 不是同一种结构。

JSON 请求、应用能力 JSON 响应、分页数组的预算分别来自契约。页可能因字节预算而少于请求的 limit；必须看 next_cursor，不能用 items.length < limit 推断结束。

### 事件和弱一致扫描

```ts
for await (const event of app.host.events({ signal })) {
  if (event.event === 'sync.required') await synchronize()
  else if (event.event === 'files.changed') await consumeChanges()
  // 未知事件仍由 SDK 推进游标，应用可以忽略其业务含义。
}
```

SDK 用带 Bearer 的 fetch 读取 SSE，重连时发送 Last-Event-ID，并做有界游标去重。sync.required 原样交付，不替应用扫描或缓存业务数据。SSE 是内存提示，不是持久日志或写入回执。

完整扫描保存第一页的 scan_cursor，分页按 ID 去重，完成后消费 changes。授权变化要重读 ScopeInfo 并重扫；子树失效要重新查询受影响子树。失败的列表请求不能被当成“旧记录全被删除”。

## 3. 应用后端 SDK

Rust 应用使用锁定依赖 `tgdrive-backend-sdk`。它只提供 Unix HTTP 和通用宿主能力，不选择外网 HTTP/TLS 客户端或数据库库。示例主动选择 rusqlite，并内置编译 SQLite C 源码；其他应用自行决定。

```rust
let start = StartContext::from_args(std::env::args_os(), CONTRACT_VERSION)?;
let host = Arc::new(UnixHostClient::new(&start));
// 在必要的私有数据库迁移完成之后才绑定与宣告 ready。
BackendServer::bind(start)?.run(handler, cleanup).await?;
```

- 唯一参数为 `--tgdrive-context <绝对路径>`，不从环境变量另抄上下文。
- SDK 严格解码 JSON、协商同 major 的共同 minor、校验启动身份和路径，不截断 Linux Unix 套接字路径。
- BackendServer 在给定套接字监听 HTTP/1.1。Linux 只接受宿主 root 的连接，GET 内部就绪路径返回契约的 BackendReadyResponse。
- 业务请求必须有唯一的、合法的 ForwardContext。缺失不意味着主人；owner 只能配 page，external 只能配 root/prefix，应用 ID 必须匹配。
- 带转发上下文访问内部前缀一律拒绝。应用自行对 external 请求鉴权，不借主人 Cookie、设备或页面令牌进入主人路由。
- 收到 SIGTERM 后关闭监听，通知 Shutdown，已有请求与 cleanup 共用契约的停止预算。应用要停止自己的任务/子进程并关闭 SQLite，不能让子进程脱离宿主回收范围。

`HostClient` 是可作为 trait object 使用的宿主接口。覆盖查询、bytes/media_url、ticket_bytes、local_url/revoke_local_url、读取租约、条件事务与回执、流式上传与核实、KV、缓存、events 和 keepalive。`ticket_bytes` 将本应用本轮签发的媒体/缓存相对票据路径原样经专用套接字读取，不需要公开源，也不接受本机地址或任意 URL。UnixHostClient 通过宿主套接字使用完整契约路径、固定 Host:tgdrive，不携带页面令牌。HTTP 连接可复用，流有背压、并发和空闲时限；取消 Rust future 或丢弃 ByteStream 会停止等待/读取。

### 直传不经过应用后端

```rust
stream_response(&method, &directive, file_size)
```

该函数用契约的 validate_stream_directive 校验，返回 204、空正文和无 padding base64url 控制头，HEAD 也有指令。后端只选择已鉴权文件、窗口和可选租约；宿主再次核对授权、内容版本和原始 Range，再发送原文件。应用不能伪造字节长度、Content-Range 或把 JSON 混入已开始的字节流。

条件写入必须保存完整请求和幂等键，未知结果先等待在途请求结束，再查 mutation_receipt 或 upload_status。查不到回执不是原请求失败的证明；不能立即另造键重写。SDK 不替应用做业务恢复政策。

## 4. 自动化测试不启动宿主

业务层分别只接受 TypeScript HostClient 或 Rust HostClient。两种测试替身共用 `testing/backend-host/` 的 Rust 内存核心。

- Rust：仅在 dev-dependencies 引入 tgdrive-test-host，创建 MemoryHost。
- TypeScript：仅在 devDependencies 引入 `@tgdrive/test-host`，MemoryHost.create 启动本地测试工作进程。默认路径遵从 `CARGO_TARGET_DIR`（未设置时使用本仓库 `target/debug`，相对目标目录按调用 cwd 解析）；`TGDRIVE_TEST_WORKER` 优先，显式 `workerPath` 再优先。`sdk:check` 会先固定相对目标目录的绝对路径，再传给各工作区子进程。
- 工作进程只读写 stdin/stdout，不监听端口或套接字，不实现宿主 HTTP 服务，不是本地网盘部署模式。
- 文件树和字节由测试构造；本地合成文件可以通过 seedFile 读入。测试不读取生产配置或真实网盘。

```ts
import { MemoryHost } from '@tgdrive/test-host'
const host = await MemoryHost.create({
  app: { id: 'example', name: '示例', version: '1.0.0', generation: 'g1' },
  files: { read: true, write: false },
  scope: { mode: 'all', access: 'read_only' },
  nodes: [{ id: '2', parent_id: '1', name: '示例.bin', kind: 'file', bytes: [1, 2, 3] }],
})
try { await testBusiness(host) } finally { await host.dispose() }
```

如何避免契约漂移：授权调用 validate_scope/effective_access，查询调用契约查询校验器，Range 调用 resolve_single_range，缓存头调用 validate_cache_entry_header，字节截页调用 json_page_prefix_count，所有常量/DTO 直接依赖 tgdrive-contract。KV CAS、上传和元数据事务的动态内存状态只实现一次，页面测试不再手抄另一套规则。页面线上形状校验也从生成 TypeScript 自动推导；sdk:schema:check 检查生成物是否过期。

替身覆盖 ID 祖先/重叠授权、授权根移动、游标绑定/高水位、Range/条件读取、在途撤权、原子条件写入、上传不可见/回执、KV 并发/ABA、缓存源失效、租约与页面关闭。测试用 setScope/addNode/changeNode/advance 等配置方法不属于 HostClient，业务不能把它们当成授权 API。

替身验证语义，不证明宿主的 SQL 索引、真实 Telegram、UID/文件权限隔离、浏览器 CSP、备份或客户端兼容已经验收。不得把 SDK/替身测试当成官方外部客户端实测。

## 5. 原生构建：在每个目标架构的 Docker 中使用 musl

本机不全局安装 zig/cross/C 编译器，也不要求本机增加 Rust Linux 目标。构建镜像 `tools-v1/native/Dockerfile` 安装 musl-tools、build-essential、pkg-config，并在镜像内安装对应 Rust musl 目标。

| 分发目标 | Docker 平台 | Rust 目标 |
|---|---|---|
| linux-amd64 | linux/amd64 | x86_64-unknown-linux-musl |
| linux-arm64 | linux/arm64 | aarch64-unknown-linux-musl |

Apple Silicon 上 amd64 由 Docker 模拟，arm64 原生运行。C 编译器也在目标架构运行，CC=musl-gcc、AR=ar；内置 SQLite 等 C 依赖不需要另一套交叉 C sysroot。显式设置 crt-static、静态 relocation 和链接器 -static，并由真实 ELF 校验器拒绝 PT_INTERP/DT_NEEDED；不能仅相信 Rust 的目标名或容器里正好有某个动态库。

源码（含根目录 LICENSE）先复制成一次冻结快照，再只读挂入容器；两架构可共享同一快照，不受编辑工作区影响。每个架构有自己的输出目录和 Cargo 注册表缓存。根 release profile 使用 thin LTO、单 codegen unit 和 strip。构建器收集实际正常依赖及标准库许可，不随包带测试替身、构建工具或宿主。

```bash
node tools-v1/build-native.mjs tgdrive-example-backend "$ARM_OUTPUT" linux-arm64
node tools-v1/build-native.mjs tgdrive-example-backend "$AMD_OUTPUT" linux-amd64
```

两个变量都必须指向新的隔离目录。输出包含 backend/app、licenses、LICENSE、NOTICE、build-info.json；target 中间目录不进入包。构建工具不发布镜像或包。

## 6. 打包、核验和目录索引

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build -p tgdrive-app-tools --bin tgapp
./target/debug/tgapp pack "$COMPILED_STAGE" "$NEW_OUTPUT" web
./target/debug/tgapp pack "$COMPILED_STAGE" "$NEW_OUTPUT" linux-arm64
./target/debug/tgapp verify "$PACKAGE"
./target/debug/tgapp elf "$BACKEND_EXECUTABLE" linux-arm64
```

工具校验清单/目标/布局、真实 ELF、ZIP 本地头与中央目录、CRC、实际长度/累计大小、ZIP64/分卷/加密、链接/特殊文件、目录覆盖与大小写别名。它不执行归档里的代码，也不把布局单元测试冒充真实 ZIP/ELF 验证。

同样的编译后文件得到逐字节相同 ZIP：ASCII 字节顺序、固定 DOS 时间、固定权限、无多余 ZIP 元数据，压缩级别与实现由锁文件固定。对能缩小的文件使用确定性 Deflate，其余 Stored。改变编译工具链、依赖或压缩器可能改变包；同版本同目标的既有包不能替换，修复升应用版本。

```bash
./target/debug/tgapp catalog example/apps "$NEW_CATALOG_OUTPUT" "$WEB_PACKAGE" "$AMD_PACKAGE" "$ARM_PACKAGE"
./target/debug/tgapp catalog-check "$NEW_CATALOG_OUTPUT/catalog.json"
```

目录地址为契约规定的 GitHub Release 精确 URL，摘要/大小来自真实 ZIP。带后端的同版本必须同时提供两架构和相同完整 app.json。发布者侧 catalog-history.json 保存所有曾见的绑定；即使撤回版本，也不能以同版本换包或倒退仍保留应用的最高版本。工具先写历史再写目录；读取旧目录时只核对已见绑定不变，最高版本检查针对最终候选目录。因此历史已保存而目录写入失败时，保留历史并用相同包重试，可恢复到与一次成功相同的字节；换包或最终候选倒退仍失败。本仓库正式发布将两份文件放在 main 的同一次 Git 提交中，每轮从该共同快照克隆状态到新目录，避免根目录出现半更新。不清空或改写历史绕过失败，具体流程见第 8 节。

所有输出目录显式指定，必须位于源码仓库之外，不能通过目录链接绕回源码。发布 Release 和提交目录是另外的授权操作；tgapp 自身只做本地核验和生成，不联网发布。示例包始终不进入真实目录索引。

本仓库第一方代码与文档统一采用 MIT 许可，原文以根目录 LICENSE 为准。冻结源码包含该文件；同仓库原生构建器把它复制到顶层 LICENSE 与各第一方依赖的 licenses 子目录，示例页面/后端包也携带顶层 LICENSE 和页面 SDK 许可。Rust 成员继承 workspace 许可，Node 工作区包声明同一许可；第三方依赖和标准库的原始许可、NOTICE 照常收集，不被 MIT 覆盖。通用 tgapp pack 只保留输入中的许可文件，不替其他应用授予本仓库许可。

## 7. 完整示例验收

```bash
node tools-v1/build-examples.mjs "$NEW_PACKAGE_OUTPUT"
```

该命令编译两个示例页面、构建两架构后端、收集许可、实际输出一个 web 包和两个原生包，并用同一契约库验证。可额外传已验证的 amd64/arm64 原生产物目录，避免每轮重复编译。重复执行到另一个新目录，核对三个原 ZIP 摘要。

真实运行的 Linux arm64 验收使用 `tools-v1/native/probe.mjs`：在只读、断网、私有临时数据的容器中以独立 UID 启动示例，root 经指定 Unix 套接字请求 ready，验证 owner/external/内部前缀边界，发送 SIGTERM 并核对正常退出。它不启动宿主，不对外发布端口，不证明资源限制或全部宿主硬隔离已经实现。

总门禁如下。

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --workspace --locked --all-features
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --workspace --locked --all-targets --all-features -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo fmt --all --check
npm ci
npm run contract:check
npm run typecheck
npm test
```

应用自己的解析、业务恢复、外部协议鉴权及真实客户端兼容测试仍由应用负责。

## 8. CI 与发布

### 本地统一门禁与全部应用构建

先安装可从 PATH 执行的 `ffmpeg` 和 `ffprobe`：Ubuntu 使用 `sudo apt-get install ffmpeg`，macOS 使用 `brew install ffmpeg`，并分别执行 `ffmpeg -version`、`ffprobe -version` 确认可用。影视 Rust 测试会生成合成视频并实际调用这两个程序；CI 在全量门禁前显式安装并验证它们，缺少依赖时不能跳过媒体测试。

```bash
export PATH="$HOME/.cargo/bin:$PATH"
fnm use 22.22.0
rustup toolchain install 1.99.1 --profile minimal --component clippy --component rustfmt
npm ci
SESSION="$(mktemp -d /tmp/tgapp-build.XXXXXX)"
export CARGO_TARGET_DIR="$SESSION/cargo-target"
npm run check:all -- --output "$SESSION/checks"
npm run build:all -- --output "$SESSION/build" --probe
```

顶层输出必须是**仓库外且尚未创建**的目录。统一入口只编排现有页面和后端构建器，不复制打包规则。`build/packages/` 恰好包含六包：阅读馆、短视频各一个 `web`，影视、影视刮削各两个 Linux 架构包；后端应用没有 `web` 包。每包都经 `tgapp verify`，`build/catalog/catalog.json` 经历史转移校验和 `catalog-check`。`--probe` 从已核验 ZIP 提取真实 ELF，在只读、断网、私有临时数据、独立 UID 的容器中测试启动与退出，不代表真实宿主或官方客户端联调。

可用 `--target web|linux-amd64|linux-arm64` 拆开构建；单目标产物不生成不完整目录。汇总时使用：

```bash
npm run catalog:packages -- --packages "$ALL_PACKAGES" --output "$SESSION/catalog-check" --catalog-state "$PWD"
```

`--reuse-native "$NATIVE_ROOT"` 可复用 `$NATIVE_ROOT/<id>/<linux-amd64|linux-arm64>/` 中已有的原生产物；未提供的目标重新编译。复用仍检查 crate、应用版本、固定 Rust 版本、真实静态 ELF 与 musl 许可。`build-result.json` 记录本轮重建/复用来源；示例始终不进入目录。

### 检查工作流与原生 runner

`.github/workflows/ci.yml` 在 `main` push、PR 和发布工作流调用时运行：统一全量门禁 → 三目标构建 → 四个后端包容器探测 → 六包重新核验并以根目录历史生成候选目录。它只保存检查产物，不创建 Release、标签或更新 main。

amd64 使用 `ubuntu-24.04`；arm64 使用公开仓库可用的 `ubuntu-24.04-arm`，并检查 runner 的 `uname -m`，不用 QEMU 构建。标签依据 [GitHub 官方托管 runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。本地 Apple Silicon 的 amd64 Docker 模拟与 CI 的原生构建是两回事。

应用构建固定 Node.js 22.22.0 与 Rust 1.99.1。所有 Action 都来自 GitHub 官方组织，固定到以下完整提交，而不是浮动版本标签：

| Action | 版本 | 完整提交 |
|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| `actions/upload-artifact` | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| `actions/download-artifact` | v8.0.2 | `9000827ccba6bdab643e8b6fd33ac0654aef8333` |

### 手动发布与升版本

`.github/workflows/release.yml` **只接受 `workflow_dispatch`，且只允许 main**。push 或 tag 不自动发布。维护者在 GitHub 的 Actions 页面选择「手动发布应用」→「Run workflow」→ main；也可以自行执行 `gh workflow run release.yml --ref main`。触发发布前必须确认要公开这些版本。

1. 改动会影响清单或 ZIP 字节时，升对应应用 `app.json.version` 的稳定 SemVer；后端 crate 的 Cargo 版本必须同步。依赖、共享 SDK/界面、编译器或许可变化可能影响多款应用，需要逐款升版。已发布同版本不能重建换包。
2. 发布重新执行完整 CI；只有发布任务有 `contents: write`，其他任务默认 `contents: read`，fork PR 没有写权限。所有 checkout 均不持久保存凭据。
3. 对目录和历史已见版本，既有 Release/资产必须存在、摘要与实际下载一致；不会重建或补传丢失的已有绑定。新版本创建带本管线标记的草稿，同名资产永不覆盖；中断后只补尚未进入目录的新版本缺少的资产。
4. 全部草稿包实际下载核验后才正式发布，再用**不含令牌**的精确 Release URL 下载、验证长度、SHA-256、真实包及完整清单。全部通过后才提交目录，目录不会指向尚不存在的资产。
5. 目录与历史通过 `createCommitOnBranch.expectedHeadOid` 放在**同一提交**中；main 已推进时拒绝提交，不强推。同一时间只允许一个发布工作流运行。

建议在仓库设置中启用不可变 Release。草稿先附齐资产再发布符合 [GitHub 官方建议](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)；草稿续跑使用有写权限的分页 Release 列表，因为 [按 tag 查询只保证返回已发布 Release](https://docs.github.com/en/rest/releases/releases)。

GitHub 草稿资产可能返回 `untagged-*` 临时下载路径；发布工具只接受同仓库、同文件名的草稿路径，并通过资产 API 核验原字节，不把临时地址写入目录。正式发布后仍必须使用精确版本标签的公开 URL 无令牌下载核验。

### 历史存放位置与失败重跑

`catalog.json` 和 `catalog-history.json` 均跟踪在 **main 根目录**。历史是发布者侧使用的工具状态，宿主不读取，不属于线上契约，也不嵌入安装目录；它只有公开清单、精确 URL、摘要与大小，没有令牌或签名 URL，所以公开存放不会泄露机密。与目录同一提交能可靠保留撤回版本与最高版本绑定；Actions cache 或短期 artifact 不能替代这份历史。

发布前严格校验现有目录的每个身份、清单与目标包绑定都已记录在历史中且一致；非空目录缺少历史、历史缺失绑定或两者矛盾时失败，不从目录重建历史。只有空目录且历史不存在的首次发布允许初始化空历史。

目录只列工作区当前的四款版本；旧版本 Release/绑定仍保留在历史中。`catalog:packages --catalog-state` 和正式 CI 每轮都读取上一份根目录共同快照，拒绝同版本换包、同版本改清单与最高版本倒退。

失败后保留已上传的草稿/正式资产及历史，修复问题后从最新 main **重新手动触发整个发布工作流**。已上传的相同包逐个核验后跳过；部分草稿只补缺少的包；Release 完成但目录提交失败时只再核验并提交目录。资产摘要冲突必须升版本，不能覆盖资产、移动标签或清空历史。若 main 已推进，不复用旧运行的源码快照；分支保护不允许令牌提交时，由维护者配置受限发布权限，不用个人令牌绕过。

### 不联网的发布演练

先安装固定工具链、`npm ci`，并通过一次普通构建准备 Docker 镜像与注册表缓存。演练不自动联网准备依赖；缺少缓存时明确失败。

```bash
npm run release:dry-run -- --output "$SESSION/rehearsal" --probe
# 已有六个完整、核验过的包时可以避免重建。
npm run release:dry-run -- --output "$SESSION/replay" --packages "$ALL_PACKAGES"
```

默认模式不联网：Cargo/npm 离线，Docker 禁止拉镜像、原生编译和探测容器断网；GitHub API 不会被调用。演练完整执行构建（未传 `--packages` 时）、核验、目录生成和 `catalog-check`，在自己的文件系统远端替身中模拟草稿/资产/目录快照，再验证第二次运行跳过不变版本、合法同版本换包被拒、版本倒退被拒。`rehearsal/rehearsal.json` 记录结果；所有目录仍留在仓库外，不创建 Git 提交或真实 Release，不能把演练目录复制进 main。
