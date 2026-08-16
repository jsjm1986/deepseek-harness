# CoHarness

English | [中文](README.zh.md)

**CoHarness is a multi-user agent harness built for teams.**

CoHarness is independently maintained and based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) under the MIT License. It keeps the Cordis-powered, plugin-based runtime and adds shared project workspaces, authenticated collaboration, administrative controls, and a deployable Web UI.

## Highlights

- **Team workspaces:** share project conversations while preserving participant identity and project or private visibility.
- **Access control:** manage administrator and user roles, read-only or read-write project membership, and directory grants.
- **Central governance:** operate user and project runtimes through one Gateway with managed model access and usage visibility.
- **Plugin architecture:** compose tools, providers, policies, interfaces, and agent behavior as Cordis plugins.
- **Self-hosting:** run the Web UI locally or deploy the Gateway behind infrastructure you control.

## Status

CoHarness is under active pre-release development. Configuration, APIs, and persisted formats may change without compatibility guarantees.

## Run

Requirements: Node.js `^22.19.0` or `>=24.0.0`, plus pnpm.

### Run from source

```sh
git clone https://github.com/jsjm1986/CoHarness.git
cd CoHarness
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

The Web UI is available at `http://127.0.0.1:3080` by default. See the [Web UI guide](docs/user/guide/index.md) for usage and the [production deployment runbook](gateway/deploy/README.md) for a multi-user Gateway deployment.

## Development

Read the [architecture documentation](docs/architecture.md) before changing runtime packages. Contributor setup and repository commands are documented in the [development guide](docs/development.md), and agent contributors must follow [AGENTS.md](AGENTS.md).

## Upstream and License

CoHarness is an independent derivative of DeepSeek Harness, originally developed by DeepSeek AI. Original copyright and license notices are retained.

The project is distributed under the [MIT License](LICENSE). Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
