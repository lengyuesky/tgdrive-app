# 阅读馆数据层

公共入口为 `index.ts`。线上依赖只有 `@tgdrive/page-sdk` 的 `HostClient` 和契约类型；测试依赖 `@tgdrive/test-host`，不检出或运行宿主。完整应用结构、KV 键和限制见 [阅读馆说明](../../docs/reader.md)。

## 生命周期

生产页面持有一个 `ReadingLibrary(host, 'all', callbacks, openPdfDocument, true)`。最后的 `true` 表示命名书库，配置保存在 `library:shelves:v1`；`books/comics` 是单元的内容种类，不是独立应用或旧 SDK 入口。

1. `initialize(signal)` 只读书库、作品和已有索引，不主动扫文件或提取正文。未知数据版本、读取失败不能构造空基线保存。
2. `addSource(path, { name, base, confirmedRoot, signal })` 条件保存目录绑定，返回 `{ source, sources, scan }`。根目录另需确认，目录选择与授权分开处理。
3. `selectSource(id, signal)` 加载一个书库的独立索引并核对增量；`selectSource(undefined, signal, false)` 回到书库列表。切换具有代次检查，在途离开后重选相同书库也不能被旧空结果覆盖。
4. `refresh(signal)` 通过通用查询完整发现阅读单元；`synchronize(signal)` 优先消费已有持久变更检查点，日志或授权失效才重扫。
5. `loadReadingState(signal)` 分页读取当前单元的进度、状态和作品标志，结果交给 `query(query, readings, flags)`。未加载或读取失败的空 Map 不是“全部未读”。
6. `getMetadata(unit, signal)` 按需解析并发布必要的作品归组变化；可见卡片用 `covers` 读取小图。扫描不解析正文、元数据或封面。
7. 进入阅读前 `pause()`，通过 `openUnit(id, signal)` 与 `reading.load(file, signal)` 重新核验身份、来源和版本；返回书库 `resume()`，页面退出 `destroy()`。

`bindLibraryLifecycle` 在隐藏时暂停、`pagehide` 时销毁，不擅自恢复仍在阅读的后台任务。界面级请求使用自己的 AbortSignal，离开视图中止。扫描的 pause 与 cancel 不同，取消后开始新扫描。

## 查询与发现

- `ReadingUnit` 只含节点、格式、来源 ID 和首次索引时间；图片目录只是一条单元，不把全库页图或正文存进索引。
- `discoverPage` 将原文件查询与直属图片目录查询归并，内存只驻留两路宿主页；应用双路位置不解码任何宿主游标。
- `LibraryAccess.list/search` 在明确的来源 ID 下查询；目录身份与迟到响应核验属于应用取材规则，实际授权始终由宿主逐请求执行。
- `LibraryScanner` 按 ID 去重，没有 2000 单元/10000 目录的发现截断。普通分页只看 `next_cursor`，结束后从第一页 `scan_cursor` 消费变更，变更分页只看 `has_more`。
- `reconcileUnits` 处理新增、覆盖、改名、删除、子树失效和图片目录命中变化；图片旧父目录不可从 upsert 推断时重查通用目录命中索引，不列整个文件树。
- 失败/取消只发布已核实部分，不清除未核实旧项；授权变化清除不可见列表，未知版本不静默改为空库。
- `query` 的作者、作品、分组和阅读状态来自应用自己的索引；宿主只认识文件属性。`complete` 是已完成核对的范围，不是实时文件系统事务快照。

## 作品与条件写入

严格一致的系列名、明确卷话编号和无冲突信息才自动归组。模糊、裸数字、番外和冲突资料不强猜。手工分组与顺序不被后台自动重写；合并保留主作品 ID 和别名，拆分第一组保留主 ID，其他组得到新 ID。各卷仍用原节点 ID 保存进度/书签。

`mergeWorks / splitWork / reorderWork / editWorkMetadata` 产生草稿，通过 `publishWorks({ ...base, rows }, signal)` 发布。`base.revision` 来自编辑表单打开时的快照，不能自动重读后强制覆盖整个旧草稿。

`ShardedStore` 先以 absent 条件创建不可变分片，最后对单一指针 CAS。默认行分片 24 KiB，所有 KV 值最多 32 KiB；描述目录过大时再分索引片。`SnapshotPublishError.draft` 保留草稿。明确失败回收自身分片；确认成功回收刚被替换的快照；提交结果未知保留分片并重读核实，没有跨键事务。

## 状态、历史与缓存

- `reading.load` 返回进度、显式状态基线和可恢复的语义位置，文件或目录版本改变不恢复旧位置。
- `markRead` 只能由用户显式操作；到末端不自动已读。`restart` 要确认，原进度与书签保留到新位置确实成功保存。
- 想读/收藏独立于阅读状态；`setWorkFlags` 逐项 CAS 处理合并别名，失败返回已发生部分更新的事实，不能假装回滚。
- `HistoryStore.record` 接受已经确认写入的进度；`rebuild` 是新平台进度键的显式索引重建，不是旧数据迁移。它遍历所有 KV 页，但排序索引只保留最近 2000 条并如实标记有限范围，不删除原进度。
- 历史指针的 KV 事件使本地历史失效，下次读取重新加载。历史写失败不把已确认的进度误报为待重放。
- `BudgetCache` 只操作自身元数据前缀，热点预算 4 MiB/2000 项；KV 单值仍遵守 32 KiB。配额/读写失败只会话降级，不删用户记录。
- 封面小图使用 `cache.objects` 的 `unit:<节点ID>`，metadata 保存应用核验摘要，sources 保存实际来源 ContentRef。源覆盖或撤权自动失效；缓存票据为同源相对路径。
- `CoverService` 核对同名/独立目录封面归属，返回 URL 与幂等 release。卡片离开视口取消，换页 clear，销毁释放。图像提取最多两并发，PDF 预览一并发；这些是解析任务预算，不是额外 HTTP 排队层。

## 回归范围

测试保留书库、归组、人工条件保存、状态、历史、元数据、封面、生命周期与读取竞态，补充万文件字节截页、扫描期间变更、图片/子树增量核对和条件分片发布。格式解析用合成 ZIP/EPUB/PDF，解码和几何由受控替身隔离。

旧批量 RPC 改测并行 stat；旧默认迁移改测不迁移/不覆盖；旧可选 covers 能力改测必备缓存发生写入错误时的会话降级。真实宿主、CSP、Telegram、实体手机与浏览器渲染属于独立联调验收，不把这些单测称为端到端通过。
