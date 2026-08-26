# dsh-plugin-subscriptions

[English](README.md) | 中文

把你的 **ChatGPT (Codex)**、**Claude**、**Grok (X Premium)**、**Gemini (Google)**、**Cursor** 订阅当作 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 LLM provider 使用 —— 不需要 API key。Codex、Grok 和 Gemini 通过 dsh web 界面 OAuth 登录（设置 → 订阅）；Claude 直接从已有的 Claude Code 会话导入凭据（macOS Keychain 或 `~/.claude/.credentials.json`）；Cursor 支持通过浏览器 OAuth（Deep Control 轮询）登录或直接粘贴 Cursor Dashboard 的 API Key / Access Token。Token 保存在 `~/.dsh/plugins/subscriptions/auth.json`（权限 0600），过期自动刷新。

## 演示

设置 → **订阅**：每个 provider 的登录/退出，无需 API key。Claude 从 Claude Code 导入凭据；Codex、Grok 和 Gemini 使用 OAuth；Cursor 支持 Deep Control 轮询登录或 API Key 粘贴（截图中账号已打码）：

![订阅设置页](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/subscriptions.png)

已登录的 provider 会带着实时模型目录进入会话模型选择器：

![模型选择器中的订阅模型](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-picker.png)

声明了推理等级的模型会在同一菜单里多出**推理等级**选择 —— Codex 系列模型、Grok 4.6 / 4.5 以及 Cursor 模型（档位和默认值来自各 provider 的实时目录，不是硬编码列表）：

![推理等级选择器](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-effort.png)

目录声明了 fast tier（即 codex CLI 的 fast 模式）的 Codex 模型，会在输入框工具行（模型选择器旁）多出一个**速度**开关 —— 标准 / 快速（`service_tier: priority`），按会话生效。`/fast` 斜杠命令提供同样的弹窗选择；当前模型不支持快速档时会提示原因。

![速度开关及其标准/快速菜单](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/speed-toggle.png)

`image_generate` 工具生成的图片直接内联显示在对话里：

![image_generate 内联显示生成的图片](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-inline.png)

`provider` 参数可选择生图后端 —— 同一条提示词分别走 GPT（`gpt-image-2`，上）和 Grok（`grok-imagine-image-2.0`，下）：

![image_generate 的 provider 参数对比 gpt 与 grok](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-providers.png)

`video_generate` 工具生成的视频直接内联播放：

![video_generate 内联播放生成的视频](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/video-generate-inline.png)

## Provider 一览

| 路由       | 订阅                               | 模型                                                                                                                               | 协议                                            |
| -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `codex`  | ChatGPT Plus/Pro/Team/Enterprise | 从 `chatgpt.com/backend-api/codex/models` 实时获取                                                                                    | OpenAI Responses SSE                          |
| `claude` | Claude Pro/Max                   | 订阅内所有可用模型（Opus、Sonnet、Haiku、Fable —— 静态目录，随插件更新）                                                                                 | Anthropic Messages SSE                        |
| `grok`   | X Premium (xAI)                  | 从 `api.x.ai/v1/models` 实时获取（仅对话模型）；推理等级来自 Grok CLI 目录（`cli-chat-proxy.grok.com/v1/models`）                                       | OpenAI Responses SSE                          |
| `gemini` | Google AI (Antigravity)          | 从 Antigravity Cloud Code Assist `fetchAvailableModels` 实时获取（仅 Gemini 模型）；登录时像官方 Antigravity/Gemini CLI 一样开通 Cloud Code Assist 项目 | Google Cloud Code Assist SSE                  |
| `cursor` | Cursor Pro/Business/Ultra        | 从 `api2.cursor.sh/aiserver.v1.AiService/GetUsableModels` 实时获取（Composer、Claude、GPT 等）                                             | HTTP/2 Connect / Protobuf（`AgentService/Run`） |

只有已登录的 provider 才会出现在会话模型选择器里；登录/退出后列表自动刷新。支持视觉的模型会声明 `['text', 'image']` 输入模态，图片内容会被翻译成各 provider 的 wire 格式。

已登录的卡片还会显示**订阅用量** —— 按限额窗口（5 小时会话窗、每周窗，以及计划包含的按模型每周窗）展示已用百分比、进度条和重置时间，并带刷新按钮：

- **Codex**：来自 `chatgpt.com/backend-api/wham/usage`（5 小时会话窗口、每周窗口及套餐类型）
- **Claude**：来自 `api.anthropic.com/api/oauth/usage`（5 小时与 7 天限额窗口）
- **Grok**：来自 Grok Build CLI 代理的 `cli-chat-proxy.grok.com/v1/billing`（CLI `/usage` 来源，包含每周共享额度与订阅档位）
- **Gemini**：来自 Cloud Code Assist 的 `retrieveUserQuota`（Gemini 模型池与 Claude/GPT 模型池配额）
- **Cursor**：来自 `api2.cursor.sh/auth/usage` 与 `usage-summary`（Fast 请求、On-Demand 用量、个人用量及套餐窗口）

随 provider 启用自动注册的工具：

- **`x_search`**（Grok）—— xAI 托管的 X 搜索，返回 `{ answer, citations }`。
- **`image_generate`**（ChatGPT 或 Grok）—— 经 Codex 后端调用 `gpt-image-2`，或经 `api.x.ai/v1/images/generations` 调用 `grok-imagine-image-2.0`。`provider` 参数指定首选提供方（`gpt` 为默认值，可选 `grok`）；首选方未登录时自动回退到另一方。图片保存到 `~/.dsh/plugins/subscriptions/images/` 并返回路径。Grok 路径上 `size`/`quality` 参数会映射为 Grok 的 `aspect_ratio`/`quality`。
- **`video_generate`**（Grok）—— 经 `api.x.ai/v1/videos` 调用 `grok-imagine-video-1.5`（异步提交 + 轮询）；MP4 保存到 `~/.dsh/plugins/subscriptions/videos/` 并返回路径，视频直接在对话里内联播放。支持时长（1–15 秒）、宽高比、分辨率，以及通过 `image_url` 做图生视频。

## 安装

本机已有 `dsh` CLI 时，从 npm 安装（预构建产物，无需构建授权）：

```sh
dsh plugin --profile web add dsh-plugin-subscriptions
```

也可以从 GitHub 安装源码：

```sh
dsh plugin --profile web add github:V1ki/dsh-plugin-subscriptions
```

首次安装 pnpm 会要求允许该包的构建脚本（git 安装拉取的是源码而非构建产物）；把打印出的包名加进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-plugin-subscriptions: true
```

然后重新执行 `add`。该授权会在安装时执行包的代码，只授给你信任的来源。

本地检出安装：

```sh
git clone https://github.com/V1ki/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

不装进 profile 的 headless 用法（先在 web 界面登录过 —— token 文件是共享的）：

```sh
cp overlay.example.yml overlay.yml   # 然后把 name: 改成本检出的 lib/index.js 绝对路径
dsh --profile headless --patch <检出目录>/overlay.yml "你的任务"
```

## 更新

npm 安装的：

```sh
dsh plugin --profile web update --latest dsh-plugin-subscriptions
```

GitHub 安装的：重新执行一遍 `add github:V1ki/dsh-plugin-subscriptions` —— 会重新拉取源码并构建。link 的本地检出只需在检出目录里 `git pull && pnpm build`。

无论哪种方式，更新后都要重启 `dsh web` 才会加载新版本。

## 使用

1. `dsh web`，打开打印的 URL。
2. **设置 → 订阅**：点对应 provider 的「连接」：
   - **Claude**：即时从 Claude Code 导入凭据（需先运行过 `claude` 并登录）。
   - **Codex / Grok / Gemini**：在打开的浏览器标签页里授权；无浏览器环境下可展开手动兜底，粘贴回调 URL 或授权码。
   - **Cursor**：在打开的标签页里授权（Deep Control 轮询模式），或展开手动兜底粘贴 Cursor Dashboard 中的 API Key / Access Token。
3. 在任意会话里打开模型选择器（`/model`），选择 **ChatGPT (Codex)** / **Claude (Subscription)** / **Grok (Subscription)** / **Gemini (Subscription)** / **Cursor (Subscription)** 下的模型。

未登录时：该 provider 不出现在选择器里；直接请求会报 `MISSING_CREDENTIAL` 并提示去设置页登录，不影响其他功能。

## 配置

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude, grok, gemini, cursor]   # 子集；默认五个全启用
    streamIdleTimeoutMs: 300000
    models:                                             # 覆盖实时发现/内置目录
      codex:
        - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
      cursor:
        - { id: composer-2.5, name: Composer 2.5, contextWindow: 200000, inputModalities: [text, image] }
```

## 开发

```sh
pnpm install   # devDependencies 用 link: 指向本地 deepseek-harness 检出 —— 先改成你的路径
pnpm build     # tsc (lib/) + tsdown (lib/client.js 浏览器 bundle)
pnpm test      # 编译后跑 node --test 单测
```

`prepare`（git 安装时触发）执行 `tsdown.prepare.config.ts`：自包含打包两个面，所有 `@deepseek-ai/*` 依赖外部化 —— 运行时从 dsh 安装解析，保证不会引入第二份 cordis。

改了代码后 `pnpm build` 并重启 `dsh web` 生效。

## 目录结构

- `src/index.ts` —— 插件入口：配置 schema、adapter 注册、登录态变更通告、RPC 接线
- `src/auth/` —— PKCE/JWT 工具、token 存储、OAuth 流程引擎（临时本地回调服务）、Claude Code 凭据读取器（Keychain/文件）、`/subscriptions-auth` RPC 通道
- `src/providers/` —— 各 provider 的 OAuth 常量/换发/刷新 + `LlmAdapter` 实现（Codex、Claude、Grok、Gemini、Cursor）
- `src/providers/cursor-proto/` —— Cursor AgentService / AiService protobuf 定义与编解码运行时
- `src/translate/` —— dsh `Message[]` 与 OpenAI Responses / Anthropic Messages / Gemini (Cloud Code Assist) / Cursor 格式互转，SSE 与 HTTP/2 Connect 流解析
- `src/tools/` —— `x_search`、`image_generate` 与 `video_generate`
- `src/client/` —— 设置 → 订阅页面及速度切换开关（浏览器面，中英文，跟随明暗主题）

