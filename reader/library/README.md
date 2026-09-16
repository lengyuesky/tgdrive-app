# 阅读馆数据层 API 说明

公共入口为 `reader/library/index.ts`。本目录提供来源、轻索引、逻辑作品、阅读状态、历史、元数据和封面服务，供阅读馆书库界面（首页/书库/详情/我的）与阅读器外壳复用。

## 推荐调用顺序

应用持有一个 `ReadingLibrary(drive, 'books' | 'comics', callbacks)`，不要为每张卡片建立实例。

1. `await library.initialize(signal)`：校验或迁移来源，加载人工作品和轻索引缓存，不主动枚举文件、不提取正文或封面。检查 `snapshot.migration`、`issues`、`complete`。初始化失败时不可用空配置继续保存。
2. 无来源时展示来源管理。`addSource(path, { base, confirmedRoot, signal })` 保存成功后立即启动扫描，返回 `{ sources, scan }`；必须处理 `scan` 的成功或失败。`base` 是打开表单时的来源快照，避免覆盖其他设备的修改。根目录必须有显式确认。
3. 启动缓存优先；需要发现新增文件时调用 `refresh(signal)`。来源移除用 `removeSource(nodeId, base, signal)`，不会删除作品、进度、书签或标志。旧 `source_dir` 只作迁移入口，原设置不改写；根目录旧值返回 `confirm-root`，不会自动授权。
4. `await library.loadReadingState(signal, onProgress)` 批量读取当前索引对应的进度、显式阅读状态和标志，再将结果传入 `query(query, state.readings, state.flags)`。不要把读取失败或尚未加载的空 Map 当成“全库未读”。此接口按 200 条遍历用户状态，不为每个单元重复执行文件 stat。
5. 卡片进入视口才请求封面。详情请求 `library.getMetadata(unit, signal)`；该方法更新名称信息，并串行发布必要的自动归组变化。应用不要绕过它直接用 `library.metadata.get()`，否则只有提取结果，没有作品归组更新。
6. 进入阅读前 `library.pause()`；先 `openUnit(nodeId, signal)` 重新取得范围内的当前文件，再 `reading.load(file, signal)`。继续阅读只能使用该次返回的 `reading.location`，不能直接恢复缓存列表里的旧位置。打开新版本时旧位置不会返回。
7. 返回书库再 `resume()`；退出应用 `destroy()`。取消整个扫描后，恢复应调用新的 `refresh()`，而非等待已经结束的任务。

### 生命周期与进度

- `changed(snapshot)` 返回可独立持有的快照；`progress(progress)` 按扫描批次给出 `phase / nodes / directories / units / issues`，不是正文阅读进度。
- `cacheStatus(kind, status)` 提供 `thumbnail | metadata` 的字节数、条目数及 `persistent | session` 状态。
- `bindLibraryLifecycle(library)` 在页面隐藏时暂停、`pagehide` 时销毁，返回解绑函数。它**不会自动在可见时恢复**，避免用户仍在阅读时重启库任务；界面需结合当前页面调用 `resume()`。
- 为详情、封面和历史迁移另持有页面级 `AbortController`，离开该页面时中止。想暂停后继续的扫描应使用应用级信号；中止扫描信号意味着取消，而不是暂停。
- `history.cancel()` 停止旧任务发布结果；需要立即中止 SDK 请求并保留已遍历的迁移断点时，中止传给 `migrate()` 的信号。
- `isLibraryAbort(error)` 可识别正常取消和旧来源代次。`library_paused` 表示调用方在暂停期间又发起了提取，不应反复重试。

## 查询、范围与公共类型

| 入口 | 用途与约束 |
| --- | --- |
| `ReadingUnit` | `nodeId / file / format / sourceIds / firstIndexedAt`。目录单元仅表示含直属图片的目录，不保存全库页图列表。 |
| `Work` / `WorksSnapshot` | 持久作品 ID、主篇/番外成员、成员顺序、人工覆盖和别名。图书始终一文件一作品。 |
| `LibrarySnapshot` | 来源、迁移状态、可见单元、完整作品快照、完整性及错误。作品快照保留隐藏项与别名；展示应使用 `query()`。 |
| `LibraryQuery` / `queryLibrary()` | 名称/作者搜索；格式、来源、阅读状态、想读、收藏筛选；名称、首次加入、最近阅读排序；作品/文件视图与分页。简介不参与搜索。 |
| `LibraryAccess.roots(signal)` | 获取来源当前路径、目录信息和不可用原因。配置里的路径只是展示缓存，不能代替节点身份。 |
| `LibraryAccess.list(id, cursor, signal)` | 按 SDK 游标查找直属节点，单批不超过 200；即使轻索引达到上限，文件视图仍可分页查找。 |
| `LibraryAccess.search(id, params, signal)` | 在一个已验证来源目录内使用 SDK 分页搜索；不提供正文搜索。 |
| `LibraryScanner.start(options)` | 底层按批服务；返回 `{ result, pause, resume, cancel }`，支持 `onBatch / onProgress / previous / firstIndexedAt`。 |

每个应用最多 16 来源、2000 个阅读单元、10000 个目录。父子来源允许并按节点去重。来源不可用、分页失败、达到上限或取消都会产生不完整结果；只有完整扫描才能核对消失项。不完整结果保留旧索引，查询返回“仅已整理范围”。`complete` 指最后一次成功整理时的范围与来源版本，不是实时文件系统事务快照。

文件操作经过异步前后身份、版本和来源范围复核。来源移动按 ID 继续，删除后同路径的新节点不会接管旧来源。SDK 返回越界节点会报错，而不是悄悄过滤成“成功的空库”。进入阅读和详情仍须使用当前节点，不可把持久路径当授权。

## 自动归组、手工整理和身份

- 仅严格一致的规范化系列名、明确卷话号、无重复号/语言版本冲突时自动归组。支持第 N 卷/话/章、Vol/v、Ch/c 和常见中文数字。裸数字、模糊名称、无法解释的附加标记不猜测；番外独立。
- `001.zip / 002.zip` 初次扫描可成为未确认单项；按需得到同系列的有效 ComicInfo 编号后，会合并已有 `single / automatic` 作品，而不是永久锁死首次扫描的结果。
- 自动合并保留最早已有主作品 ID，其他 ID 保留为 `redirectTo` 别名；旧标志记录不删除。手工分组/排序的 `manual` 不自动合并。多个独立作品中存在人工元数据修正时，不自动吞并这些修正。
- 后得到的内嵌信息若推翻已有归组，立即取消错误连读置信；完整而一致的内嵌编号可重新分类并确认自动顺序。缺失信息不当成已确认。
- `resolveWork(works, oldId)` 将旧详情路由或标志引用解析为当前主作品，检查悬空/循环。解析后还需确认作品有当前范围内的可见成员。
- `nextWorkUnit(work, nodeId, availableIds)` 只返回顺序明确的后续正篇；不会循环、自动跳过缺失的下一项或把番外混入。界面必须由显式按钮调用，而非自动导航。

手工编辑使用 `mergeWorks / splitWork / reorderWork / editWorkMetadata` 产生新 `rows`，再 `publishWorks({ ...base, rows }, signal)`。`base.revision` 必须来自打开编辑器时的快照；保存会停止旧扫描，必要时由界面重新刷新。元数据编辑参数是**完整的人工覆盖对象**；局部修改应先展开 `work.overrides`，不要意外删除其他已编辑字段。

`SnapshotPublishError.draft` 保留失败草稿；底层分片全部写好后才 CAS 发布指针。失败不发布残缺人工快照、不清除原人工数据。发生冲突时读取 `works.load(signal)`，让用户基于新版本确认后重试，不自动强制覆盖。

### 已批准的拆分规则

**拆分不是恢复历史合并。** 第一组保留主 Work ID，其余组分配新 ID；旧合并别名、作品级收藏/想读及后续作品偏好跟随第一组。其他新组的标志/偏好使用新 ID 的默认值。各卷仍使用原 `fileId`，所以阅读进度和书签不变。

界面必须让用户选择哪组放在第一组，并在确认处说明：

> 第一组保留原作品标记，其余为新作品；各卷阅读进度和书签均保留。

拆分后的组为 `manual`，不会在下次读取 ComicInfo 或刷新时又被自动合并；确认顺序用 `reorderWork()`。

## 阅读状态、标志和历史

- `reading.load(file, signal)` 返回旧 `progress`、显式状态的 CAS 基线及可恢复的 `UnitReading`。兼容原 `file / title / location`，不迁移书签。
- `reading.saveProgress(progress, revision, signal)` 保存原 `progress:${fileId}`，可附 `summary`。历史索引失败时返回 `historyWarning`，不能把已成功的进度误报为未保存。
- `summary.percent` 只由确知整本比例的阅读实现提供。旧记录无摘要时不伪造百分比；多成员作品不平均各卷百分比冒充整部比例。
- `reading.markRead(file, stateBase, signal)` 才显式已读，不因翻到末页自动调用。`restart(file, stateBase, format, confirmed, signal)` 要求确认，返回起点位置；阅读器成功打开并保存后才覆盖旧 progress，失败仍保留旧位置和所有书签。
- 想读、收藏独立于未读/在读/已读。单个记录可用 `flags(workId)`、`setFlags(workId, base, patch, signal)`；合并作品的界面切换必须用 `setWorkFlags(work, works, flagSnapshots, patch, signal)`，其中基线来自 `loadReadingState()`。
- `aggregateFlags()` 沿别名 OR 汇总。显式关闭标志会对相关记录逐项 CAS，因此旧别名的 `true` 不会再激活已关闭的标志。多键不伪装成事务：冲突返回 `flags_not_saved`，已成功项不回滚，重读全部基线后可重试；未冲突的其他字段与原记录保留。
- `history.load()` 优先加载缓存；`history.migrate({ signal, resume, onProgress })` 遍历所有 `progress:` 分页，以真实 `updated_at` 排序，最多驻留最近 2000 条，不删原进度。截断或未完成必须显示有限范围提示。
- `history.page(offset, limit, signal)` 每页重新校验来源，隐藏不可用或范围外记录；由于隐藏和范围检查，页可不足 `limit`，仍需按 `nextOffset` 继续。`location` 仅在内容版本匹配时提供。

## 元数据与封面

详情取得 `getMetadata()` 的结果后，使用 `resolvedMetadata(unit, work, result.metadata)` 合成人工优先信息；书架查询只保留轻量可搜索字段，不持有全库简介。所有展示文本使用 `textContent`，不将元数据、文件名或错误字符串写入 `innerHTML`。

- `MetadataService` / `parseComicInfo` / `epubArchiveMetadata` / `pdfMetadata`：ComicInfo 白名单、OPF 标题作者简介与包内封面、PDF 信息/XMP；禁止 DOCTYPE/ENTITY、外链资源、任意 HTML/CSS/脚本。扫描不调用这些提取器，元数据提取不解析 EPUB 正文章节或渲染 PDF 正文页。
- 不可用元数据返回空字段及 `warnings`，不伪造作者、简介或评分；安全失败不缓存为“成功结果”。
- `CoverService.get(unit, signal)` 返回 `{ url, origin, warnings, release() }`；`url === null` 时画文字占位。替换、离开或销毁时必须 `release()`。
- 优先级：同名图片、可确认独立作品的目录封面、内嵌封面、首图/PDF 首页、文字占位。混放目录的通用 cover 不套给所有文件；目录版本和命中缓存期间的归属变化也会重新核验。
- `ViewportCoverLoader(service, signal)` 用于可见卡片，`observe(element, unit)` 后才监听；离开视口取消，列表换页/重绘用 `clear()`，退出用 `destroy()`。它不负责列表虚拟化；不要登记无限累积的 DOM 节点。
- 元数据和封面各最多 2 个任务；PDF 预览在封面任务内再限 1 个。保留现有 Range 单次 1 MiB/全局 3 并发、归档与图片像素上限。提取结束释放 Archive、Range、PDF 文档、画布和临时 URL，不写阅读进度。
- `BudgetCache` 只管自身缓存前缀，thumbnail 8 MiB、metadata 4 MiB，最多各 2000 项，单记录大于 48 KiB 时仅内存缓存。超配额/存储失败会话降级，不删用户状态。

### PDF 入口与下一阶段构建要求

`openPdfDocument(drive, file, signal)` 使用锁定 `pdfjs-dist@6.3.289` 的 legacy 主模块和同版 legacy worker。真实 PDF 测试确认现代构建依赖固定 Node 22.22.0 所缺的 `Promise.try`，因此不使用只在测试里补丁的假通过。

本阶段没有改 `books/pdf.ts`。后续阅读器须复用这一入口，避免现代/legacy 双份构建或混用全局 worker。共享 library 也可能使 comics 输出 PDF 动态块，应优先按 app 适配器隔离不需要的 PDF 依赖。若某包实际携带 legacy 内嵌的 core-js 3.50.0，必须核验并随该包附上真实 MIT 许可证及中文 NOTICE；不能只处理 books、只留 URL 或杜撰许可证。此阶段没有生成这些新版发布包。

真实 PDF 解析、损坏文件和慢 Range 取消有测试；封面 canvas/Image 的单元测试使用受控替身。手机实际渲染、较旧浏览器能力（包括取消 API）及所有许可打包仍需后续浏览器/构建阶段验证。

## 存储与失败边界

| 键 | 性质 |
| --- | --- |
| `library:sources` | 版本化来源，CAS；未知格式/读取失败不覆盖。 |
| `library:works`、其 `:shard:` | 不可变人工/作品快照及 CAS 指针；缓存回收绝不触碰。 |
| `progress:${fileId}`、原 `bookmark:` | 保持原阅读契约，书签不迁移、不删除。 |
| `library:reading:${fileId}` | 显式阅读状态，绑定内容版本。 |
| `library:flags:${workId}` | 独立想读/收藏，别名记录保留。 |
| `library:cache:index`、`library:cache:history`、其 `:shard:` | 可重建有界快照；成功替换后只回收刚被替换的缓存分片，避免每次刷新/阅读进度都累积整份历史。 |
| `library:cache:metadata:`、`library:cache:thumbnail:` | 按各自字节预算回收的提取缓存。 |

分片按 UTF-8 字节计量，最多 48 KiB。缓存的明确未发布草稿可回收；提交结果不明时保留，避免删除可能仍活动的快照。人工旧分片及草稿不会自动清理。取消/通信失败若发生在提交确认附近，应重新读取指针确认状态，不能假定远端肯定没有保存。

`index_session_only`、历史返回的 `message`、缓存 `mode: 'session'` 均应可见提示。`source_changed / file_changed / directory_changed` 需要重新核验当前上下文；`unknown_sources / unknown_progress` 等不能通过清空记录“修复”。

## 数据层验证与集成

本目录测试覆盖真实内存 SDK 的 CAS、分页、稳定节点、异步竞态、合成千本与 2000/10000 上限；真实 ZIP/EPUB/ComicInfo/合成 PDF；人工快照失败、旧进度、别名标志、资源释放及缓存预算。集中服务与查询的集成行为分别见 `service.test.ts`、`catalog.test.ts`。

验收使用 Node **22.22.0**，运行 `npm run typecheck`、`npx vitest run reader/library`、`npm test`。具体次数、退出结果和日志由交接报告记录。非阅读正文界面已在 `reader/ui/` 和 `reader/app.ts` 中完成模块化接入并通过真实单测。全量 Vitest 中既有分发测试使用临时输出目录，不等于本次阅读馆发布包构建通过。

后续阶段负责新分格式设置、缩略图面板与完整浏览器验收。没有读取私有宿主、生产环境或真实网盘；真机与跨库集成均未验收。本阶段按分工不改版本、不暂存或提交。
