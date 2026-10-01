# 短视频 1.2.0

## 播放与操作

- 视频地址与封面独立请求；封面迟到或失败不阻塞视频首帧，切换后旧结果不覆盖当前项。
- 当前视频开始播放后，只预取下一条的播放地址，最多保留一条、30 秒内复用；不创建隐藏播放器，也不提前下载下一段视频。
- 底部显示播放进度、缓冲进度与时长，支持拖动定位。播放时拖动会暂时暂停，松手后继续；原本暂停的仍保持暂停。
- 点按画面或播放按钮控制暂停。桌面空格播放/暂停、上下键换视频、左右键前后移动 5 秒、M 切换声音、Esc 退出；输入框、进度条和按钮获得焦点时保留原生键盘行为。
- 一次滚轮惯性只切换一条；手机上下滑动切换，忽略多指与横向手势，滑动后的尾随轻点不再暂停新视频。
- 手动暂停后切换声音保持暂停。切后台自动暂停，回到前台只恢复原本想播放的视频。
- 加载提示延迟 220ms，减少快速切换时的闪烁；自动播放限制显示手动播放入口，加载失败可重试同一条或切换下一条。
- 手机顶部可直接更换取材文件夹，标题最多显示两行；进度条与主要操作保留至少 44px 点击区域，并适配小屏横屏。

关闭应用会取消列表请求、清空媒体地址并终止旧 Range 读取，移除事件监听。图书、漫画、影视插件及宿主源码未修改。

## 独立验证

单测使用真实入口脚本与 HTML，只隔离宿主 SDK 和媒体解码。浏览器测试由 `ffmpeg` 合成 MP4，在内存路由中提供 Range 响应，不访问真实网盘或外部视频。

```bash
npm test -- tests/unit/shorts.test.ts
npm run test:shorts
npm run test:shorts -- --browser=webkit --grep-invert '手机真实上滑'
```

触摸注入使用 Chromium CDP；WebKit 验证实际媒体播放、进度拖动、切换与布局。布局覆盖 320×568、390×844、568×320、844×390、768×1024、1440×900，并检查按钮是否被其他元素遮挡。未执行实体手机测试。

## 本次验收

2026-10-01，Node.js 22.22.0。

| 命令 | 退出结果 |
| --- | --- |
| `npm ci` | 0 |
| `TGDRIVE_APP_BUILD_OUTPUT="$build_dir" npm run check`，变量为新建临时目录 | 0，类型检查与四插件构建通过 |
| `npm test` | 0，46 个文件、520 项通过 |
| `npm run catalog verify ./catalog.json` | 0，真实包与目录匹配 |
| `sha256sum -c SHA256SUMS` | 0，全部通过 |
| `npm run test:shorts` | 0，5 项通过 |
| `npm run test:shorts -- --browser=webkit --grep-invert '手机真实上滑'` | 0，4 项通过 |
| `npm run test:e2e`，显式提供 `TGDRIVE_HOST_DIR` 与临时 Cargo 包装器 | 0，44 项完整通过，包含短视频实际播放、暂停拖动、设置和退出取消传输 |

宿主使用 `compatibility.json` 中的提交 `de1cf4273966fda313a36d7f625602154d4dfd8d`；集成仅运行临时数据库、内存网盘及合成媒体，测试服务验收后关闭。

沿用本机已确认的压缩差异处理：隔离构建后，将未变更插件的新旧包逐成员解压比对；文件名集合与所有内容完全一致才保留原发布包。本次只替换短视频 1.2.0，目录通过 `catalog generate --previous=原目录` 和真实包校验，同版本摘要保护保持启用。

容器镜像构建初次执行 `docker compose build tgdrive` 遇到镜像仓库 503，两次退出 1；随后用临时 Dockerfile 将四个基础镜像固定为上一轮已验证的相同 digest，执行 `docker build --pull=false -f 临时Dockerfile -t tgdrive:latest .`，退出 0。没有修改宿主仓库的 Dockerfile 或升级基础镜像。

`docker compose up -d --no-deps --force-recreate tgdrive` 已完成容器重建；`docker exec tgdrive-tgdrive-1 tgdrive healthcheck` 退出 0、返回 `ok`，容器状态为 `running healthy`。`docker image prune -f` 退出 0，检查后无悬空旧镜像。

浏览器测试中的合成 MP4 验证常见播放路径；MKV、AVI 等格式仍取决于浏览器本身的解码支持，不支持时会显示明确提示和下载入口。
