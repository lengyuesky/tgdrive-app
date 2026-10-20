# 阅读馆 1.0.1 全屏与书库侧栏独立验证记录

验证日期：2026-10-20（上海时间）。本轮完成插件工作区中的漫画全屏适配和书库侧栏。独立验证结束后，用户明确授权提交并推送本轮源码、测试和文档；本次不执行部署、生产安装或根目录分发更新，提交与推送结果以实际 Git 记录为准。

## 环境与边界

- 全部 JavaScript 命令使用 Node.js 22.22.0，通过 `fnm exec --using=22.22.0` 执行。
- 插件 base SHA：`eb39a543f0cfb86e3a8b5676e2bef3609f6a9291`；上述独立验证执行于 dirty 工作区，目标阅读馆版本为 1.0.1，不能把该 base SHA 当作 1.0.1 验证提交。
- 宿主只读查看公开接口对应的源码；宿主 HEAD 为 `0100bee95726280268a329ac7c0956179acd9e07`，工作区保持干净。本轮不代表该宿主与本版插件已通过跨库集成。
- 所有浏览器夹具使用内存 Drive、合成 TXT/EPUB/PDF/CBZ/ZIP/图片目录，不读取生产 `.env`、数据库、凭据或真实网盘文件。
- 临时构建和浏览器产物通过 `mktemp -d` 写入调用者的 `TMPDIR`；每次独立浏览器运行使用不同输出目录，避免清理另一轮测试产物。

## 实际检查

以下命令均在插件工作目录运行，最终退出码全部为 0。`validationDir`、`readersResults`、`comicResults` 表示当次新建的隔离临时目录，不是仓库中的固定路径。

| 实际命令 | 最终结果 |
| --- | --- |
| `fnm exec --using=22.22.0 npm ci` | 安装 103 个包，审计 104 个包 |
| `fnm exec --using=22.22.0 npm run typecheck` | 严格 TypeScript 检查通过 |
| `TGDRIVE_APP_BUILD_OUTPUT="$validationDir" fnm exec --using=22.22.0 npm run check` | 类型检查与全部三款插件生产构建、真实归档生成成功，根目录资产未更新 |
| `fnm exec --using=22.22.0 npm test` | 58 个文件、614 项通过 |
| `PLAYWRIGHT_READERS_OUTPUT_DIR="$readersResults" fnm exec --using=22.22.0 npm run test:readers` | 17 项真实统一入口浏览器测试通过 |
| `PLAYWRIGHT_APPS_OUTPUT_DIR="$comicResults" fnm exec --using=22.22.0 npm run test:comics` | 8 项底层漫画滚动、异步布局与惯性回归通过 |
| `fnm exec --using=22.22.0 npm run catalog verify ./catalog.json` | 现有根目录三款真实包校验通过；reader 为旧版 1.0.0 |
| `sha256sum -c SHA256SUMS` | 现有根目录包与 catalog 摘要全部匹配 |
| `fnm exec --using=22.22.0 npm run catalog verify "$validationDir/catalog.json"` | 隔离目录的三款真实包校验通过；reader 为工作区 1.0.1 |
| `(cd "$validationDir" && sha256sum -c SHA256SUMS)` | 隔离验证包与 catalog 摘要全部匹配 |
| `cmp` 比较根目录与隔离目录的 shorts/cinema 包 | 两款归档字节完全相同，无需升版 |
| `git diff --check` | 通过 |

初轮新增单测的两个失败分别来自错误的合成分组快照和超过已有 3200 万像素限制的测试图片；改用真实 `BookGroupsStore` 生成夹具、合法像素尺寸后复跑通过，没有放宽生产校验。

初轮新增浏览器测试发现桌面阅读设置的关闭按钮被 `.mobile-only` 样式隐藏；修正桌面面板标题样式后，四项新增用例定向复跑及随后完整 17 项均通过。

## 覆盖行为

- 桌面主页侧栏占满高度，内容类型、来源目录、自定义分组分别路由到真实书库筛选；手机抽屉支持关闭按钮、遮罩、ESC、Tab 焦点循环及背景 inert 状态恢复。
- 类型/格式/来源/分组切换清空旧搜索、阅读状态与分页；返回阅读后保留选择，分组改名和跨设备事件更新导航；快速来源切换取消旧请求，迟到结果不能覆盖最终选择。
- 所有用户来源路径与分组名按纯文本渲染；导航未变化时保留 DOM，刷新时尝试恢复被替换按钮的焦点。
- 漫画在 390 和 1280 两视口使用完整正文区域、零内边距；工具栏显隐和面板开闭不改变漫画几何。小图适页可放大至视口高度，适宽铺满宽度，缩放作用于适配结果。
- 单页、双页和连续模式保持图片比例；CSS 尺寸上限同时约束两轴，不拉伸超长图片。宽高比不一致的适页留白是保全完整图片所必需，不是额外工具栏占位。
- 阅读馆桌面和手机均通过已声明的 SDK 能力请求宿主全屏，离开后撤销；桌面/手机菜单布局切换不反复退出宿主全屏，主题变化同步背景。不支持该能力的宿主不调用缺失接口。
- 既有 TXT/EPUB/PDF 解析、书签、混合库筛选、手机横竖屏、触控尺寸、长文件名、长条漫快速滚动与异步估高回归仍通过。

独立浏览器截图包括 `sidebar-home.png` 和 `comic-fullscreen.png`，位于当次测试输出目录，使用真实 Vite 构建和合成内容。它们不是本次更新的源码分发截图。

## 隔离构建产物

- 阅读馆验证包：`apps/reader-1.0.1.tgapp`，2,446,490 字节。
- SHA256：`a0beacbdbb6cf5badfa6a10c9d16a169136b256f35e5f82b0ff7c0782c9219bb`。
- 保留原第三方许可、PDF worker、cmaps、standard_fonts 与现有源码截图；本包用于工作区独立检查，不是正式分发资产。
- 根目录 `catalog.json`、`SHA256SUMS` 与 `apps/` 保持上一版状态，没有删除发布基线或同版本覆盖。

## 未执行项与剩余限制

- 未运行跨库 `npm run test:e2e`、宿主 Cargo/前端测试或真实宿主安装本版包。独立 SDK 替身验证不能替代宿主全屏、权限、授权、安装生命周期的集成验收。
- 未更新 `reader/screenshots/` 的正式分发截图，未生成最终根目录 1.0.1 分发资产；发布前须先完成真实截图、获授权的宿主集成验收，再生成并校验最终包。
- `compatibility.json` 保留上一版实际验证提交记录，未将本轮未执行的集成门禁标记为通过。
- `npm ci` 仍报告已有 5 项漏洞：低危 1、中危 1、高危 1、严重 2；本轮未变更锁文件或自动升级依赖。
- 浏览器验证使用本机 Chromium 和模拟手机，不等于实体 iPhone Safari 验收。
