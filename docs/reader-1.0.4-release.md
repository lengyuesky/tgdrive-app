# 阅读馆 1.0.4 发布验收记录

验收日期：2026-10-21（上海时间）。用户明确授权发布 iOS 漫画滚动瞬跳修复。本版通过插件仓库 `main` 的 `catalog.json` 与 `apps/` 分发，不创建 GitHub Release，不部署宿主、不执行生产安装、不操作真实网盘文件。实际提交和推送状态以 Git 记录及公开分发资产核验为准。

## 版本与边界

- 插件验收 base SHA：`82565d9dbac1bfae74432422bb194785dce6054d`，在包含修复、测试、文档和新分发资产的 dirty 工作区验证；base SHA 不冒充本版发布提交。
- 实际宿主：`0100bee95726280268a329ac7c0956179acd9e07`，版本 `0.3.3`，Git tree 为 `f4f519b3e090e5c50b56a0feffc8465c72aba657`。宿主已重新构建并测试，源码工作区保持干净；没有宿主源码、配置或数据变更。
- JavaScript 使用 Node.js `22.22.0`，通过显式 PATH 传给全部子进程；Cargo、rustc 为 `1.99.0`。
- 集成显式指定 `TGDRIVE_HOST_DIR`、插件包目录和 `CARGO_TARGET_DIR`，每轮开始前确认端口 4187 空闲，禁止复用未知服务。文件操作前核验 `/__apps_fixture` 返回 `{ "fixture": "tgdrive-apps-tests" }`。
- 仅使用临时 SQLite、临时封面库、内存 Telegram、合成图书漫画和视频；未读取生产 `.env`、数据库、凭据或真实网盘文件。
- 日志、trace、旧包与集成截图留在调用者 TMPDIR 下的独立发布目录，不上传宿主源码、日志、构建产物或集成 trace。

## 修复行为

1. `settleTo()` 完全吸收布局变化后直接保留实时 `scrollTop`，不再将 iOS 原生滚动在同步重排期间推进的距离回写到旧锚点。
2. 删除旧挂载节点、安装头部探测尺寸、整图尺寸修改及测量前先保护滚动范围，防止浏览器因临时布局缩短截断坐标。重复保护只增不减，测量完成后统一还原。
3. 保留原生触摸与松手惯性、五页挂载、四十一页局部轨道、有界尺寸探测和预读，以及书签、显式跳页、旋转后的页内比例恢复。
4. 从 1.0.3 更新不清空或迁移书库、分组、进度、书签、目录授权或自定义偏好。紧凑筛选、默认适宽、手动创建书库和首次替换旧 books/comics 的确认边界不变；SDK、依赖与持久化 schema 未改。

源码阶段复现与独立验证保留于 [滚动修复验证记录](reader-ios-scroll-validation.md)，不将本次后续发布追记成此前已执行。

## 真实旧包升级与新包回归

所有旧包从本机 Git 的已发布原始包复制或导出到隔离目录，不从生产安装提取，不用合成清单代替旧版本。

| 旧包 | 来源提交 | SHA256 |
| --- | --- | --- |
| `reader-1.0.3.tgapp` | 本次插件 base | `30d0b556919dc90e5ff755575ed0713f333c7bc9bf227d070c7d687f522bdc9b` |
| `reader-1.0.2.tgapp` | `6fee73580abf6838e9245a0bcb2cb66c611a8d1a` | `cbf99cf9790b4f1f66134fd3ddcd4e3a5ae753ac0cd1f0f92b3ae1c7ba009406` |
| `reader-1.0.1.tgapp` | `9dfaa278cb831041e0ba3b12372eccf666d4321b` | `5af19fc61b5b4d4f56e10487ff7e1af33f0a133c41afd55915e0f965c859ce68` |

1.0.2 和 1.0.3 升级用例先用旧 UI 手动创建书库和分组、移动图书、添加书签、修改字号并保存进度，再通过宿主应用中心导入 1.0.4。核对原记录的值与修订号、授权范围均保留；已有书库可直接进入，原分组筛选及书签继续可用。

两项 1.0.1 升级继续验证自定义滚动/适宽/75% 缩放保留，以及旧“单页＋整页＋100%”默认组合的一次适宽迁移。旧来源不自动变成手动书库，用户重建同目录后旧记录可继续使用。

新增 `tests/browser/reader-scroll.spec.ts` 三项回归实际运行新 `.tgapp`、宿主沙箱和 SDK：在真实 ResizeObserver 重排期间模拟 `+80px/-80px` 原生位移，断言没有旧坐标回写、画面与页码一致；另验证跨入末页时不因删除旧节点追加坐标赋值。原生位移为受控模拟，不冒充实体 iOS 合成器验证。Chromium CDP 的真实触摸惯性用例继续由独立漫画套件覆盖。

## 正式分发资产

| 项目 | 实际值 |
| --- | --- |
| 安装包 | `apps/reader-1.0.4.tgapp` |
| 压缩大小 | 2,419,307 字节 |
| SHA256 | `30fc57fb7e85de912063d31f30df5421c175fe1ec2e172e8ea74cd0d247fe760` |
| 最低宿主 / API | `0.3.3` / `2` |
| Catalog | schema_version 2，三条官方最新记录 |
| Catalog SHA256 | `646abb900bb98bb14009c3bdc1812ffa1d7f16c06adba855b5074d426023f6f3` |
| 归档条目 / 解压大小 | 209 个文件 / 4,421,048 字节 |
| 最大单文件 | 1,262,844 字节 |

包内完整 manifest 与 `reader/app.json` 及 catalog 深度一致，SDK 与源码逐字节一致。包含 ZIP、DOMPurify、PDF worker、169 个 CMap 条目、16 个标准字体资源及对应许可证、NOTICE；数量、单文件和总大小限制均正常。

四张截图重新通过真实宿主中的手动书库界面生成并查看，包内与源码逐字节一致。此次只改滚动补偿，实际重新截取的四张图片与 1.0.3 字节相同，不把旧素材复制冒充重新截图。

| 截图 | 字节数 | SHA256 |
| --- | --- | --- |
| `home.png` | 48,436 | `9cc7eec4b3617ef9365101948249145f05322910f50d133b90f27237b0ddb3c3` |
| `mobile-library.png` | 57,572 | `9bc5ff22a7b406cc7512602f1fa1807e17addd2f36937e8db77d931101fcc339` |
| `mobile-reading.png` | 2,857 | `56be481e3b16ef06e26dde59f2d92e1e3378c2fb4896f6f4249a22de5ee6a95f` |
| `mobile-sidebar.png` | 42,147 | `a3f70e45cc6964e68126f17fd68c09518495ce2775f93bad883eb35a3ecc6b53` |

预检及最终候选输出目录均复制了原 1.0.3 catalog 作为版本基线。新截图确认后生成最终候选，完整 E2E 通过后才执行正常根目录构建；根 catalog、SHA256SUMS 和三包与已验收候选逐字节相同。旧根 reader 1.0.3 按最新版本规则移除；未删除原 catalog 绕过保护、未降版、未覆盖同版本包。影视 1.4.5、短视频 1.4.6、SDK 和依赖锁文件与 base 完全相同。

## 本次实际执行的门禁

以下数量来自用户授权发布后的新日志，不沿用源码阶段或旧版发布结果。最终通过项退出码均为 0；安全审计和初轮失败另列。

| 工作区 | 实际命令 | 结果 |
| --- | --- | --- |
| 插件 | `npm ci` | 预检与最终阶段各执行一次，安装 103 个包，锁文件未改 |
| 插件 | `TGDRIVE_APP_BUILD_OUTPUT="$releaseDir/preflight-dist" npm run check` | 类型检查与三包预检构建通过 |
| 插件 | 定向 E2E：`reader-scroll.spec.ts reader-compact-upgrade.spec.ts reader-upgrade.spec.ts reader-layout.spec.ts` | 初轮 9/12 通过；夹具修正后滚动 3 项复跑通过 |
| 插件 | `TGDRIVE_APP_BUILD_OUTPUT="$releaseDir/candidate-dist" npm run check` | 最终候选构建通过 |
| 插件 | 下方完整 E2E 命令 | 69 项通过，零失败、零跳过；含四项真实旧包升级、新包滚动及截图 |
| 插件 | `npm run test:comics` | Chromium 11 项通过，含真实触摸惯性 |
| 插件 | `npm run test:comics -- --browser=webkit` | WebKit 9 项通过，2 项 Chromium CDP 专属用例明确跳过 |
| 插件 | `npm run test:readers` | 统一阅读馆 Chromium 19 项通过 |
| 插件 | `npm run test:readers -- --browser=webkit --grep '漫画全屏\|真实漫画\|长条漫快速\|参差条漫\|混合书库同入口'` | 统一入口 WebKit 定向 8 项通过，不是全量 WebKit 验证 |
| 插件 | `env -u TGDRIVE_APP_BUILD_OUTPUT npm run check` | 正式根分发构建通过 |
| 插件 | `npm test` | 预检与最终阶段均为 61 文件、640 项通过 |
| 插件 | `npm run catalog verify ./catalog.json`、`sha256sum -c SHA256SUMS` | 根三包与 catalog 摘要、大小、完整 manifest 通过 |
| 插件 | 候选目录的 catalog、SHA256SUMS 校验；`cmp` 根资产与候选 | 通过，三包和两个清单逐字节一致 |
| 插件 | 包内 manifest、SDK、许可、大小和四张截图核验；`git diff --check` | 通过 |
| 宿主 | `npm --prefix frontend run check` | 前端类型检查与构建通过 |
| 宿主 | `cargo test --locked apps::tests::browser_fixture --no-run` | 夹具编译通过，随后由集成实际启动 |
| 宿主 | `npm --prefix frontend test` | 36 文件、209 项通过 |
| 宿主 | `cargo test --locked` | 343 项通过、2 项按定义忽略 |
| 宿主 | `CARGO_TARGET_DIR="$hostDir/target" PLAYWRIGHT_APPS_OUTPUT_DIR="$releaseDir/host-apps-results" npm --prefix frontend run test:apps` | 12 项应用中心和 PWA 回归通过 |
| 宿主 | `git diff --exit-code`、`git status --short` | 源码工作区干净，完整 SHA 和 Git tree 与兼容性记录一致 |

完整 E2E 最终命令如下。`$hostDir` 为当前获授权的宿主工作区，`$releaseDir` 是调用者 TMPDIR 中本轮新建的隔离目录；Cargo 与固定 Node 目录预先加入 PATH，公开文档不写本机私有绝对路径。

```bash
TGDRIVE_HOST_DIR="$hostDir" \
TGDRIVE_APP_CATALOG_DIR="$releaseDir/candidate-dist/apps" \
CARGO_TARGET_DIR="$hostDir/target" \
TGDRIVE_READER_PREVIOUS_PACKAGE="$releaseDir/reader-1.0.1.tgapp" \
TGDRIVE_READER_PREVIOUS_STABLE_PACKAGE="$releaseDir/reader-1.0.2.tgapp" \
TGDRIVE_READER_PREVIOUS_LATEST_PACKAGE="$releaseDir/reader-1.0.3.tgapp" \
TGDRIVE_CAPTURE_SCREENSHOTS=1 \
TGDRIVE_APPS_E2E_REUSE=0 \
PLAYWRIGHT_APPS_OUTPUT_DIR="$releaseDir/candidate-integration-results" \
npm run test:e2e
```

初轮定向测试退出 1：两项新滚动夹具只改 padding，不能触发默认内容盒 ResizeObserver；末页准备断言把比例精度设得过高，约 1px 页高舍入被误判为失败。改为上方 figure 内容盒变化和不超过 2px 的实际画面误差后，定向三项及最终完整 69 项均通过；产品修复代码未因此改动，没有忽略失败用例。

## 安装与剩余风险

- 宿主 `>= 0.3.3` 时，在应用中心刷新目录并更新阅读馆至 1.0.4，或下载 `.tgapp` 导入；无需重建宿主镜像或重启。1.0.2/1.0.3 普通升级保留已有书库与分组。
- `npm audit --json` 实际退出 1：低危 1、中危 1、高危 2、严重 2，共 6 项，涉及 DOMPurify、@vitest/mocker、source-map-js、Vite、tinypool、Vitest。依赖未改，未运行 `npm audit fix`，不将安全审计记为通过。
- 未执行生产安装、部署、真实 Telegram 网络、实体 iPhone Safari/主屏幕验收、全仓格式化或 clippy。Cargo 忽略项为常驻服务型夹具及需真实 Telegram 的历史探测；前者已由本机集成实际启动。
- WebKit 与受控合成器位移模拟不能替代真机惯性、地址栏伸缩和前后台切换验收。建议升级后分别验证连续前进/回看、慢网络迟到图片、章节末尾、旋转及进度重开。
