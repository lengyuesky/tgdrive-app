# tgdrive 插件 SDK 规范

本文档说明官方插件 SDK（`sdk/tgdrive-sdk.js`）的协议规范、API 接口、生命周期握手及安全边界。

## 概述与引用方式

每个插件在打包为 `.tgapp` 时，打包工具（`package.mjs`）会自动在包根目录注入 `tgdrive-sdk.js`。插件入口 HTML 文件中只需使用相对路径引入：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>我的插件</title>
    <script defer src="./tgdrive-sdk.js"></script>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.js"></script>
  </body>
</html>
```

`tgdrive-sdk.js` 会在 `window` 对象上暴露 `window.tgdrive` 单例对象。

## 插件生命周期与握手

插件运行在宿主提供的受保护沙箱 `<iframe>` 中：
1. **通道建立**：宿主在加载插件页面后，通过 `window.postMessage` 向插件发送握手消息，并附带一条专用的 `MessagePort`。
2. **绘制就绪**：SDK 在收到握手通道后，会先等待宿主及自身的动画帧（`requestAnimationFrame`）绘制，确保沙箱页面元素准备就绪后再解除 `tgdrive.ready` 的等待，避免初始白屏闪烁。如果页面处于后台标签（`document.visibilityState === 'hidden'`），SDK 将立即就绪而不等待动画帧。
3. **上下文对象**：`await tgdrive.ready` 返回一个被冻结（`Object.freeze`）的就绪上下文：
   ```ts
   interface ReadyContext {
     id: string              // 插件 ID，例如 "books"
     name: string            // 插件名称，例如 "图书"
     version: string         // 插件版本，例如 "1.1.4"
     api_version: number     // 声明的 API 版本，当前为 2
     dark: boolean           // 宿主当前是否为深色模式
     capabilities?: string[] // 宿主支持的可选能力列表，探测方式见「能力探测」一节
   }
   ```
4. **清理与卸载**：当插件页面被关闭、切换或收到 `pagehide` 事件时，SDK 自动关闭 `MessagePort` 并拒绝未完成的异步调用。

## API 接口详情

所有对宿主的请求均基于 `MessagePort` 进行 RPC 通信，方法签名定义在 `sdk/types.ts` 中。

### 1. 文件操作 (`drive.files`)

需在 `manifest.permissions` 中声明 `files.read`。

- **目录列表**：
  ```ts
  const page = await tgdrive.files.list({ path: '/图书', limit: 200, cursor: null });
  // 返回 { entries: FileEntry[], has_more: boolean, next_cursor: string | null }
  ```
- **文件元数据**：
  ```ts
  const file = await tgdrive.files.stat({ id: 123 });
  // 或按路径查询：await tgdrive.files.stat({ path: '/视频/演示.mp4' });
  ```
- **带游标的分页搜索**：
  ```ts
  const searchResult = await tgdrive.files.searchPage({ q: '百年孤独', limit: 50, cursor: null });
  ```
- **分段读取 (Range Read)**：
  ```ts
  const file = await tgdrive.files.stat({ id: 123 });
  const bytes = await tgdrive.files.readRange(file, 0, 65536, { signal });
  // 返回 Uint8Array；file 同时携带稳定节点 ID 与 content_version
  ```
- **批量分段读取**（需宿主声明 `files.readRanges` 能力，用于消息通道的降级优化）：
  ```ts
  // 一次 RPC 拉回多段：1～8 段、每段 ≤1 MiB、总量 ≤4 MiB
  const blocks = await tgdrive.files.readRanges(file, [{ offset: 0, length: 4096 }, { offset: 9, length: 512 }], { signal });
  ```

- **批量信封**（需宿主声明 `rpc.batch` 能力）：一次往返执行最多 16 项服务端能力，逐项返回 `{ result }` 或
  `{ error }`（`error` 为 `Error`，带 `code` 与 HTTP `status`），一项失败不影响其余；权限与目录范围逐项检查，
  批量算一次请求计入页面限流。可批量：`app.ping`、`settings.get/patch`、`files.search/list/stat/searchPage`、
  `favorites.set`、`media.url`、`storage.get/set/list/delete`；`ui.*`、字节与资源读取、批量本身不可进入。
  ```ts
  if (tgdrive.can('rpc.batch')) {
    const [root, file] = await tgdrive.batch([
      { method: 'files.stat', params: { id: rootId } },
      { method: 'files.stat', params: { id: fileId } },
    ], { signal });
    if (file.error) throw file.error;
  }
  ```
  阅读馆的 `LibraryAccess` 在宿主支持时用它把"来源根 + 目标文件"的两轮核对合并为两次往返，旧宿主自动逐个 `stat`。

### 2. 媒体直链与缩略图 (`drive.media`)

需在 `manifest.permissions` 中声明 `media.read`。

- **获取媒体 URL**：
  ```ts
  // 支持按路径或按引用对象获取预览/缩略图地址
  const thumbnailUrl = await tgdrive.media.url('/电影.mp4', 'thumbnail');
  const previewUrl = await tgdrive.media.url({ id: 42, content_version: '...' }, 'preview');
  ```
  返回带有有效时限和签名凭证的 URL，可直接赋予 `<img>` 或 `<video>` 元素。

- **字节数据面票据**（需宿主声明 `media.bytes` 能力）：
  ```ts
  const grant = await tgdrive.media.bytes(file, { signal });
  // grant: { url: '/api/apps/media/…', expires_at: Unix 秒 }
  const response = await fetch(grant.url, {
    signal, credentials: 'omit', redirect: 'error',
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  // 必须校验 status === 206、Content-Range 与 Content-Length 与请求一致
  ```
  票据绑定单个文件与内容版本，可缓存复用；返回 `403` 表示票据过期或失效，
  应丢弃缓存重签一次重试。相比 `files.readRange`，数据不再经宿主页面二次缓冲，
  也不受消息通道的限流约束。共享的传输实现见 `reader/io.ts` 的 `createTransport`。

### 3. 插件私有存储 (`drive.storage`)

无需额外权限，各插件享有按当前用户和应用 ID 隔离的键值存储。

- **写入与 CAS 乐观锁**：
  ```ts
  // 第三个参数是预期修订号；首次创建传 null，更新传此前读到的 revision
  const previous = await tgdrive.storage.get('my-key');
  const { revision } = await tgdrive.storage.set('my-key', { foo: 'bar' }, previous?.revision ?? null);
  ```
- **读取**：
  ```ts
  const record = await tgdrive.storage.get('my-key');
  // 返回 { key, revision, updated_at, value } 或 null
  ```
- **按前缀列出**：
  ```ts
  const list = await tgdrive.storage.list({ prefix: 'progress:', limit: 100, cursor: null });
  ```
- **删除**：
  ```ts
  const previous = await tgdrive.storage.get('my-key');
  if (previous) await tgdrive.storage.delete('my-key', previous.revision);
  ```

### 4. 插件配置项 (`drive.settings`)

读取用户在宿主应用管理中为该插件填写的设置（对应 `app.json` 中的 `settings` 定义）。

```ts
const settings = await tgdrive.settings.get();
console.log('用户配置的取材目录：', settings.source_dir);
```

### 5. 沉浸模式控制 (`drive.ui`)

当 `context.capabilities` 包含 `ui.setImmersive` 时可用（如图书和短视频应用）。

```ts
// 进入沉浸模式（隐藏宿主顶栏/导航栏），可选传递背景颜色
await tgdrive.ui.setImmersive(true, { background: '#f4ebd6' });

// 退出沉浸模式
await tgdrive.ui.setImmersive(false);
```

### 6. 事件监听 (`drive.on`)

监听宿主推送的状态变化。事件只携带标识不携带内容，插件应自行按需重拉。

```ts
// 深色模式切换（本地即时转发）
const unbindTheme = tgdrive.on('theme.changed', ({ dark }) => {
  document.documentElement.classList.toggle('dark', dark);
});

// 另一设备写入本应用私有数据（需 storage.events 能力，事件值 { key }）
const unbindStorage = tgdrive.on('storage.changed', ({ key }) => {
  if (key.startsWith('progress:')) void reloadProgress(key);
});

// 文件树变更（需 storage.events 能力）：上传、改名、复制、删除、恢复、Bot 收件等通知。
// 新宿主附带 { paths }（发生变化的目录列表，规范化绝对路径），并已按应用目录范围过滤且服务端合并去抖；
// 旧宿主或范围未知时参数为 undefined，应整体重扫。图书/漫画（filesChangeAffectsSources）与影视
// （filesChangeAffectsLibraries）再按自己的来源目录过滤，无关目录的变化不触发重扫。
const unbindFiles = tgdrive.on('files.changed', (value) => {
  const paths = value?.paths; // string[] | undefined
  if (paths && !paths.some((path) => path === '/' || path.startsWith('/书'))) return;
  void refreshLists();
});

// 用户在宿主端修改了目录范围：越界访问将从下一次请求起被拒绝
tgdrive.on('scope.changed', () => void refreshLists());

// SSE 断线重连后的提示：断档期间可能错过事件，应全量校对一次
tgdrive.on('sync.hint', () => void refreshLists());
// 页面卸载时取消监听：unbindTheme();
```

### 7. 能力探测 (`drive.can`)

宿主按自身支持的能力在就绪上下文里声明 `capabilities`，插件用 `tgdrive.can(name)` 探测，
未声明的功能必须降级到消息通道或忽略。当前定义：

| 能力名 | 含义 |
|---|---|
| `media.bytes` | 字节数据面票据可用（`media.bytes` RPC + 票据 URL 直连 Range 读取） |
| `files.readRanges` | `files.readRanges` 批量段读可用 |
| `storage.events` | `storage.changed` / `settings.changed` / `scope.changed` / `files.changed` / `sync.hint` 事件可用 |
| `files.scope` | 宿主支持按应用配置目录范围 |
| `rpc.batch` | `batch(calls)` 批量信封可用 |
| `ui.setImmersive` / `ui.immersiveBackground` | 沉浸模式 |

```ts
const transport = tgdrive.can('media.bytes') ? new ByteTicketTransport(tgdrive) : new MessageChannelTransport(tgdrive);
```

## 安全设计原则

1. **同源隔离与沙箱约束**：插件在沙箱内运行，无法访问宿主页面的 Cookies、Local Storage 或 DOM 结构。CSP 允许插件向同源发起 `fetch`，但宿主接口需要登录凭据（沙箱源不携带 Cookie），唯一可用通道仍是宿主签发的单文件票据。
2. **最小权限原则**：插件必须在 `app.json` 中显式声明所需权限（如 `files.read`、`media.read`），未声明的接口调用将被宿主网关直接拦截。用户可在宿主端为每个应用配置「目录范围」，把文件访问收窄到指定目录子树；范围立即生效，不打断运行中的页面。
3. **票据即能力**：媒体票据只授权单个文件、单一用途并绑定内容版本；文件被覆盖后旧票据立即失效。
4. **取消与资源释放**：支持标准 `AbortSignal`。当页面发起分段网络读取但在完成前销毁时，SDK 会向宿主发送取消控制帧，确保服务端立即关闭传输句柄。
