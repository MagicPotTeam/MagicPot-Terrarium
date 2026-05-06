# MagicPot

MagicPot 是一个基于 Electron 的 AI 工作台。它把 AI 对话、ComfyUI 工作流、快应用、参考画布、模型文件管理、MCP/LLM 配置和运行日志放在同一个桌面客户端中，面向本地 AI 创作与自动化工作流开发。

当前仓库使用 `electron-vite` 构建，主工程语言为 TypeScript。

## 功能概览

- **AI Chat**：面向多模型/多技能的对话入口，支持流式响应、附件与工具调用链路。
- **Quick App**：运行、设计和管理快应用，配合目标方案与自定义技能扩展工作流。
- **Project Canvas**：参考画布，承载图片、视频、3D/图层等创作素材的导入、选择、拖拽、裁切与恢复能力。
- **ComfyUI 集成**：管理 ComfyUI 启动、HTTP/WS 通信、队列、输出结果和文件访问。
- **Model Browser**：在配置了 ComfyUI 目录后浏览模型和相关文件。
- **Settings**：配置 Python、ComfyUI、LLM、MCP、插件、主题和应用行为。
- **Logs / Terminal**：查看应用日志、ComfyUI 运行状态和诊断信息。

## 技术栈

- Electron 37
- electron-vite 4
- React 19
- TypeScript 5
- MUI 7
- Redux Toolkit
- Three.js / React Three Fiber
- Konva / PixiJS
- Vitest / Testing Library
- electron-builder

## 环境要求

建议使用：

- Node.js 22.x
- npm 10.x 或随 Node.js 附带的 npm
- Git
- Windows 10/11 作为主要开发和 embedded 打包环境

`pure` 模式需要用户自行准备可运行的 Python 与 ComfyUI。`embedded` 模式会把 Python 与 ComfyUI 一并打包，但目前 Windows embedded Python 的准备脚本只支持 Windows。

## 初始化

```bash
npm ci
```

`npm ci` 会严格按照 `package-lock.json` 安装依赖，适合新机器和 CI。需要临时重新解析依赖时再使用：

```bash
npm install
```

如果 npm 下载 Electron 或依赖过慢，可先切换 registry：

```bash
npm config set registry https://registry.npmmirror.com/
```

公开源码 candidate 默认不包含 `.gitmodules`、ComfyUI 子模块、本地运行数据或 `vendor/windows/VC_redist.x64.exe`。公开源码仓的默认可验证路径是 `pure` 模式：用户自行在设置页配置 Python 与 ComfyUI 路径。

私仓维护者或需要自行准备 embedded runtime 的构建者，才需要在具备子模块的完整工作区中初始化 ComfyUI 子模块：

```bash
git submodule update --init --recursive
```

## 本地运行

默认开发模式为 `pure`：

```bash
npm run dev
```

显式指定模式：

```bash
npm run dev:pure
npm run dev:embedded
```

预览已经构建好的产物：

```bash
npm run start:pure
npm run start:embedded
```

## 构建与打包

只构建源码：

```bash
npm run build:pure
npm run build:embedded
```

按平台打包。未设置 `PACKAGE_MODE` 时，默认按 `pure` 处理：

```bash
npm run package:win
npm run package:mac
npm run package:linux
```

推荐使用带模式的发布命令：

```bash
npm run release:pure
npm run release:embedded
```

公开源码 candidate 不随仓库分发 embedded ComfyUI runtime、ComfyUI 子模块或 Microsoft VC Redistributable 安装器。`release:embedded` 仅适用于维护者工作区，或已经自行准备 `vendor/comfyui/ComfyUI`、`vendor/comfyui/comfyui_data/custom_nodes`、Windows embedded Python 和 VC Redistributable 的本地环境。

Windows embedded 单平台打包：

```bash
npm run release:embedded:win
```

GitHub release workflows are maintainer-only automation. They expect repository secrets and variables for signing, upload, Aliyun OSS publishing, and Discord notifications. Forks or public source checkouts can still build locally, but should not expect release workflows to publish without maintainer-provided credentials.

## 运行模式

MagicPot 有两种构建模式。模式由构建参数决定，应用打包完成后用户不能在运行时切换。

| 模式       | 说明                                                         | 适用场景                                  |
| ---------- | ------------------------------------------------------------ | ----------------------------------------- |
| `pure`     | 不随应用打包 Python 和 ComfyUI，用户在设置页自行填写路径     | 体积小，适合开发或已有 ComfyUI 环境的用户 |
| `embedded` | 随应用打包内置 Python 和 ComfyUI，未配置路径时使用内置默认值 | 适合给终端用户交付开箱即用版本            |

模式在两处生效：

- 源码构建阶段：`electron-vite build --mode <pure|embedded>`，应用内读取 `import.meta.env.VITE_BUILD_MODE`。
- 应用打包阶段：通过 `PACKAGE_MODE=<pure|embedded>` 控制 `config/electron/electron-builder.config.js` 的附带文件与输出目录。

## Embedded 打包准备

embedded 包会使用 `.staging/embedded` 作为打包暂存目录。

公开源码 candidate 不包含 embedded 打包所需的 ComfyUI 子模块和本地 runtime 数据。下面的命令适用于私仓维护者工作区，或已经按相同目录结构自行准备 runtime 资源的本地工作区；在未准备 `vendor/comfyui/ComfyUI` 和 `vendor/comfyui/comfyui_data/custom_nodes` 时会失败。

准备 ComfyUI 源码与自定义节点：

```bash
npm run prepare:embedded-staging
```

This command clones clean ComfyUI source from `vendor/comfyui/ComfyUI` and copies custom nodes from `vendor/comfyui/comfyui_data/custom_nodes` into `.staging/embedded/ComfyUI/custom_nodes`. Model files are not included in embedded packages.

准备 Windows embedded Python：

```bash
npm run prepare:embedded-python
```

该命令会下载 Python embeddable zip、安装 pip、安装 ComfyUI 与自定义节点依赖，并运行 ComfyUI quick test。可先查看 dry-run 信息：

```bash
npm run prepare:embedded-python:dry-run
```

完整准备：

```bash
npm run prepare:embedded
```

Windows embedded 默认路径约定：

```text
ComfyUI_windows_portable/python_embeded/python.exe
ComfyUI_windows_portable/ComfyUI
```

macOS embedded 仍约定 Python 目录为：

```text
ComfyUI_windows_portable/python_embedded_macos
```

当前仓库不会自动生成 macOS embedded Python 目录，如需打包 macOS embedded 版本，需要先自行准备。

### Windows VC Redistributable

Windows ComfyUI runtime 需要 Microsoft Visual C++ Redistributable。公开源码 candidate 不分发 `vendor/windows/VC_redist.x64.exe`。用户、安装流程或维护者打包环境应从 Microsoft 官方页面获取：

https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist

再分发受 Microsoft Software License Terms for Visual Studio / Visual C++ Redistributable 约束。若维护者决定在 release artifact 中随包附带该安装器，需要先确认授权条件；公开源码仓不要直接携带该 Microsoft 二进制文件。

Windows `pure` 版 NSIS 安装器会提供可选勾选项：用户勾选后，安装流程会从 Microsoft 官方下载 `VC_redist.x64.exe` 并执行静默安装。该流程用于帮助需要本地 ComfyUI 的 Windows 用户补齐运行库；未勾选时，用户仍可稍后从 Microsoft 官方页面自行安装。

`embedded` 版运行时会在启动内置 ComfyUI 前检测 VC Redistributable。维护者如果要在非公开 release artifact 中随包附带 `VC_redist.x64.exe`，需要先确认 Microsoft Software License Terms 允许相应再分发。

## 常用质量命令

```bash
npm run check:text-encoding
npm run lint
npm run typecheck
npm run test:node
npm run test:web:light:1
npm run test:web:light:2
npm run test:web:light:3
```

完整测试：

```bash
npm test
```

启动烟测：

```bash
npm run smoke:startup
```

Project Canvas 压测与专项验证：

```bash
npm run stress:project-canvas
npm run benchmark:project-canvas:webgl
npm run benchmark:project-canvas:overlay
npm run benchmark:project-canvas:video
```

安全姿态检查：

```bash
npm run qa:security-posture
```

## 目录结构

```text
MagicPot/
|- .github/
|- docs/
|- examples/
|- config/         # Build, lint, format, env, Vitest, Vite, and TypeScript config
|- scripts/        # Build, embedded, QA, benchmark, and smoke helpers
|- packages/
|  |- app/            # Electron main, preload, renderer, and shared app code
|  |- qapps/          # Bundled Quick Apps
|  |- skills/         # Bundled skill resources
|  |- target-schemes/ # Bundled target schemes
|  `- runtime-assets/ # App runtime resources and electron-builder assets
|- vendor/
|  |- comfyui/     # ComfyUI submodules and local runtime integration
|  `- windows/     # Windows third-party runtime helpers
|- tests/          # Top-level test support files
`- README / LICENSE / package.json / package-lock.json
```

### Main

`packages/app/src/main` 承担应用后端职责：

- `api/`：IPC service 实现与注册。
- `assistantRuntime/`：助手运行时、会话、技能和工具调度。
- `comfy/`：ComfyUI HTTP/WS 封装、状态同步和文件访问。
- `config/`：构建环境、用户配置持久化和配置迁移。
- `llmProxy/`：LLM 代理、聊天服务端能力和 Hunyuan3D 集成。
- `mcp/`：MCP client manager、runtime、bridge 与状态管理。
- `qApp/`：快应用默认项、文件扫描和 watcher。
- `queue/`：Comfy 任务队列、结果映射和错误归类。
- `subprocess/`：子进程启动、日志、清理和强制结束。
- `testSupport/`、`testUiPolicy.ts`、`startup.smoke.test.ts`：自动化测试窗口策略和启动烟测。

### Preload

`packages/app/src/preload` 只做受控能力暴露：

- `apiIpc.ts` 基于 `shared/api` 动态创建类型安全的 IPC client。
- `winBridge.ts` 暴露窗口最小化、最大化和关闭等控制能力。
- `index.ts` 通过 `contextBridge` 注入 renderer。

### Renderer

`packages/app/src/renderer/src` 是前端应用：

- `pages/ChatPage`：AI 对话。
- `pages/QuickAppPage`：快应用执行、设计、自定义工坊、目标和技能管理。
- `pages/ProjectCanvasPage`：参考画布。
- `pages/FileBrowserPage`：模型和文件浏览。
- `pages/SettingsPage`：环境、LLM、MCP、插件和应用设置。
- `pages/ComfyUIAppBuilderPage.tsx`：ComfyUI 应用构建。
- `pages/AppLogPage.tsx`、`pages/TerminalPage.tsx`：日志和 ComfyUI 运行界面。
- `components/`、`hooks/`、`store/`、`utils/`：复用 UI、Hooks、Redux 和工具逻辑。

### Shared API

`packages/app/src/shared/api` 是主进程与渲染进程的服务协议层：

- 普通请求使用 `ipcMain.handle` / `ipcRenderer.invoke`。
- 流式请求使用 `MessagePort`。
- 服务命名统一为 `svcName.methodName`。
- 新增 service 或 method 时，先改 `packages/app/src/shared/api` 的类型和 `apiDef`，再在 `packages/app/src/main/api` 实现。

详细指南见 [`packages/app/src/shared/api/README.md`](packages/app/src/shared/api/README.md)。

## 开发约定

- 新增跨进程能力时，优先通过 `shared/api` 定义接口，不在 renderer 直接接触 Node 能力。
- `renderer` 只负责 UI 和轻量交互编排，系统资源访问放在 `main`。
- `pure` 和 `embedded` 的差异应集中在构建环境、路径默认值和打包资源中，不应散落到业务组件。
- 自动化测试产生的临时文件、截图和 smoke artifact 不应写入仓库根目录。
- 修改文本文件后运行 `npm run check:text-encoding`，避免混入乱码或占位符。

## 常见问题

### 为什么 `npm run dev` 启动后找不到 ComfyUI？

默认 `dev` 是 `pure` 模式。请在设置页填写 Python 路径和 ComfyUI 目录，或使用 `npm run dev:embedded` 并确保本地 embedded 默认路径存在。

### embedded 包会包含模型文件吗？

默认不会。`prepare:embedded-staging` 会保留 `ComfyUI/models`、`input`、`output` 等目录结构，但不会把 `.safetensors`、`.ckpt`、`.pt`、`.pth`、`.gguf`、`.onnx`、`.bin` 等模型文件打进安装包。

### Windows embedded 为什么输出 `dir` 和 `zip`？

embedded 包包含大量 Python 文件，NSIS 对大体积和大量文件的安装包不友好。当前配置中 Windows embedded 使用 `dir` 和 `zip` 作为主要输出。

### 如何新增一个 IPC API？

按 `packages/app/src/shared/api/README.md` 的步骤新增接口类型、`ServiceDefSheet`、main 侧实现和 server 注册。UI 侧通过 `window.api.<service>.<method>()` 调用。

## 许可证

本项目使用 AGPL-3.0-only。详见 [`LICENSE`](LICENSE)。
