# 宿主平台集成

本版官方应用需要宿主 0.3.0、API v2。宿主先更新，再在应用中心更新插件。原 v1/v2 第三方插件继续由宿主兼容。

## 文件入口与授权

清单 `integration.file_types` 声明小写文件扩展名，`directories` 表示支持图片目录。宿主文件页“打开方式”按这些字段列出应用，并在 `await drive.ready` 的 `launch.file` 中提供已核验文件身份。读取时仍需按 `id` 和 `content_version` 校验。

图书、漫画、影视从文件打开时把所属目录加入内容来源，短视频从所在目录构建播放队列。新安装默认未授权，宿主会先让用户选择目录。应用内用 `drive.ui.authorizeDirectory()` 选择并授权新来源；原 `pickDirectory()` 只选择既有授权范围内的目录。授权范围与媒体库来源是两个概念。

文件定位与详情使用 `drive.ui.showFile(ref)`、`drive.ui.fileDetails(ref)`。宿主负责权限校验和界面展示；应用不能传入任意站点 URL。

## 页面和生命周期

新增接口通过 `drive.can()` 检测，类型定义以 `sdk/types.ts` 为准：

| 接口 | 用途 |
| --- | --- |
| `ui.setTitle(title)` | 更新宿主应用标题 |
| `ui.setExitMessage(message)` | 需要提醒时设置离开提示；清空字符串撤销提示 |
| `ui.task({id,title,completed,total?,state})` | 报告真实任务进度；state 为 running/done/cancelled/failed |
| `on('task.cancel', callback)` | 用户请求取消；应用必须终止实际任务再报告结果 |
| `lifecycle.migrate(version, callback)` | 在独占租约中执行幂等数据迁移；回调收到 AbortSignal |
| `lifecycle.report('ready'|'failed', message?)` | 记录最近就绪或失败状态 |

迁移版本来自 `integration.data_schema`。失败不提升版本，重新打开可重试；不要将读取失败当成空库覆盖。迁移租约为 60 秒、SDK 每 20 秒续租；回调需响应取消。迁移中的多键写入不是原子事务。

宿主每次升级保存一个旧包及私有数据快照，显式恢复会覆盖更新后的应用数据并轮换运行凭据，当前授权不会扩大。应用私有数据继续随宿主数据库备份；封面可再生缓存不参与备份。

宿主合并文件事件并尝试补齐断线期间的变化；`sync.hint` 可包含 `filesRecovered`。该标志只表示文件变化已补齐，应用仍需重新核对来源、设置和阅读状态；宿主重启或变更窗口过期会回退为完整刷新。

## 详情与素材

`integration` 同时声明支持格式、使用限制、更新说明、维护链接和包内截图。截图是使用合成测试内容运行真实应用后截取，不包含私人文件。每张最多 512 KiB。运行 `TGDRIVE_CAPTURE_SCREENSHOTS=1 npm run test:e2e -- tests/browser/platform-integration.spec.ts` 可在获授权的本机集成环境重新生成截图。

## 开发工具

```bash
npm run create -- sample-viewer /path/to/new-directory
npm run dev:host -- /path/to/new-directory
npm run package -- /path/to/new-directory /path/to/output
npm run test:dev-host
```

脚手架拒绝覆盖已有目录。模拟宿主默认地址 `http://127.0.0.1:4190`，可用 `TGDRIVE_DEV_PORT` 修改端口。只读取指定应用目录，测试文件由浏览器选择，状态仅保存在页面内存；刷新页面清空数据。它覆盖开发常用的文件、目录选择、私有数据 CAS、主题和任务接口，不模拟生产性能、Telegram、数据库备份或真实安全授权。正式发布仍需宿主集成验收。
