# FNTV 0.1.2 封面与目录验收

2026-11-07。`fntv 0.1.2` 要求最低宿主 `0.3.7`，加入后台封面状态、缺图原因和现有刷新入口的重试说明。用户在完成隔离验收后授权提交及推送，宿主功能提交为 `6ab85fc57f31b568571ad271ccddfe60b37bded4`，由本轮 `compatibility.json` 记录为实际验证来源。宿主依次使用同目录海报、Telegram 已附带小图及受限截帧；完整约定记录在宿主的 `docs/fntv-cover-design.md`。

前期候选验收的插件 base SHA 为 `519ef5a357986867eddf516f5724f8640bcdf1dc`，宿主 base SHA 为 `c1cbc486837188cf4873d4da1be462c0a326ce16`，当时使用未提交工作区。当前分发包仍为相同的 12,471 字节，SHA-256 为 `8ef1d3087b684d31890337799961db07d2211b3c45040f6e86ca02449fd9dffa`。

前期构建通过 `TGDRIVE_APP_BUILD_OUTPUT` 写入宿主任务目录的 `tmp/fntv-covers-validation-20261107/plugin-build/`，没有改动正式目录。获得提交及推送授权后，再用 Node.js 22.22.0 在仓库重建正式四包；FNTV `0.1.2` 与候选逐字节相同，其他三款包与原提交逐字节相同。`catalog.json`、`SHA256SUMS` 和 `apps/fntv-0.1.2.tgapp` 一起更新，目录只保留四个最新版包。

## 实际检查

| 命令或范围 | 结果 |
| --- | --- |
| Node.js 22.22.0 的 `npm ci`、`npm run check` | 退出 0，类型检查和全部插件构建通过 |
| `npm test` | 退出 0，63 个文件、645 项全部通过 |
| 添加封面 E2E 后 `npm run typecheck` | 退出 0 |
| `npm run test:e2e -- tests/browser/fntv.spec.ts` | 退出 0，3 项全部通过 |
| 共享缓存及播放生命周期的四个浏览器测试文件 | 退出 0，10 项通过、1 项原有按需截图用例跳过 |
| 官方 `1.12.3 (1123003)` 客户端合成连接 | 新画面验收通过；补图后重新进入列表显示真实图片，详情、继续观看、剧、季、单集及三种来源通过 |
| 正式和候选目录的 `catalog verify` | 两处均退出 0，各核对四款插件及包 |
| 正式和候选目录的 `sha256sum -c SHA256SUMS` | 两处均退出 0，四包和目录摘要全部匹配 |

E2E 使用显式 `TGDRIVE_HOST_DIR`、独立候选包目录和临时宿主。先验证夹具身份，再操作合成账号和应用数据。FNTV 用例覆盖公开目录安装、授权配置、主动启动、原字节 Range、关闭页面继续运行、停服撤销登录和真实 `0.1.0` 候选包升级保留数据。

新增封面用例在真实 iframe 中确认就绪 1、失败 1，显示实际缺图原因，只有现有“刷新媒体库”入口；刷新会重试失败项并复用已成功图片。纯视频取得真实 JPEG，损坏视频仍保留原文件读取入口。旧宿主不返回 `covers` 时的提示由 UI 回归覆盖。

宿主另通过 392 项程序测试、Clippy、普通二进制编译、6 条完整临时宿主封面协议检查和 ARM64／AMD64 媒体组件验证。临时夹具正常停止，最终活动读取者为 0。完整结果见宿主的 `docs/fntv-cover-verification-20261107.md`。

## 提交源码与完整集成

为排除主工作区原有搜索、分享改动，宿主先单独暂存本次功能，再提交为 `6ab85fc57f31b568571ad271ccddfe60b37bded4`。测试使用 `git archive` 的独立导出，347 个文件的 Git blob 和执行位逐项匹配提交树 `45e1ad098f5ba1b318d75098816acea688686c4d`，没有混入未提交模块。`compatibility.json` 的 `worktree_dirty=false` 描述该导出，不描述仍保留其他修改的主工作区。

以下命令在本次提交门禁中实际执行，退出均为 0：

| 检查 | 实际结果 |
| --- | --- |
| 独立宿主 `cargo test --locked` | 388 通过，6 个显式集成夹具忽略 |
| 独立宿主 `cargo clippy --locked --all-targets -- -D warnings` | 通过 |
| 独立宿主前端 `npm ci`、`npm run build` | 通过 |
| 插件 `npm ci`、`npm run check`、`npm test` | 构建通过，645 项测试全部通过 |
| 完整 `npm run test:e2e` | 66 通过、7 跳过；其中 5 项需要显式旧包，2 项为按需截图生成 |
| 提供四个真实旧包后补跑 `reader-upgrade.spec.ts`、`reader-compact-upgrade.spec.ts` | 5 项升级全部通过；覆盖 1.0.1 默认迁移及 1.0.2／1.0.3／1.0.4 数据行、修订号保留 |
| 正式 `catalog verify`、`sha256sum -c SHA256SUMS` | 四包、目录、完整清单与摘要全部通过 |

两次浏览器运行合计覆盖全部 71 项行为回归，剩下 2 项为资源未变化的按需截图生成。本次 FNTV 管理页截图和官方客户端截图已另行取得；没有将旧截图写成新的通过证据。历史包直接从本仓库 Git 中读取，真实版本和摘要保存在本机任务目录，未从生产安装取包。

提交门禁日志位于宿主任务目录 `tmp/fntv-cover-commit-20261107-xASjXp/`，包括 `committed-host-source.json`、`host-tests.log`、`host-clippy.log`、`plugin-check.log`、`plugin-tests.log`、`browser-full.log`、`browser-legacy.log` 及历史包来源摘要。本仓库不上传私有宿主源码、构建产物或集成 trace。

## 交付状态

候选实现、隔离程序／管理页及指定官方客户端新增画面验证已完成。用户继续任务、解锁 Mac 后，用同一候选包和新的合成宿主，确认从占位到重新进入列表后取得图片的转换；未用旧截图或协议通过替代这一结果。临时宿主已正常停止，活动读取者为 0，合成连接失效。

本轮按用户授权提交源码与四包目录，兼容性记录指向实际验证的宿主提交。没有部署日常服务或创建新的宿主标签；完整候选 Docker 镜像及真实 Telegram／其他设备未验收。完整新客户端截图和边界见宿主的 `docs/fntv-cover-verification-20261107.md`。
