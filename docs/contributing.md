# 代码贡献指南

## 开发方式

使用 Node.js 22.22.0 与锁文件安装依赖；Rust 固定 1.99.1（`rust-toolchain.toml`），cargo 加入 PATH。Python 优先使用 uv 虚拟环境。开发者无需检出私有宿主。

- 契约：`contract/` 是机器可读的唯一出处，[契约文档](contract.md) 规定动态语义；TypeScript 类型由 Rust 生成。
- 页面：依赖 `@tgdrive/page-sdk`，在沙箱 iframe 里直接 `fetch` 宿主；界面交互使用 `tgdrive.ui.v1`。
- 后端：依赖 `tgdrive-backend-sdk`，在 Linux 以独立用户运行，经指定 Unix 套接字调用宿主。自由联网能力属于应用后端，不属于页面或宿主网络代理。
- 共享界面：按包名引用 `@tgdrive/ui` 与 `@tgdrive/ui/base.css`，不跨应用相对引用。
- 测试：TypeScript 使用 `@tgdrive/test-host`，Rust 使用 `tgdrive-test-host`；两者共用 Rust 内存核心，测试只提供合成文件。
- 构建：`tools-v1/` 负责冻结源码、页面编译与原生 musl 构建，`app-tools/` 校验真实 ZIP/ELF 和确定性打包。参照 `examples/`，示例不发布。

新代码注释、文档与提交信息使用中文，保持严格类型与行为覆盖。应用自身的解析、内存限额、业务数据版本和冲突处理由应用负责；请求队列、传输重试和会话续签直接使用 SDK，不重复实现。

## 自检

```bash
fnm use 22.22.0
npm ci
npm run typecheck
npm test
npm run contract:check
PATH="$HOME/.cargo/bin:$PATH" cargo test --workspace --locked --all-features
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --workspace --locked --all-targets --all-features -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo fmt --all --check
```

四款应用均已接入类型检查与单测，SDK/契约/打包工具一起检查；不保留旧 SDK 或旧管线。新应用要补文件发现、游标增量核对、CAS 冲突和关闭保存测试。分页以游标判断结束；KV 与小对象缓存限额引用契约，不另抄上限。

统一门禁与构建分别为 `npm run check:all -- --output "$NEW_CHECK_OUTPUT"` 和 `npm run build:all -- --output "$NEW_BUILD_OUTPUT" --probe`。传入尚未创建的仓库外目录，不把临时依赖、产物和日志提交进仓库。

独立测试通过不等于真实宿主、Telegram、浏览器 CSP 或官方客户端通过。报告必须说明未执行的真实联调范围，不能引用旧平台验收作为新平台证明。

## 发布与安全

所有编译/包输出使用新的仓库外目录。新平台包只放 GitHub Release，目录位于 main 根目录 `catalog.json`；`catalog-history.json` 与目录同一次提交，永久保留已见绑定。同版本同目标的包、摘要、大小与完整清单不可替换，后端同版本两个架构必须齐全且清单完全一致。

CI 自动检查 main push 与 PR，不发布内容。发布只允许维护者手动触发 main 上的 `release.yml`：完整门禁和原生双架构构建后，先核验/发布不可覆盖的资产，再无令牌下载核验，最后以分支头前置条件提交目录。失败从最新 main 重新手动运行，不删除资产或清空历史。详细升版规则与不联网演练见 [应用开发指南「CI 与发布」](app-development.md#8-ci-与发布)。

本仓库第一方代码与文档采用 MIT 许可，见根目录 LICENSE；同仓库应用包携带该许可，第三方许可、worker、cmaps、标准字体等实际运行资源保持原样随包携带，不以 MIT 覆盖第三方许可。不加载 CDN、远程字体或跟踪器，不上传私有宿主信息。

提交、推送、创建 Release/标签、部署须维护者明确授权。不得修改宿主与原生客户端，不读取生产配置或真实网盘。安全问题私下协调，不公开泄露攻击路径或凭据。
