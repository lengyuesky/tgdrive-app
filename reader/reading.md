# 阅读器接口与页面接入

本说明对应 `state.ts`、`view.ts`、`flow.ts` 与 `formats/{text,epub,pdf,comic}.ts`。线上文件与读取依赖 `@tgdrive/page-sdk` 的 `HostClient`，共用界面依赖 `@tgdrive/ui`，不引用其他应用源码。阅读器不直接保存业务进度、偏好或已读状态，保存由应用外壳与 `reader/library/` 负责。

## 分格式偏好

`Preferences` 是 `ViewContext.prefs` 和 `view.configure()` 的平面视图配置；`preferences(raw)` 只负责此配置的规范化，不用于解析持久记录。

`PreferenceStore(host, readerDefaultPreferences)` 使用 KV 条件写入：

- `load(signal?)` 返回 `PreferencesSnapshot={value,revision}`；`value` 是 `{schemaVersion:2,text,comic,pdf}`，未知版本/字段或读取失败拒绝，不映射旧 flat/V1，也不迁移旧默认值。
- `saveFormat(base, format, patch, signal?)` 用表单基线 CAS，局部合并该格式，保留其他格式。
- `loadWork(workId)` 读取 `preferences:work:<主作品ID>`，缺键使用 `{schemaVersion:2,overrides:{}}`；`saveWork` 保存稀疏覆盖，`clearWork` 清除目标格式覆盖，不删除其他覆盖或进度。
- `resolvePreferences(global, format, work?)` 得到平面配置，作品覆盖优先；TXT/EPUB 对应 text，CBZ/ZIP/图片目录对应 comic，PDF 对应 pdf。
- 首次默认文字分页、漫画单页适宽、PDF 适页；读取失败不能拿默认值构造可写基线。

`PreferenceSaveError` 提供 key/draft/cause/code。冲突和未确认保存都保留草稿，重读后只重试用户确认的局部修改，不能无条件覆盖整个旧草稿。

| 控件 | 约束 |
|---|---|
| 主题 | system/light/sepia/dark；界面通道的主题通知更新跟随模式与沉浸背景。 |
| 字体 | serif/sans/system，本地字体栈，不请求外部字体。 |
| 字号/行距/边距 | 12～36、1.2～2.8、0～64px。 |
| 文字模式 | scroll/page，位置保持 UTF-16 字符锚点，不存排版页号。 |
| 漫画模式 | scroll/single/double；竖屏临时回单页，不覆盖双页偏好。 |
| 适宽/整页、缩放 | width/page；0.5、0.75、1、1.25、1.5、2、3。 |
| 方向与配对 | ltr/rtl、coverAlone、spreadOffset 0/1，物理图片页号不改变。 |
| TXT 编码 | utf-8/utf-16le/utf-16be/gb18030，随 Location.encoding 保存。 |

## 导航、搜索与末端

`ReaderView` 以 `capabilities` 表达可用控件。没有 `atEnd` 或全书百分比就不猜测它们。

- `NavigationItem={label,location,depth?}` 的行号不是正文位置；选中后调用 restore/go。
- TXT 长章技术分段保持原字符偏移；EPUB nav/NCX 保持层级，同 XHTML 的多个锚点共享 spine 内容单元；PDF 目录 depth 独立于标题文本。
- 详情只按需建立独立实例、空 viewport 和页面级 signal，调用 loadNavigation，finally destroy；不调用隐藏 open，不访问 protected 方法。
- 正文搜索返回真实语义位置，跳转与高亮不修改原正文。外壳串行 configure/turn/go/restore/setEncoding，EPUB 内部链接走同一导航队列。
- `navigationState().atEnd === true` 仅显示“读完”或“读完并下一卷”。局部轨道底部、末张长图顶部、未解码或未完成加载都不是末端。只有点击后调用 markRead；下一卷必须顺序明确、仍在来源内，不循环或跳过缺失卷。

## 漫画的物理页与滚动

封面独立、offset 0 的序列为 `[0] [1,2] [3,4]…`，offset 1 为 `[0] [1] [2,3]…`；不独立时分别为 `[0,1] [2,3]…` 和 `[0] [1,2]…`。候选两页有宽图、未知尺寸或合计解码成本超过预算时暂按单页，不改变后续奇偶和物理位置。降级通过 layoutNotice 提示，不写回偏好。

`turn(1)` 始终是逻辑下一页/组，RTL 的物理输入只由外壳反转一次。current.index/entry/ratio 不因配对、旋转或 RTL 改为组号。

连续阅读保留五页挂载、四十一页局部轨道和有界预读。头部探测跟随阅读中心：图片目录只读小 Range；归档只解压条目头部并共享分块，不为远页下载新块。已知尺寸与字节比例参与估高，但估高更新不能自行选择新页。

尺寸变化锚定当前物理页及页内像素偏移。触摸和惯性期间，上方布局变化先吸收进占位/滚动债，不回写捕获时的旧 scrollTop；停止后一次结清。删除旧节点或修改尺寸前先保护滚动范围，避免浏览器先截断坐标。显式跳页、恢复和旋转仍保留语义位置。

图片章节完整分页时核对 children_revision，重复游标拒绝、节点按 ID 去重。超过 10000 页明确失败，请按章节拆分，不静默截断。

## 资源、缩略图与生命周期

- RangeFile 是解析缓存，不是传输队列；每块最多 1 MiB、热点最多 32 块。同块读取共享，取消一个等待者不取消其他读者，销毁取消底层请求。HTTP 排队、重试/退避与续签由 SDK 承担。
- TXT 64 MiB，EPUB/PDF 512 MiB，漫画归档 2 GiB；条目解压、结构、CRC、路径、图片格式与 3200 万像素有独立上限。
- 漫画独立缩略图最多两任务，只借已完成缓存，未命中独立读取，不移动预读中心、挤正文缓存或改 DOM/位置。PDF 缩略图独立文档，共用一并发预览预算。
- 缩略图最大 320px，返回幂等 release；取消、离开面板、换书和销毁释放 URL、画布、归档、文档与在途读取。迟到编码回调不创建新 URL。
- PDF 只用同版 legacy 主模块与 worker，随包 cMaps/标准字体，不开外网、脚本/XFA或无界画布；正文单画布另有像素与字节预算。
- ReaderChrome 通过 `tgdrive.ui.v1` 管理沉浸，菜单、面板、焦点、Escape 与手势不改变正文尺寸；不叠加宿主安全区。进度先条件保存，再更新应用历史；历史写失败不重放已经确认的进度。

## 验证边界

阅读几何、物理页、长条漫迟到尺寸、取消、正文搜索、格式与条件保存继续由回归测试覆盖。真实浏览器沙箱、实体手机、CSP、PDF 资源加载和宿主 Range 属于独立联调；当前测试不代表真实宿主端到端验收。构建只在仓库外新目录输出并用新工具校验，旧发布基线保持不动。
