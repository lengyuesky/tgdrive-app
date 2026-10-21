# 阅读馆 1.0.3 发布验收记录

验收日期：2026-10-21（上海时间）。用户明确授权发布书库紧凑布局改进。本版通过插件仓库 `main` 的 `catalog.json` 与 `apps/` 分发，不创建 GitHub Release，不部署宿主、不执行生产安装、不操作真实网盘文件。实际提交及推送状态以 Git 记录与公开分发资产核验为准。

## 版本与隔离边界

- 插件验收 base SHA：`6fee73580abf6838e9245a0bcb2cb66c611a8d1a`。本版验收在包含布局、测试、文档、截图和分发资产的 dirty 工作区执行；base SHA 不是本版发布提交。
- 实际宿主：`0100bee95726280268a329ac7c0956179acd9e07`，版本 `0.3.3`，Git tree 为 `f4f519b3e090e5c50b56a0feffc8465c72aba657`。本轮重新构建及验收后宿主源码工作区保持干净，无宿主源码、配置或数据变更。
- JavaScript 构建与验证固定使用 `fnm exec --using=22.22.0`；Cargo、rustc 为 1.99.0。
- 集成明确指定 `TGDRIVE_HOST_DIR`、插件包目录和 `CARGO_TARGET_DIR`，每轮开始前确认端口 4187 空闲，禁止复用未知服务。任何测试文件操作前核验 `/__apps_fixture` 返回 `{ "fixture": "tgdrive-apps-tests" }`。
- 仅使用临时 SQLite、临时封面库、内存 Telegram、合成书漫与视频。未读取生产 `.env`、数据库、凭据或真实网盘文件。
- 日志、trace、真实旧包和集成截图留在调用者 `TMPDIR` 的独立发布目录；公开仓库只包含经人工查看的四张合成应用截图，不上传宿主日志、源码或构建产物。

## 1.0.3 行为

1. 手机书库默认收起类型、格式、阅读状态、排序和分组筛选，点“筛选与分组”展开。入口显示非默认条件数量；仅展开或收起不会清除条件或当前书籍选择。
2. 作品/文件切换与搜索始终可用；管理分组和“目录全部文件”位于展开面板。“重置筛选”保留当前手动书库及搜索词，不扩展到其他目录。
3. 进入“批量分组”收起筛选并显示独立移动栏，支持当前页选择、移动、重新加载及退出；实际切换筛选仍清空选择，失败保留选择和目标分组。
4. 插件手机顶栏约 49px，目录设置和返回使用保留无障碍名称的图标；书库标题和路径合为紧凑区域。独立手机首行封面约在 220px 出现；真实宿主中也断言距 iframe 顶部不超过 225px。点击区域仍不少于 44px。
5. 桌面筛选常驻显示，视口改变时同步切换；内容区无横向溢出，手机底部导航贴底。手动目录书库、索引范围、漫画适宽和阅读器沉浸行为不变。
6. `reader 1.0.2 → 1.0.3` 为同 ID 普通升级，不要求重建书库，保留现有手动书库、分组、进度、书签、自定义偏好和目录授权；未新增数据库迁移或修改 SDK。

## 真实旧包升级

所有旧包均从本机 Git 中的已发布原始包复制或导出到隔离目录，不从生产安装提取，也不用合成 manifest 代替旧版本。

| 旧包 | 来源 | SHA256 |
| --- | --- | --- |
| `reader-1.0.2.tgapp` | 本次插件 base 提交的根分发包 | `cbf99cf9790b4f1f66134fd3ddcd4e3a5ae753ac0cd1f0f92b3ae1c7ba009406` |
| `reader-1.0.1.tgapp` | `9dfaa278cb831041e0ba3b12372eccf666d4321b` 的原始分发包 | `5af19fc61b5b4d4f56e10487ff7e1af33f0a133c41afd55915e0f965c859ce68` |

新增升级用例经真实宿主 inspect/install 安装 1.0.2，在旧 UI 手动创建书库和分组、移动书籍、添加书签、修改字号并保存进度；随后通过应用中心导入 1.0.3。逐项核对旧存储记录的值与修订号，以及授权范围均保留；新 UI 中已有书库直接可见，折叠筛选可按旧分组找到同一书籍并打开，旧书签继续显示。

另外两项 1.0.1 升级分别验证自定义滚动、适宽、75% 缩放保留，以及旧“单页＋整页＋100%”默认组合一次迁移为适宽；旧来源不自动成为手动书库，重建同目录后进度和书签可继续使用。这与首次替换退役 `books/comics` 的私有数据清理确认不同。

## 正式分发资产

| 项目 | 实际值 |
| --- | --- |
| 安装包 | `apps/reader-1.0.3.tgapp` |
| 压缩大小 | 2,419,210 字节 |
| SHA256 | `30d0b556919dc90e5ff755575ed0713f333c7bc9bf227d070c7d687f522bdc9b` |
| 最低宿主 / API | `0.3.3` / `2` |
| Catalog | schema_version 2，三条官方最新记录 |
| Catalog SHA256 | `e7dd83788dbb2b5e067dab9799cde289e376ccd03716e76d5e7813abe0af72e0` |
| 归档条目 / 解压大小 | 209 个文件 / 4,420,770 字节 |
| 最大单文件 | 1,262,844 字节 |

包内完整 manifest 与 `reader/app.json` 深度一致，包含当前 SDK、ZIP、DOMPurify、PDF worker、169 个 CMap 条目、16 个标准字体资源、对应许可证与 NOTICE。四张截图均来自真实宿主中用户表单创建的合成目录书库，已人工查看并逐字节核对包内截图与源码截图：

| 截图 | 字节数 | SHA256 |
| --- | --- | --- |
| `home.png` | 48,436 | `9cc7eec4b3617ef9365101948249145f05322910f50d133b90f27237b0ddb3c3` |
| `mobile-library.png` | 57,572 | `9bc5ff22a7b406cc7512602f1fa1807e17addd2f36937e8db77d931101fcc339` |
| `mobile-reading.png` | 2,857 | `56be481e3b16ef06e26dde59f2d92e1e3378c2fb4896f6f4249a22de5ee6a95f` |
| `mobile-sidebar.png` | 42,147 | `a3f70e45cc6964e68126f17fd68c09518495ce2775f93bad883eb35a3ecc6b53` |

漫画正文行为未改，重新截取的 `mobile-reading.png` 与 1.0.2 字节相同，这是实际重截结果，不冒充未执行的新素材。

影视 1.4.5、短视频 1.4.6 的包与 base 提交完全相同，SDK、依赖清单、锁文件未改变。先用旧截图的预检包完成定向验收和生成素材，确认截图后在新的隔离目录生成最终候选；完整 E2E 使用该候选全部通过后，再正常构建根分发资产。根 catalog、SHA256SUMS、三个包与已验收候选逐字节相同。旧根 reader 1.0.2 包按正常最新版本规则移除，未删除或绕过旧 catalog 基线、未降版、未同版本覆盖。

## 实际执行的门禁

下表数量均来自此次用户授权发布后的实际日志，不沿用前一轮源码验证或 1.0.2 发布日志。所有最终通过命令退出码为 0，安全审计另列限制。

| 工作区 | 实际命令 | 结果 |
| --- | --- | --- |
| 插件 | `fnm exec --using=22.22.0 npm ci` | 预检和最终阶段各执行一次，安装 103 个包、审计 104 个包，锁文件未改变 |
| 插件 | `TGDRIVE_APP_BUILD_OUTPUT="$releaseDir/preflight-dist" fnm exec --using=22.22.0 npm run check` | 类型检查与三包预检构建通过 |
| 插件 | 定向 E2E：`tests/browser/reader-layout.spec.ts tests/browser/reader-compact-upgrade.spec.ts` | 6 项通过，含真实 1.0.2 升级、两种视口与四张截图生成 |
| 插件 | `TGDRIVE_APP_BUILD_OUTPUT="$releaseDir/candidate-dist" fnm exec --using=22.22.0 npm run check` | 含新截图的最终候选构建通过 |
| 插件 | 下方完整 E2E 命令 | 65 项通过，零失败、零跳过；含三项真实旧包升级 |
| 插件 | `PLAYWRIGHT_READERS_OUTPUT_DIR="$releaseDir/standalone-readers-results" fnm exec --using=22.22.0 npm run test:readers` | 19 项独立 Chromium 阅读馆回归通过 |
| 插件 | `PLAYWRIGHT_APPS_OUTPUT_DIR="$releaseDir/standalone-comics-results" fnm exec --using=22.22.0 npm run test:comics` | 8 项底层漫画真实几何及惯性滚动回归通过 |
| 插件 | `PLAYWRIGHT_READERS_OUTPUT_DIR="$releaseDir/standalone-webkit-results" fnm exec --using=22.22.0 npm run test:readers -- --browser=webkit --grep '手机书库紧凑\|桌面书库常驻'` | 2 项 WebKit 布局与筛选、多选回归通过，不是 WebKit 全量测试 |
| 插件 | `env -u TGDRIVE_APP_BUILD_OUTPUT fnm exec --using=22.22.0 npm run check` | 最终根分发构建通过 |
| 插件 | `fnm exec --using=22.22.0 npm test` | 预检与最终阶段均为 61 文件、637 项通过 |
| 插件 | `fnm exec --using=22.22.0 npm run catalog verify ./catalog.json` | 三包摘要、大小、完整 manifest 通过 |
| 插件 | `sha256sum -c SHA256SUMS` | 根三包及 catalog 全部匹配 |
| 插件 | `cmp` 根资产与候选 catalog、SHA256SUMS、三个包 | 全部逐字节相同 |
| 插件 | `git diff --exit-code -- apps/cinema-1.4.5.tgapp apps/shorts-1.4.6.tgapp sdk package.json package-lock.json` | 其他包、SDK、依赖未变 |
| 插件 | 包内 manifest、许可、大小与四张截图核验；`git diff --check` | 通过 |
| 宿主 | `fnm exec --using=22.22.0 npm --prefix frontend run check` | 前端类型与生产构建通过 |
| 宿主 | `fnm exec --using=22.22.0 npm --prefix frontend test` | 36 文件、209 项通过 |
| 宿主 | `cargo test --locked` | 343 项通过、2 项按定义忽略 |
| 宿主 | `CARGO_TARGET_DIR="$hostDir/target" PLAYWRIGHT_APPS_OUTPUT_DIR="$releaseDir/host-apps-results" fnm exec --using=22.22.0 npm --prefix frontend run test:apps` | 12 项宿主应用中心和 PWA 回归通过 |
| 宿主 | `git diff --exit-code` / `git status --short` | 源码工作区干净，完整 SHA 与 Git tree 匹配兼容性记录 |

完整 E2E 最终命令如下，执行时各目录均明确指定，Cargo 可执行目录加入 PATH。`$hostDir` 指向本次获授权的宿主工作区，`$releaseDir` 为调用者 TMPDIR 中本轮新建的隔离目录，不在公开文档写入私有绝对路径。

```bash
TGDRIVE_HOST_DIR="$hostDir" \
TGDRIVE_APP_CATALOG_DIR="$releaseDir/candidate-dist/apps" \
CARGO_TARGET_DIR="$hostDir/target" \
TGDRIVE_READER_PREVIOUS_PACKAGE="$releaseDir/reader-1.0.1.tgapp" \
TGDRIVE_READER_PREVIOUS_STABLE_PACKAGE="$releaseDir/reader-1.0.2.tgapp" \
TGDRIVE_CAPTURE_SCREENSHOTS=1 \
TGDRIVE_APPS_E2E_REUSE=0 \
PLAYWRIGHT_APPS_OUTPUT_DIR="$releaseDir/candidate-integration-results" \
fnm exec --using=22.22.0 npm run test:e2e
```

本轮无需失败重试：定向预检 6 项与完整候选 65 项首轮均通过；最终门禁也通过。根分发构建在截图确认和完整验收后执行，不能把旧截图预检包等同于最终发布包。

## 安装方式与剩余风险

- 宿主 `>= 0.3.3` 时，在应用中心刷新目录并更新到阅读馆 1.0.3，或下载 `.tgapp` 导入；无需重建宿主镜像或重启。从 1.0.2 更新保留现有书库与分组。
- 旧 1.0.0/1.0.1 的来源记录不会自动变为手动书库；首次替换 `books/comics` 仍需单独确认私有数据清理，网盘原文件及网盘收藏不受影响。
- `fnm exec --using=22.22.0 npm audit --json` 实际退出 1，报告低危 1、中危 1、高危 2、严重 2，共 6 项，涉及 DOMPurify、@vitest/mocker、source-map-js、Vite、tinypool、Vitest。依赖与锁文件未改，未自动运行 `npm audit fix`，不将该安全审计列为通过。
- 未执行生产安装、部署、真实 Telegram 网络或实体 iPhone Safari 验收，也未运行全仓格式化、clippy。Cargo 忽略项为服务型浏览器夹具和需真实 Telegram 的历史探测，前者已由集成测试实际启动。
- Chromium 覆盖模拟手机触控和 iOS 安全区，WebKit 仅覆盖 2 项独立布局回归，不能替代实体设备验收。宿主顶层工具栏和系统安全区没有修改。
