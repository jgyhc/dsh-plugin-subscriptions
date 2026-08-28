# dsh-plugin-subscriptions

English | [中文](README.zh.md)

Use your **ChatGPT (Codex)**, **Claude**, **Grok (X Premium)**, **Gemini (Google)**, and **Cursor** subscriptions as LLM providers in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — no API keys. Codex, Grok, and Gemini log in via OAuth in the dsh web UI (Settings → Subscriptions); Claude imports credentials directly from an existing Claude Code session (macOS Keychain or `~/.claude/.credentials.json`); Cursor supports OAuth Deep Control login or pasting an API key / access token from the Cursor Dashboard. Tokens live at `~/.dsh/plugins/subscriptions/auth.json` (mode 0600) and refresh automatically.

## Demo

Settings → **Subscriptions**: per-provider login/logout, no API keys. Claude imports credentials from Claude Code; Codex, Grok, and Gemini use OAuth; Cursor supports Deep Control OAuth polling or API key paste (account address masked in the screenshot):

![Subscriptions settings page](https://raw.githubusercontent.com/jgyhc/dsh-plugin-subscriptions/main/docs/images/subscriptions.png)

Logged-in providers join the session model picker with their live model catalogs:

![Model picker with subscription models](https://raw.githubusercontent.com/jgyhc/dsh-plugin-subscriptions/main/docs/images/model-picker.png)

Models that advertise reasoning levels get an **Effort** selector in the same menu — Codex models, Grok 4.6 / 4.5, and Cursor models (levels and defaults come from each provider's live catalog, not a hardcoded list):

![Reasoning effort selector](https://raw.githubusercontent.com/jgyhc/dsh-plugin-subscriptions/main/docs/images/model-effort.png)

Codex models whose catalog advertises the fast tier (the codex CLI's fast mode) get a **Speed** toggle in the composer's tool row, next to the model selector — Standard or Fast (`service_tier: priority`), per session. The `/fast` slash command offers the same choice as a popup; it errors with an explanation when the current model has no fast tier.

![Speed toggle with the Standard/Fast menu open](https://raw.githubusercontent.com/jgyhc/dsh-plugin-subscriptions/main/docs/images/speed-toggle.png)

The `image_generate` tool renders its result inline in the conversation:

![image_generate renders the image inline](https://raw.githubusercontent.com/jgyhc/dsh-plugin-subscriptions/main/docs/images/image-generate-inline.png)

Its `provider` parameter picks the image backend — the same prompt through GPT (`gpt-image-2`, top) and Grok (`grok-imagine-image-2.0`, bottom):

![image_generate with provider gpt vs grok](https://raw.githubusercontent.com/jgyhc/dsh-plugin-subscriptions/main/docs/images/image-generate-providers.png)

The `video_generate` tool plays the generated clip inline:

![video_generate plays the clip inline](https://raw.githubusercontent.com/jgyhc/dsh-plugin-subscriptions/main/docs/images/video-generate-inline.png)

## Providers

| Route    | Subscription      | Models | Protocol |
|----------|-------------------|--------|----------|
| `codex`  | ChatGPT Plus/Pro/Team/Enterprise | live catalog from `chatgpt.com/backend-api/codex/models` | OpenAI Responses SSE |
| `claude` | Claude Pro/Max    | all models available in your subscription (Opus, Sonnet, Haiku, Fable — static catalog, updated with the plugin) | Anthropic Messages SSE |
| `grok`   | X Premium (xAI)   | live catalog from `api.x.ai/v1/models` (chat models only); reasoning efforts from the Grok CLI catalog (`cli-chat-proxy.grok.com/v1/models`) | OpenAI Responses SSE |
| `gemini` | Google AI (Antigravity) | live catalog from Antigravity Cloud Code Assist `fetchAvailableModels` (Gemini models only); login provisions the Cloud Code Assist project like the official Antigravity/Gemini CLI does | Google Cloud Code Assist SSE |
| `cursor` | Cursor Pro/Business/Ultra | live catalog from `api2.cursor.sh/aiserver.v1.AiService/GetUsableModels` (Composer, Claude, GPT, etc.) | HTTP/2 Connect / Protobuf (`AgentService/Run`) |

Only logged-in providers appear in the session model picker; the lists above refresh on login/logout. Vision-capable models declare `['text', 'image']` input modalities, and image content is translated to each provider's wire format.

Logged-in cards also show **subscription usage** — per rate-limit window (5-hour session, weekly, and per-model weekly where the plan has one) with the used percentage, a progress bar, and the reset time, plus a Refresh button:
- **Codex**: `chatgpt.com/backend-api/wham/usage` (session, weekly windows, and plan type)
- **Claude**: `api.anthropic.com/api/oauth/usage` (5-hour and 7-day usage limits)
- **Grok**: Grok Build CLI proxy's `cli-chat-proxy.grok.com/v1/billing` (shared weekly pool and subscription tier)
- **Gemini**: Cloud Code Assist's `retrieveUserQuota` (Gemini models and Claude/GPT quota windows)
- **Cursor**: `api2.cursor.sh/auth/usage` & `usage-summary` (fast requests, on-demand usage, personal usage, and plan limit pools)

Also included, registered when the matching provider is enabled:

- **`x_search`** tool (Grok) — xAI's hosted X search, returning `{ answer, citations }`.
- **`image_generate`** tool (ChatGPT or Grok) — `gpt-image-2` via the Codex backend, or `grok-imagine-image-2.0` via `api.x.ai/v1/images/generations`. The `provider` argument picks the preferred provider (`gpt`, the default, or `grok`); when the preferred one is logged out the other serves as fallback. Images are saved under `~/.dsh/plugins/subscriptions/images/` and the paths returned. The `size`/`quality` arguments map onto Grok's `aspect_ratio`/`quality` on the Grok path.
- **`video_generate`** tool (Grok) — `grok-imagine-video-1.5` via `api.x.ai/v1/videos` (async submit + poll); MP4s are saved under `~/.dsh/plugins/subscriptions/videos/`, the path returned, and the clip plays inline in the conversation. Supports duration (1–15 s), aspect ratio, resolution, and image-to-video via `image_url`.

## Install

With the `dsh` CLI available, install from npm (prebuilt artifacts, no build permission needed):

```sh
dsh plugin --profile web add dsh-plugin-subscriptions
```

Or install the sources from GitHub:

```sh
dsh plugin --profile web add github:jgyhc/dsh-plugin-subscriptions
```

pnpm will ask you to allow this package's build script on first install (git installs fetch sources, not built artifacts); add the printed key to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-plugin-subscriptions: true
```

and re-run the `add`. Only grant this to packages you trust — it runs the package's code at install time.

From a local checkout instead:

```sh
git clone https://github.com/jgyhc/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

Headless-only usage without installing into a profile (log in via the web UI first — the token file is shared):

```sh
cp overlay.example.yml overlay.yml   # then edit the name: to this checkout's absolute lib/index.js path
dsh --profile headless --patch <checkout>/overlay.yml "your task"
```

## Update

Installed from npm:

```sh
dsh plugin --profile web update --latest dsh-plugin-subscriptions
```

Installed from GitHub: re-run the same `add github:jgyhc/dsh-plugin-subscriptions` command — it re-fetches the sources and rebuilds. A linked local checkout just needs `git pull && pnpm build` in the checkout.

Either way, restart `dsh web` afterwards so the new version loads.

## Use

1. `dsh web`, open the printed URL.
2. Settings → **Subscriptions**: click **Connect** on a provider:
   - **Claude**: credentials are imported instantly from Claude Code (you must have run `claude` and logged in at least once).
   - **Codex / Grok / Gemini**: authorize in the opened browser tab; if the browser flow can't complete (headless host), expand the manual fallback and paste the callback URL or code.
   - **Cursor**: authorize in the opened browser tab (Deep Control polling flow), or expand the manual fallback to paste an API key / access token from the Cursor Dashboard.
3. In any session, open the model picker (`/model`) and choose a model under **ChatGPT (Codex)** / **Claude (Subscription)** / **Grok (Subscription)** / **Gemini (Subscription)** / **Cursor (Subscription)**.

Not logged in? The provider stays out of the picker, and requests fail with `MISSING_CREDENTIAL` pointing at the Settings page; nothing else breaks.

## Config

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude, grok, gemini, cursor]   # subset; default all five
    streamIdleTimeoutMs: 300000
    models:                                             # override the discovered/built-in catalogs
      codex:
        - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
      cursor:
        - { id: composer-2.5, name: Composer 2.5, contextWindow: 200000, inputModalities: [text, image] }
```

## Develop

```sh
pnpm install   # devDependencies link into a local deepseek-harness checkout — edit the paths first
pnpm build     # tsc (lib/) + tsdown (lib/client.js browser bundle)
pnpm test      # node --test over compiled unit specs
```

`prepare` (used by git installs) runs `tsdown.prepare.config.ts`: a self-contained bundle build of both faces with all `@deepseek-ai/*` specifiers external — they resolve from the dsh installation at runtime, so this package never carries a second cordis copy.

After `pnpm build`, restart `dsh web` to pick up changes.

## Layout

- `src/index.ts` — plugin entry: config schema, adapter registration, auth-change re-announce, RPC wiring
- `src/auth/` — PKCE/JWT helpers, token store, OAuth flow engine (temp loopback callback server), Claude Code credential reader (Keychain/file), `/subscriptions-auth` RPC channel
- `src/providers/` — per-provider OAuth constants/exchange/refresh + `LlmAdapter` implementations (Codex, Claude, Grok, Gemini, Cursor)
- `src/providers/cursor-proto/` — Cursor AgentService / AiService protobuf definitions and encode/decode runtime
- `src/translate/` — dsh `Message[]` ⟷ OpenAI Responses / Anthropic Messages / Gemini (Cloud Code Assist) / Cursor wire formats, SSE and HTTP/2 Connect stream parsers
- `src/tools/` — `x_search`, `image_generate`, and `video_generate`
- `src/client/` — the Settings → Subscriptions page & speed toggle (browser half, zh/en, theme-token aware)
