# 影视刮削验收与 main 交付记录

本文保留 `media-scraper 0.1.0` 的历史验收。目录一键刮削改版及当前 `0.1.1` 的实际验证见 [新版验收记录](media-scraper-simple-validation.md)。

日期：2026-11-14。用户已确认 Q1–Q42，默认及公共验收后端为 `https://metatube-server.hf.space/`。本轮源码、五个应用包、catalog 与摘要按用户授权直接交付到两个仓库的 main，不新建其他分支；日常服务未部署，未创建宿主版本标签。

## 代码与包基线

宿主 0.3.10 的实际提交为 `033dd6563b695b4cb75644036283aac996d09217`，tree 为 `6f8d698839a42071d9d5960d870d309f77b4275d`，包含新的 `scraper.service`、手动刮削步骤、上传事务保护、两端长 NFO 读取，以及中断续传测试的异步清理修复。开发基线为 `3ad8b3f6b86dd23c49569b2bc2ad41a8cb882ff9`（源码版本 0.3.9）。插件基于 `9ae5727fd4d76a5acc8f3d4b0e9b99d8efdf5434`，用于集成验收的五包及其摘要见下表。

两个仓库均在独立 worktree 实施，原宿主工作区的其他改动未纳入。`compatibility.json` 的宿主 SHA、tree 与 `worktree_dirty=false` 对应上述已提交宿主；插件的 `plugin_base_ref` 和 `plugin_worktree_dirty` 记录集成验收启动时的状态，验收后的源码、分发资产与报告一并提交，不编造插件自身提交 SHA。

| 分发包 | 最低宿主 | 改动原因 |
|---|---|---|
| media-scraper 0.1.0 | 0.3.10 | 新增目录扫描、预览、候选选择、手动整理、NFO／海报和操作记录 |
| cinema 1.5.1 | 0.3.0 | 消费完整 NFO、统一海报优先级，番号电影保持独立播放入口 |
| fntv 0.1.4 | 0.3.7 | 随包嵌入新增共享 SDK；长 NFO 能力由宿主 0.3.10 提供 |
| reader 1.1.2 | 0.3.3 | 新增共享 SDK，并修复纯图片 EPUB 解码／回收时提前跳章 |
| shorts 1.5.1 | 0.3.1 | 随包嵌入新增共享 SDK，避免替换同版本摘要 |

## 文件操作与停止契约

首期只手动执行，每次宿主调用推进一个步骤，页面心跳续约；没有后台自动续跑。默认补齐缺失资料并保留专属／公共文件，主动重刮分别选择 NFO 和海报，预览告知整份 NFO 替换。散放视频进入当前父目录下的番号目录，保留原名；同基本名的不同视频后缀按整组处理，只写一份同名资料。

整理与最终写入在 SQLite 事务中核对文件身份、内容版本、名称、父目录、目标冲突和配套资料集合。明确关联的字幕同行，多归属或共用字幕、海报由用户选择。新增视频改变关联、海报别名影响其他选中版本、预览后源或拟覆盖文件变化都会拒绝旧计划。

停止、关页、撤权、停用或应用失效阻止后续步骤；已提交结果保留。在途上传停止后先核实，宿主未确认终态时页面仍显示正在停止，不能立即开始新批次。正常重启不自动续跑；记录保留 30 天，恢复出的旧记录只供查看，重新扫描创建新预览。恢复清洗只丢弃未提交影子，不撤回原实例后来完成的 ready 文件。

Token 仅保存到宿主私有文件，以后端地址及 generation 绑定，页面只显示配置状态；不进入 SQLite、数据库备份或应用恢复快照。内部刮削上传不进入网页续传源文件列表，清理流程仍管理其状态。

## 独立检查与分发门禁

Node.js 固定为 22.22.0。先在新的空 `TGDRIVE_APP_BUILD_OUTPUT` 构建五包；编译中间目录分别位于该轮 staging 的 `compiled/<app>`。通过后再生成根目录分发资产，不删除旧 catalog 绕过同版本防篡改。

验收问题修复完成后，使用含 reader 1.1.2 的最终候选按以下顺序重新执行门禁，五步均退出 0；没有跳过根目录构建或以临时 catalog 代替校验：

| 实际命令（npm 均由 `fnm exec --using=22.22.0` 执行） | 退出结果 |
|---|---|
| `npm ci` | 0，按锁文件安装依赖 |
| `npm run check` | 0，严格类型检查及五包构建，更新根目录分发资产 |
| `npm test` | 0，65 个测试文件、672 项通过 |
| `npm run catalog verify ./catalog.json` | 0，5 个真实本地包与完整 manifest 校验通过 |
| `sha256sum -c SHA256SUMS` | 0，五包及 catalog 全部通过 |

根目录五包、`catalog.json` 与 `SHA256SUMS` 均与最终 E2E 候选逐字节一致；全部 manifest 与源 `app.json`、截图与源图片一致。阅读馆及 Cinema 第三方许可证均随包核对。官方客户端所用 FNTV 0.1.4 包的摘要与交付包一致。

| 包 | 字节数 | SHA256 |
|---|---:|---|
| cinema-1.5.1.tgapp | 175788 | `50c805b2352b448f01389218650d1f6c62aecaeb2afb27a80eb2c82ac8a5e79d` |
| fntv-0.1.4.tgapp | 16386 | `8bd43585e989897766916406e9805cf704ab3120ef10db78f3794d98559643f1` |
| media-scraper-0.1.0.tgapp | 407367 | `496c5e1d671a5fb2e67a5f80213204bd24991463b67877b80605571b8c72f563` |
| reader-1.1.2.tgapp | 2406915 | `6f720c4ea849424ae69628e63710c830e44331eda02e45267c98be4412416b1e` |
| shorts-1.5.1.tgapp | 133151 | `1d021b455acdef18130d4073bdc160b77338782d59183dac69fb5d3b616e57fd` |

`catalog.json` SHA256 为 `44f2d01ecdb9a489c30ec261ee0357da68c355c583e520b5c7b1cb608b5e863c`。main 提交前的五步退出结果和日志位于 `.build/scraper-main-verification/gates.json` 及同目录 `gate-1.log` 至 `gate-5.log`，临时检查产物不进入公开分发。阅读馆从首轮候选 1.1.1 升为 1.1.2，其他四包与首轮摘要一致。

宿主 `cargo test --locked` 退出 0，436 项通过、6 项显式环境夹具忽略；首轮宿主前端依赖、检查与 215 项测试通过。

首轮严格 Clippy 与全库格式检查未通过。用户要求解决验收问题后，于 2026-11-14 修复收件测试的跨异步等待持锁、复制冲突测试数据的复杂元组、三个仅被测试调用的上传辅助方法、多余借用和格式差异。同步锁在数据库异步查询前释放，复杂元组替换为命名字段结构，测试辅助方法经全库调用核对后仅在测试构建编译；没有添加警告屏蔽规则或删除原有回归。

修复后重新执行：

| 实际命令 | 结果 |
|---|---|
| 宿主 `cargo fmt --check` | 0，全库格式通过 |
| 宿主 `cargo clippy --locked --all-targets -- -D warnings` | 0，全目标零警告 |
| 宿主 `cargo test --locked` | 0，436 项通过、6 项显式环境夹具忽略 |
| 插件 `npm ci → npm run check → npm test → npm run catalog verify ./catalog.json → sha256sum -c SHA256SUMS` | 五步均为 0，65 个测试文件、672 项通过 |

本次宿主前端源码未改变，215 项前端结果仍引用首轮。最终五包与目录摘要与上表一致；逐步命令及结果在 `.build/scraper-acceptance-fixes/final-gates/gates.json`，宿主日志在其 `target/media-scraper-acceptance-fixes/` 中。

main 提交准备阶段的宿主复测曾为 435 项通过、1 项失败、6 项忽略。失败来自既有 `resumable_parts_survive_an_interrupted_request`：测试丢弃请求后只让出一次调度，便在异步清理完成前执行启动恢复专用的全局声明重置，随后遇到尚未清除的不确定标记。测试改为有期限地等待真实占用释放，明确断言不确定标记已清理、已完成分块保留，并核验续传前后分别只有 1 和 3 次发送；没有放宽生产的“不确定结果禁止重发”保护。

此修复已纳入上述宿主提交。在干净提交上重新执行 `cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo test --locked`，三步均退出 0，完整 Rust 回归为 436 项通过、6 项忽略。中断续传用例还通过编译出的同一测试程序连续执行 20 次；重启保留不确定标记、重启失败禁止重发的原有回归均通过。准确提交、tree、命令及退出结果位于宿主 `target/media-scraper-main-verification/final/report.json`。

## 阅读馆翻页问题修复

修复宿主质量检查后的第一次完整复测为 79 项通过、1 项失败、零跳过，捕捉到纯图片 EPUB 连续翻页时提前进入下一章。此前两项按配置跳过的截图用例在这一轮已通过。

根因是已知尺寸的分页图片仍使用自动宽高：设置图片来源后、解码完成前，浏览器会暂时将图片计算为 0×0，导致页数收缩；移出解码缓存后也可能改变占位高度。用户的下一页操作因此可能按临时页数跳章。修复使用已验证的原始图片宽度、比例和当前分页容器宽高，同时约束实际显示宽度与高度，使等待解码、加载完成和回收时占位一致，不改变阅读进度结构或按需加载预算。

新增 `tests/standalone/flow-images.spec.ts`：编译实际 `PictureWindow` 并加载生产样式，暂停本机拦截的合成图片请求，稳定验证解码前后的浏览器几何。旧代码在横竖屏两项均失败（应为四页，实际收缩为一页）；最终修复保留原有断言并通过如下核验：

| 实际命令（Node.js 22.22.0，输出目录均显式指定） | 结果 |
|---|---|
| `npm run test:readers -- flow-images.spec.ts --repeat-each=5 --reporter=list,json` | 0，横竖屏重复共 10 项通过 |
| `npm run test:e2e -- tests/browser/mobile-reading.spec.ts --grep '纯图片章节' --repeat-each=5 --reporter=list,json` | 0，原失败用例连续 5 次通过，保留末页保存、重开恢复和停用退出断言 |
| `npm run test:readers -- --reporter=list,json` | 0，完整独立浏览器验收 25 项通过，44.8 秒 |

对应结果分别在 `.build/scraper-acceptance-fixes/image-fixed/`、`reader-regression/`、`readers-final/`。由于包内代码改变，阅读馆提升到 1.1.2，未覆盖 1.1.1 的摘要绑定。

## 实际沙箱与公共后端

浏览器夹具只监听 `127.0.0.1:4187`，使用临时 SQLite、内存 Telegram 和合成视频。文件操作前核对 `/__apps_fixture` 返回 `{"fixture":"tgdrive-apps-tests"}`，并用显式 `TGDRIVE_HOST_DIR` 和候选包目录启动。未读取生产 `.env`、数据库或真实网盘。

六项刮削 E2E 已分别通过，并在带最终截图的候选包上再次通过：

1. 预览不移动；三个合成视频分两组整理，字幕同行，NFO／JPEG 写入后由真实 Cinema 包及 FNTV 索引消费。
2. 在途取消保留已整理的视频，核实上传结果后由用户手动继续。
3. 关闭应用停止后续写入，再次打开不自行续跑。
4. 后端海报故障暂停，保留已写 NFO，从操作记录手动补齐海报。
5. 使用指定公共 MetaTube 后端，经真实应用生成合成 `IPX-001` 的 NFO／JPEG；请求不携带真实凭据。
6. 备份恢复记录只供查看，重新扫描后生成新的预览。

合成长简介为 `完整长简介。` 重复 5000 次，共 90,000 个 UTF-8 字节，超过旧的 4 KiB 单字段及 64 KiB 整份 NFO 上限。Cinema 详情逐字一致，实际播放后同番号各版本不自动连播。FNTV 实际接口返回三条独立影片，每条简介长度与 SHA256 一致。完整 NFO 生成及两端读取均限制 1 MiB，海报为精确 2:3 JPEG、最多 2 MiB。

公共接口初次独立核验于北京时间 01:58:43–02:00:56 完成：providers、`IPX-001` 默认搜索、唯一 JAV321 候选详情及 primary 图片均 HTTP 200；图片实收 64,696 字节、358×538 像素。后续真实应用写入使用宿主处理后的精确比例 JPEG。单来源的 403／404／500 不作为整个后端需要 Token 的证据。

main 提交前，使用上述已提交宿主 `033dd6563b695b4cb75644036283aac996d09217` 和插件根目录五包重新执行完整跨库回归，退出 0，80 项全部通过、零失败、零跳过、无重试通过项，耗时 276.3 秒。验收启动和结束时宿主 SHA 与干净工作树状态一致，应用包及目录摘要也保持一致。本次显式设置 `TGDRIVE_CAPTURE_SCREENSHOTS=1`，将首轮按配置跳过的应用详情及阅读馆截图生成也纳入执行；截图只写本机测试产物。新增刮削链路、纯图片 EPUB 回归及全部真实旧包升级均通过。

首轮首次完整运行曾为 77 项通过、1 项失败、2 项跳过；失败断言仍要求收藏页零目录读取。NFO 关联需分页列出当前影片所在目录，已将断言改为只允许该目录内每页最多 200 项的 `files.list`，继续拒绝其他目录和全库搜索；当时定向与完整复测通过。本次修复后的 80 项完整回归继续覆盖这一边界，未修改产品权限来消除失败。

以下旧版包从真实 Git 历史提取，逐项校验 manifest、文件摘要与同提交 catalog 一致；1.0.1 两项及 1.0.2–1.0.5 各一项升级全部通过：

| 旧 reader 版本 | 真实包所在提交 |
|---|---|
| 1.0.1 | `9dfaa278cb831041e0ba3b12372eccf666d4321b` |
| 1.0.2 | `6fee73580abf6838e9245a0bcb2cb66c611a8d1a` |
| 1.0.3 | `82565d9dbac1bfae74432422bb194785dce6054d` |
| 1.0.4 | `5a77c3d1a0bea8b17b3b80bd05c770eac1507573` |
| 1.0.5 | `aba406e37e2a2a090b74f44029002816ab1de6a2` |

实际完整命令如下。`hostDir`、`candidateDir`、`historyDir` 和 `resultsDir` 由调用者显式指定为获授权的隔离目录；本次 `candidateDir` 为插件工作树根目录，直接使用根目录 `apps/` 中的五包，历史包位于 `.build/scraper-history-packages/`。完整命令记录在 `.build/scraper-main-verification/e2e-command.json`，结果在 `.build/scraper-main-verification/e2e/report.json`：

```bash
TGDRIVE_HOST_DIR="$hostDir" \
TGDRIVE_APP_CATALOG_DIR="$candidateDir/apps" \
TGDRIVE_SCRAPER_PUBLIC_BACKEND=1 \
TGDRIVE_CAPTURE_SCREENSHOTS=1 \
TGDRIVE_APPS_E2E_REUSE=0 \
TGDRIVE_READER_PREVIOUS_PACKAGE="$historyDir/reader-1.0.1.tgapp" \
TGDRIVE_READER_PREVIOUS_STABLE_PACKAGE="$historyDir/reader-1.0.2.tgapp" \
TGDRIVE_READER_PREVIOUS_LATEST_PACKAGE="$historyDir/reader-1.0.3.tgapp" \
TGDRIVE_READER_PREVIOUS_PATCH_PACKAGE="$historyDir/reader-1.0.4.tgapp" \
TGDRIVE_READER_PREVIOUS_RELEASE_PACKAGE="$historyDir/reader-1.0.5.tgapp" \
PLAYWRIGHT_APPS_OUTPUT_DIR="$resultsDir" \
PLAYWRIGHT_JSON_OUTPUT_FILE="$resultsDir/report.json" \
fnm exec --using=22.22.0 npm run test:e2e -- --reporter=list,json
```

## 官方飞牛客户端

使用已安装的官方飞牛播放器 1.12.3（build 1123003、bundle `com.trim.media.ios`）。这是在 macOS 上运行的 iOS／iPadOS 应用，本轮没有真机验收。

连接临时合成服务后，影片列表实际显示三条“星海远航”、2025 年份和蓝色合成海报。详情显示标题、年份、海报背景及简介，点击“更多”打开简介弹窗；实际播放 20 秒合成彩条视频，截图时已到 00:06.750，字幕可见。

协议侧已确认完整 90,000 字节简介。界面可见且可展开，无障碍工具单字段仅读取部分文本，因此没有把它记为官方客户端全文逐字一致。未改变已有真实服务的配置；合成账号未勾选记住密码，临时服务在核验后经测试停止接口正常退出。

| 证据 | 图片 |
|---|---|
| 官方列表：标题、年份、海报 | [列表截图](images/media-scraper/fntv-list.jpg) |
| 官方详情：标题、年份、简介与背景 | [详情截图](images/media-scraper/fntv-detail.jpg) |
| 官方展开简介 | [简介截图](images/media-scraper/fntv-overview.jpg) |
| 官方实际播放合成片 | [播放截图](images/media-scraper/fntv-playback.jpg) |
| Cinema 手机详情 | [Cinema 截图](images/media-scraper/cinema-mobile.png) |

影视刮削包还随附四张真实沙箱截图：桌面预览、手机目录、手机预览和手机记录，每张不超过 512 KiB。

## 实际范围

本轮验证公共资料服务与合成网盘完整链路。未进行真实 Telegram 附件写入、日常生产部署、真机测试或公共后端长期稳定性测试。首期只适配 MetaTube 番号影片，不自动翻译，普通电影及电视剧联网资料源后续适配；飞牛服务仍保留合计 3000 条视频的首期索引上限。
