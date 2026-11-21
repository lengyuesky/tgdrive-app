# 智能体工作守则

本指南适用于应用源码、契约、SDK、测试替身和打包工具。

## 仓库边界与授权

- 宿主是独立仓库。应用任务不得修改宿主源码、配置、数据或原生客户端；获授权的接口资料只读查看。
- 宿主只提供与内容无关的通用能力。格式解析、内容组织、联网资料源、业务配置与应用数据版本处理全部属于应用。
- 不兼容旧实现、不保留旧应用数据、不加旧协议别名或降级兼容层。
- 保全已有工作区改动，不回退他人代码。多人协作使用独立工作树，根锁文件冲突重新生成。
- 提交、推送、创建外部资源、发布、部署、生成凭据等操作须维护者明确授权，代码修改任务不隐含这些授权。
- 开发和测试不得读取生产配置、连接生产数据库或操作真实网盘。不得把宿主源码、日志、凭据、构建产物或测试 trace 上传外站。

## 代码与文档

- 新增注释、说明文档和提交信息使用中文；保持 TypeScript 严格模式与真实行为测试。
- 线上 DTO、常量、权限与地址以 `contract/` 和 `docs/contract.md` 为唯一出处。生成类型不手工编辑；契约问题先报告维护者。
- 页面通过 `@tgdrive/page-sdk` 直接访问宿主，后端使用 `tgdrive-backend-sdk`。不得在应用里再写请求队列、限流退避、续签或通用票据重签层。
- 共用界面资源来自 `@tgdrive/ui`；应用不能相对引用其他应用或另一仓库的源码、依赖、符号链接。
- 所有页面资源、worker、字体和第三方许可随包携带，不依赖 CDN。尚未声明的第一方许可不得自行补写。
- 分页只看 `next_cursor`；文件变更以 `has_more` 与 checkpoint 核对。不能以页内数量判断结束，不能全库截断。
- KV 写入/删除必须有条件；单值 32 KiB，没有跨键事务。应用处理冲突与自身数据版本，不调用不存在的宿主业务设置或迁移回调。

## 验证与构建

Node.js 固定 22.22.0，Rust 固定 1.99.1（`rust-toolchain.toml`）；cargo 命令前加 `PATH="$HOME/.cargo/bin:$PATH"`；Python 优先使用 uv 虚拟环境。

```bash
npm ci
npm run typecheck
npm test
npm run contract:check
PATH="$HOME/.cargo/bin:$PATH" cargo test --workspace --locked --all-features
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --workspace --locked --all-targets --all-features -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo fmt --all --check
```

测试替身与示例在本仓库独立运行，不依赖跨仓库夹具。真实宿主联调由获授权的集成任务负责，未执行不能声称端到端通过。

构建使用 `tools-v1/`、`app-tools/`，输出必须是仓库外且尚未创建的隔离目录，不把源码目录直接打包。临时数据放调用者的 `TMPDIR`；依赖、target、dist 与测试产物不提交。同版本同目标的清单和 ZIP 不可变；目录与不可清空的发布历史跟踪在 main，包只在 GitHub Release。CI 只检查，正式发布仅通过维护者明确触发的 main 手动工作流；不覆盖资产、不移动已有标签、不强推。

报告记录实际命令、退出结果、未执行项和剩余问题，不能把旧日志或只收集测试计为通过。更多步骤见 [应用开发指南](docs/app-development.md) 与 [贡献指南](docs/contributing.md)。
