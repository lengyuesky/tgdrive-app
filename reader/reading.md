# 阅读器接口与阅读馆接入

本说明对应 `state.ts`、`view.ts`、`flow.ts`、`books/text.ts`、`books/epub.ts`、`books/pdf.ts`、`comics/comic.ts`。数据来源、作品身份及已读状态仍由 `reader/library` 管理。阅读器本身不写阅读进度、偏好或已读状态。

## 偏好：持久记录与视图配置分开

`Preferences` 是传给 `ViewContext.prefs` / `view.configure(prefs)` 的平面配置。旧字面量中的 `theme/fontSize/lineHeight/width/mode/direction/zoom` 仍可直接编译；新增字段可选。`preferences(raw)` 只规范化这种平面配置，**不能拿它解析或覆盖持久化 V2 记录**。

持久化使用 `PreferenceStore(drive)`：

| 方法或类型 | 契约 |
| --- | --- |
| `load(signal?)` → `PreferencesSnapshot` | 读取 `preferences`；返回 `value/revision/migrated`。旧无版本 flat 或明确 V1 只在内存映射，不自动写回。 |
| `PreferencesV2` | `{ schemaVersion: 2, text, comic, pdf }`。不能直接传给阅读视图。 |
| `saveFormat(base, format, patch, signal?)` | 用表单打开时的 `base.revision` CAS，合并该格式的局部字段；其他格式保留。返回新快照。 |
| `loadWork(workId, signal?)` → `WorkPreferencesSnapshot` | 读取 `preferences:work:<主WorkId>`；返回 `workId/value/revision`。不存在时使用空覆盖。 |
| `saveWork(base, format, patch, signal?)` | 逐记录 CAS，保存稀疏作品覆盖，不复制无关默认字段。 |
| `clearWork(base, format, signal?)` | 清除此作品的一个格式覆盖；保留其他覆盖、原记录及所有进度/书签。 |
| `resolvePreferences(global.value, format, work?.value)` | 合成并校验当前格式的平面 `Preferences`。作品局部覆盖优先，未覆盖字段跟随最新格式默认。 |
| `preferenceFormat(locationFormat)` | `txt/epub → text`，`comic → comic`，`pdf → pdf`。索引的 `cbz/zip/images` 应先归为 `comic`，不是直接传入此方法。 |
| `defaultPreferences()` | 返回独立的 V2 默认对象；不能在存储读取失败后把它当成可写基线。 |

`WorkPreferencesV2` 的结构为 `{ schemaVersion: 2, overrides: { text?: Partial<TextPreferences>, comic?: Partial<ComicPreferences>, pdf?: Partial<PdfPreferences> } }`。进入旧作品路由时先使用数据层 `resolveWork()` 得到主 Work，再读取覆盖；偏好不做别名 OR 合并。拆分首组保留主 ID 及覆盖，新 ID 使用默认，各卷进度和书签不变。

未知 schema、未知字段、非法 V2 值或读取失败直接报错，不清空原记录。保存不会自动重读重试 CAS。`PreferenceSaveError` 提供 `key/draft/cause/code`：

- `code === 'storage_conflict'`：显示冲突，保留表单草稿，允许重读并采用远端或经用户确认后重试改动字段。
- `code === 'preferences_not_saved'`：保存未确认。配额、断网及提交附近取消都不能冒充已同步；重读确认后再保存。
- 载入解析错误带 `code: 'unknown_preferences'`。取消前尚未提交的调用可以直接抛 `AbortError`。

不要将整个旧草稿无条件覆盖到新修订；重试时将用户确认的局部 `patch` 合到重新读取的基线上。

### 控件到字段的映射

所有设置先形成待保存的对应格式 `patch`，经 `resolvePreferences()` 得到平面配置，再串行 `await view.configure(prefs)`。保存与应用失败都应可见，不自动假定成功。

| 控件 | 格式字段 / 值 | 视图能力 |
| --- | --- | --- |
| 主题 | 三种格式各自 `theme: system/light/sepia/dark` | 主题由外壳应用到页面；`ReaderChrome.themeChanged()` 同步已授权宿主背景。 |
| 字体 | text `font: serif/sans/system` | `capabilities.fonts`；`localFonts` 只含本地字体栈，不请求字体网络资源。 |
| 字号 / 行距 | text `fontSize: 12..36`、`lineHeight: 1.2..2.8` | `fontSize/lineHeight`。 |
| 边距 | text `margin: 0..64` 像素，默认 12 | `margin`；正文左右各一份，不叠加原 article 边距。 |
| 正文宽度 | text `width: 360..1400`，默认 760 | `width`；沿用沉浸模式填满可用宽度，手机可隐藏该桌面控件。 |
| 文字模式 | text `mode: scroll/page` | `modes`。字符锚点不改成排版页号。 |
| 漫画模式 | comic `mode: scroll/single/double` | `modes`；旧平面 `mode: page` 仍按 `single` 读取。 |
| 适合宽度 / 整页 | comic/pdf `fit: width/page` | `fits`；与 `zoom` 相乘，不修改持久物理页号。 |
| 缩放 | comic/pdf `zoom: 0.5..3` | `zoomLevels`：`0.5, 0.75, 1, 1.25, 1.5, 2, 3`。 |
| 平移 | `view.pan?.(dx, dy)`，增量单位为 CSS 像素；也可原生滚动 | `pan`；不实现自定义捏合。 |
| 阅读方向 | comic `direction: ltr/rtl` | `direction`；仅左右呈现及物理输入方向反转。 |
| 封面独立 | comic `coverAlone: boolean`，默认 true | `spreads`。 |
| 双页配对偏移 | comic `spreadOffset: 0/1`，默认 0 | `spreads`。 |
| 应用范围 / 恢复默认 | 格式默认用 `saveFormat`；仅本作用 `saveWork`；取消覆盖用 `clearWork` | 切换范围不会删除进度或书签。 |
| TXT 编码 | `TextReader.setEncoding(utf-8/utf-16le/utf-16be/gb18030)` | 编码随 `Location.encoding` 保存，不是跨作品偏好字段。 |

旧 flat/V1 的主题映射到三个格式；字号、行距、宽度保留给 text；方向保留给 comic；zoom 保留给 comic/pdf；旧 `page` 对应文字 `page`、漫画 `single`。未指定 fit 的旧 PDF 始终按适宽，旧漫画 page 按适页。没有旧设置时仍默认 scroll，不探测设备指纹。

## 导航与独立详情目录

`ReaderView` 新能力都是可选的，旧 mock 和实现无需补字段。先看 `view.capabilities` 再显示格式专属控件；缺少能力或 `navigationState().atEnd` 不能通过猜测补成支持/已完成。

- `NavigationItem` 为 `{ label, location, depth? }`，旧无 `depth` 的项按 0 展示。
- 普通章节、书签、缩略图选中后调用 `restore(item.location)` 或 `go(physicalIndex)`；不要把目录行号当正文 `index`。
- TXT 长章只有一份原文，技术分段是章下 `depth: 1` 的导航项，语义 `offset` 仍是原文 UTF-16 偏移。
- EPUB nav/NCX 保留层级，同 XHTML 的多个锚点共用同一 spine 内容单元。非链接 `span` 父标题以首个有效 spine 后代的 `Location` 为组入口；有自己有效链接的父项不被替换，空组及外部/越界目标不伪造入口。**展开箭头只折叠/展开，点击父标题才跳到组入口。**
- PDF 目录 `depth` 独立于纯文本标题，不再把缩进空格写进标题。

详情只在用户打开目录时建立独立视图实例，传入页面级 `ViewContext.signal` 以及空的独立 viewport，调用可选的 `loadNavigation()`，在 `finally` 中 `destroy()`。**不要调用隐藏的 `open()`，也不要访问 protected 方法。**

`TextReader/EpubReader/PdfReader.loadNavigation(): Promise<NavigationItem[]>` 使用 prepare-once：

1. 重复调用不会累积目录或重复准备。
2. 不挂载正文、不触发 `changed`，不读写进度。TXT 可能完整解码，仍受 64 MiB/10000 窗口边界；EPUB 只提取必要清单、nav/NCX 和安全检查结构；PDF 不调用 `getPage/render`。
3. 取消和准备失败释放范围读取、归档或文档；调用方仍须 `finally destroy()`。
4. 用户选定某个 `Location` 后，重新核验来源/内容版本，再以正常阅读实例 `open(location)`；不用已销毁的详情实例继续阅读。

正式阅读的来源校验、旧位置版本核对、扫描暂停/恢复由 `ReadingLibrary.openUnit()`、`reading.load()`、`pause()/resume()` 负责。外壳应串行执行 `configure/turn/go/restore/setEncoding`，内部 EPUB 链接通过 `ViewContext.navigate` 进入同一导航队列。

## 漫画的固定配对与物理位置

默认封面单独时，offset 0 的序列是 `[0] [1,2] [3,4]…`；offset 1 是 `[0] [1] [2,3]…`。关闭封面独立后，offset 0 为 `[0,1] [2,3]…`，offset 1 为 `[0] [1,2]…`。末尾不足一对时单独显示。

只检查当前候选两页的已验证图片头部，不预扫全章：

- 任一页 `width > height` 时，该候选对两页各占一次翻页，不改变后续奇偶，不漏掉宽图邻页。
- 当前两页合计解码成本超过 `PictureWindow` 的 128 MiB 总预算时，按相同固定配对规则暂分为单页。预算和 `width * height * 4` 公式由 `PICTURE_COST_LIMIT/pictureCost` 共用，不放宽单图 3200 万像素限制。
- 内存降级只通过可选 `navigationState().layoutNotice` 给出非阻断提示；不循环弹错误、不保存该提示。换到可配对页、scroll/single 或竖屏回退后会清除旧提示。
- double 仅在横向视口生效；竖向临时回到 single，保留 double 偏好。转向不等待旧候选的慢尺寸，也不让迟到结果改回旧物理目标。
- `current().index/entry/ratio` 不改成双页组号，不因 offset、转向或 RTL 被重置成组内第一页。`visiblePages` 返回当前组的物理页号；`effectiveMode` 是当前布局模式，单独封面/宽图/预算降级组仍可处于 double 布局策略，具体显示页数看 `visiblePages`。
- `turn(1)` 永远是逻辑下一页/组，`turn(-1)` 是上一页/组。RTL 的左右箭头、边缘点按、横滑由外壳将物理方向取反一次；“上一页/下一页”语义按钮不反转。不得在外壳和阅读器两处重复反转。

scroll 的五页挂载窗口、四十一页局部轨道、惯性滚动不重写相同 scrollTop、未知尺寸锚点及相邻长短图补偿继续使用原算法。

## 缩略图与资源生命周期

`thumbnail?(physicalIndex, signal): Promise<ReaderThumbnail>` 返回 `{ url, width, height, release() }`，宽高最多 320。只对目录/缩略图面板中可见项请求；离开视口、关闭面板或换书时取消，已返回资源必须释放。`release()` 幂等；取消调用信号或销毁视图也会释放 URL。

- 漫画缩略图最多两个任务；借用已完成字节缓存，未命中使用 `ComicPreloader.readIndependent()` 独立读取。不会移动预读中心、挤掉正文缓存或修改位置/正文 DOM。
- PDF 缩略图使用独立文档并共用全局单 PDF 预览队列，不与正文共享页面清理或渲染取消。结束归零画布并释放页面/文档，缩略图 URL 留到调用方释放。
- 编码期间取消立即拒绝，迟到的 `toBlob` 回调不再创建 URL。图片格式、像素、Archive、Range 1 MiB/全局三并发边界不放宽。
- PDF 正文只复用 `reader/library/pdf-document.ts` 的 legacy 主模块及同版 worker，不再引入现代 PDF.js 主入口。正文单画布最多 16 MiB、每边最多 16384 像素；失败的新页不会替换旧位置或旧画布。

## 真实末端不等于已读

`navigationState().atEnd === true` 仅供显示显式“读完”或“读完并下一卷”按钮：文字需在最后内容单元末列/正文底部（不含人工留白），漫画需到最后物理图片底部且可见页已解码，PDF 需最后页底部可见。局部漫画轨道底部、末章/末张长图顶部、未完成加载或已销毁视图都不能算末端。

点击后才调用数据层 `reading.markRead()`。需要下一卷时再调用 `nextWorkUnit()`，并尊重明确正篇顺序与当前来源范围；没有下一卷不循环、不强制跳卷、不把番外混入。正文 `changed` 回调及 `atEnd` 更新都不能自动标已读。文字“本节页数”不应伪造成全书百分比。

## 外壳与样式

集成入口在原 `style.css` **之后**引入 `reading.css`。该文件仅补阅读器单双页原生平移、整页尺寸和步进按钮至少 44px 的触控面积，不改书库样式、不重复增加宿主安全区。

`ReaderChrome` 的 `enter/opened/leave`、`togglePanel/closePanel`、焦点圈定、Escape 及宿主 capability 降级继续沿用。手机中央轻点唤出菜单；不要在正文上覆盖新的点击层。设置 `ReadingGestures.paged()` 时排除 scroll、面板及需要原生横向平移的状态；已有选区、长按、多指、链接、纵向滚动或实际发生的横向平移不能顺带翻页。

当前阶段没有接入 `reader/app.ts` 的新版控件/偏好路径；该外壳仍是旧读写方式。UI 集成必须一起替换旧 flat 存储路径并引入增量样式，不能一边写 V2 一边继续旧 `savePreference()`。

浏览器几何、真机、宿主兼容及正式包许可/构建是独立门禁。中间构建遵循最新实施契约，在新建且复制公开基线的隔离草稿目录正常校验；根 catalog/apps/SHA256SUMS 留到全流程审查后由父侧生成，不绕过同版本校验。
