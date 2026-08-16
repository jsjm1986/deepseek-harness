# CoHarness

[English](README.md) | 中文

**CoHarness 是面向团队协作的多用户智能体 Harness。**

CoHarness 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立维护项目，遵循 MIT 许可证。项目保留由 Cordis 驱动的插件化运行时，并增加共享项目空间、身份认证协作、管理控制和可部署的 Web UI。

## 主要能力

- **团队工作空间：**共享项目对话，同时保留参与者身份以及项目或私有可见性。
- **访问控制：**管理管理员与普通用户角色、项目只读或读写成员权限，以及目录授权。
- **集中治理：**通过统一 Gateway 管理用户和项目运行时、模型访问与用量信息。
- **插件架构：**通过 Cordis 插件组合工具、服务提供方、策略、界面和智能体行为。
- **自主部署：**可以在本机运行 Web UI，也可以将 Gateway 部署到自行管理的基础设施。

## 项目状态

CoHarness 目前处于发布前的持续开发阶段，配置、API 和持久化格式可能发生不兼容变更。

## 运行

需要 Node.js `^22.19.0` 或 `>=24.0.0`，以及 pnpm。

### 从源码运行

```sh
git clone https://github.com/jsjm1986/CoHarness.git
cd CoHarness
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

Web UI 默认地址为 `http://127.0.0.1:3080`。使用方法参见 [Web UI 指南](docs/user/guide/index.md)，多用户 Gateway 部署参见[生产部署手册](gateway/deploy/README.md)。

## 开发

修改运行时软件包前请阅读[架构文档](docs/architecture.md)。开发环境和仓库命令参见[开发指南](docs/development.md)，智能体贡献者必须遵循 [AGENTS.md](AGENTS.md)。

## 上游与许可证

CoHarness 是 DeepSeek AI 原始开发的 DeepSeek Harness 的独立衍生项目，并保留原始版权和许可证声明。

本项目使用 [MIT 许可证](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
