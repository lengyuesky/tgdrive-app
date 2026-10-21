# 阅读馆 1.0.2 发布验收记录

验收时间：2026-10-21（上海时间）。本次继续用户授权的阅读馆发布任务，并按用户确认的要求修复手动目录书库及漫画铺满宽度。分发通过插件仓库 `main` 的 `catalog.json` 与 `apps/` 完成；不创建 GitHub Release，不部署宿主，不执行生产安装，也不替用户创建生产书库。最终提交和线上状态以实际 Git 记录及公开原始文件核验为准。

## 版本与隔离边界

- 插件验收 base SHA：`9dfaa278cb831041e0ba3b12372eccf666d4321b`。本次验收在包含修复、测试、文档、截图和分发资产的 dirty 工作区执行；该 base SHA 不是本版发布提交。
- 实际宿主：`0100bee95726280268a329ac7c0956179acd9e07`，版本 `0.3.3`，Git tree 为 `f4f519b3e090e5c50b56a0feffc8465c72aba657`。本轮构建和验收后宿主源码工作区仍干净，未修改宿主源码、配置或数据。
- JavaScript 命令固定为 `fnm exec --using=22.22.0`；Cargo 1.99.0、rustc 1.99.0。
- 集成显式指定获授权的 `TGDRIVE_HOST_DIR`、插件包目录及 `CARGO_TARGET_DIR`，每轮开始前确认夹具端口 `4187` 无占用。文件操作前核验 `/__apps_fixture` 返回 `{ "fixture": "tgdrive-apps-tests" }`。
- 全部测试使用临时 SQLite、独立临时封面库、内存 Telegram 与合成书漫及视频；不读取生产 `.env`、凭据、数据库或真实网盘文件。
- 日志、trace、旧安装包和测试截图只保留在调用者 `TMPDIR` 下的本机隔离目录；公开仓库仅包含经查看的四张合成界面截图，不上传宿主测试产物。

## 本版行为

1. 首页、全部书库和侧栏只显示用户手动创建的书库；不自动生成类型书库，不采用旧来源，不把目录授权当成书库。从文件打开也不隐式创建其父目录书库。
2. 一库绑定一个目录，填写名称并确认“创建并扫描”后才扫描该目录及子目录，并保存独立应用索引。未创建书库时不枚举或显示网盘图书；进入书库只显示对应目录内容。
3. 配置使用 `library:shelves:v1`，独立索引使用 `library:cache:shelves:v1:index:source:<nodeId>`。重开先显示书库列表，选库复用有效索引；相关文件事件或显式刷新只扫描当前目录，JSON 对象键重排不会误使索引失效。
4. 名称和目录不可重复，最多 16 个书库；根目录需额外确认。支持修改名称、重扫和删除绑定，删除书库不删除网盘文件、阅读进度或书签。每库整理索引仍最多 2000 项，同目录宿主分页入口用于查找超过上限的文件。
5. 漫画默认单页适宽、等比例铺满可用屏幕宽度，高度超出时纵向滚动；菜单显隐不挤压正文，不按屏高缩小、不拉伸或强制裁剪。仅整页且未放大时限制单/双页滚动。
6. 旧 V2 “单页＋整页＋100%”默认组合以原修订号 CAS 迁移一次为适宽，并保存 `comicWidthDefault: 1`。用户随后主动选择整页不再被重置；自定义滚动、双页、缩放、文字/PDF 设置及作品覆盖保留，旧 flat/V1 仍仅内存映射。冲突不自动重试覆盖。

## 正式分发资产

| 项目 | 实际值 |
| --- | --- |
| 安装包 | `apps/reader-1.0.2.tgapp` |
| 压缩大小 | 2,411,012 字节 |
| SHA256 | `cbf99cf9790b4f1f66134fd3ddcd4e3a5ae753ac0cd1f0f92b3ae1c7ba009406` |
| 最低宿主 / API | `0.3.3` / `2` |
| Catalog | schema_version 2，三条官方最新记录 |
| Catalog SHA256 | `31ae8522431ea42b3c49a0618e4549d2a18bb8db1c38748d727b35309137cb6a` |
| 归档条目 / 解压大小 | 209 个文件 / 4,407,030 字节 |
| 最大单文件 | 1,262,844 字节 |

reader 归档包含当前 SDK、ZIP、DOMPurify、PDF worker、169 个 CMap 条目、16 个标准字体资源、对应许可证与 NOTICE，以及四张正式截图。包内完整 manifest 与源码 `reader/app.json` 深度一致，四张截图逐字节与源码截图一致。其 SHA256 为：

| 截图 | SHA256 |
| --- | --- |
| `home.png` | `1962f61da9785ccba3e0c04fa4c7a415eac03323e39083c92cb75ee19f51b6f4` |
| `mobile-library.png` | `21bece297d153ff5c0c4ed8e9131bbe9753c21d19727273db2ccf47831df44f4` |
| `mobile-reading.png` | `56be481e3b16ef06e26dde59f2d92e1e3378c2fb4896f6f4249a22de5ee6a95f` |
| `mobile-sidebar.png` | `6b8c543f0716f392c4146acea3951c190d002661dc887931140025df2921b042` |

影视 `1.4.5`、短视频 `1.4.6` 的包与 base 提交完全相同，SDK、依赖清单和锁文件未改变。真实截图完成后在新隔离目录生成最终候选包，完整 E2E 通过后按正常构建生成根分发；根 catalog、SHA256SUMS 及三个包与已通过验收的候选资产逐字节一致。没有删除公开基线、降版或跳过同版本不可变校验。

## 实际执行的门禁

以下最终通过命令退出码均为 0；数量来自本次 1.0.2 发布任务的实际执行日志，不引用更早版本的结果。JavaScript 命令均带固定 Node.js 前缀，环境变量路径在执行时均显式配置。会话恢复后重新执行的门禁与未重跑项另见下方复核说明。

| 工作区 | 命令 | 实际结果 |
| --- | --- | --- |
| 插件 | `fnm exec --using=22.22.0 npm ci` | 安装 103 个包、审计 104 个包；保留锁文件，漏洞提示另列下方 |
| 插件 | `fnm exec --using=22.22.0 npm run check` | 全部三款插件类型与正式生产构建通过 |
| 插件 | `fnm exec --using=22.22.0 npm test` | 60 个文件、632 项通过；含旧默认迁移、CAS 冲突、保存失败和取消回归 |
| 插件 | `PLAYWRIGHT_READERS_OUTPUT_DIR="$releaseDir/standalone-readers-results" fnm exec --using=22.22.0 npm run test:readers` | 17 项独立统一入口浏览器回归通过 |
| 插件 | `PLAYWRIGHT_APPS_OUTPUT_DIR="$releaseDir/standalone-comics-results" fnm exec --using=22.22.0 npm run test:comics` | 8 项底层漫画真实滚动及惯性回归通过 |
| 插件 | 下方完整 E2E 命令 | 最终候选 62 项通过，零失败、零跳过；包括两种真实 1.0.1 升级及截图采集 |
| 插件 | `fnm exec --using=22.22.0 npm run catalog verify ./catalog.json` | 三条目录及真实包的摘要、大小、完整 manifest 通过 |
| 插件 | `sha256sum -c SHA256SUMS` | 三包及 catalog 全部匹配 |
| 插件 | `cmp` 根目录与已验收候选的 catalog、SHA256SUMS、三包 | 全部逐字节相同 |
| 插件 | `git diff --exit-code -- apps/cinema-1.4.5.tgapp apps/shorts-1.4.6.tgapp sdk package.json package-lock.json` | 其他包、SDK、依赖未变 |
| 插件 | `git diff --check` | 通过 |
| 宿主 | `fnm exec --using=22.22.0 npm --prefix frontend run check` | 前端类型与生产构建通过 |
| 宿主 | `fnm exec --using=22.22.0 npm --prefix frontend test` | 36 个文件、209 项通过 |
| 宿主 | `cargo test --locked` | 343 项通过、2 项按定义忽略 |
| 宿主 | `CARGO_TARGET_DIR="$hostDir/target" PLAYWRIGHT_APPS_OUTPUT_DIR="$releaseDir/host-apps-results" fnm exec --using=22.22.0 npm --prefix frontend run test:apps` | 12 项应用中心浏览器回归通过 |
| 宿主 | `git diff --exit-code` / `git status --short --branch` | 源码工作区干净 |

完整插件 E2E 的最终命令：

```bash
TGDRIVE_HOST_DIR="$hostDir" \
TGDRIVE_APP_CATALOG_DIR="$releaseDir/candidate-dist/apps" \
CARGO_TARGET_DIR="$hostDir/target" \
TGDRIVE_READER_PREVIOUS_PACKAGE="$releaseDir/reader-1.0.1.tgapp" \
TGDRIVE_CAPTURE_SCREENSHOTS=1 \
PLAYWRIGHT_APPS_OUTPUT_DIR="$releaseDir/candidate-integration-results" \
fnm exec --using=22.22.0 npm run test:e2e
```

Cargo 的可执行目录预先加入 PATH。旧包从上述 plugin base 提交导出，SHA256 为 `5af19fc61b5b4d4f56e10487ff7e1af33f0a133c41afd55915e0f965c859ce68`。两项升级用例先经真实宿主 inspect/install 安装 1.0.1，再通过应用中心导入 1.0.2，分别验证：

- 自定义滚动、适宽和 75% 缩放完整保留；旧来源不被自动采用，用户重建同目录书库后旧进度和书签继续可用。
- 真实旧 V2 默认在新应用打开时迁移为适宽，记录保留，重开不重复写入；桌面图片宽度实际为 1280px，高度超过 900px 且比例不变。

新装书库用例另在 390px 与 1280px 两视口逐项验证：创建前 `files.list/files.searchPage/library.page` 为零，配置不被暗中写入；创建后只有所选目录被扫描，索引持久化且重开不改写，侧栏没有虚构类型书库；漫画 DOM 宽度等于视口，桌面纵向滚轮使 `scrollTop` 增长，适页/适宽切换及菜单显隐不改变正文视口。

## 首轮失败与修正

本轮首轮完整 E2E 为 61 项通过、1 项失败，退出码 1，未据此发布。手动书库、像素宽度、旧包升级及截图用例已经通过。唯一失败是旧移动漫画测试在单页模式下仍断言 `overflow: hidden`，与用户确认的“适宽后纵向可滚动”要求相反；实际样式为 `auto`，符合新行为。

仅修改该测试：默认适宽断言图片实际宽度等于视口、`overflow: auto`，继续核验真实轻点、横滑及 RTL 翻页；手动切换整页后再断言 `overflow: hidden`。未通过修改产品行为来迎合旧断言。定向重跑该用例为 1 项通过；随后以含新截图的最终候选包完整重跑 62 项全部通过。最终依次重跑 `npm ci`、根目录 `npm run check`、`npm test`、catalog 与 SHA256 门禁，全部通过，并确认根资产与已验收候选完全一致。

## 会话恢复后的发布前复核

2026-10-21 恢复本次发布任务后，再次固定 Node.js 22.22.0，依次执行 `npm ci`、`npm run check`、`npm test`、`npm run catalog verify ./catalog.json` 和 `sha256sum -c SHA256SUMS`，退出码均为 0；单元回归仍为 60 个文件、632 项通过。依赖审计仍提示上述 6 项漏洞，不作为已通过门禁。

本次续接未重复宿主构建及浏览器测试；直接核验同日保留的实际日志，确认最终候选的 62 项 E2E、17 项独立阅读馆、8 项独立漫画和 12 项宿主应用中心测试均已通过。重建后的根 catalog、SHA256SUMS 与三个包再次逐字节匹配该已验收候选。宿主完整提交 SHA、Git tree 与兼容性记录一致且工作区干净；插件无未暂存改动，重新构建未改变暂存发布资产。提交和推送仍只覆盖本次插件发布范围。

## 安装及剩余限制

- 宿主满足 `>= 0.3.3` 时，在应用中心刷新目录并更新阅读馆即可，或下载 `.tgapp` 导入；无需重建镜像或重启。
- 升级后需由用户重新创建书库；原 `library:sources` 保留但不作为新书库使用。进度、书签、作品及自定义偏好保留，只有明确列出的旧默认适配组合迁移一次。
- 首次替换旧 `books/comics` 仍需确认清理其应用私有数据，不承诺跨 ID 无损迁移；网盘原文件及网盘收藏不受影响。
- `npm audit --json` 本轮实际退出 1，报告 6 项：低危 1、中危 1、高危 2、严重 2。涉及 DOMPurify、@vitest/mocker、source-map-js、Vite、tinypool 和 Vitest；依赖与锁文件未改变，但公告更新使数量不同于上一版。本次不自动升级依赖、不声称安全审计通过。
- 本轮不运行生产安装、真实 Telegram 网络测试、实体 iPhone Safari、全仓格式化或 clippy。Cargo 两项忽略是服务型浏览器夹具和真实 Telegram 历史探测；浏览器夹具已由 E2E 实际启动。
- 自动化使用本机 Chromium、模拟手机触控及 iOS 安全区，不能替代实体 iPhone Safari 验收。正式截图中的书库为测试过程手动创建的合成目录，未创建用户生产书库。
