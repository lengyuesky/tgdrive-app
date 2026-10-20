# 阅读馆 1.0.1 发布验收记录

验收时间：2026-10-20 至 2026-10-21（上海时间）。用户明确授权继续完成阅读馆发布。本版通过插件仓库 `main` 分支的 `catalog.json` 与 `apps/` 分发，不创建 GitHub Release，不部署宿主或执行生产安装；提交及线上状态以实际 Git 记录和原始文件核验为准。

## 版本与边界

- 插件验收 base SHA：`b9d3a12154b9ecefe7f963102091dcff2d02ad58`。验收在包含本版修复、测试、截图和分发资产的 dirty 工作区执行，该 base SHA 不是本次发布提交。
- 实际验收宿主：`0100bee95726280268a329ac7c0956179acd9e07`，版本 `0.3.3`，Git tree 为 `f4f519b3e090e5c50b56a0feffc8465c72aba657`；全过程源码工作区干净。`compatibility.json` 记录该完整提交和本报告。
- JavaScript 命令使用 `fnm exec --using=22.22.0`；Rust 使用本机 Cargo 1.99.0、rustc 1.99.0。
- 跨库验收显式配置 `TGDRIVE_HOST_DIR`、`TGDRIVE_APP_CATALOG_DIR`、`CARGO_TARGET_DIR`；启动前确认 4187 端口无占用，文件操作前核验 `/__apps_fixture` 身份。
- 全部集成仅使用临时 SQLite、独立临时封面库、内存 Telegram 和合成书漫及视频，不读取生产 `.env`、数据库、凭据或真实网盘文件。
- 日志、截图、trace 和真实旧包仅存于调用者 `TMPDIR` 下的本机隔离目录，不提交或上传宿主产物。

## 分发资产

| 项目 | 实际值 |
| --- | --- |
| 安装包 | `apps/reader-1.0.1.tgapp` |
| 大小 | 2,477,343 字节 |
| SHA256 | `5af19fc61b5b4d4f56e10487ff7e1af33f0a133c41afd55915e0f965c859ce68` |
| 最低宿主 / API | `0.3.3` / `2` |
| Catalog | schema_version 2，三条官方最新版记录 |
| Catalog SHA256 | `ae51dabd5ad52b72c1f4ee7306d6ce4189a21047561a026740621d95a128c01e` |

影视 `1.4.5` 和短视频 `1.4.6` 包与上一提交字节相同，SDK、依赖清单和锁文件未变化。阅读馆替换根目录旧 `1.0.0` 包，包、catalog 和 SHA256SUMS 必须随本次发布同一提交更新；没有删除基线、降版或跳过同版本不可变校验。

最终 reader 归档包含 209 个条目：SDK、PDF worker、169 个 CMap、16 个标准字体资源、ZIP/DOMPurify/PDF.js/core-js 许可证与 NOTICE，以及 `home.png`、`mobile-library.png`、`mobile-reading.png`、`mobile-sidebar.png` 四张正式截图。逐一验证包内截图与源码截图字节相同；本轮还通过真实宿主合成混合库运行发布截图采集，不以文件存在代替界面验收。

## 实际门禁

以下最终命令退出码均为 0；表中数量是实际完成结果，不引用上一版日志。

| 工作区 | 命令 | 最终结果 |
| --- | --- | --- |
| 插件 | `fnm exec --using=22.22.0 npm ci` | 安装 103 个包，审计 104 个包；保留原锁文件 |
| 插件 | `fnm exec --using=22.22.0 npm run check` | 类型检查及全部三款插件最终生产构建通过；重复构建归档摘要不变 |
| 插件 | `fnm exec --using=22.22.0 npm test` | 59 个文件、617 项通过 |
| 插件 | `PLAYWRIGHT_READERS_OUTPUT_DIR="$readersResults" fnm exec --using=22.22.0 npm run test:readers` | 17 项真实统一入口浏览器回归通过 |
| 插件 | `PLAYWRIGHT_APPS_OUTPUT_DIR="$comicsResults" fnm exec --using=22.22.0 npm run test:comics` | 8 项底层漫画真实滚动及惯性回归通过 |
| 插件 | 下方完整 E2E 命令 | 最终 61 项通过，零失败、零跳过 |
| 插件 | `fnm exec --using=22.22.0 npm run catalog verify ./catalog.json` | 三条目录及真实包的摘要、大小、完整 manifest 通过 |
| 插件 | `sha256sum -c SHA256SUMS` | 三款安装包和 catalog 全部匹配 |
| 插件 | `git diff --exit-code -- apps/cinema-1.4.5.tgapp apps/shorts-1.4.6.tgapp sdk package.json package-lock.json` | 其他插件、SDK 与依赖未变化 |
| 插件 | `git diff --check` | 通过 |
| 宿主 | `cargo test --locked` | 343 项通过、2 项按定义忽略 |
| 宿主 | `fnm exec --using=22.22.0 npm --prefix frontend run check` | 前端类型检查与生产构建通过 |
| 宿主 | `fnm exec --using=22.22.0 npm --prefix frontend test` | 36 个文件、209 项通过 |
| 宿主 | `CARGO_TARGET_DIR="$hostTarget" PLAYWRIGHT_APPS_OUTPUT_DIR="$hostResults" fnm exec --using=22.22.0 npm --prefix frontend run test:apps` | 12 项应用中心浏览器回归通过 |
| 宿主 | `git diff --exit-code` / `git status --short --branch` | 源码无改动，工作区干净 |

完整插件 E2E 的实际环境与命令如下；变量均为显式绝对路径，`releaseDir` 为本轮新建的本机临时目录，`hostDir` 为获授权宿主工作区。Cargo 可执行路径提前加入 PATH。

```bash
TGDRIVE_HOST_DIR="$hostDir" \
TGDRIVE_APP_CATALOG_DIR="$pluginDir/apps" \
CARGO_TARGET_DIR="$hostDir/target" \
TGDRIVE_READER_PREVIOUS_PACKAGE="$releaseDir/reader-1.0.0.tgapp" \
TGDRIVE_CAPTURE_SCREENSHOTS=1 \
PLAYWRIGHT_APPS_OUTPUT_DIR="$releaseDir/final-integration-results" \
fnm exec --using=22.22.0 npm run test:e2e
```

真实旧包从插件 base 提交的 `apps/reader-1.0.0.tgapp` 导出到临时目录，SHA256 验证为 `00a5a8f8b7af6916bad849a2d86004d0a369ee71a555ebcc44d03260a303e4fe`。升级用例先经宿主 inspect/install 安装该包，再通过应用中心真实导入 `1.0.1`，逐项核对来源、偏好、阅读进度和书签未变化，并打开漫画验证旧滚动、适宽和缩放偏好继续生效。

## 初轮失败及修正

初轮完整插件 E2E 为 59 项通过、2 项失败，退出码 1，未据此发布。新增全屏、侧栏、真实旧包升级及截图用例已经通过。两项失败经实现与实际 DOM 核对后仅修正测试，不改产品接口或放宽资源限制：

1. 旧测试从最近进度列表首条读取 TXT 字符 offset，但统一阅读馆同时保留漫画进度，首条可能是漫画记录。改为按当前 TXT 节点 ID 读取 `progress:<id>`，等待真实字符 offset 后再校验字号变化保持位置。
2. 旧测试假设滚动 3000px 必定进入第五页；新版适宽会等比例放大小图，实际当时位于第二页，相邻窗口四页是正确结果。改为按真实图片页高使用浏览器滚轮逐页前进，断言实际页码、滚动坐标和每一步准确的相邻挂载窗口，移除固定等待。

修正后先运行定向 E2E（`--grep '长漫画窗口|条漫模式连续滚动'`），2 项通过；随后重跑完整 61 项全部通过。最后重新依次执行 `npm ci`、`npm run check`、`npm test`、catalog 校验及全摘要校验，全部通过，最终包摘要保持不变。

## 安装、升级与限制

- 宿主满足最低版本时，在应用中心刷新目录安装或更新即可，也可下载 `.tgapp` 手动导入；不需要重建镜像或重启宿主。
- `reader 1.0.0 → 1.0.1` 是同 ID 普通升级，保留现有来源、偏好、进度和书签。首次替换旧 `books`、`comics` 仍需明确确认清理其私有数据，不做跨 ID 无损迁移；网盘原文件和网盘收藏保留。
- 本轮不运行生产安装、宿主部署、真实 Telegram 网络测试、实体 iPhone Safari、全仓格式化或 clippy。Cargo 两项忽略分别为服务型浏览器夹具和需要真实 Telegram 环境的历史探测；夹具已由上述浏览器门禁单独实际启动。
- `npm audit --json` 实际退出 1，仍有既有 5 项漏洞：低危 1、中危 1、高危 1、严重 2。严重项涉及测试工具链 Vitest/tinypool，高危项为构建依赖 source-map-js；运行依赖 DOMPurify 仍有低危提示。本轮不自动升级依赖、不改锁文件、不声称安全审计通过。
- 自动化使用本机 Chromium、模拟手机及 iOS 安全区，不等同于实体 iPhone Safari 验收。正式源码截图只包含合成库，不包含用户网盘内容。
