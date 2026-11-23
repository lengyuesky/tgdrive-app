# 宿主与应用契约，第 1 版

契约版本：**1.0**。Rust 契约库版本：**1.0.0**。应用包格式与目录索引格式：**1.0**。

本文和 `contract/` 是本次平台重写的契约，不是旧页面应用 API v1/v2 的兼容层。旧 SDK、旧包、旧目录索引和旧应用数据不接入此协议。首次切换清除旧应用平台的数据，但不改变网盘文件；以后新平台自身的普通更新保留应用数据。

文中的“必须”“不得”是符合性要求。“可以”是明确允许的选择。JSON 字段、URL、枚举及常量以 `contract/src/` 中的 Rust 定义为唯一机器可读出处；`contract/types/contract.ts` 是生成物，不得手工编辑。本文规定不能仅靠类型表达的行为、授权与生命周期。

## 1. 边界与术语

- **宿主**：提供网盘本体和应用平台，不认识书、电影、NFO、番号、媒体库、刮削资料来源或某款客户端协议。
- **应用**：独立安装与发布的单元，可以有应用页面、应用后端之一或两者。
- **应用页面**：TypeScript 编译出的静态页面，运行在应用中心的沙箱 iframe 中。
- **应用后端**：应用包内的 Rust 原生可执行文件，由宿主以该应用的独立系统用户启动。
- **页面应用**：没有应用后端的应用。
- **应用中心**：宿主中供主人安装、授权、更新、停用、卸载应用的部分。
- **对外服务**：应用后端提供给外部客户端的服务；安装或进程就绪不等于应用自身的对外服务已经启用。
- **根地址**：不属于 `/admin` 的对外地址部分，同一时间交给主人指定的一个应用。
- **目录授权**：应用可以访问的网盘目录范围，以及各范围的只读或读写级别；应用自身的取材目录只是筛选条件。
- **文件内容版本**：某文件内容的版本。重命名、移动不改变它；每次覆盖产生新版本，即使覆盖后的字节相同。
- **沉浸状态**：应用页面占满宿主可用屏幕、不显示宿主外壳，不是浏览器 Fullscreen API。

应用页面不得依赖宿主的 Vue 组件、内部路由、数据库表或另一应用。应用后端不得读取宿主数据库、配置、密钥、其他应用的数据或 Telegram 凭据。修正某款客户端协议、解析某种资料或增加联网资料来源，只能修改并发布应用，不得要求宿主增加应用专用方法。

### 已由指挥确认的设计取舍

| 自行决定并经指挥确认的事项 | 理由 |
|---|---|
| 每应用一对、双方向各一个独享 HTTP Unix 套接字 | 两端各自监听，身份简单可靠，不需要反向 RPC 或令牌 |
| 通用直传开始/结束事件与可撤销读取租约，撤销中止在途传输 | 满足实际起播与登出竞争处理，宿主仍不认识影视内容，只有最小通用原语 |
| 通用索引随机抽样，不全表扫描，并明确不保证严格均匀性 | 短视频无需先遍历几十万文件，随机保证与实现成本清楚 |
| CSP 禁外站网络 API/资源，外站导航为包的禁止行为，不宣称恶意页面零外联 | 保护网盘授权与宿主，不为本来可联网的应用引入额外浏览器/网络隔离 |
| 所有应用必备的通用小对象缓存、LRU、不备份 | 缓存属于通用数据能力，避免重复读取/解析，不建立内容专用封面库 |

## 2. 版本、能力与演进

### 2.1 四种版本

| 版本 | 含义 |
|---|---|
| 清单 `version` | 应用自身的稳定 SemVer `X.Y.Z`，数字段无前导零，不使用预发布或构建后缀 |
| 清单 `contract` | 应用要求的最低契约版本 `{ "major": 1, "minor": 0 }`，不是最低宿主产品版本 |
| 包 `package.json.format` | ZIP 及包元数据格式的版本 |
| 目录 `catalog.json.format` | 目录索引格式的版本 |

Rust 库采用 SemVer。协议 1.0 初始对应库 1.0.0；只修正文档或校验实现缺陷升 patch，新增可选通用能力升 minor，改变线上语义或删除旧能力升 major。宿主锁定库的发布版本或完整提交，不依赖浮动 `main`；应用使用自己的已锁定依赖。不要求所有应用与宿主使用同一库 patch/minor。

### 2.2 向后兼容规则

1. 同一契约 major 的宿主必须保留已经支持的所有旧 minor 行为与默认值。新增能力不能使已兼容应用必须升版。
2. minor 只能增加可选字段、新接口、可探测能力、开放事件名和开放错误码，不能改变已有字段含义、类型、默认值或授权边界。
3. 结构体的未知可选字段必须接受并忽略其行为。清单及其嵌套扩展字段还必须保留，以参与完整清单比较。不得使用拒绝全部未知字段的策略。
4. 新字段如影响权限、必需的启动方式或正确性，应用必须同时提高最低 `contract.minor` 或声明对应 `required_capabilities`。旧宿主忽略新字段时绝不能意外授予新权限。
5. 清单 `required_capabilities` 是开放名称列表。缺少必需能力只使该条应用版本不可安装，不能使整个目录失效。可选能力不需要写入另一个冗余列表：运行时检查 `RuntimeInfo.capabilities` 即可。
6. 权限、节点种类、运行模式、转发调用方等**闭合枚举**，不得在 minor 中直接加入破坏旧解析器的新值。需要新值时增加可选字段/新能力，或升 major。
7. 错误 `code`、SSE `event`、`sync.required.reason` 是开放字符串。应用必须有未知分支：显示通用错误，或忽略未知事件但推进事件游标。不能把未知事件解析失败视为整个事件流损坏。
8. 目录读取先解析原始条目的 ID、版本、最低契约和必需能力，再判断兼容性，最后解析兼容条目的完整清单。未来 major 的清单形状不得拖垮仍兼容的条目。不兼容条目不下载，仍校验身份、精确 Release URL、小写摘要与正长度，但不套用本宿主旧包大小上限；否则未来更大包也会拖垮全部目录。
9. 包和目录格式的同 major 新 minor 也只能增加可忽略字段。依赖新包行为的应用必须声明对应最低契约/必需能力。未知架构条目可以保留但不选择；未知格式 major 拒绝。
10. 已安装的旧 major 可以继续运行，前提是宿主仍声明支持它。宿主不得静默把请求解释成另一 major；未来停止支持 major 必须显式阻止升级或先由主人处理不兼容应用，不留旧协议别名。

`RuntimeInfo.contract` 和 `BackendStartContext.contract` 表示宿主支持的最高同 major 版本。应用后端在就绪响应中返回 `min(宿主最高 minor, 自身实现的最高 minor)`，必须不低于清单要求。宿主以该就绪版本向该进程发送转发上下文。旧 1.0 应用不能因宿主升到 1.1 而被判定就绪失败。页面按最低契约和能力探测使用接口，忽略额外上下文字段。

v1 的宿主必须实现本文的基础运行时、目录授权、通用文件、键值存储、通用小对象缓存、事件和界面通道。后端能力只对带后端且满足硬隔离约定的应用适用。`cache.objects` 是所有应用都能使用的必备基础能力，应用不需要为其缺失写降级路径。原生设备 KV 是独立的 `kv.device` 扩展，不属于 v1 宿主必备；首版不实现，iOS 适配不在本次切换范围。

能力名称全集如下；`CAPABILITY_REQUIREMENTS` 标明 v1 是否必备，`CAPABILITIES` 是已定义名称全集，不是实际支持声明。RuntimeInfo 只列当前调用方/安装形态适用且宿主实际支持的项，能力可用不替代目录授权。

| 分类 | 名称 |
|---|---|
| 运行时与授权 | `runtime.info`、`session.refresh`、`scope.read` |
| 文件查询 | `files.stat`、`files.list`、`files.query`、`files.directories_with_files`、`files.random`、`files.changes` |
| 字节与写入 | `files.bytes`、`files.media_url`、`files.local_url`、`files.mutate`、`files.upload`、`read_leases` |
| 数据与事件 | `kv.cas`、`events.sse`、`cache.objects` |
| 非必备扩展 | `kv.device`，仅支持此扩展的宿主提供设备 KV |
| 后端 | `backend.proxy`、`backend.keepalive`、`backend.external` |
| 界面 | `ui.set_immersive`、`ui.set_title`、`ui.pick_directory`、`ui.request_scope`、`ui.task`、`ui.close`、`ui.theme_changed` |

名称 1～80 字节，小写字母开头，仅含小写字母、数字、点、下划线、短横线；必需列表不得重复。后续新增同 major 能力仍使用独立名称，不能把某应用 ID 当能力名。

## 3. JSON 与 HTTP 公共规则

### 3.1 线上数值和标识

- UTF-8 JSON，字段名使用本文的 snake_case；Content-Type 为 `application/json`。列出的结构体必须使用对象形态，数组只出现在指定数组字段或任意 JSON value 中；不能把 serde 的结构体位置数组解码当成合法协议对象。
- 所有层级拒绝重复 JSON 对象键，拒绝非有限数和超出 JavaScript 安全范围的 JSON 整数。使用契约的严格 JSON 读取器，不能先经会静默覆盖重复键的解析再校验。
- `NodeId` 是无前导零的十进制**字符串**，范围 `1..=9223372036854775807`。不使用 number。
- `ByteCount` 是无前导零的十进制**字符串**，范围 `0..=18446744073709551615`；单个网盘文件受 SQLite 限制，不超过 `i64::MAX`。偏移、长度、大小、配额和已发送字节都使用它。
- `Timestamp` 是 Unix **毫秒整数**，范围 `0..=9007199254740991`，线上仍是 JSON number。
- 内容版本、修订、租约 ID、会话 ID、请求 ID、关联标识是不透明字符串，统一使用 1～128 个 ASCII 字母、数字、下划线、短横线；应用不能推导、比较大小或复用删除后的修订。
- 游标是不透明、不超过 4096 字节的字符串。不能自行构造、截断或解码后修改。
- 网盘路径是规范化绝对路径，根为 `/`，总长最多 4096 字节。名称是 1～255 字节 UTF-8，不含控制字符、`/`、`\`，不等于 `.` 或 `..`；不接受重复斜杠、尾斜杠或路径中的 `.`、`..`。
- 包资源路径另有更窄的规则，见第 5 节，不能把网盘路径规则用于解包。宿主输出的限时 URL/公开基地址是合法 URI、不含控制字符、最多 8192 字节。

TypeScript 生成类型表示 Rust 序列化后的规范化对象。请求中写明可省略的默认字段可以省略，但使用生成类型的调用方可以传完整规范化对象；未来 SDK 可以填充默认值，不另抄一套协议类型。`Option` 字段接受省略或 `null`；必需字段不得用 `null` 代替。

### 3.2 认证入口

应用能力统一位于 `/admin/api/apps/v1/self`，请求中不接受另一个应用 ID。

| 调用者 | 调用方式 | 身份与边界 |
|---|---|---|
| 应用页面 | `fetch(bootstrap.api_base + path)`，`Authorization: Bearer <应用会话令牌>`，`credentials: 'omit'`、`redirect: 'error'` | 令牌绑定应用、安装 generation、页面会话；不是主人登录令牌 |
| 应用后端 | HTTP/1.1 经 `BackendStartContext.host_socket` 的 Unix 套接字，使用同一完整 `/admin/...` 路径 | 套接字和 `SO_PEERCRED` 决定应用身份，不传令牌，不接受应用 ID 覆盖 |
| 原生客户端 | kv.device 扩展的第 10 节专用 KV 地址，`Authorization: Bearer <设备令牌>` | 仅实现该非必备扩展时可用；主人配对且有对应 app_data 授权，不变成页面/后端；首版不实现 |
| 应用中心 | `/admin/api/app-center/v1`，主人登录 Cookie 与宿主的同源/CSRF 防护 | 应用会话、后端套接字和普通外部客户端均不能调用 |
| 媒体元素/外部客户端 | 第 9 节的限时票据 URL，或应用自己的对外协议地址 | 票据只允许规定表示的 GET/HEAD；外部协议由应用鉴权 |

接口注册表 ENDPOINTS 的 backend_socket 表示该端点是否在应用后端的宿主套接字上注册，不替代其 access、能力或目录授权。除适用的 self 能力外，media.ticket/cache.ticket 也为 true，但只接受本应用当前后端启动轮次签发的票据；local.ticket 仍只在内部 loopback 监听器，不在 host.sock 注册。

后端的宿主套接字只接受该应用专用 UID 的连接，进程启动时清空附加组、Linux capabilities，禁止 UID 切换。宿主每个启动轮次重新创建身份绑定，旧进程及其子进程不能复用新启动的能力通道。HTTP `Host` 不决定身份；使用固定 `Host: tgdrive` 即可。该套接字不提供主人管理接口或任意网络代理。

页面的会话令牌只在内存中保存，不能放进 Cookie、localStorage、请求查询参数、日志、错误文本或发送给自己的后端。页面必须用直接 fetch 读取字节和 SSE，不经宿主页面二次转发。

### 3.3 页面 CORS、会话与错误

- 应用专用能力端点验证 Bearer 后允许不透明沙箱源 `Origin: null`；响应 `Access-Control-Allow-Origin: null`，不返回 `Access-Control-Allow-Credentials`。限时媒体/缓存地址及包静态资源可以返回 `Access-Control-Allow-Origin: *`，仍不允许携带 Cookie。
- 允许头为 `Authorization, Content-Type, Range, If-None-Match, If-Range, Last-Event-ID, Idempotency-Key, X-Tgdrive-Cache-Meta`。OPTIONS 只做预检，不执行操作，返回 204；允许方法必须取该目标实际支持的方法，不能开放 CONNECT/TRACE。
- 暴露响应头为 `Content-Length, Content-Range, Accept-Ranges, ETag, Retry-After, X-Tgdrive-Request-Id, X-Tgdrive-Cache-Meta`。
- 应用会话默认 6 小时。页面在过期前经 `POST /self/session/refresh` 续签同一页面会话；**续签保持页面令牌值不变，只更新 expires_at**，使宿主外壳持有启动响应的同一令牌也能独立关闭该会话。令牌已过期则返回 `session_expired`，需由应用中心重新启动页面，不经消息通道续签。更新、停用、卸载、恢复、更换安装 generation 或主人登录撤销都会使关联页面会话失效。
- `DELETE /admin/api/apps/v1/self/session` 仅接受当前页面会话 Bearer，无正文，成功返回 **204**。宿主外壳关闭页面时用启动响应中的同一令牌调用，页面 SDK 在主动关闭并保存完成后也可以调用；不接受安装 Cookie、设备令牌或后端套接字身份，也不接受另一页面 ID/应用 ID。
- 该接口撤销当前页面会话及其创建的**媒体票据、缓存票据、读取租约**，取消页面关联的在途读取/请求；不轮换安装 generation，不影响其他页面或应用后端的独立会话/租约，不删除 KV 或缓存对象。格式/签名/用途无效的 Bearer 返回 401 unauthorized；后端套接字身份调用返回 403 caller_not_allowed；已经关闭、过期或因安装撤销而失效的页面令牌返回 401 session_expired 或 unauthorized，不重新激活该会话。
- 页面关闭使该页面会话及其派生访问能力失效；应用后端自己的服务登录会话不因此撤销。后端停止/崩溃使该启动轮次签发的租约、票据、本机读取和在途直传失效。
- **JSON 请求正文上限为 64 KiB，标准应用能力 JSON 响应上限为 2 MiB**；不是同一个方向的预算。计 UTF-8 序列化后的实际字节（含 JSON 转义），不得用请求上限限制合法响应。RuntimeInfo.limits 分别提供 json_request_bytes、json_response_bytes、json_page_bytes。此响应上限用于应用直接调用宿主 self 能力及 kv.device 标准 JSON；应用中心/仅主人内部界面响应、应用后端自定协议转发、二进制和 SSE 按各自接口限制，不套用此 SDK 响应预算。
- 所有通用文件/变更/KV分页数组累计最多 **512 KiB**，仍同时遵守各自条数上限；到达字节上限必须提前结束本页并签发续页游标，不静默漏掉下一项。完整分页外层（游标、目录元信息等）仍检查 2 MiB 响应总上限。
- 除指定的二进制/SSE/代理响应外，成功直接返回所列对象，不另加 data/ok 信封；空成功返回 HTTP 204，无正文。
- 错误为 `ErrorResponse`，例子如下。所有响应带 `X-Tgdrive-Request-Id`。消息不得泄露秘密、未授权节点名称/路径、套接字路径、代理凭据或完整限时 URL。

```json
{
  "error": {
    "code": "storage_conflict",
    "message": "记录已由其他设备更新",
    "request_id": "request-1",
    "details": { "current_revision": "revision-2" }
  }
}
```

限流/配额错误使用 429，可附 `retry_after_ms`，同时返回向上取整秒数的 `Retry-After`。只读请求可以遵守该提示做有界重试。写入、授权错误、冲突和结果未知的请求不得无条件自动重放；只有第 8 节明确规定的幂等请求可用相同幂等键核实或重试。

### 3.4 公共错误码全集

下表是当前闭合清单，但线上 `error.code` 是开放字符串。各接口还有公共的 `invalid_request`、`payload_too_large`、`rate_limited`、`request_timeout`、`internal_error`。

| HTTP | 错误码 | 条件 |
|---|---|---|
| 400 | `invalid_request`、`invalid_cursor`、`invalid_path` | 参数、游标绑定或路径非法 |
| 401 | `unauthorized`、`session_expired`、`device_revoked` | 应用/设备认证缺失、过期或撤销 |
| 403 | `scope_denied`、`write_not_declared`、`caller_not_allowed` | 当前目录授权不足、未声明写入或调用方类型不符 |
| 404 | `not_found` | 节点不可见/已进回收站、键外对象、未安装应用、票据绑定的缓存不存在 |
| 405 | `method_not_allowed` | 目标不接受此方法；返回 Allow |
| 409 | `app_changed`、`app_disabled` | 安装 generation 改变或应用停用 |
| 409 | `content_changed`、`node_changed`、`children_changed`、`scope_changed` | 内容引用、节点条件、直属集合条件、授权修订不再匹配 |
| 409 | `storage_conflict`、`name_conflict` | KV CAS 冲突，或目标有同名可见节点 |
| 409 | `upload_state`、`idempotency_conflict` | 上传状态不允许操作，或幂等键被不同请求复用 |
| 409 | `incompatible_contract`、`capability_unavailable`、`package_changed` | 契约/能力不满足，或已确认的包/清单绑定改变 |
| 410 | `cursor_expired`、`ticket_expired`、`lease_expired`、`upload_expired` | 游标超出保留期、票据/租约/上传过期 |
| 411 | `length_required` | 需要可确定正文边界但缺少有效长度/分块编码 |
| 413 | `payload_too_large` | 请求、包、指令、对象或流式正文超过对应上限 |
| 416 | `range_not_satisfiable` | 空文件上的 Range、格式非法、越界或 v1 不支持的多范围；返回 `Content-Range: bytes */<表示长度>` |
| 422 | `not_directory`、`is_directory`、`invalid_operation` | 节点种类不符，非法树操作/同批次冲突 |
| 422 | `invalid_manifest`、`invalid_package`、`invalid_catalog` | 静态格式或安全校验失败 |
| 429 | `rate_limited`、`quota_exceeded` | 请求、并发、存储或本机读取预算耗尽 |
| 500 | `internal_error` | 宿主内部错误，不回显内部异常链 |
| 502 | `invalid_backend_response`、`upstream_unavailable` | 应用控制响应非法，或上游字节读取失败 |
| 503 | `backend_unavailable`、`storage_unavailable`、`host_maintenance` | 后端未能就绪、Telegram 读取/写入不可用或宿主维护中 |
| 504 | `request_timeout` | 有界请求超时 |

验证库的 `ValidationError` 另外带 `field`，可放入 HTTP 错误的 `details.field`。外部协议由应用产生的普通错误响应原样代理；宿主自身失败仍使用上述通用错误，不懂应用协议的错误信封。

## 4. 清单 app.json

最小页面应用如下，缺省 `files` 为两项 false，缺省必需能力与文件入口为空。

```json
{
  "id": "example-reader",
  "name": "示例阅读应用",
  "version": "1.0.0",
  "contract": { "major": 1, "minor": 0 },
  "description": "读取授权目录内的文件。",
  "author": "开发者",
  "files": { "read": true, "write": false },
  "page": { "entry": "page/index.html" },
  "required_capabilities": [],
  "open_with": { "extensions": ["epub", "pdf"], "directories": true }
}
```

带后端应用可以增加如下字段，页面仍可省略。

```json
{
  "backend": {
    "entry": "backend/app",
    "run_mode": "resident",
    "external_service": true
  }
}
```

| 字段 | 要求 |
|---|---|
| `id` | 小写字母开头，只含小写字母、数字、短横线，1～64 字节；整个安装生命周期的命名空间身份 |
| `name` / `description` / `author` | 必需、非空、不含控制字符；分别最多 120 / 1600 / 160 字节，作者只是声明而非身份认证 |
| `version` | 稳定 SemVer，最多 80 字节，同 ID 单调更新 |
| `contract` | 必需的最低契约；与宿主产品版本解耦 |
| `files.read` / `files.write` | 缺省 false；write=true 必须 read=true。声明不是目录授权；未声明 write 永远拿不到读写 |
| `page` | 可选；entry 必须在 `page/` 下且以 `.html` 结束 |
| `backend` | 可选；entry 固定 `backend/app`，run_mode 必需为 `resident` 或 `on_demand`；external_service 缺省 false |
| `icon` | 可选的 `assets/` 或 `page/` 下 SVG、PNG、WebP，不超过 256 KiB，以图像方式显示，不执行 SVG 脚本 |
| `required_capabilities` | 最多 64 个互不重复的通用名称；未知必需能力只使该版本不可安装 |
| `open_with` | 可省略；extensions 为 0～64 个互不重复的小写后缀，directories 缺省 false；声明入口必须 read=true |
| 其他字段 | 可选扩展，保留但无权限效力；不得与已定义字段重名 |

应用不在清单里声明或请求资源。内存与 CPU 只有一组由主人在宿主设置里填写的总体限制，全部应用后端合计共用，不按应用分配；进程数、打开文件数、数据库与缓存容量是宿主对每个应用统一使用的固定值，见第 14 节。旧包清单里的 `backend.resources` 按普通扩展字段保留，没有任何效力。

不提供宿主专用设置表、内容格式列表、内置爬取源、固定应用 ID 特权或应用专用迁移回调。配置、业务状态、SQLite/KV 的应用自身 schema 迁移都由应用实现。

## 5. 应用包与分发

### 5.1 ZIP 布局

`.tgapp` 是标准 ZIP，仅支持 Stored 或 Deflate，不加密，不用 ZIP64 或分卷。例子如下。

```text
app.json
package.json
page/index.html                 # 页面可选
page/app.js
page/style.css
backend/app                     # 后端可选，唯一入口
assets/icon.svg                 # 可选静态资源
licenses/依赖的许可文件           # 实际路径必须遵守下述 ASCII 规则
LICENSE
NOTICE
```

`package.json` 是构建目标元数据，不是 Node.js 包清单。

```json
{ "format": { "major": 1, "minor": 0 }, "target": "linux-amd64" }
```

- 带后端包每架构一份，目标为 `linux-amd64` 或 `linux-arm64`；同版本各架构必须有相同完整 app.json。仅页面包 target 为 `web`，只构建一次。
- 后端是 Linux、64 位、小端 ELF，amd64 对应 e_machine=62，arm64 对应 e_machine=183。可以是静态 PIE，但不得有 PT_INTERP 或动态 DT_NEEDED 依赖；不得把“容器里恰好有某动态库”当作静态链接。
- 宿主校验真实 ELF 标头/程序头与目标，不只相信文件名、ZIP 可执行位或清单。宿主设置入口可执行权限，包内 UID/GID、setuid/setgid、额外权限位不保留。
- 不自动加入旧 SDK；所有页面脚本、工作线程、字体及第三方依赖自行编译并随包携带许可/NOTICE。运行时不加载 CDN 或宿主源码。
- app.json 和 package.json 各为非空 UTF-8 JSON 对象，最多 64 KiB。页面入口/后端入口必须真实存在且非空；图标也必须存在并满足限额。
- 压缩包最多 128 MiB，解压总量最多 256 MiB，单文件最多 128 MiB，文件和目录合计最多 4096 项。逐条核对实际解压长度与 CRC，并检查实际累计大小，不只看 ZIP 声明。
- 路径最多 240 字节。每段非空、不以点开头，只含 ASCII 字母、数字、`.`、`_`、`-`。拒绝绝对路径、反斜线、`..`、控制字符、重复路径（包括大小写折叠后的重复）、文件/目录覆盖、链接、硬链接、设备文件、加密与不支持的压缩。
- 顶层只接受上述清单、package.json、page/backend/assets/licenses 目录及 LICENSE/NOTICE。页面应用不得夹带 backend 文件。
- ZIP 本地文件头与中央目录的名称、类型、方法、标志、大小和校验信息必须相符；不得跟随解包目录中的链接。在新的空 staging 目录内全部校验完成后原子物化，失败不切换旧版本。
- 可在安装时生成宿主自己的预压缩静态资源，但不改变原包字节、摘要或 app.json。这是缓存，不属于分发包。

`validate_archive_layout` 校验归档读取器传入的布局信息，不自行解 ZIP 或解析 ELF。压缩包 SHA256、CRC、真实长度、ZIP64/分卷和真实静态 ELF 校验必须由宿主的包读取器完成，不能把布局测试冒充真实包安全校验。

### 5.2 Release 与 catalog.json

目录索引保存在应用仓库 **main 分支根目录 catalog.json**。包保存在同仓库 GitHub Release，不再保存在 main 的 apps/。

```json
{
  "format": { "major": 1, "minor": 0 },
  "repository": "example/apps",
  "entries": [
    {
      "manifest": {
        "id": "example-reader", "name": "示例阅读应用", "version": "1.0.0",
        "contract": { "major": 1, "minor": 0 }, "description": "读取文件。", "author": "开发者",
        "files": { "read": true, "write": false }, "page": { "entry": "page/index.html" },
        "required_capabilities": [], "open_with": { "extensions": [], "directories": false }
      },
      "packages": {
        "web": {
          "url": "https://github.com/example/apps/releases/download/example-reader-v1.0.0/example-reader-1.0.0.tgapp",
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "size": "100"
        }
      }
    }
  ]
}
```

带后端条目必须同时有 `linux-amd64`、`linux-arm64`，不得有 web。纯页面条目只允许 web。目录最多 4 MiB、512 个版本条目，每个 `(id, version)` 唯一；同 ID 可以保留多个版本供旧宿主选择最高兼容版本。未知未来 Linux 架构可以保留，但 v1 不选择它。

固定地址规则如下，仓库标识必须是合法的 GitHub owner/repo，不含凭据、路径逃逸或查询。

```text
目录：https://raw.githubusercontent.com/<repository>/main/catalog.json
Release tag：<id>-v<version>
页面包：<id>-<version>.tgapp
原生包：<id>-<version>-linux-amd64.tgapp
        <id>-<version>-linux-arm64.tgapp
初始包地址：https://github.com/<repository>/releases/download/<tag>/<包名>
```

摘要是原 ZIP 全部字节的 SHA256，64 位小写十六进制；size 是实际压缩包长度的十进制字符串。下载/命中缓存都必须校验长度、摘要、真实包和完整清单相等，再原子切换安装。

同一 `(id, version)` 的清单不可变，同一 `(id, version, target)` 的 URL、摘要、大小和包字节不可变。可以为同版本追加此前没有的未来架构，但不能重建/替换已有目标。修复必须升应用版本。目录可以撤回整条版本，仍保留该应用时不能把最高发布版本倒退。

宿主长期保存所有曾见过的身份/版本/架构绑定，包含后来从目录移除的条目，防止删条目后以同版本换包。`validate_catalog_transition` 只校验已传入历史，不替宿主持久化历史。安装预览绑定精确版本、目标、摘要和旧安装修订；刷新目录、网络故障或缓存命中不能静默改成另一个包。

GitHub Release 的初始 URL 必须精确符合上述格式。最多 5 跳重定向，只允许 HTTPS/443、无用户信息/片段；后续目标只允许 GitHub 的 Release 下载域（`github.com`、`release-assets.githubusercontent.com`、`objects.githubusercontent.com`），查询仅允许 GitHub 签发的临时下载参数。不得把任意重定向当作通用网络代理。目录读取仅接受同仓库 main 的固定原始地址。令牌、完整签名 URL 与代理凭据不写日志；不需要 GitHub token。

目录失败保留上次成功快照并标 stale，不影响已安装应用运行；没有成功快照为 unavailable。普通检查缓存 5 分钟，手动刷新也至少间隔 30 秒；并发刷新合并。目录请求总时限 10 秒，包下载总时限 120 秒。新下载内容视为不可信数据，隔离到新的空目录，不从包目录执行解释器或构建工具。

## 6. 目录授权

### 6.1 存储模型

`DirectoryScope` 只有三种模式。

```json
{ "mode": "none" }
```

```json
{
  "mode": "selected",
  "directories": [
    { "directory_id": "12", "access": "read_only" },
    { "directory_id": "34", "access": "read_write" }
  ]
}
```

```json
{ "mode": "all", "access": "read_only" }
```

- 新安装默认为 none。selected 必须为 1～128 个互不重复、当前可见的目录 ID；空数组不是全盘，使用 none。
- 授权锚定**目录 ID**，不锚定路径字符串。读取时按最新可见祖先链判定包含关系，不用容易混淆 `/a` 与 `/ab` 的前缀判断。
- 移动/重命名授权根后授权跟随该目录身份，ScopeInfo 的显示路径和授权修订更新；旧路径上的新目录不会继承授权。授权根进入回收站时暂不可用，ScopeInfo.roots 中 node=null；恢复同一身份后重新计算。
- 多个重叠授权取权限并集：任一有效祖先授予读写就可读写；子目录只读不否决父目录读写。要隔离只读子目录，不能先授予其祖先读写，应分别选根。此规则避免隐藏的拒绝优先级。
- 未声明 files.read 不能获得非 none 授权；未声明 files.write 不能获得任意读写授权。升级撤掉 write 声明时，宿主同步降为只读并更新授权修订；新增 write 声明不会自动提升既有授权。
- ScopeInfo 返回 `{ revision, scope, roots }`；每个根附最新目录元数据或 null，用来显示/选择，不重复扫根。
- 应用不能修改授权。页面只能用 ui.request_scope 请求宿主授权对话框，最终由主人确认。没有页面的应用由主人在应用中心手动授权，不提供应用后端的授权请求 HTTP 接口。选择目录只表明主人选择了这个目录，**不等于目录授权**。

### 6.2 逐请求和在途校验

每次列目录、查询、stat、实际读取、票据访问、流式写入开始与最终提交，都按最新授权判定。查询根和返回行必须在授权范围内，不能先返回全盘结果给页面过滤。重叠查询根去重，不返回未授权目录的兄弟、祖先详情、文件内容或全盘总数。

读取、直传与本机地址在授权/内容/可见性变化时停止后续发出字节。可以先检查内存中的 generation/授权/树变更 epoch，仅 epoch 改变时重新解析祖先链；不得为了每个 64 KiB 块做多次 SQLite 递归查询。撤权操作必须同步更新 epoch/撤销信号，不能等待 SSE 到达应用才生效。已经传给客户端的字节不能撤回。

写入还必须满足以下规则。

- 新建目录/新文件：目标父目录读写。
- 覆盖：原文件及其父目录读写，且引用条件匹配。
- 重命名/移动/回收：目标节点、源父目录读写；移动还需目标父目录读写。整目录操作对整棵受影响子树判定写入权限，不能借父节点请求修改只读数据。
- 单独授权的根不自动授予其未授权父目录写入，因此不能只凭根内读写权限重命名、移走或回收该授权根。可以修改根内子项。
- 根目录不可重命名、移动、回收。拒绝把目录移入自身/子孙，拒绝覆盖同名节点，拒绝永久删除。删除一律进回收站，恢复/清空由主人网盘界面操作。
- 元数据事务使用调用方提供的 scope_revision；开始和最终提交时都检查最新修订和当前安装/启动状态。期间撤权或禁用不得提交。

## 7. 通用文件模型和查询接口

### 7.1 FileNode 与引用

FileNode 的所有字段如下，常规接口只返回可见、已完成的节点，不返回 uploading/回收站内部行或 Telegram 定位信息。

```json
{
  "id": "42", "parent_id": "12", "name": "示例.bin", "path": "/资料/示例.bin",
  "kind": "file", "size": "100", "created_at": 1, "modified_at": 2,
  "revision": "node-revision-1", "content_version": "content-1", "children_revision": null,
  "has_thumbnail": false
}
```

文件有 content_version、children_revision=null；目录 size="0"、content_version=null、有 children_revision、has_thumbnail=false。根 parent_id=null、path="/"、name=""。revision 表示当前节点元数据，包括派生路径；祖先移动导致 path 改变时 revision 也必须改变，不要求逐行持久更新所有子孙，可在查询时结合路径/祖先版本计算。children_revision 只表示直属可见集合及其元数据变化，不能当成整个子树修订。

`ContentRef={id, content_version}` 用于读字节；`NodeCondition={id, revision}` 用于条件写入。stat 的 NodeReference 显式用 by 区分 ID/路径，避免同时传两种身份的歧义。

```json
{ "by": "id", "id": "42", "content_version": "content-1" }
```

```json
{ "by": "path", "path": "/资料/示例.bin" }
```

content_version 可省略表示读取当前 stat；提供则必须匹配。目录不得提供内容版本。应用收藏、阅读进度、影视描述等不属于 FileNode，应用自己保存。

### 7.2 筛选、排序和分页

FileFilter 的字段：kind 缺省 file（file/directory/all）；name_contains 可选，最多 255 字节；extensions 缺省 []，最多 64 个互不重复的规范化后缀；size={min?,max?}；created_at/modified_at={from?,to?}；include_hidden 缺省 false。大小与时间边界均包含端点，min<=max、from<=to。

名称匹配是**字面子串**，不是 SQL、正则或 glob。ASCII 大小写折叠，非 ASCII 按原字符匹配；不隐式执行 NFKC/自然排序或标题解析。后缀为不带前导点的小写 ASCII 字母、数字及 `._+-`，最多 40 字节，支持 tar.gz 等多段后缀，不含重复点/末尾点。extensions 只筛文件，kind=all 时目录不因后缀集合而消失，但仍需满足其他对应筛选；目录逻辑大小为 0。

include_hidden=false 排除以点开头的节点及隐藏目录内的后代。排序为 name/size/created_at/modified_at/id，order=asc/desc。name 按 ASCII 折叠名、原始 UTF-8 名、数值节点 ID 破同名；其他排序以数值节点 ID 破同值。目录匹配查询不支持无意义的目录大小排序。

所有分页为**键集游标**，不用 OFFSET，不把完整文件树读进应用或宿主内存。默认 200、最多 500 行，并以 items/changes 数组序列化后累计 **512 KiB** 为另一个页上限，没有隐含的全库 2000/20000 文件截断。页字节预算只允许 **64 KiB～512 KiB**，最低预算足以容纳最大的合法键值记录、FileNode 或子树变更；**只要有待返回的匹配项，每页至少返回一项，不能让合法单项因预算被永久卡住**。空结果/已结束页可以没有项；变更日志只含不可见项时也可空，但 checkpoint 必须推进。

到达任一上限先结束本页：next_cursor 基于最后实际返回项，未装入的下一项在续页继续；**页内项数少于 limit 不代表结束，SDK 与应用不得以返回数量判断末页**。普通数据页结束的唯一标志是 **next_cursor=null**；变更接口用 **has_more=false** 表示已到本轮高水位，其非空 next_cursor 保留作以后增量 checkpoint。非法单项超出完整页预算时报 payload_too_large，不能静默跳过或制造永远不推进的空页。

普通游标绑定应用 generation、授权修订、查询根/筛选/排序/页大小与最后键；修改参数必须从首页开始。游标每次签发后 1 小时有效，使用当前最新元数据。普通查询**不是跨 HTTP 请求的 SQLite 快照**：并发变更可能使已移动排序键重复/漏过，应用按 ID 去重并用第一页的 scan_cursor 增量核对。该 scan_cursor 在同一次分页中保持不变，在首次读取的数据库快照内先取得，不在查询之后才取得，否则会漏掉变化。

每个查询根必须是已授权的目录。roots=[] 表示全部当前授权根；非空最多 128 个 ID，重叠去重。recursive=true 缺省，查询子孙但不把查询根自身混入普通结果；false 查询直属子项。直属匹配目录查询会包含自身直接有匹配文件的授权/查询根。

实现必须把名称、后缀、大小、时间、子树/授权条件下推到有索引的 SQL/通用索引，不能每页递归扫描全盘或再在 Rust 中截断过滤。宿主只索引这些通用属性，不建阅读/影视内容索引。

### 7.3 查询接口全集

表中 A 表示有效应用身份；R 表示声明 read 且当前范围只读或读写；W 表示声明 write 且相关范围读写；B 表示仅应用后端套接字。所有 JSON 请求还遵守第 3 节公共错误。

| 方法与完整路径 | 参数 | 成功响应 | 权限与专用错误 |
|---|---|---|---|
| GET `/admin/api/apps/v1/self/info` | 无 | 200 RuntimeInfo，应用身份、最高契约、可用能力、声明、ScopeInfo、实际限额、可选后端状态与 ExternalServiceInfo 对外入口信息 | A；app_changed/app_disabled |
| POST `/admin/api/apps/v1/self/session/refresh` | 无正文 | 200 SessionRefreshResponse={session_token,expires_at}，同会话令牌值不变 | 仅页面；session_expired/caller_not_allowed |
| DELETE `/admin/api/apps/v1/self/session` | 当前页面会话 Bearer，无正文；沿用 session.refresh 能力 | 204，撤销本页会话、媒体/缓存票据和读取租约，取消关联读取 | 仅页面；失效令牌 401 session_expired/unauthorized，后端 403 caller_not_allowed；不改安装 generation |
| GET `/admin/api/apps/v1/self/scope` | 无 | 200 ScopeInfo | A，不要求文件授权；app_changed |
| POST `/admin/api/apps/v1/self/files/stat` | NodeReference | 200 FileNode | R；not_found/content_changed/scope_denied |
| POST `/admin/api/apps/v1/self/files/list` | ListDirectoryRequest={directory,sort?,order?,limit?,cursor?}，默认 name/asc/200 | 200 DirectoryPage={directory,items,next_cursor,scan_cursor,scope_revision} | R；not_directory/invalid_cursor/scope_changed/cursor_expired |
| POST `/admin/api/apps/v1/self/files/query` | FileQuery={roots?,recursive?,filter?,sort?,order?,limit?,cursor?} | 200 FilePage={items,next_cursor,scan_cursor,scope_revision} | R；not_directory/invalid_cursor/scope_changed/cursor_expired |
| POST `/admin/api/apps/v1/self/files/directories-with-files` | DirectoriesWithFilesQuery={roots?,file_filter,directory_name_contains?,sort?,order?,limit?,cursor?}；file_filter.kind=file，后缀非空 | 200 FilePage，items 均为直接含匹配文件的目录，递归搜索目录，每个目录一次 | R；不允许以子孙命中冒充直属命中；not_directory/invalid_cursor/scope_changed/cursor_expired |
| POST `/admin/api/apps/v1/self/files/random` | RandomFilesRequest={roots?,filter?,limit?,exclude_ids?}；kind=file，默认 20、最多 64 个，排除最多 512 个互不重复 ID | 200 RandomFilesResponse={items,scope_revision} | R；not_directory/invalid_request；结果不足表示剩余匹配项不足，不是未授权项补足 |
| POST `/admin/api/apps/v1/self/files/changes` | FileChangesRequest={cursor?,limit?}，默认 200、最多 500 | 200 FileChangesPage，见 7.4 | R；scope_changed/cursor_expired/invalid_cursor |

随机查询覆盖全部匹配授权范围，每次返回不重复 ID，不固定从名称前 200 项洗牌，也不要求页面先遍历完整目录树。它是面向浏览的伪随机抽样，**不保证统计意义的严格均匀性**。宿主可为节点维护内容无关的随机排序键，随机选环起点、按索引续取并回绕；必须走授权/目录、后缀和相关筛选的通用索引，不得使用全盘 `ORDER BY random()`、随机 OFFSET 或先全表扫完再抽样。

每次最多检查 4096 个索引候选步骤；某个筛选组合无法在预算内满足数量或确认候选已经穷尽时，明确返回 quota_exceeded，不能继续全表扫描、不能将预算内的少量命中假称为全范围只剩这些。调用方可以缩小查询或作有界重试。只有确认已穷尽时，200 的不足数量才表示剩余匹配不足。短视频主要的目录+后缀场景应由组合索引直接定位，不能依赖这种成本拒绝作为正常加载路径。近期排除只影响选择，不改变目录授权。

### 7.3.1 本应用的对外入口信息

RuntimeInfo.external_service 是可选的 ExternalServiceInfo；有应用后端时必须给出，无后端的页面应用为 null/省略。应用通过原有 runtime.info 能力读取，无需新增接口，也不能调用只允许主人的 root-app 管理接口。

| 字段 | 含义 |
|---|---|
| declared | 清单是否声明 backend.external_service |
| available | 平台当前可安全转发外部请求，或可按需启动后端；未声明对外服务、应用停用或平台不能安全运行后端时为 false。正常空闲的按需后端若可唤醒，仍为 true。不是应用业务自身的服务开关、账号状态或影视索引就绪状态 |
| root_assigned | 主人当前根地址选择是否指向本应用，独立于 available 和应用业务服务是否运行 |
| prefix_path | 本应用固定入口路径 `/admin/api/apps/v1/services/<app_id>`，即 SERVICE_BASE+`/<app_id>`，无尾斜杠；未声明服务时也给出该路径，套接字调用同样给出 |
| prefix_url | 页面调用、已声明对外服务且能从当前请求可信得出公开源时，为 public_origin+prefix_path；否则 null。不因 available=false 隐藏已声明入口 |
| root_url | 页面调用、根地址当前属于本应用且能从当前请求可信得出公开源时，为 public_origin；否则 null。未归属时不得冒称本应用的根入口 |

页面 Bearer 的 HTTP 请求可以据请求与可信代理取得公开源并返回完整入口地址；后端的 Unix 请求 Host=tgdrive 不携带公开源，root_url/prefix_url 都为 null，不猜测 localhost、固定端口或额外配置。后端收到外部/页面转发请求后从 ForwardContext.public_origin/public_base_url 取得可信地址；页面也可以把 host_origin 与已知路径拼接。宿主只提供通用入口状态，影视应用自己判断官方客户端必须连接根地址，并结合自己的业务服务状态展示。

根地址归属变化必须向旧应用和新应用的事件订阅发送 `external_service.changed`，data 为 {}；清除根选择通知旧应用，首次选择通知新应用，不向无关应用广播另一个应用的 ID。**根归属变更本身不轮换安装 generation，不发送 app.changed，不撤销页面会话、票据或读取租约**。调用方收到提示后重读 RuntimeInfo 即可，不轮询 root-app。入口声明/平台可用性变化也用此提示，但它不替代第 3、12 节的安装更新/停用撤销规则；事件本身不授予或撤销能力。事件过期/宿主重启仍按 sync.required 重核信息。

### 7.4 变更游标与增量核对

```json
{
  "changes": [{ "type": "upsert", "node": { "id": "42", "parent_id": "12", "name": "示例.bin", "path": "/资料/示例.bin", "kind": "file", "size": "100", "created_at": 1, "modified_at": 2, "revision": "r2", "content_version": "v1", "children_revision": null, "has_thumbnail": false } }],
  "next_cursor": "changes-2", "has_more": false, "reset_required": false, "scope_revision": "scope-1"
}
```

- cursor 省略/null：返回当前 checkpoint、changes=[]、has_more=false、reset_required=true，用它开始完整扫描；不是返回全部历史。
- 有 cursor：返回该点后的已提交变更。next_cursor 永远存在，表示已经检查到的位置；即使期间只有未授权变更也向前推进，不泄露这些变更的 ID/路径。has_more=true 时继续读到本轮固定高水位，不能被持续上传永远追着跑。
- `upsert`：当前仍授权/可见的最新 FileNode。`removed`：先前授权范围的节点离开范围、被回收或删除，只带已知 ID，不带新的未授权位置。
- `subtree_invalidated`：目录移动、回收、恢复或整棵结构改变。只对受影响授权子树发一条；previous_path 仅在原位置可授权时给出，current 仅在当前位置可授权时给出。应用删除/失效对应旧子树缓存，对仍授权的当前子树重新分页查询。不得为移动一个十万文件目录产生十万条日志。
- 授权根本身或其祖先变化会更新该应用 scope_revision，旧游标返回 scope_changed，应用重读 ScopeInfo、清除不再授权的派生列表并重扫。不能把撤权当成一个普通文件删除事件。
- 游标绑定应用 generation 与授权修订，日志持久化并在普通宿主重启后继续。最多保留 7 天或 100 万条（先到为准）；恢复/清除导致 epoch 改变，旧游标返回 cursor_expired，details 可带当前 checkpoint，必须完整核对。
- 首次扫描保存第一页 scan_cursor，分页按 ID 去重，完毕后消费该点以来的变更；有子树失效重新查该子树，有授权改变重扫授权范围。不能宣称一次弱一致扫描是完整快照，也不能因为列表分页失败而清空旧记录。

## 8. 条件写入、流式上传和回执

### 8.1 单一元数据事务接口

不另提供一套逐个 mkdir/rename/move/delete 接口。一次操作也使用 FileMutationRequest；多项元数据变化在一个有界 SQLite 事务内执行。

| 方法与完整路径 | 参数 | 成功响应 | 权限与专用错误 |
|---|---|---|---|
| POST `/admin/api/apps/v1/self/files/mutations` | `Idempotency-Key` 必需；FileMutationRequest={scope_revision,assertions?,operations} | 200 MutationReceipt={idempotency_key,committed_at,results,expires_at} | W；node_changed/children_changed/scope_changed/name_conflict/invalid_operation/idempotency_conflict |
| GET `/admin/api/apps/v1/self/files/mutations/{key}` | 该应用的幂等键 | 200 已提交 MutationReceipt | A；not_found。只核实本应用已提交操作的 ID/版本，不读取新文件内容 |

最大 64 项操作、256 项断言，所有 operation_id 在同批次唯一，为 1～64 个 ASCII 字母、数字、下划线、短横线。操作按数组顺序执行，断言及既有节点条件在事务开始的同一快照内验证，最终再验证授权/generation。任何一项失败全部回滚，失败不留下新目录、局部移动或已可见覆盖。本次合法树修改引起的授权根显示路径/修订更新在成功提交后公布，不因事务自己的变化把它误判为并发撤权；并发主人改授权、停用或更新仍必须阻止提交。

| FileOperation.type | 额外字段 | 行为 |
|---|---|---|
| `mkdir` | operation_id,parent,name | 非递归新建一个目录；parent 是 existing{id}，或 created{operation_id} 引用本批次先前 mkdir |
| `rename` | operation_id,node={id,revision},name | 只改名称，不改父目录或内容版本 |
| `move` | operation_id,node,parent,name? | 改父目录，可同时改名；name 缺省原名，保留节点身份和内容版本 |
| `trash` | operation_id,node | 整节点/子树进回收站；不永久删除 |
| `commit_upload` | operation_id,upload_id | 把已上传但未可见的 ready 上传原子提交，见 8.2 |

同批次不得重复修改同一既有节点；新建目录可供后续操作引用。拒绝循环、未出现的 created 引用、文件作为父目录、同名覆盖和回收后继续使用该节点。上限内整理一组文件与配套文件可先 mkdir，再一次 move 全组。

FileAssertion 为 node{id,revision} 或 children{directory_id,children_revision}。它们不是业务预览：应用需要防止“预览后另一个设备改变同行文件归属”时，断言相关源/目标目录的 children_revision 与节点修订。宿主只核对通用条件，不认识 NFO、海报或配套文件。

MutationResult 只返回 `{operation_id,node_id,content_version}`，目录内容版本为 null；当前名字/路径按需 stat。回执是本应用的操作记录，即使后续撤权也可读取先前的操作 ID/版本，不因此重新授予文件访问。

幂等键为 16～128 个 ASCII 字母、数字、下划线、短横线，应用使用足够随机且永不复用的值。宿主持久绑定应用 generation、键与规范化完整请求；相同键/相同请求返回原提交回执，绝不再次执行，不同请求返回 idempotency_conflict。旧 generation/撤权仍阻止新的文件写入调用；回执查询用于核实。回执保留 7 天，事务修改与回执必须原子提交。查不到回执不等于未知网络请求已经失败：先等待原在途请求结束，再核实，不能立刻另造键重复操作。

### 8.2 流式上传

| 方法与完整路径 | 参数 | 成功响应 | 权限与专用错误 |
|---|---|---|---|
| POST `/admin/api/apps/v1/self/uploads` | `Idempotency-Key` 必需；CreateUploadRequest={target,size,sha256?,scope_revision} | 201 UploadInfo，id 为本应用上传句柄，state=awaiting_body | W；name_conflict/node_changed/scope_changed/idempotency_conflict |
| PUT `/admin/api/apps/v1/self/uploads/{id}/body` | 原始二进制正文；Content-Type: application/octet-stream；长度可用 Content-Length 或分块编码，实际必须等于声明 size | 200 UploadInfo，成功为 ready | W；upload_state/upload_expired/content_changed/scope_changed/payload_too_large/upstream_unavailable |
| GET `/admin/api/apps/v1/self/uploads/{id}` | 上传 ID | 200 UploadInfo | A；not_found/upload_expired；不返回目标未授权元数据 |
| DELETE `/admin/api/apps/v1/self/uploads/{id}` | 上传 ID，无正文 | 204，取消/删除未提交上传 | A；upload_state（已经 committed 不得变成删除网盘文件） |

UploadTarget 为 create{parent_id,name}，或 replace{node:{id,revision}}，不使用 overwrite=true 这种盲写。create 时目标必须不存在；replace 时目标必须是相同可见节点、相同预期元数据。提交时再次检查，不因“开始上传时曾获准”而跳过最新授权/条件。

1. 创建上传句柄时验证目标、安装 generation、目录授权、声明大小/可选小写 SHA256，但不创建可见目标、不改旧文件。
2. 正文从调用方流式传入宿主再传至 Telegram，使用有界缓冲和背压，不把完整文件放进内存，不把本机数据目录当成网盘存储。支持零字节文件。
3. 单句柄只接受一次正文上传；重复 PUT 不追加或覆盖。未知结果先 GET 状态。接收过程中维持 received_bytes、检查撤权/停止信号；超过声明长度立即终止，长度不足或摘要不符变 failed，不进入 ready。
4. 已收到并核实的 Telegram 内容进入 ready，但仍不可见。网络写入不持有长 SQLite 元数据事务。
5. 应用通过 commit_upload 操作提交；可与上限内的其他元数据操作同事务。create 分配新节点 ID；replace 保留 ID 与 created_at，修改内容/modified_at，生成新的内容版本并清除不适用的旧缩略图。目标条件改变不能偷偷转成新建或覆盖另一节点。
6. GET UploadInfo 返回 id,state,size,received_bytes,expires_at,result?,error_code?；result 只在 committed 时为 ContentRef。状态为 awaiting_body/receiving/ready/committed/failed/cancelled。正文结果不确定时可以保持 receiving，直到宿主明确核实；不能以超时假装失败并自动提交。
7. 未提交句柄保留 24 小时；取消、过期、停用、更新、后端启动轮次失效都阻止其未来提交。已上传的孤儿 Telegram 内容进入通用清理队列。已提交结果/创建幂等绑定至少保留至对应 7 天回执期限，以便崩溃后核实，不能重新用旧幂等键创建另一上传。

应用自己的步骤记录放 SQLite/KV。刮削的联网、资料选择、命名、产物生成和何时继续/停止完全在应用后端，不进入宿主上传事务。

## 9. 字节读取、票据、本机地址与直传

### 9.1 读取接口全集

| 方法与完整路径 | 参数 | 成功响应 | 权限与专用错误 |
|---|---|---|---|
| GET/HEAD `/admin/api/apps/v1/self/files/{id}/bytes` | query.content_version 必需；可带 Range/If-None-Match/If-Range | 200/206 原始字节，HEAD 无正文；也可 304 | R；content_changed/is_directory/416；默认 octet-stream，不解析内容 |
| POST `/admin/api/apps/v1/self/files/media-url` | MediaUrlRequest={file,representation?,disposition?,filename?,content_type?,ttl_seconds?,lease_id?} | 200 MediaUrl={url,expires_at,file,representation}；url 为同源相对票据路径 | R；content_changed/is_directory/not_found（没有原文件附带缩略图）/lease_expired/quota_exceeded |
| GET/HEAD `/admin/api/apps/v1/media/{ticket}` | 公网或本应用 host.sock 上的票据地址，Range/条件头；无 Cookie/应用 Bearer | 200/206/304 字节或附带缩略图 | 票据绑定身份与最新 R；套接字只接受本应用当前启动轮次签发的票据；ticket_expired/app_changed/content_changed/scope_denied/lease_expired/416 |
| POST `/admin/api/apps/v1/self/files/local-url` | LocalFileUrlRequest={file,ttl_seconds?,byte_budget?,request_budget?,lease_id?} | 200 LocalFileUrl={id,url,expires_at,byte_budget,request_budget} | B+R；caller_not_allowed/content_changed/lease_expired/quota_exceeded |
| DELETE `/admin/api/apps/v1/self/files/local-url/{id}` | 本应用本启动轮次的本机地址 ID | 204，立即撤销，取消该地址全部在途读取（包括未带读取租约的读取） | B；不存在也 204 |
| GET/HEAD `/admin/apps-local/v1/{ticket}` | 仅单独的 loopback 监听端口，不在宿主公网监听器注册；Range | 有界本机字节，见 9.3 | 票据+最新 R+本启动轮次；ticket_expired/quota_exceeded/416；外部公网该路径始终 404 |
| POST `/admin/api/apps/v1/self/read-leases` | CreateReadLeaseRequest={ttl_seconds} | 201 ReadLease={id,expires_at} | R；quota_exceeded |
| PUT `/admin/api/apps/v1/self/read-leases/{id}` | 同上，只能在未过期/未撤销时续期 | 200 ReadLease | R；lease_expired/not_found |
| DELETE `/admin/api/apps/v1/self/read-leases/{id}` | 租约 ID | 204，立即撤销相关票据与在途传输 | A；重复撤销也 204，不能重新启用旧 ID |

文件字节接口和票据默认按单范围读取，不需要转成整文件 Blob。应用负责自身的解析/缓存/解码上限。所有 Telegram 范围读取必须严格按请求字节区间或已有内容缓存满足；上游不支持且无法严格读取时返回 upstream_unavailable，不能静默整块下载作为小 Range 的回退。

### 9.2 通用媒体票据

representation 缺省 original，可选 thumbnail 只指 Telegram 原文件附带的缩略图，不是宿主提取帧、探测视频或解析 PDF。thumbnail 没有时明确 not_found。宿主知道这种附件的存储元数据，不知道文件内容类型。

original 缺省 Content-Type=application/octet-stream；应用可以传安全的 MIME 与文件名，宿主只检查头格式/转义，不根据后缀认识电影或书。缩略图 MIME 由宿主根据已有附件表示决定，不能靠调用方 MIME 伪装。disposition 缺省 inline，attachment 用于下载；filename 缺省当前文件名。

票据只授权一个应用、当前 generation、创建它的页面会话/后端启动轮次、一个文件身份/内容版本、一个表示及可选读取租约。它不是任意文件凭据，不允许换 ID、用途或写入。ttl 缺省 900 秒、范围 1～21600 秒，且不超过创建者会话/租约剩余时间。每次真实 GET/HEAD 仍核对启用、当前授权、节点可见性和内容版本；先核对再返回 304。

**票据 URL 只有一种形式**：MediaUrl.url 对所有调用方（页面和后端套接字）都返回以 `/` 开头的同源相对路径，例如 `/admin/api/apps/v1/media/<票据>`，不含 scheme/authority，也不是 `//host/...` 的协议相对地址。页面直接给 fetch、video、img 使用，或与 PageBootstrap.host_origin 拼接；应用后端先完成自己的外部客户端鉴权，再用该外部请求 ForwardContext.public_origin 加上完整票据路径，交给客户端。不能用含服务前缀的 public_base_url 拼票据，也不能把套接字固定 Host=tgdrive 当公开主机。媒体票据形式不因调用方变化，本机 local-url 是明确的例外，仍返回绝对 loopback 地址。票据是可转交能力，不是宿主主人登录凭据。

MediaUrl::TICKET_BASE 与生成的 MEDIA_TICKET_BASE 绑定 `/admin/api/apps/v1/media`；缓存票据另用 CACHE_TICKET_BASE，见第 11 节。相对票据路径仍须满足第 3 节合法 URI 和 8192 字节上限，不含片段、反斜线或未编码空白；共享 valid_same_origin_path 校验此形式，非 ASCII 字符须百分号编码。

**媒体票据地址在应用后端的 host.sock 上同样可达**。后端自身读取原文件或附带缩略图时，把 MediaUrl.url 相对路径原样经 BackendStartContext.host_socket 请求，使用固定 Host=tgdrive，**不经公网、不拼 public_origin**；不要求存在当前外部转发请求或声明对外服务。票据本身即为该表示的读取授权，不另传 Cookie/Bearer，但宿主仍验证套接字身份与当前启动轮次，**只接受该应用自己这一启动轮次签发的票据**。不得借此读取其他应用、页面会话签发或旧启动轮次的票据。

套接字票据的内容与公网入口语义相同：支持 Range、HEAD 和条件请求，继续核对启用/generation、最新目录授权、节点可见性、内容版本及绑定的读取租约；返回 304 前也必须核对，撤销中止在途读取。thumbnail 仍只返回已有附件缩略图，不变成原文件读取或内容探测。public_origin 仅用于把票据地址交给外部客户端，后端自身读取不需要公开源。

读取租约为通用的、可撤销关联：例如应用把若干已鉴权客户端传输绑在一个租约上，登出或修改自己的业务访问规则时 DELETE。租约默认不主动创建，单次 TTL 为 1～86400 秒、最多 256 个；续期只改变租约有效期，不延长已签发票据的 TTL，撤销后旧 ID 不可复活。不带租约的读取仍受应用 generation/创建者生命周期约束。

### 9.3 ffprobe/ffmpeg 的本机输入

应用后端可以执行上下文提供的 ffprobe_path/ffmpeg_path，用本机限时 URL 读取网盘。地址形如 `http://127.0.0.1:<宿主内部端口>/admin/apps-local/v1/<高熵票据>`，该 loopback 端口不对外发布，不改变“只有一个对外端口”。不在公网同路径挂一个可绕过本机边界的别名。

ttl 默认 60 秒、范围 1～600；累计上游字节预算默认 16 MiB、范围 1 字节～1 GiB；请求预算默认 32、范围 1～256。对应 DEFAULT_LOCAL_BYTE_BUDGET/MAX_LOCAL_BYTE_BUDGET 与 DEFAULT_LOCAL_REQUEST_BUDGET/MAX_LOCAL_REQUEST_BUDGET。LocalFileUrl.byte_budget/request_budget 表示签发时授予的总预算，不是每次请求可独占的预算。HEAD 计请求但不计字节；请求数预算按请求计、不归还。

**字节预算按块计费，不做整段预留**：一次 `bytes=0-` 请求不能因为其声明的响应窗口很大就占满地址剩余预算。宿主每从上游拉取一个有界块时原子扣减该地址的共享余额，扣不到就停止；已拉取的块（包括对齐/预取而额外取得的上游字节）全部计费。每个请求的响应窗口只按请求开始时的剩余预算裁剪，并照该窗口生成状态、Content-Range 和 Content-Length，不预扣整段窗口。resolve_local_range 复用单 Range 规则计算这个窗口，不执行扣减；实际块计费、取消和并发状态由宿主实现。

并发请求共享同一预算，先前开放流尚未回收也不能凭它的未读窗口阻止新的 seek。取消或对端关闭后不再继续拉取，不计尚未拉取的窗口字节；不得隐性整块下载回退。若传输中途预算被其他请求耗尽，或对齐/预取开销使剩余预算不足以继续拉取，只中断该字节流，不追加 JSON 或其他正文，客户端按连接中断处理。**只有请求开始时剩余字节预算为零才返回 quota_exceeded**（请求次数耗尽另按请求限额处理），不能因另一个请求宣告了开放窗口就返回字节配额错误。

本机读取是明确的**有界输入**，不是一般下载：Range 或无 Range 全文件超出请求开始时的剩余预算时，只声明预算内前缀，状态 206，Content-Range 精确标明这段及原文件总长度；未裁剪时仍遵守第 9.5 节的 200/206/HEAD/416 规则。ffprobe 可以据此继续 seek。实际发送途中不足时按上文中断，不能声称已完成或把错误正文混进文件字节。**DELETE 本机地址必须中止该地址的全部在途读取并关闭上游，不论是否带读取租约**。应用应给子进程设置自己的超时、输出/像素/轨道/并发预算，结束时撤销地址；宿主不解析媒体或选择帧。

同一地址上，一个开放式 Range 请求只读一小段、连接尚未关闭时立即发起 seek 请求，剩余预算仍足够拉取新块就必须成功，不等待先前窗口归还。ffprobe 与随后 ffmpeg 可以共用同一地址及剩余预算，不要求因为一个开放窗口曾被声明就重新签发地址。

### 9.4 应用后端指示原文件直传

对应用页面代理请求以及根地址/固定前缀的 GET/HEAD，应用后端可以返回以下**控制响应**。正文始终为空，因此 HEAD 也能携带指令，不使用会被 HTTP HEAD 丢弃的 JSON 正文。

```text
HTTP/1.1 204 No Content
X-Tgdrive-Stream: v1;<base64url(UTF-8 JSON StreamDirective)，不加 padding>
```

解码后的 JSON 例子如下。

```json
{
  "file": { "id": "42", "content_version": "content-1" },
  "range": "client",
  "disposition": "inline",
  "content_type": "video/mp4",
  "filename": "示例.mp4",
  "cache": "private_revalidate",
  "lease_id": "lease-1",
  "correlation_id": "play-1"
}
```

- 只有宿主从**该应用后端套接字收到的** 204+控制头能触发直传。客户端同名头会被剥除；控制头不暴露给客户端。其他状态带控制头、解码错误、重复指令头、非空正文、超过 4096 字节 JSON、非 GET/HEAD 均为 invalid_backend_response，不转发假文件。
- 应用只鉴权并选择 file、可选 window、租约、关联标识和显示 MIME/文件名。宿主在接受控制响应后重新检查该应用当前目录授权、启动轮次、文件内容版本、租约和范围，再直接从 Telegram 流给客户端；**原文件字节不经过应用后端**。
- window={offset,length} 可省略，默认整个文件。提供时定义一个“逻辑表示”：客户端 Range 相对于这个窗口从 0 计，表示总长度为 window.length，实际读取位置为 window.offset+相对范围。窗口必须完整落在原文件内，不改写任何字节。不要把它误解为请求的最终 Content-Range。
- range 缺省 client，宿主解析原始客户端 Range/条件头；ignore 明确忽略 Range、返回完整逻辑表示，并返回 Accept-Ranges:none。应用不能通过附加 Content-Length、Content-Range 或状态码自行伪造实际读取结果。
- MIME 与文件名由应用选择，省略分别为 octet-stream/当前文件名。宿主负责 header 校验和 RFC 5987 文件名编码，拒绝 CR/LF、路径和过长字段。Content-Length、Content-Range、Accept-Ranges、ETag、200/206/304/416、HEAD 无正文规则由宿主唯一决定。
- cache 缺省 no_store，对应 Cache-Control:no-store；private_revalidate 对应 private,no-cache。不能放开成公开共享缓存绕过每次鉴权。安全头由宿主覆盖，应用无法关闭。
- 普通后端响应的端到端自定义协议头可以保留，但宿主删除/覆盖 hop-by-hop、内部 X-Tgdrive-*、Content-Length/Range/Encoding、ETag、Content-Disposition、Content-Type 与 Cache-Control 等直传专属头。不得在直传之后进行 gzip/转码或转换容器。
- correlation_id 可省略。只有带该标识的直传产生 stream.started/stream.finished 事件，减少封面小图造成的无关日志。应用用它连接自己的播放/下载状态，宿主不认识其业务含义。
- stream.started 只在 GET 实际向响应体发出第一段非空字节后产生，不因 HEAD、304、416、详情查询或接受指令就产生。finished 带 bytes_sent/outcome，只有已开始的直传才产生结束事件。TCP 对端最终是否消费/显示不是宿主能证明的事实。
- 登出等业务撤销由应用 DELETE 读取租约，未来请求也由应用继续鉴权。使用同一租约使“鉴权后、开始发字节前发生登出”的竞争也能被宿主阻止。

### 9.5 Range 和条件响应的唯一解释

v1 只支持单一 `bytes=a-b`、`bytes=a-`、`bytes=-n`，允许末尾超过表示长度并裁到结尾。n>0；起点不能超出表示；非法单位、反向区间、多范围、整数溢出和空文件上的 Range 返回 416，不静默挑第一段或整文件回退。

无 Range 返回 200，合法 Range 即使覆盖全表示也返回 206。空表示无 Range 返回 200、Content-Length:0。HEAD 计算与 GET 相同的状态/头，但不读 Telegram，不发 started。

ETag 为强标识：原文件表示为 `"v<content_version>"`；有窗口为 `"v<content_version>:<offset>:<length>"`；缩略图/缓存为其独立表示修订，不与原文件混用。If-None-Match 支持列表、弱匹配与 `*`，命中返回 304；仍先鉴权。If-Range 只接受当前强 ETag，弱标签、日期或不匹配均忽略 Range 返回完整表示。v1 不使用文件重命名时的 modified_at 作为内容验证器，也不实现 If-Match/If-Unmodified-Since 的额外写入语义。

应用后端收到原始 Range/If-None-Match/If-Range 但不必再解析一遍；宿主处理。流开始前上游读取错误返回通用错误，开始后出错/撤权只中断连接，绝不向字节正文追加 JSON/HTML。调用方必须校验 206 的 Content-Range/Content-Length，不能把忽略 Range 的 200 全文件当作所需小段。

## 10. 应用键值存储与原生客户端

所有应用，包括带后端应用，都能使用同一个通用 KV 语义，按应用 ID 隔离，不按设备拆分。带后端应用的大型索引/敏感连接配置可以放自己的 SQLite；KV 不提供某应用的特殊例外。

| 方法与完整路径 | 参数 | 成功响应 | 权限与专用错误 |
|---|---|---|---|
| GET `/admin/api/apps/v1/self/kv/{key}` | URL key | 200 KvGetResponse={record:KvRecord\|null} | A；缺键不是 404；app_changed |
| PUT `/admin/api/apps/v1/self/kv/{key}` | KvPutRequest={value,condition} | 200 新 KvRecord={key,value,revision,updated_at} | A；storage_conflict/quota_exceeded |
| DELETE `/admin/api/apps/v1/self/kv/{key}` | JSON KvDeleteRequest={revision} | 204 | A；storage_conflict，包括期望存在但已被删除 |
| POST `/admin/api/apps/v1/self/kv/list` | KvListRequest={prefix?,limit?,cursor?}，默认 prefix=""、limit=100，最多 200 | 200 KvPage={records,next_cursor} | A；invalid_cursor/cursor_expired |
| GET `/admin/api/apps/v1/self/data/usage` | 无 | 200 DataUsage，KV 条数/字节/限额、缓存占用/限额、可选后端数据库占用/限额 | A |

下面四个接口属于已定义的**非必备 kv.device 扩展**。只有实际实现并声明 kv.device 的宿主提供，首版宿主不实现，原生客户端须先通过宿主原生能力宣告探测；不把 iOS 适配纳入本次切换。DeviceAppDataGrant 类型保留供该扩展使用。

| 方法与完整路径 | 参数 | 成功响应 | 权限与专用错误 |
|---|---|---|---|
| GET `/admin/api/native/apps/v1/{app_id}/kv/{key}` | app_id,key，设备 Bearer | 同 KV GET | kv.device + 设备有该应用 app_data.read；device_revoked/caller_not_allowed/not_found（应用未安装） |
| PUT `/admin/api/native/apps/v1/{app_id}/kv/{key}` | 同 KV PUT | 同 KV PUT | kv.device + 设备有该应用 app_data.write；同 CAS 错误 |
| DELETE `/admin/api/native/apps/v1/{app_id}/kv/{key}` | 同 KV DELETE | 204 | kv.device + 设备有该应用 app_data.write；同 CAS 错误 |
| POST `/admin/api/native/apps/v1/{app_id}/kv/list` | 同 KV list | 同 KvPage | kv.device + 设备有该应用 app_data.read；同游标错误 |

key 为 1～128 个 ASCII 字母、数字、冒号、下划线、短横线，区分大小写。value 为任意合法 JSON，单值序列化后最多 32 KiB；null 也是合法值，必须与 record=null（不存在）区分。每应用默认 10 万条、键+JSON UTF-8 字节合计 64 MiB，不含 SQLite 索引开销；检查净增长和条数在同一写事务内完成。

condition 必需，只有两种：`{"type":"absent"}` 只在不存在时创建；`{"type":"revision","revision":"r1"}` 只在旧修订匹配时更新。删除也必须匹配旧修订；**没有无条件 set/delete**。新修订为不复用的不透明标识，不能用 updated_at 判断 CAS 或防止 ABA。事务同时核对当前应用启用/generation，旧页面不能在更新后继续写。

列表按键 UTF-8/ASCII 二进制升序作键集分页，不按更新时间排序以免一次写入把所有后续页移动。除默认100/最多200条外，records 数组序列化累计最多 **512 KiB**（包括键、JSON value、revision、updated_at、字段名/分隔符）；装不下下一条就先返回当前连续前缀和游标，不消费/跳过那条。32 KiB 值在最大记录页中通常只能装约15条，SDK 必须按 next_cursor 继续，不按返回条数判定结束。prefix 是字面前缀，游标绑定应用 generation/prefix/limit，1 小时有效；并发修改是弱一致，事件提示重拉相关键。不能把“读到最大页码”当成冲突自动合并规则，主人可能正在回读。

原生设备的 app_data 授权由主人配对/设置，在既有设备认证系统中保存 `DeviceAppDataGrant={app_id,access}`，access 为 read_only/read_write；后者包含 KV 读取。应用后端不能创建、扩权或冒用设备令牌；设备令牌不能调用 self 文件/界面/安装接口。这是 KV 应用命名空间的授权，不等于该应用的网盘目录读写。普通更新保留 KV，停用/卸载阻止访问，显式清数据卸载才删除；重新安装同 ID 后使用新的 generation。

KV 与后端 SQLite 纳入备份。应用不要假定 KV 是秘密保管箱：获主人授权的原生设备可以读取其被授予的键值。后端自己的业务账号/Token 不需要暴露到通用 KV 或页面。

## 11. 通用小对象缓存

这是 v1 必备的可再生二进制缓存，不是内容专用“封面库”，不备份、不发 KV 事件、不占 KV 配额。页面可以保存从授权文件生成的小对象，以免反复解析 PDF/归档；对象内容与 metadata 完全由应用解释。

| 方法与完整路径 | 参数 | 成功响应 | 权限与专用错误 |
|---|---|---|---|
| PUT `/admin/api/apps/v1/self/cache/{key}` | 原始二进制，安全 Content-Type；可选 X-Tgdrive-Cache-Meta=`base64url(JSON CachePutMetadata)` | 200 CacheEntry={key,content_type,size,revision,metadata,updated_at} | A+cache.objects；payload_too_large/quota_exceeded；sources 有值时还需 R/内容匹配 |
| GET/HEAD `/admin/api/apps/v1/self/cache/{key}` | key，If-None-Match | 200/304 缓存字节；响应 X-Tgdrive-Cache-Meta=`base64url(JSON CacheEntry)`，HEAD 无正文 | A+cache.objects；未命中/源失效统一 not_found |
| DELETE `/admin/api/apps/v1/self/cache/{key}` | 无正文 | 204，不存在也成功 | A+cache.objects |
| POST `/admin/api/apps/v1/self/cache/lookup` | CacheLookupRequest={keys}，1～64 个不重复键 | 200 CacheLookupResponse={hits:[{entry,url,expires_at}]}；url 为同源相对缓存票据路径，只返回命中项 | A+cache.objects |
| GET/HEAD `/admin/api/apps/v1/cache-media/{ticket}` | 公网或本应用 host.sock 上的单对象/单修订票据，If-None-Match | 200/304 字节，同样携带 CacheEntry 元信息响应头 | 绑定应用 generation/创建者/缓存修订、当前 sources；套接字只接受本应用当前启动轮次签发的票据；ticket_expired/not_found |

**响应头类型只有 CacheEntry 一种表示**：所有缓存 GET/HEAD 的 200/304 响应（含限时缓存票据地址）必须携带 X-Tgdrive-Cache-Meta，值为无 padding 的 base64url(UTF-8 JSON CacheEntry)，不是 CachePutMetadata，也不是只有 metadata 字段。它与 PUT 的 200 JSON 正文及 lookup 的 hits[].entry 使用完全相同的 CacheEntry 类型；PUT/lookup 已返回 JSON，不重复发送这份元信息头。请求与响应保留同一头名但类型按方向明确：PUT 请求头为 CachePutMetadata，缓存读取响应头为 CacheEntry；SDK 不得猜测或提供另一种响应结构。错误/未命中响应不携带旧条目头。

CacheEntry.key 最多 128 字节，content_type 最多 256 字节安全 ASCII，revision 为 1～128 字节不透明 ASCII 标识，updated_at 为协议规定的毫秒时间，metadata 按完整 UTF-8 JSON 序列化后最多 4096 字节。**完整 CacheEntry JSON 上限为 5120 字节，编码后的响应头值上限为 6827 个 ASCII 字节**，编码上限为 ceil(4×5120/3)，不包含头名/分隔符；所有响应头合计仍受 32 KiB 限制。上限包含键名、MIME、修订、大小、时间及 JSON 转义开销，不把单个 metadata 的 4096 字节误当整个头的上限。宿主用 validate_cache_entry_header 校验后再编码，不截断 JSON/头值。Rust 的 CacheEntry::METADATA_HEADER/HEADER_JSON_MAX_BYTES/HEADER_VALUE_MAX_BYTES 与生成 LIMITS 绑定该类型和边界；PUT 请求头仍按 CachePutMetadata 的 metadata/source 数量及请求总头限制校验，不套用响应头上限。

key 与 KV 相同。单对象最多 2 MiB，metadata JSON 最多 4096 字节，sources 最多 16 个 ContentRef。省略 CachePutMetadata 视为 metadata=null、sources=[]。有 sources 时每次 lookup/读取验证最新授权与内容版本，源失效就是缓存未命中；应用不需要拿旧图冒充新内容。没有 sources 的对象只按应用生命周期隔离，宿主不能自动推断其源文件，应用应为文件派生产物提供 sources。

缓存 lookup 的 hits[].url 对所有调用方也只返回 `/admin/api/apps/v1/cache-media/<票据>` 这样的同源相对路径，不含 scheme/authority；形式与长度同第 9.2 节。CacheHit::TICKET_BASE 与生成的 CACHE_TICKET_BASE 绑定该路径基址。页面直接使用或加 host_origin；后端把票据交给外部客户端时，加该外部请求的 ForwardContext.public_origin，不加 public_base_url 的服务前缀。本机 local-url 不适用此规则。

**缓存票据地址在应用后端的 host.sock 上同样可达**。后端自身读取时把 hits[].url 原样经宿主套接字请求，不经公网、不拼 public_origin；套接字**只接受该应用自己这一启动轮次签发的票据**，不接受其他应用、页面会话或旧启动轮次的票据。票据本身即授权，但读取与公网入口一样核对应用 generation/创建者生命周期、缓存修订，以及 sources 的最新目录授权和内容版本；对象或源失效按既有 not_found 语义处理，不能借套接字绕过失效检查。媒体票据的可选租约检查仍按第 9.2 节，不为缓存另增未定义的 lease_id 字段。

缓存票据的公网/套接字入口都只支持 GET/HEAD 与 If-None-Match，成功响应为 200/304，语义与各自的公网入口完全相同。缓存对象最大 2 MiB，不支持 Range 与 If-Range，不提供 206 或 416 响应，也不使用第 9.5 节的 Range/If-Range 解释。ETag 绑定缓存修订，200/304 均携带同一完整 CacheEntry 元信息响应头；HEAD 不读缓存正文，304 前仍核对票据与源有效性。

缓存默认页面应用 256 MiB，带后端 1 GiB（与私有 cache 子目录共用总配额），按最近访问淘汰到上限 90%；新 PUT 对象本轮不淘汰。读取访问时间可以合并刷新，不每次写 SQLite。lookup URL TTL 为 300 秒，不超过创建者会话/源权限，缓存同键覆盖后旧票据作为未命中，不返回旧字节。

宿主在该应用 `cache/objects/` 内用原子文件/可再生元数据管理 API 对象；应用后端自行生成的工作缓存放 `cache/work/`。不建任何内容类型的表、不用 base64 把所有二进制塞进 JSON 主库。应用不得直接修改 objects 的实现文件，但可以通过 API 操作；objects/work 都可随时丢失或清空，后端不能把业务状态放在缓存中。纯页面应用没有任意文件系统接口。

## 12. 应用后端进程约定

### 12.1 启动、目录与环境

应用包按摘要物化为宿主只读的不可变目录。宿主为每个应用创建独立、无登录 shell、无额外组的系统 UID/GID，不复用另一个保留数据应用的 UID。宿主数据库/配置/密钥及管理目录 root 专有；其他应用数据目录不得 world-readable。每个后端只能写自己的应用数据目录，不给它可写的共享 /tmp 或宿主包目录。

逻辑布局如下，绝对位置由上下文给出，不写死机器路径。

```text
<data_dir>/                      # root 管理目录，应用只读/可遍历
  state/                         # 本应用 UID 可写
    app.sqlite3                  # 唯一纳入备份的 SQLite 数据库
    app.sqlite3-wal / -shm        # SQLite 同库辅助文件，不单独当作业务库
  cache/                         # 可再生，共用缓存配额
    objects/                     # 通用缓存 API 管理
    work/                        # 应用后端工作缓存
  tmp/                           # 本应用私有临时文件，不备份
  run/                           # 宿主 root 管理、只读给应用，重启可清除
    context.json                 # root 写、该应用只读的启动上下文
    host.sock                    # 应用调用宿主的套接字
    backend/                     # 应用 UID 可绑定套接字
      backend.sock               # 宿主调用应用后端的套接字
```

应用可读取自己的包、上述数据、镜像附带的只读系统运行库/证书与 ffmpeg/ffprobe；“只能读写自己的数据目录”不意味着无法执行这些只读程序。不能读取其他应用目录、宿主秘密或可泄露这些内容的 `/proc` 进程信息。共享临时目录必须隔离/只读，宿主禁用敏感进程转储/ptrace 泄露；不靠用户名本身假装已经隔离。

唯一启动形式：

```text
<包目录>/backend/app --tgdrive-context <data_dir>/run/context.json
```

context.json 为 BackendStartContext：contract、app{id,name,version,generation}、run_id、host_socket、listen_socket、data_dir、database_path、cache_dir、temp_dir、ffmpeg_path、ffprobe_path、limits。所有路径为宿主提供的绝对路径；两个套接字路径必须符合 Linux sockaddr_un 的实际 107 字节有效上限，不符合就拒绝启动，不能截断导致身份碰撞。

宿主清空环境，只提供 PATH（镜像固定目录）、LANG/LC_ALL=C.UTF-8、HOME=`state/`、TMPDIR=`tmp/`；如提供 RUST_LOG，值是非敏感日志级别。不得继承宿主 Telegram/代理/备份凭据。context.json 也没有秘密或会话令牌，不用环境变量冗余传同一上下文。

应用后端可自由访问外部 HTTP/TCP 网络，不提供宿主通用网络代理。需要应用自己的外部 Token/代理地址由应用配置并放私有 SQLite。已获读取授权的内容可以被后端发送到外站，这是该架构已经接受的能力，不宣称防止应用主动外传其授权内容。

### 12.2 套接字方向与安全

每应用有**一对独享监听套接字**：host.sock 由宿主监听，backend.sock 由应用后端监听，均为 HTTP/1.1，支持 keep-alive 和流式正文，不采用 WebSocket/反向 RPC。两个方向的连接不可复用成未定义的双向 HTTP RPC。

绝不让不同应用共用一个靠请求中 app_id 分发的身份套接字。

run/host.sock 的目录由 root 管理、组访问绑定唯一应用 UID/GID；宿主验证 SO_PEERCRED 和当前 run_id 绑定，不只信路径名称。后端监听目录归该应用，但宿主连接前/连接后校验套接字类型、所有者和目标进程 UID，防止链接/路径替换。应用后端的监听器只信来自宿主 root 的连接；客户端不能从 TCP 直接连接这个监听器。

宿主处理缓存、临时文件及恢复输出等应用控制路径时必须锚定已验证的数据根目录 FD，采用 openat2 的 beneath/no-symlink 约束或逐级 openat+O_NOFOLLOW 等等效安全打开；核对普通文件、期望所有者和单一链接，拒绝链接/设备文件，不先检查后按不受信任路径重新打开。缓存原子写入不得跟随既有叶子链接；读取/清理也不能被应用替换的目录链接引到宿主或其他应用数据。清单中的“应用不得直接修改 objects”是使用约定，不是替代这些防护的安全保证。

### 12.3 就绪、停止、崩溃与按需回收

1. 启动前撤销旧轮次能力、回收进程组/子进程，重新建立 run_id、套接字与只读上下文。应用绑定 backend.sock 后才接受就绪探测。
2. 宿主用私有套接字请求 `GET /_tgdrive/ready`，30 秒内必须返回 200 BackendReadyResponse={contract,app_id,version,generation,run_id}。所有身份与轮次必须匹配；contract 按第 2 节协商，不要求旧应用报告新宿主的最高 minor。
3. ready 表示必要的私有数据迁移完成、可以接收请求，不表示整个内容索引必须已扫完。应用自己后台构建索引并用自己的页面接口报告状态。只有 ready 后宿主才转发业务请求。
4. `/_tgdrive` 是应用后端内部管理前缀。应用必须在带 ForwardContext 的页面/外部请求上拒绝此内部前缀；宿主直接私有就绪探测不带用户转发上下文。不能把公开 GET /_tgdrive/ready 当作内部身份。
5. resident 随宿主启动（仅已安装且启用），不依赖页面打开。on_demand 在首次页面代理或对外请求时合并并发启动；就绪失败统一 backend_unavailable，不无限排队。
6. on_demand 无在途业务请求、直传、本机读取后，空闲 300 秒停止。后端发出的有效宿主调用刷新空闲时间；长联网/计算任务可用 `POST /admin/api/apps/v1/self/process/keepalive` 的 BackendKeepaliveRequest={ttl_seconds}，范围 1～300，续活动期限，不把页面消息当后端心跳。宿主事件订阅本身不永久阻止回收。
7. 停止先停止接收/转发新请求、撤销该轮次通道/票据/租约/未提交上传，发送 SIGTERM；应用停止自己的任务/子进程并关闭 SQLite，10 秒后宿主 SIGKILL 整个应用进程组；可用的 cgroup 协助回收。不能只杀父 PID 留 ffmpeg 继续读写，应用不得让子进程脱离宿主的回收范围。
8. 非预期退出使用 1、2、4、8、16 秒有界退避；10 分钟最多重启 5 次，之后 failed、停止自动重启，由主人重启/重新启用解除。按需应用只有仍有请求/活动需求时重启，正常空闲/SIGTERM 停止不计崩溃。崩溃事件与状态不泄露 stderr 中的秘密。
9. 停用、卸载、更新、恢复会撤销安装 generation；后端崩溃重启只换 run_id，页面会话仍可查询状态/等待重启，但旧轮次能力失效。普通 stdout/stderr 由宿主采集到有界轮换日志，禁止把秘密写出。宿主不解析应用日志中的业务指令。

### 12.4 数据库、备份与资源

应用持久业务状态只放 `state/app.sqlite3`，可以使用 WAL，但不得另建需要备份的数据库、ATTACH 外部库或依赖缓存中的文件。应用自己管理表、迁移和 schema；宿主不认识这些表，也不注入业务逻辑。应用可在 state 临时产生迁移文件，但不能把未纳入备份的文件当作持久秘密来源。

宿主派生一个以**该应用 UID/GID**运行、清空宿主敏感环境的备份辅助进程。辅助进程只在应用权限范围内，用 SQLite Online Backup API 对固定 `state/app.sqlite3` 取一致快照，再把结果通过有界管道流回宿主；应用后端持续运行。root 不按应用可控路径打开该数据库，路径即使被替换也不能让辅助进程越过应用文件权限读取宿主或其他应用数据。快照失败保留上次成功备份，不在线裸复制 `.sqlite3` 而忽略 WAL。KV 与各应用库分别保证快照一致，**不承诺跨多个数据库的共同事务时点**；应用通过文件内容版本/变更游标恢复派生索引。备份包含应用库中选择保存的秘密，应与宿主备份同等保护。

恢复前停止全部应用进程与在途写入；恢复后重新分配有效 generation/run_id，清理缓存/临时目录/旧票据与游标 epoch，只恢复已验证的应用记录和对应固定数据库。应用按最新网盘文件状态自行核对索引，不自动续跑未知写入或把旧回执当作新提交。

启动后端必须满足的硬要求只有：每应用独立 UID/GID、文件权限隔离、专用套接字身份、清空宿主环境、按应用进程组回收全部子进程。无法满足这些要求时返回 capability_unavailable/backend_unavailable，不能假装隔离。

资源限制**尽力而为**：内存/CPU 是宿主设置里的总体限制，设置在全部应用后端共同所在的 cgroup 上，各后端合计不超过它，0 表示不限制；主人修改后对运行中的后端立即生效。设了内存上限时同时禁止这些后端使用交换空间，合计超出时内核在这些后端里终止占用最多的进程。它在 cgroup v2 的相应控制器可写且实际设置成功时应用；cgroup 只读、不可用或设置失败时仍照常启动。PID 数用 RLIMIT_NPROC（独立 UID 使计数按应用生效），fd 用 RLIMIT_NOFILE，禁用 core dump。配置目标与实际强制分开：RuntimeInfo.limits.backend 和 BackendStartContext.limits 都必须带 `enforced={memory,cpu,pids,open_files}`，四项布尔值只在该轮实际强制成功时为 true，设为不限制的项为 false；失败记录告警并为 false，不把配置值冒充硬上限。

磁盘只有**监督式计量**：KV/API 缓存写入由宿主同步计量，cache/work、state、tmp 的后端文件写入由宿主监督统计，发现超限停止后端、阻止再启动直至主人清理/调整。数据库按 database_bytes 计量，cache/work/objects 与 tmp 合计按 cache_bytes 计量。监督可能短暂超额，**不是实时硬隔离保证**，不能静默删除 SQLite 业务数据；应用必须主动限制缓存和临时输出。

## 13. 请求转发与浏览器安全

### 13.1 三个入口，两个调用方

| 入口 | 客户端地址 | 发送给后端的 URI | caller / entry |
|---|---|---|---|
| 应用页面 | `/admin/api/apps/v1/self/backend/<path>`，有效本应用页面 Bearer | 去掉宿主前缀，得到 `/<path>`，原查询不变 | owner / page |
| 根地址 | `/admin` 以外的全部请求，主人当前指定的应用 | 原路径/查询不变 | external / root |
| 固定前缀 | `/admin/api/apps/v1/services/<app_id>/<path>` | 去掉该应用固定前缀，得到 `/<path>` | external / prefix |

应用页面不能直连外站、另一个应用或应用后端套接字。后端普通业务路由由应用自己决定，宿主不内置 `/fntv`、`/scraper` 或内容类型路由。`GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS` 可以代理，CONNECT、TRACE、HTTP Upgrade/WebSocket 不在 v1 支持范围；SSE 和普通流式 HTTP 响应支持。后端专用的活动续期接口 POST `/admin/api/apps/v1/self/process/keepalive` 不占用应用的业务代理路径，返回 204；页面调用它返回 caller_not_allowed。

未指定根地址应用时 GET/HEAD 302 到 `/admin/`，其他方法 303 到 `/admin/`，不把外部 POST 正文重放给管理端。已指定但应用停用、后端失败/服务未声明时返回 backend_unavailable，不临时把根地址分给另一应用。卸载根地址应用会原子清除选择。只有声明 backend.external_service=true 的已启用带后端应用能被指定或使用固定前缀；应用自己的服务开关/客户端账号仍由它实现。

`/admin` 边界必须按规范化路由段处理，`/administrator` 是根地址，`/admin` 或 `/admin/...` 是宿主；畸形路径、编码斜杠/反斜杠、点段不能逃逸到另一入口。宿主不改写应用路径大小写/百分号编码，去前缀后不能进行第二次业务解码。

### 13.2 可信 ForwardContext

宿主剥除全部客户端 `X-Tgdrive-*`、Forwarded/X-Forwarded-* 及 hop-by-hop 头，再添加唯一 `X-Tgdrive-Context`：无 padding 的 base64url UTF-8 JSON ForwardContext。

```json
{
  "contract": { "major": 1, "minor": 0 },
  "app_id": "example-app",
  "caller": "external",
  "entry": "root",
  "request_id": "request-1",
  "original_uri": "/client/api?q=1",
  "public_origin": "https://drive.invalid",
  "public_base_url": "https://drive.invalid",
  "client_ip": null
}
```

public_origin 为可信公开源 `scheme://authority`，不含路径、查询或尾斜杠；与 public_base_url 一样，由直接请求和主人配置的可信代理判定，不能信任任意客户端转发头。public_base_url 为本入口完整公开基地址，无尾斜杠：根等于 public_origin，固定前缀/页面包含各自代理前缀。应用协议链接使用 public_base_url；宿主签发的 `/admin/...` 票据路径只与 public_origin 拼接，避免固定前缀重复。例如 public_origin=`https://drive.invalid`、public_base_url=`https://drive.invalid/admin/api/apps/v1/services/example`，票据 `/admin/api/apps/v1/media/t1` 的绝对地址仍是 `https://drive.invalid/admin/api/apps/v1/media/t1`。original_uri 是原始路径+查询，不带 authority；client_ip 也只来自直接连接或可信代理。

owner 只出现在有效应用页面入口；即使外部请求带主人 Cookie/设备令牌/应用 Bearer，也仍是 external，不能借这些身份进入应用的主人路由。后端须先根据可信 caller 选择主人接口或外部鉴权，不能在“某头缺失”时默认主人。

**Authorization 来源隔离**：根地址入口与固定前缀入口转发前，宿主必须剔除经校验确属宿主自己签发的 Authorization 凭据，包括原生设备访问令牌、应用页面会话令牌等宿主签发的一切 Bearer。判定依据是宿主能够验证签名或命中自己的令牌存储，**不是按字符串形态猜测**，也不能把令牌先发给应用再要求它验证。已经过期/撤销但仍能识别签发来源的宿主凭据也不转交。校验不通过的 Authorization 视为应用自己的协议凭据原样保留；剔除后请求仍是 external，不提升为主人请求、不向应用泄露凭据值。这样旧客户端即使仍请求错误的旧 `/api` 地址，宿主签发的设备/会话凭据也不会被交给根地址应用。

请求方向按入口隔离 Cookie：

- **页面入口**：剥除全部 Cookie 与应用会话 Authorization；主人身份只通过可信 ForwardContext 传递。
- **固定前缀入口**：剥除全部 Cookie；服务用 Authorization 或自己的协议字段鉴权，v1 不支持其基于 Cookie 的登录。
- **根地址入口**：按名称剔除宿主自己的全部 Cookie 与保留前缀 `tgdrive_` 的 Cookie，其余 Cookie 与应用自身 Authorization 保留；过滤后为空就不发送 Cookie 头。

根地址应用的 Path=/ Cookie 会自动随浏览器请求进入 `/admin` 下其他应用的固定前缀；固定前缀还会收到 Path=/admin 的宿主登录 Cookie，因此不能放宽成只按宿主名称过滤。以上隔离防止把根服务的登录凭据泄露给别的应用。页面 fetch 使用 credentials:omit，不自动携带登录 Cookie。请求目标 app_id 不能由业务 JSON/头改变。

### 13.3 响应、Cookie 与脚本禁用

根地址和固定前缀入口**所有状态的所有响应**（普通、错误、重定向、HEAD/304、宿主直传）强制覆盖以下头。

```text
Content-Security-Policy: sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

删除应用尝试覆盖的同名安全头及 Content-Security-Policy-Report-Only 等弱化/外站报告配置；不允许靠外部 HTML/JS 地址在宿主源执行脚本。应用的 UI 只能在应用中心沙箱页面里运行。Media/缓存字节地址也强制脚本禁用安全头，避免原文件或应用自定 MIME 变成同源活动内容。

响应剥除内部 X-Tgdrive-* 与 hop-by-hop 头。所有应用入口都必须丢弃与宿主 Cookie **同名**或以保留前缀 `tgdrive_` 开头的每一条 Set-Cookie，**无论其 Path/Domain 是什么**；同源 Cookie 写入不能靠 Path 隔离，应用即使不能伪造签名也不能覆盖登录状态造成强制登出。

- **页面入口**：剥除全部 Set-Cookie。
- **固定前缀入口**：剥除全部 Set-Cookie，不能反向覆盖根地址应用的 Cookie。
- **根地址入口**：仅保留应用自己的、非宿主名称/保留前缀的 Set-Cookie，**Path 强制为 `/`、删除 Domain**；不能改写宿主 Cookie。

宿主登录 Cookie 名使用保留命名空间、**Path=/admin**，并按宿主策略 HttpOnly/Secure/SameSite；Cookie 名区分大小写，保留前缀的拼写固定。

应用输出 Location 时应使用 public_base_url 或相对本入口地址。宿主不自动跟随后端重定向。重定向必须留在该应用入口或合法外部 HTTPS 地址，不能指向 `/admin` 下除自身外部前缀之外的管理接口/另一应用；否则 invalid_backend_response。页面代理入口禁止跨源重定向，fetch 也使用 redirect:error。宿主不改写响应正文中的协议链接。

普通代理请求正文上限 8 MiB，首响应头超时 60 秒（含按需就绪等待），普通连接连续无字节 60 秒结束；SSE 注释心跳也算活动。正文流有背压、有界缓冲；代理不自动重试业务写请求。元数据控制请求 30 秒。文件上传走第 8 节单独的声明大小与流式策略，不受 JSON/普通代理正文上限。

### 13.4 应用页面沙箱与真实限制

iframe 带 `sandbox="allow-scripts allow-downloads"`，不得加入 allow-same-origin、allow-forms、allow-popups、allow-top-navigation。allow-downloads 用于应用明确由主人点击的限时 attachment 下载，应用不得后台自动发起下载；这是页面行为规则，浏览器并非可靠的用户手势/下载频率隔离器。资源响应也附同样的 CSP sandbox 约束，防止直接访问静态入口变成宿主同源页面。

资源响应的 CSP 使用 Rust 常量 PAGE_CSP，可直接使用 `'self'`，包括 `connect-src 'self'`；CSP 的 self 按文档 URL 的源匹配，不因 iframe 的不透明源而失效。宿主不为 CSP 增加公开地址配置，也不把任意 Host 原样拼入策略。允许同源的包资源、自己的后端代理/限时媒体与缓存、必要 blob worker 和 data/blob 图像/媒体；禁止外站 fetch/XHR/WebSocket、外站脚本/图像/字体/worker、frame、object、表单、Service Worker、eval 和任意 inline script。可允许 inline style；建议 default-src 'none'，script-src/connect-src/font-src 为 'self'，base-uri/form-action/object-src/frame-src 'none'，frame-ancestors 'self'。同源访问仍逐请求校验应用身份、能力和目录授权，不靠 CSP 代替接口授权。public_base_url 与启动上下文的 host_origin 按请求及可信代理配置推导，用于链接/消息绑定，不是额外的 CSP 地址设置。

沙箱的不透明源上不能依赖浏览器持久存储、读取宿主 DOM/Cookie 或注册宿主 Service Worker。包内的 EPUB/HTML 等不可信内容仍需由应用清洗，不能假定它是应用脚本。

**既定保证级别**：CSP 禁止页面直接调用外站网络 API 和加载外部资源，页面业务联网经自己的后端；外站导航/外站链接是包的禁止行为，发布验收检查。标准 iframe sandbox+CSP 不能可靠阻止恶意脚本导航自身 iframe 后发出的首个外站请求，所以不宣称浏览器级恶意页面“零外联”，也不为此引入额外浏览器或网络边界。安全边界是保护宿主与网盘授权；获得目录授权的应用后端本来就可把内容发送到外站。

## 14. 界面消息通道、事件和限额

### 14.1 页面启动与界面消息

主人通过应用中心 launch 取得 LaunchPageResponse={frame_url,bootstrap}。宿主将 bootstrap JSON 以无 padding base64url 放在 iframe URL **片段** `#tgdrive=<内容>`，不会进入服务器请求/Referer；不是查询参数或内联脚本。页面解析后移除片段，只在内存保留 PageBootstrap：contract、app、session_token、expires_at、host_origin、api_base、backend_base?、ui_nonce、theme、launch（browse 或 open{file}）。open 文件必须已经过目录授权确认；用户取消授权则不向应用交付未授权文件详情。

postMessage 没有 HTTP/RPC/字节传输桥，也不提供 MessagePort 数据面。UiMessage 通道固定 `tgdrive.ui.v1`，每条带 bootstrap.ui_nonce。页面只接受 source===window.parent、origin===host_origin 的消息；宿主只接受当前 iframe.contentWindow、origin 为其沙箱不透明源、nonce 匹配的消息，不能只检查 origin=null。页面发送 targetOrigin=host_origin，宿主发给不透明 iframe 时只能 `*`，靠 source/nonce 绑定。不得在消息中允许任意方法名、URL、文件正文或应用会话续签。

请求信封如下，响应/通知都使用生成的 UiMessage。

```json
{
  "type": "request", "channel": "tgdrive.ui.v1", "nonce": "nonce-1", "id": "ui-1",
  "request": { "method": "ui.set_immersive", "params": { "active": true, "background": "#ffffff" } }
}
```

| UiRequest.method | 参数/结果 | 行为 |
|---|---|---|
| `ui.set_immersive` | {active,background?} → acknowledged | background 仅六位 #RRGGBB，不接受 URL/CSS/透明色；宿主布局完成后应答，不调用 Fullscreen API |
| `ui.set_title` | {title} → acknowledged | 非空纯文本，最多 120 字节，不作为 HTML |
| `ui.pick_directory` | {initial_id?} → directory{directory:FileNode\|null} | 用户选择一目录；取消为 null，选择不授予读取/写入 |
| `ui.request_scope` | ScopeAuthorizationRequest={reason,preferred_access} → authorization{scope:ScopeInfo\|null} | reason 非空最多 800 字节；宿主授权对话框，最终主人确认；取消为 null，应用不能自行确认 |
| `ui.task` | TaskProgress → acknowledged | id 1～64 字节标识，title 最多160字节；completed/total 为 0～4294967295 的 u32，total? 不小于 completed；state=running/completed/cancelled/failed，cancellable 缺省 false |
| `ui.close` | 无 params → acknowledged | 宿主离开应用页面，先进行 before_close 流程 |
| `ui.closed` | {close_id} → acknowledged | 应用已经完成 before_close 保存的界面确认，不含保存的数据 |

响应 type=response，带原 id，result 为 `{status:"ok",value:UiValue}` 或 `{status:"error",error:ApiError}`。同一页面最多 32 个待应答界面请求，普通 UI 最大 5 分钟；同一时间只开一个选择/授权窗口。未知方法返回 capability_unavailable，不当作文件请求执行。

通知 type=notice：ui.theme_changed{theme:light/dark}；ui.task_cancel{task_id}；ui.before_close{close_id,deadline_ms:2000}。关闭/切换前页面通过直接 HTTP 保存进度，最多 2 秒后宿主继续关闭，强制关闭浏览器不保证最后一笔保存。

宿主外壳在保存宽限结束后、移除 iframe 时，使用 LaunchPageResponse.bootstrap.session_token 调用 DELETE `/admin/api/apps/v1/self/session`，仅撤销该页面而不是整个安装 generation。页面 SDK 主动关闭时先保存，再通过 ui.close 请求外壳关闭；也可先用当前页面令牌调用 DELETE 独立撤销能力，ui.close/ui.closed 仍只负责当前界面的退出确认，不恢复 HTTP 能力。重复关闭得到 401 session_expired/unauthorized 可视为会话已不可用，不应回退成撤销整个应用。该 DELETE 不经 postMessage 转发，不增加界面 RPC 或能力名。

退出、会话失效、崩溃或卸载要恢复标题、沉浸背景、滚动/viewport 与宿主导航；迟到旧 nonce 的消息不能再隐藏宿主。

### 14.2 SSE 事件

GET `/admin/api/apps/v1/self/events` 返回 `text/event-stream`，页面用带 Bearer 的 fetch 消费流，不把令牌放在 EventSource URL 中；后端通过自己的宿主套接字使用同接口。每个页面会话/每个后端启动轮次最多 2 条连接，连接本身不占普通控制请求槽。

```text
id: events-2
event: host
data: {"cursor":"events-2","occurred_at":2,"event":"files.changed","data":{"change_cursor":"changes-2"}}

```

每个 SSE data 是 HostEvent={cursor,occurred_at,event,data}；SSE id 与 cursor 相同。使用 Last-Event-ID 重连，应用按 cursor 去重，不假定 exactly-once 或每条事件必达。宿主只在**内存**中为每应用保留最多 4096 条近期事件，不持久化、不承诺保留时长。宿主重启、游标早于内存窗口、无游标、恢复/epoch 改变或连接队列溢出时先发 sync.required 并给新游标，应用据此重读 ScopeInfo/KV/文件变更。每 15 秒发送注释心跳。

持久增量依据只有文件变更游标（7 天/100 万条）与 KV 当前数据，不把 SSE 当持久日志或写入回执。stream.started/finished 也是内存提示，应用应及时将自己的业务状态写入私有 SQLite，断线/重启后的业务核实由应用协议与自己的持久数据完成。

| event | data 类型/字段 | 含义 |
|---|---|---|
| `files.changed` | FilesChangedEvent={change_cursor} | 本授权范围相关的文件变更提示，消费文件变更接口；可 250 ms 合并、最长 1 秒下发，不重复整个 FileNode 负载 |
| `scope.changed` | ScopeChangedEvent={revision} | 当前目录授权更新，旧查询游标失效，后续请求立即按新授权 |
| `kv.changed` | KvChangedEvent={key,revision?} | 本应用键写入/删除，删除 revision=null，不发送 value；页面/设备/后端的写入同样通知 |
| `storage.changed` | StorageChangedEvent={readable,writable} | Telegram 读写可用性变化，不含目标 Token/频道配置 |
| `backend.changed` | BackendChangedEvent={state,run_id?} | 后端启动/就绪/停止/失败，不等于具体对外服务的业务状态 |
| `external_service.changed` | {}（EmptyResponse） | 本应用根归属/对外入口平台状态变化，重读 RuntimeInfo.external_service；不撤销页面或更换 generation |
| `app.changed` | AppChangedEvent={generation,enabled} | 安装/停用/更新撤销页面能力；可先通知再关闭连接，但认证撤销不等待事件 |
| `stream.started` | StreamStartedEvent={request_id,correlation_id,file,range,lease_id?} | 第 9 节带关联标识的直传真正开始；range 为实际原文件绝对偏移/长度 |
| `stream.finished` | StreamFinishedEvent={request_id,correlation_id,file,bytes_sent,outcome,error_code?} | 已开始直传完成/取消/失败，不包含字节，outcome=completed/cancelled/failed |
| `sync.required` | SyncRequiredEvent={reason} | initial/host_restarted/cursor_expired/overflow/restored 等开放原因，需要同步 |

事件只送当前应用，不泄露其他应用 KV 或未授权文件变更。应用日志、业务任务、媒体库更新不是宿主事件；应用可在自己的页面后端代理路由提供普通 SSE。事件权限/同步不能代替实际操作的最新授权检查。

### 14.3 v1 限额表

所有宿主前端/页面SDK需要用于输入检查的数值从 Rust 的 LIMITS 导出，校验代码引用同一常量。超过 JavaScript 安全整数的上界（NodeId、ByteCount）在生成 LIMITS 中使用十进制字符串，前端用 BigInt 比较，不能先转 number。u32进度和毫秒时间上界仍是安全数值。

| 输入类别 | 已导出的常量/值 |
|---|---|
| 界面 | MAX_UI_TITLE_BYTES=120、MAX_AUTHORIZATION_REASON_BYTES=800、MAX_TASK_TITLE_BYTES=160、MAX_TASK_ID_BYTES=64、MAX_TASK_PROGRESS=4294967295、颜色6位HEX/7字节 |
| 标识与数值 | MAX_OPAQUE_ID_BYTES=128、MAX_NODE_ID="9223372036854775807"（19位）、MAX_BYTE_COUNT="18446744073709551615"（20位）、MAX_TIMESTAMP_MILLIS=9007199254740991、契约版本组件65535 |
| 清单与名称 | 名称120/描述1600/作者160字节、版本80字节、能力名称80字节/必需列表64项、后缀40字节、MIME256字节、资源/路径/节点名沿用相应上限 |
| 分发 | 仓库owner39/name100字节、架构目标名48字节/最多16目标、SHA256固定64位、包/图标/目录文件和条目限额沿用对应常量 |
| 操作与默认 | operation_id64字节、幂等键16～128字节、Unix套接字路径107字节、文件/KV/随机默认200/100/20项、正数参数最小1 |
| 资源与事件 | 后端数据库/缓存/PID/fd 的每应用固定值均导出；缓存淘汰目标90%、文件提示去抖250ms/最长1000ms亦统一导出 |

**响应预算核算与选择**：FileNode 的名字/路径禁止控制字符，UTF-8 JSON 仅引号等至多约2倍转义，不按每字节6倍或再次字符串化 JSON value 估算。按路径4096、名字255、修订/内容标识128、数值和字段名，单个 FileNode 保守上界10 KiB；未按字节截页时500节点加游标约5 MiB。KV单值的32 KiB已是序列化 JSON，放进 record.value 不再二次转义，200条连同键/修订约6.4 MiB。子树失效变更还包含旧路径，500项可接近10 MiB。这些大整页不适合把通用SDK预算放大到约14 MiB，因此选择512 KiB数组字节截页，而不是降低所有小记录的条数上限。

字节截页后，目录/文件/变更/KV页面数组至多512 KiB，算入外层目录节点和最多两个4096字节游标（即使按JSON最坏6倍转义），完整响应仍低于约600 KiB。非分页 ScopeInfo/RuntimeInfo 最多128个授权根节点，再加声明/限额信息低于约1.5 MiB；缓存 lookup 最多64项，每项CacheEntry≤5 KiB、合法URL≤8192字节，即使URL按2倍JSON转义也低于约1.4 MiB。因此宿主应用能力 JSON 响应总上限定为**2 MiB（2097152字节）**。宿主在序列化前按数组累计预算选连续前缀，用 json_page_prefix_count/validate_json_page 与 validate_json_response 共用计数规则；不能先生成大响应，再因超过预算丢弃结果或断言小于limit即结束。计数校验不另分配完整JSON缓冲。

除清单、包与查询已写明的上限外，以下默认值在 `http::LIMITS` 统一定义，RuntimeInfo 给出本调用方配置与实际强制状态。宿主接口自身的请求、并发与 KV/对象写入限额直接执行；后端 CPU/内存/PID/fd 为尽力而为，必须按 enforced 标明，后端磁盘为监督式计量。允许主人降低配额，不能把目标配置或缺失的强制措施冒充实际硬上限；增加配额不能改变数据类型边界。

| 项目 | v1 值 |
|---|---|
| JSON 请求 / 应用能力 JSON 响应 / 分页数组 | 64 KiB / 2 MiB / 默认512 KiB（可设64～512 KiB），按 UTF-8 序列化字节，方向独立 |
| URI / 头总量 | 8192 字节 / 32 KiB |
| 普通后端代理正文 / 直传 JSON 指令 | 8 MiB / 4096 字节（base64url 头约 5.5 KiB） |
| 页面/后端控制并发 | 16 / 32 |
| 页面/后端原文件字节并发 | 8 / 32；含票据/直传/本机读取，依创建者归属计数 |
| 页面控制速率/突发 | 120 次/秒、240 次；按页面会话，应用总量还受宿主总资源约束 |
| 后端控制速率/突发 | 300 次/秒、600 次；按当前 run_id |
| 普通请求 / 代理首响应 / 字节空闲时限 | 30 秒 / 60 秒 / 60 秒 |
| 普通分页/KV 游标有效期 | 每次签发 1 小时，不维持跨页 SQLite 事务 |
| 随机查询候选预算 | 最多 4096 个索引候选步骤，预算耗尽返回 quota_exceeded，不全表扫描回退 |
| 每应用读租约 / 活跃媒体票据 / 未提交上传 | 256 / 8192 / 4；ticket/lease 到期清理，不能靠重试累积无界内存 |
| 本机地址 | TTL 默认 60、最多 600 秒；16 MiB 默认累计预算、最多 1 GiB，按有界上游块共享扣减、不预留整段；32 默认请求、最多 256，计次不归还 |
| KV | 10 万条、64 MiB、单值 32 KiB、键 128 字节、页最多 200 |
| 页面缓存 / 后端缓存（含 tmp） | 256 MiB / 1 GiB，单 API 对象 2 MiB、metadata 4096 字节、lookup 最多 64 键 |
| 缓存元信息响应头 | CacheEntry 完整 JSON 5120 字节，base64url 无 padding 头值最多 6827 字节；与请求 CachePutMetadata 分开解释 |
| 后端 SQLite / 缓存 / PID / fd | 每应用固定 512 MiB / 1 GiB / 64 / 1024，应用不能声明；磁盘监督，PID/fd 用 rlimit |
| 后端内存 / CPU | 宿主设置里的总体限制，全部应用后端合计共用，默认 2 GiB / 不限制，0 为不限制；可写 cgroup 时强制，状态见 enforced |
| 就绪 / 停止 / 按需空闲 | 30 / 10 / 300 秒 |
| 重启 | 10 分钟最多 5 次，退避 1/2/4/8/16 秒 |
| UI 等待 / 关闭保存 / 待请求 | 300 秒 / 2000 ms / 32 项 |
| SSE 心跳/连接 | 15 秒 / 每个页面会话/后端启动轮次最多 2 条 |
| SSE / 文件变更保留 | 内存最多 4096 条每应用、宿主重启清空 / 持久 7 天或 100 万条，先到者截断 |
| 上传/变更回执保留 | 未提交上传 24 小时；创建幂等/已提交结果与元数据回执 7 天 |
| 包上传 staging / 安装预览 | 1 小时 / 10 分钟；只保存已验证内容，失效要求重新预览 |

宿主接口的限额冲突先拒绝，不静默截断结果或超预算缓冲；后端资源按上文的实际强制/监督状态处理，不因没有可写 cgroup 拒绝启动。可以合并只读请求/预取、缓存与事件去抖，但不合并有不同取消语义的写入、不替应用推断业务优先级或无限排队。

## 15. 应用中心管理接口全集

本节定义的是契约中的应用中心管理接口，不是宿主自己的前端全部内部接口全集。宿主前端可以另用仅主人登录可调用的内部接口，例如为目录选择器读取未授权目录的 FileNode；这些不属于契约，应用页面和应用后端均不可调用。判定原则：**凡是应用会调用的必须在契约里，只有宿主自己的前端调用的不必**。ENDPOINTS 与文档完整性测试只核对本契约注册的接口，不要求枚举宿主私有路由。

本节只有已登录主人可以调用，必须经过宿主既有账号安全、Cookie Path=/admin、同源与 CSRF 防护。应用页面/后端/普通设备 KV 令牌不可调用。这些是宿主应用中心的实现接口，不是应用 SDK 的安装能力。

| 方法与完整路径 | 参数 | 成功响应 | 专用错误/行为 |
|---|---|---|---|
| GET `/admin/api/app-center/v1/apps` | 无 | 200 InstalledAppsResponse={apps,root_app} | 列表不等待目录联网 |
| GET `/admin/api/app-center/v1/apps/{app_id}` | ID | 200 InstalledApp | not_found |
| GET `/admin/api/app-center/v1/catalog` | 无 | 200 CatalogResponse={status,result:CatalogReadResult} | 返回兼容及被跳过的身份/原因，未成功时 unavailable |
| POST `/admin/api/app-center/v1/catalog/refresh` | CatalogRefreshRequest={force?}，缺省 false | 200 CatalogResponse | 最小检查间隔、失败保留好快照，不阻止已安装应用 |
| POST `/admin/api/app-center/v1/packages` | 原始 ZIP，Content-Type: application/zip | 201 PackageUploadReceipt={package_id,manifest,package,expires_at} | invalid_package/invalid_manifest/payload_too_large；只上传校验，不安装 |
| POST `/admin/api/app-center/v1/install/preview` | InstallPreviewRequest={source}；catalog{app_id,version,target,sha256} 或 uploaded{package_id} | 200 InstallPreview | 精确取包校验，包含旧 state_revision、新增读取/写入、是否后端/外网；package_changed/incompatible_contract/capability_unavailable |
| POST `/admin/api/app-center/v1/install` | InstallRequest={preview_id} | 200 InstalledApp | 主人明确确认预览才调用；过期/旧安装/包变化返回冲突，不自动换新版 |
| PATCH `/admin/api/app-center/v1/apps/{app_id}/state` | AppStatePatch={expected_state_revision,enabled?,pinned?}，至少一个变化 | 200 InstalledApp | app_changed；pinned 只改 UI，不撤销运行 generation；启停按进程生命周期 |
| PUT `/admin/api/app-center/v1/apps/{app_id}/scope` | ScopeUpdateRequest={expected_revision,scope} | 200 ScopeInfo | scope_changed/write_not_declared/not_directory；先验证所有根，再原子替换 |
| DELETE `/admin/api/app-center/v1/apps/{app_id}` | query.purge_data 缺省 false；If-Match 必需为加双引号的 state_revision | 204 | app_changed；先停进程，删除包、run/tmp/cache；默认保留 KV/固定数据库，purge=true 才清除应用数据，不删除网盘文件 |
| DELETE `/admin/api/app-center/v1/apps/{app_id}/cache` | 无正文 | 204 | 后端需要时先停止、清缓存/临时数据，再按原运行模式恢复；不删 SQLite/KV |
| POST `/admin/api/app-center/v1/apps/{app_id}/backend/restart` | 无正文 | 200 BackendStatus | not_found/caller_not_allowed（无后端）/backend_unavailable；清崩溃计数，换 run_id |
| POST `/admin/api/app-center/v1/apps/{app_id}/launch` | LaunchPageRequest={open_node_id?} | 200 LaunchPageResponse={frame_url,bootstrap} | 没页面则 caller_not_allowed；若 open 未授权先主人授权，取消不得泄露节点详情 |
| GET `/admin/api/app-center/v1/root-app` | 无 | 200 RootAppSelection={app_id?,revision} | app_id=null 表示无选择 |
| GET `/admin/api/app-center/v1/resource-limits` | 无 | 200 AppResourceLimits={memory_bytes,cpu_millis,memory_enforced,cpu_enforced} | 全部应用后端合计共用的唯一一组限制；0 表示不限制，enforced 只在实际写入 cgroup 时为 true |
| PUT `/admin/api/app-center/v1/resource-limits` | AppResourceLimitsUpdateRequest={memory_bytes,cpu_millis} | 200 AppResourceLimits | invalid_request（非 0 时内存须在 64 MiB～1 TiB、CPU 须在 100～256000 毫秒/秒）；保存后对运行中的后端立即生效，不重启应用 |
| PUT `/admin/api/app-center/v1/root-app` | RootAppUpdateRequest={expected_revision,app_id?}；null 清除 | 200 RootAppSelection | app_changed/caller_not_allowed（未声明对外服务或停用）；只选一个，不写应用协议 |

InstalledApp 包含 manifest、generation、state_revision、enabled/pinned、ScopeInfo、实际 target/摘要/大小、可选 BackendStatus、安装/更新时间。更新只接受同 ID 更高稳定版本（同版本同内容可返回已安装，不能改内容），已确认的旧 state_revision 不匹配则重新预览。切换包、generation、写权限降级和撤销旧运行必须原子协调；失败不留下半个新安装。

静态资源：GET/HEAD `/admin/apps/assets/{app_id}/{sha256}/{path}`，只提供当前已启用包的 page/assets 中资源及入口，禁止暴露 backend、app.json/package.json、内部运行目录/许可证之外任意宿主文件。该路径按摘要不可变，ETag 绑定摘要+路径+表示编码，支持 304，private,max-age=31536000,immutable。返回第 13.4 节沙箱 CSP，包资源本身不授予应用会话，不要求 Bearer。已缓存旧资源也不能得到有效新 generation 能力。

宿主管理、网盘 REST、WebDAV、分享、健康检查与管理静态资源全部在 `/admin` 下；本契约不重定义它们的内容 API，也不提供旧 `/api`、`/dav`、`/s` 等别名。

## 16. 四款应用的能力核对与符合性

旧实现仅用于核对真实需要，不要求兼容旧方法或数据。核对参考包括旧文件节点/内容版本、目录范围、KV CAS、事件、媒体票据，以及旧飞牛 protocol/index/covers/probe/frame、旧刮削 backend/planner/data、阅读馆 scanner 和短视频分页洗牌代码。

| 应用 | 如何仅凭本契约实现 | 宿主不承担的内容业务 |
|---|---|---|
| 影视（含飞牛兼容服务） | resident 后端，root/prefix 的 external 调用自行鉴权；按命名目录根用 files.query+changes 构建自己的 SQLite 索引；stat/list/bytes 读取同目录资料、字幕和头像；原附件缩略图或 local-url+ffmpeg 获取封面；用 RuntimeInfo.external_service 展示真实根归属/固定入口，订阅 external_service.changed 刷新而不轮询应用中心；用 204 控制头直传原视频，用租约撤销/stream.started 记录实际起播；页面经 owner 代理共享同一索引/进度 | 飞牛路由/登录、影视媒体库、季集归属、NFO/演员解析、字幕处理、封面选择、FFprobe 参数、播放会话/观看进度 |
| 刮削 | on_demand 后端自由联网调用资料源；query 游标取授权视频；读取现有产物；应用生成 NFO/图片；流式 staging 上传，再条件提交；mkdir+整组 move 与 children_revision 断言防止同行集合变化；自己的 SQLite 写步骤记录与恢复核实，长任务 keepalive | 番号识别、资料来源/联网策略、候选选择、标题/配套归属、资料生成、操作批次、心跳业务规则、自动/手动执行政策 |
| 阅读馆 | 页面 files.query 按格式/名称/时间在大书库分页；directories-with-files 找直接有图片的目录；list 取单章直属图；bytes/限时 URL 有界读取 EPUB/PDF/归档，KV CAS 存进度/配置；cache.objects 缓存生成的小对象；变化用增量核对 | 格式支持、书籍元数据、作品组织、章节/页面/书签、PDF/归档解析、封面生成、阅读 UI |
| 短视频 | 页面 files.random 在全部授权范围抽样并排除近期视频；stat/限时 URL 播放，原附件缩略图可选；KV 存偏好/应用收藏，变化重核来源；沉浸/关闭走 UI 消息 | 视频后缀集合、随机队列/历史策略、播放控件、手势、应用收藏 |

必须具备的符合性测试至少包括：同 minor 新字段不拖垮旧应用；未来条目被单独跳过；两架构和完整清单/摘要绑定；路径/链接/ZIP 安全；none/读写声明/ID 祖先/重叠授权；撤权或移动祖先后旧票据和游标失效；大规模查询不截断/不使用 OFFSET；目录直属命中而非后代命中；随机不是前页洗牌且不全表扫描；KV CAS/ABA；条件整组移动/上传最终提交与崩溃回执；单 Range/窗口/HEAD/304/416；外部不能伪造 owner；后端崩溃撤销并回收子进程；无可写 cgroup 仍可启动并如实报告 enforced；在线备份辅助进程按应用 UID 读取；SSE 重启/缺口发 sync.required；根入口安全头；根地址/固定前缀按真实签名或令牌存储识别并剥除宿主 Bearer，不能按字符串猜测，应用自己的未命中凭据保留且请求仍为 external；页面/固定前缀双向全部 Cookie 隔离；根地址按宿主名称/保留前缀过滤、Set-Cookie 固定 Path=/ 并去除 Domain，任何 Path/Domain 都不能覆写宿主 Cookie。实现 kv.device 时另外验证设备 KV 隔离，不把未实现的扩展算作 v1 验收失败。

以下场景必须单独验收，不能只验证生成类型：

- **票据与公开源**：媒体/缓存票据在页面和后端套接字两种调用方下均为同源相对路径；local-url 仍为绝对 loopback 地址。固定前缀入口下，public_origin 加票据路径正确，含前缀的 public_base_url 只用于应用协议链接。
- **后端自身票据读取**：后端在没有任何公开源/转发上下文时，原样通过 host.sock 读取自己本轮签发的媒体/缓存票据，包括 thumbnail 表示；媒体验证 Range/HEAD/条件请求，缓存只验证 200/304、HEAD 与 If-None-Match，不扩展 Range/If-Range，两者均与各自公网入口完全相同。拒绝其他应用、页面签发及旧启动轮次票据；撤权、内容/缓存修订改变和媒体租约撤销后仍阻止读取/304 或中止在途传输。不能改用公网地址或扩大到原文件读取来绕过缩略图入口。
- **本应用入口状态**：页面获得已声明服务的完整 prefix_url，只有根归属本应用时获得 root_url；套接字调用的两个完整 URL 都为 null。根归属由旧应用切到新应用、首次分配和清除时，只通知对应应用 `external_service.changed`、data={}；两应用重读运行时信息，既有页面会话、generation、票据和租约不因根切换而失效，不以 app.changed 代替该提示。
- **本机并发 seek**：同一地址上，一个开放式 Range 请求只读一小段、连接尚未关闭时立即发起 seek 请求，在剩余预算足以拉取新块时必须成功；不能等前一个 bytes=0- 响应被服务端回收或整个窗口归还后才成功。
- **真实媒体工具共用预算**：用同一地址先执行 ffprobe，再执行 ffmpeg；验证 ffprobe 的开放式请求与紧接着的 seek，以及随后 ffmpeg 读取，在足够的共享预算内成功。统计实际上游块，包括对齐/预取开销，不按声明的整个响应长度扣费。
- **本机限额与撤销**：并发块扣费总额不超预算；窗口和状态/Content-Range 按请求开始时的余额裁剪。请求开始时零余额返回 quota_exceeded，传输中途耗尽只中断字节流、不追加 JSON 或其他正文；取消或对端关闭后不再拉取。请求次数按请求扣减且不归还；DELETE 地址中止全部在途读取，带租约和不带租约两种场景均验证。

本次库内单元测试只验证静态类型、序列化和共享校验/范围规则，不证明尚未实现的宿主、包解析器、进程隔离或浏览器行为已经通过。后续宿主实现和四款应用必须补真实集成验收，不能把本库测试当作飞牛官方客户端实测。

正式发布的宿主**永远只有 Telegram 网盘存储**，不存在可配置的本地网盘存储后端；宿主自己的 SQLite、包与缓存/临时目录不是网盘内容存储后端。

**仅限测试构建**：非 Linux 的自动化测试可以使用按本机架构编译的应用后端（例如 macOS 的 Mach-O），不做系统 UID/GID 隔离，跳过真实 ELF/Linux 目标校验，并用本地合成文件作为网盘内容。上述替身和豁免只能在测试构建中存在，不增加生产清单字段、可配置存储后端或发布开关，发布可执行文件与镜像不包含。生产仍要求 Linux 分架构静态包和第 12.4 节的硬隔离，真实隔离在 Linux 容器中验收；文件授权、游标、Range、上传和错误语义的自动化测试在 macOS 上照常运行，只使用临时数据，不读生产配置。

## 17. 契约库和生成类型的使用与门禁

宿主直接依赖 `contract/` 的 tgdrive-contract，关闭默认功能即可（当前默认本来为空）。运行时依赖只有 serde、serde_json 和用于稳定版本校验的 semver；`types` 可选功能才引入 ts-rs，宿主不需要它。库不带 HTTP 客户端、运行时、数据库、ZIP、ELF、SDK 或内容业务实现。

主要共享函数：parse_unique_json、parse_manifest/validate_manifest、parse_package_metadata、negotiate_contract、parse_catalog_for_host/validate_catalog/validate_catalog_transition、validate_archive_layout、validate_scope/effective_access、各查询校验、validate_json_request/validate_json_response、validate_json_page/json_page_prefix_count、validate_file_node_size、validate_cache_entry_header、valid_same_origin_path、validate_stream_directive、resolve_single_range/resolve_local_range。动态目录/安装/启动状态、真正的 SHA256/ZIP/ELF、安全文件打开、HTTP 头构建、本机地址的原子块计费/取消和持久化由宿主实现。

仓库根目录命令如下。

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test -p tgdrive-contract --locked --all-features
PATH="$HOME/.cargo/bin:$PATH" cargo clippy -p tgdrive-contract --locked --all-targets --all-features -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo fmt --all --check
fnm use 22.22.0
npm run contract:generate
npm run contract:check
```

contract:generate 只更新 `contract/types/contract.ts`。contract:check 先重算并逐字节检查生成结果，缺失/过期立即失败且不覆盖，再用独立 tsconfig 对生成类型和正/负符合性示例做严格 TypeScript 检查。生成器递归遍历类型依赖、检查所有公开 TS 派生类型都在注册表中，新增独立类型不能静默漏生成。错误码、限额、接口注册表和地址/头常量也从 Rust 导出。

这些命令不构建/修改旧应用源码、旧 SDK、根目录旧 catalog.json 或 apps/ 分发包。不把主仓库半成品、真实网盘数据或生产配置用于验证。
