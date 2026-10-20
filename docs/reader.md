# 统一阅读馆

官方分发改为 `shorts`、`reader`、`cinema` 三款。阅读馆 `reader 1.0.0` 要求宿主 `0.3.3`，在同一个来源列表内浏览 TXT、EPUB、PDF、CBZ、ZIP 和图片目录。`books/`、`comics/` 的底层解析器源码和回归保留，独立官方分发入口退役。

## 混合内容与阅读偏好

同一应用按文件真实格式选择文字、PDF 或漫画解析器；作品内容种类仍为 books/comics，不能把这些数据种类批量改为 reader。混合书库支持格式筛选，宿主全库查询可选择全部、图书或漫画。书签、阅读进度和偏好属于 reader 的应用私有存储。

阅读馆首装无偏好时，文字默认分页、漫画默认单页并适页、PDF 默认适页；手机进入正文时隐藏工具栏，桌面初始显示工具栏。已有显式阅读偏好继续生效。原 books/comics 解析器的滚动模式回归通过显式偏好或独立解析器夹具保留。

## 旧应用替换与清理

宿主 0.3.3 的安装预览会列出阅读馆替换的已安装旧图书/漫画应用，并说明应用私有数据清理范围。确认替换后，旧应用的进度、书签、偏好、书库配置及恢复快照会清理，不会自动迁移至 reader。网盘原文件及网盘收藏继续保留；取消安装不会执行替换或清理。需要替换的应用必须单独确认，普通批量更新不承担这一清理动作。

安装前请保留自己需要的旧进度与书签记录；确认后在阅读馆重新添加来源。仅从 catalog 移除旧包不等于旧应用数据已经迁移，不能把保留解析器源码描述成跨 ID 无损升级。

## 构建与验证

`build.mjs` 仅构建 shorts、reader、cinema。reader 包同时携带 ZIP、DOMPurify、PDF worker、cmaps、standard_fonts，以及 ZIP/DOMPurify/PDF.js/core-js 和字体许可、NOTICE。不得依赖旧 books/comics 安装包或远程 CDN。SDK 改动若改变其他插件归档摘要，必须按同版本不可变规则检查并协调升版。

`npm test -- tests/unit` 验证三款分发、reader 清单版本、资源许可、退役包清理和同版本防篡改；所有分发构建使用合成临时输出，不依赖根目录已有 reader 包。`npm run test:readers` 使用真实 reader 入口与内存 Drive，保留书/漫内容夹具，新增 390/1280 两视口混合阅读切换。`npm run test:comics` 继续直接回归底层漫画几何与滚动。

跨库用例位于 `tests/browser/`，通过 reader 应用 ID 验证同库全部格式、移动阅读、来源、全库索引和平台集成。仅用显式 `TGDRIVE_HOST_DIR` 指向获授权宿主，使用临时数据库、内存 Telegram 与合成媒体；同一时刻只能有一个服务占用 4187。Cargo 默认复用该宿主的 target 目录。截图只写测试产物，最终源码截图由维护者独立生成。

每次迭代构建使用新的空 `TGDRIVE_APP_BUILD_OUTPUT`；真实截图完成后才生成最终根目录分发资产，不清除已发布基线绕过保护。`compatibility.json` 的 host_ref 记录宿主 0.3.3 的实际验证提交，Git tree 与已通过本地验收的工作区一致。后续若验证未提交改动，须另外记录真实 base SHA、dirty 状态和验证范围。实际命令、最终结果、未执行项与限制见 [阅读馆验证记录](reader-validation.md)。

## 分发与测试适配阶段的实际检查

2026-10-20 使用 Node.js 22.22.0，命令通过显式 PATH 传递给子进程：

| 命令 | 实际结果 |
| --- | --- |
| `npm ci` | 退出 0，安装 103 个包、审计 104 个包；npm 报告低危 1、中危 1、高危 1、严重 2，未自动升级依赖 |
| `npm run typecheck` | 退出 0 |
| `npm test -- tests/unit` | 最终退出 0，7 文件、226 项通过；首次唯一失败为文档更新前的旧 books 示例，更新为 reader 后已复验 |
| `npx playwright test --list` | 退出 0，收集跨库 57 项，未启动宿主夹具 |
| `npx playwright test -c tests/standalone/readers.config.ts --list` | 退出 0，收集独立阅读馆 13 项 |

适配阶段的独立 readers 实跑因与主验证共用产物目录产生 trace 冲突而停止，退出 130；其局部通过项不计为完整通过。后续完整 readers、跨库、宿主测试、最终真实截图和根目录分发均由主验证记录汇总。本节不是最终发布验收，不将仅收集测试写成浏览器通过。
