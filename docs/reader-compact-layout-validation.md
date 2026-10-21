# 阅读馆书库紧凑布局独立验证

验证日期：2026-10-21。本文记录用户授权发布之前的源码优化阶段；后续正式 1.0.3 发布另见 [发布验收记录](reader-1.0.3-release.md)，不将后续发布行为追记成当时已执行。插件 base SHA 为 `6fee73580abf6838e9245a0bcb2cb66c611a8d1a`，独立验证在未提交的 dirty 工作区执行。当时源码清单和已发布包仍为 `reader 1.0.2`，尚未发布新版本。

## 改动范围

- `reader/ui/library-view.ts`：手机默认折叠筛选和分组操作；展示非默认条件数量，支持保留当前书库与搜索的筛选重置。分组筛选并入同一筛选区，多选移动栏独立展示，进入多选自动收起筛选。
- `reader/ui/nav.ts`、`reader/style.css`、`reader/shelf.css`：压紧插件顶栏，设置和返回使用有无障碍名称的图标；书库标题和路径合并，消除段落外边距与容器间距的叠加，保留 44px 手机点击区域。
- `reader/ui/library-toolbar.test.ts`、`reader/ui/nav.test.ts`：覆盖折叠状态、条件计数、重置范围、多选操作、视口切换、监听清理与图标操作。
- `tests/standalone/readers.spec.ts`：新增紧凑首屏和桌面长标题浏览器验证，原分组和格式测试通过可见入口展开筛选；断言真实内容区无横向溢出。
- `tests/browser/`：只调整手机筛选与目录全部文件入口的操作步骤，本轮未运行跨库测试。

未修改宿主源码、SDK、持久化数据契约、依赖清单、锁文件、根分发资产或兼容性记录；未读取生产 `.env`、数据库或真实网盘文件。

## 实际验证命令

所有命令均在插件仓库执行，通过 `fnm exec --using=22.22.0` 使用固定的 Node.js 22.22.0。`npm ci` 在本轮检查前执行；完整门禁依次执行如下。构建输出使用 `mktemp -d` 在调用者 `TMPDIR` 中生成的新目录，下表以 `$验证目录` 表示该目录，不写入本机私有绝对路径。

| 实际命令 | 退出结果与范围 |
| --- | --- |
| `fnm exec --using=22.22.0 npm ci` | 退出 0，安装 103 包、审计 104 包；审计报告 6 项风险，未自动修改依赖 |
| `TGDRIVE_APP_BUILD_OUTPUT="$验证目录/build" fnm exec --using=22.22.0 npm run check` | 退出 0，严格类型检查和 shorts、reader、cinema 的隔离构建通过 |
| `fnm exec --using=22.22.0 npm test` | 退出 0，61 文件、637 项通过 |
| `fnm exec --using=22.22.0 npm run catalog verify ./catalog.json` | 退出 0，核验根目录既有的 3 个已发布包，不表示本轮源码已发布 |
| `sha256sum -c SHA256SUMS` | 退出 0，根目录既有资产摘要通过 |
| `fnm exec --using=22.22.0 npm run catalog verify "$验证目录/build/catalog.json"` | 退出 0，核验本轮隔离构建的 3 个包 |
| `(cd "$验证目录/build" && sha256sum -c SHA256SUMS)` | 退出 0，隔离构建资产摘要通过 |
| `fnm exec --using=22.22.0 npm run test:readers` | 最终退出 0，19 项 Chromium 独立浏览器测试全部通过，覆盖手机、桌面、分组、全部阅读格式及触摸滚动 |
| `fnm exec --using=22.22.0 npm run test:comics` | 退出 0，8 项底层漫画真实几何与惯性滚动测试通过 |
| `fnm exec --using=22.22.0 npm run test:readers -- --browser=webkit --grep '手机书库紧凑\|桌面书库常驻'` | 退出 0，2 项 WebKit 紧凑布局、筛选和多选测试通过，不等于 WebKit 全量回归 |
| `git diff --check` | 退出 0 |

前置的类型检查、定向 Vitest、2 项 Chromium 布局检查也通过。最终以完整 637 项 Vitest 与 19 项 Chromium 结果为准，不累加重复运行的用例数。

## 真实界面与构建边界

- 390×844 的独立移动页面中，插件顶栏约 49px，书库标题与路径约 44px，首行封面在插件页面顶部约 220px 出现；320、390、430、768 窄屏首行均在 225px 内出现。
- 折叠后顶栏、搜索刷新、浏览方式和返回书库按钮均保留不少于 44×44px 的点击区域。底部导航贴底，内容区只能上下滚动。
- 展开后格式筛选、条件计数、重置、分组创建与批量移动可用；进入多选后筛选收起，但移动和退出按钮仍可操作。只有筛选实际变化才清空选择，单纯折叠不清空。
- 真实浏览器截图写到调用者临时测试产物目录，包括 `mobile-library-compact.png`、`mobile-library-expanded.png`、`mobile-library-filtered.png`、`mobile-library-selection.png`、`desktop-library-compact.png`。已人工查看折叠、展开、多选与桌面截图；未替换包内正式截图。
- 本轮构建的 shorts、cinema 包与根目录同版本资产逐字节一致，只有 reader 改变。reader 隔离包仍使用当前源码清单，仅用于验证，不能作为同版本更新分发：正式发布必须升版、更新正式截图，并同步生成包、catalog 与 SHA256SUMS，不得覆盖既有 1.0.2 包。

## 未执行项与剩余风险

- 未运行跨库 E2E、宿主构建、生产安装、部署、提交或推送；调整过的跨库步骤只通过本轮 TypeScript 检查，不能宣称已验证真实宿主集成。
- 未在真实 iPhone、Safari PWA 或系统状态栏安全区内验收。WebKit 仅覆盖上述 2 项独立布局测试；宿主工具栏及系统安全区未修改。
- `npm ci` 报告低危 1、中危 1、高危 2、严重 2。本轮未更改依赖或运行 `npm audit fix`，依赖风险需单独评估处理。
- 构建保留现有 SDK 非模块脚本提示；PDF 损坏文件回归产生预期解析警告，命令均退出 0，未通过隐藏警告规避门禁。
- 在本文独立验证阶段，代码改进尚未进入已发布插件。根目录包校验通过仅证明当时的既有资产完整；后续 1.0.3 发布以单独发布报告和真实 Git 记录为准。
