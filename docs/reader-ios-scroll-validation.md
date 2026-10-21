# 阅读馆 iOS 漫画滚动瞬跳修复验证

本记录对应用户授权发布之前的源码修复与本地独立验证，不是发布或部署记录。后续 1.0.4 发布另见 [发布验收记录](reader-1.0.4-release.md)，不将后续发布行为追记为当时已执行。插件 base SHA 为 `82565d9dbac1bfae74432422bb194785dce6054d`，在 dirty 工作区验证；当时根目录已发布的 reader 1.0.3 包、catalog 和 SHA256SUMS 保持不变。

## 定位与修复

问题在 `comics/comic.ts`，有两条会打断原生滚动的路径：

1. `settleTo()` 将高度变化完全吸收进滚动债后，仍调用 `syncScroll(target)`。`target` 对应捕获锚点时的旧坐标，iOS 合成器在同步尺寸变更期间继续推进的滚动位置会被回写撤销。新增单测在尺寸修改期间分别注入 `+80px/-80px` 原生位移，旧代码两种情况均回写 `20600`，撤销这段位移。
2. 防截断的下方占位原来只在 `measure()` 内扩大，删除旧挂载节点或修改图片尺寸可能已经触发了布局缩短。真实 Chromium 在从倒数第二页跨到末页时，先把坐标截断为 `24500`，阅读器再回写 `25680`；这类额外赋值也会中断惯性。

修复：

- 高度变化完全吸收后直接保留实时滚动坐标，不再比较或回写旧锚点坐标。停稳后仍一次性结清滚动债，保持画面与阅读位置一致。
- 抽出 `guardScroll()`，在删除旧节点、安装探测尺寸、整图尺寸修改及测量重排之前保护滚动范围。重复保护只扩大、不缩小，测量完成后统一还原。
- 保留五页挂载、四十一页局部轨道、尺寸探测、估高学习、显式跳页、横竖屏比例恢复和上方占位不足时的必要坐标补偿。

## 回归覆盖

- `comics/comic.test.ts` 新增三项：同步重排期间正反向原生位移、章节末尾换窗；夹具主动模拟节点删除后的浏览器即时坐标截断。
- `tests/standalone/comics.spec.ts` 新增三项真实浏览器回归，分别核对末页换窗没有额外坐标赋值，以及正反向重排期间实际图片位置、页码和停稳后的债务结清。
- 同步重排期间的位移由夹具调用浏览器原生 setter 模拟，不冒充实体 iOS 合成器验证；已有 Chromium CDP 用例继续验证真实触摸及松手惯性。
- WebKit 无 Chromium CDP，两个真实触摸注入用例明确跳过。非 CDP 的移动 WebKit 用例使用原生坐标推进，不调用其不支持的 `mouse.wheel`。
- 阅读馆统一入口夹具仅放行自身 origin 创建的 `blob:` 图片。此前 WebKit 将它们误判为外部请求并阻断，导致两项全屏几何用例图片无法解码；外部网络请求仍全部阻断，不修改产品图片读取逻辑。

## 实际验证命令与结果

JavaScript 命令均使用 Node.js **22.22.0**。`$validationDir` 为调用者 `TMPDIR` 下本轮新建的隔离目录；浏览器产物使用互不冲突的 `PLAYWRIGHT_APPS_OUTPUT_DIR` / `PLAYWRIGHT_READERS_OUTPUT_DIR`，未写入公开仓库。

| 实际命令 | 退出结果 |
| --- | --- |
| `npm ci` | 0，安装 103 个包，锁文件未改 |
| `TGDRIVE_APP_BUILD_OUTPUT="$validationDir/dist" npm run check` | 0，严格类型检查和三插件隔离构建通过 |
| `npm test` | 0，61 个文件、640 项通过 |
| `npm run catalog verify ./catalog.json` | 0，既有发布目录与三包一致；不表示发布包已包含本次修复 |
| `sha256sum -c SHA256SUMS` | 0，既有根目录分发资产完整性通过 |
| `npm run catalog verify "$validationDir/dist/catalog.json"` | 0，当前源码隔离构建的三包与目录一致 |
| 在隔离输出目录运行 `sha256sum -c SHA256SUMS` | 0，隔离构建包摘要通过 |
| `npm run test:comics` | 0，Chromium 11 项通过 |
| `npm run test:comics -- --browser=webkit` | 0，WebKit 9 项通过，2 项 CDP 用例明确跳过 |
| `npm run test:readers` | 0，统一阅读馆 Chromium 19 项通过，含 TXT/EPUB/PDF/CBZ/ZIP/图片目录 |
| `npm run test:readers -- --browser=webkit --grep '漫画全屏\|真实漫画\|长条漫快速\|参差条漫\|混合书库同入口'` | 0，统一入口 WebKit 定向 8 项通过，不是全量 WebKit 验证 |
| `git diff --check` | 0 |
| `git diff --exit-code -- apps catalog.json SHA256SUMS sdk package.json package-lock.json reader/app.json` | 0，既有发布资产、SDK、依赖和版本声明未变 |

初轮 WebKit 漫画定向命令退出 1：一个旧用例调用移动 WebKit 不支持的 `mouse.wheel`。初轮统一入口 WebKit 定向命令退出 1：8 项中 6 项通过、2 项因夹具阻断本地 Blob 而失败。上述夹具兼容问题已修正，最终源码的命令均重新执行并得到表中结果；没有将失败轮次记为通过。

## 未执行项与剩余风险

- 未执行跨库宿主 E2E、实体 iPhone Safari/主屏幕窗口验收、生产安装、部署、提交或推送。宿主源码、配置与生产数据没有修改；未读取生产 `.env` 或连接真实网盘。
- 临时构建仍沿用源码的 1.0.3 声明，仅供本地验证，不能替换或发布为既有 1.0.3。正式更新须提升 reader 版本、完成发布门禁并生成新的分发资产；不能覆盖同版本包。
- `npm ci` 报告既有依赖 6 项漏洞（低危 1、中危 1、高危 2、严重 2）。本轮不修改依赖或执行 `npm audit fix`，不将安全审计记为通过。
- WebKit 自动化和受控位移测试不能替代真实 iOS 惯性、地址栏伸缩及系统前后台切换验收。建议真机分别验证连续前进/回看、慢网络迟到图片、章节末尾、旋转与进度重开。
