/**
 * dsh-plugin-subscriptions: register OAuth-subscription LLM providers
 * (ChatGPT/Codex, Claude, Grok, Gemini, Cursor) on `ctx.llm`, and expose the
 * `/subscriptions-auth` RPC channel the web Settings page uses to run the
 * logins. The token store lives at `~/.dsh/plugins/subscriptions/auth.json`;
 * the channel registers only when a host `connection` service exists, so
 * headless compositions load fine.
 * @module dsh-plugin-subscriptions
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CallId, createUserMessage, errorChain, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, GenerateOptions } from '@deepseek-ai/dsh-llm'
// Type-only: activates the `ctx.tools` Context merge for the inject block.
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { OAuthFlowManager, type OAuthAttempt } from './auth/oauth-flow.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readClaudeCodeCredentials, refreshClaudeSynced } from './auth/claude-code-creds.js'
import { registerAuthRpc } from './auth/rpc.js'
import type {
  AuthController,
  ImageBytesResult,
  ModelInfoResult,
  ProviderStatus,
  SpeedController,
  SpeedTier,
  TestConnectivityResult,
  VideoBytesResult,
} from './auth/rpc.js'
import {
  deleteSession,
  getSession,
  saveSession,
  PROVIDER_IDS,
} from './auth/store.js'
import type {
  ClaudeSession,
  CodexSession,
  CursorSession,
  GeminiSession,
  GrokSession,
  ProviderId,
  SessionMap,
  StoredSession,
} from './auth/store.js'
import { TokenManager, validateModels } from './providers/common.js'
import type { ModelEntry, ProviderUsage } from './providers/common.js'
import { catalogStore } from './providers/catalog-store.js'
import {
  CodexAdapter,
  codexFlow,
  CODEX_PREEMPT_MS,
  codexProfileClaims,
  exchangeCodexCode,
  fetchCodexUsage,
  isCodexPermanentRefreshError,
  refreshCodex,
} from './providers/codex.js'
import {
  ClaudeAdapter,
  claudeFlow,
  CLAUDE_PREEMPT_MS,
  exchangeClaudeCode,
  fetchClaudeUsage,
  isClaudePermanentRefreshError,
  refreshClaude,
} from './providers/claude.js'
import {
  GrokAdapter,
  grokFlow,
  GROK_PREEMPT_MS,
  exchangeGrokCode,
  fetchGrokUsage,
  isGrokPermanentRefreshError,
  refreshGrok,
} from './providers/grok.js'
import {
  GeminiAdapter,
  geminiFlow,
  GEMINI_PREEMPT_MS,
  exchangeGeminiCode,
  fetchGeminiUsage,
  isGeminiPermanentRefreshError,
  refreshGemini,
} from './providers/gemini.js'
import {
  CURSOR_PREEMPT_MS,
  CursorLoginAttempt,
  exchangeCursorApiKey,
  fetchCursorUsage,
  isCursorPermanentRefreshError,
  refreshCursor,
} from './providers/cursor.js'
import { CursorAdapter } from './providers/cursor-adapter.js'
import type { ExecuteMcpTool, NativeToolOutcome } from './translate/cursor-native-exec.js'
import { createXSearchTool } from './tools/x-search.js'
import { createImageGenerateTool } from './tools/image-generate.js'
import { createVideoGenerateTool, videosDirectory } from './tools/video-generate.js'

export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js'
export type { ModelInfoResult, ProviderStatus, TestConnectivityResult } from './auth/rpc.js'
export type { ClaudeSession, CodexSession, CursorSession, GrokSession, GeminiSession, ProviderId } from './auth/store.js'

export const name = 'dsh-plugin-subscriptions'
export const inject = ['llm']

/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Provider routes to register; defaults to all four. */
  providers?: ProviderId[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Advisory model catalogs overriding the built-in defaults, per provider. */
  models?: {
    codex?: ModelEntry[]
    claude?: ModelEntry[]
    grok?: ModelEntry[]
    gemini?: ModelEntry[]
    cursor?: ModelEntry[]
  }
}

const providerIdSchema = z.union(['codex', 'claude', 'grok', 'gemini', 'cursor'])
const modelEntrySchema: z<ModelEntry> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])),
})

export const Config: z<Config> = z.object({
  providers: z.array(providerIdSchema).default(['codex', 'claude', 'grok', 'gemini', 'cursor']),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  models: z.object({
    codex: z.array(modelEntrySchema),
    claude: z.array(modelEntrySchema),
    grok: z.array(modelEntrySchema),
    gemini: z.array(modelEntrySchema),
    cursor: z.array(modelEntrySchema),
  }),
})

/** Built-in catalogs used when the config does not override a provider's models. */
const DEFAULT_MODELS: Record<ProviderId, ModelEntry[]> = {
  codex: [
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
  ],
  claude: [
    { id: 'claude-opus-5', name: 'Claude Opus 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-fable-5', name: 'Claude Fable 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', maxTokens: 64_000 },
  ],
  grok: [
    { id: 'grok-4', name: 'Grok 4' },
    { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning' },
    { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
  ],
  gemini: [
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', maxTokens: 65_536, contextWindow: 1_048_576 },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', maxTokens: 65_536, contextWindow: 1_048_576 },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', maxTokens: 65_536, contextWindow: 1_048_576 },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', maxTokens: 65_535, contextWindow: 1_048_576 },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', maxTokens: 65_535, contextWindow: 1_048_576 },
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash', maxTokens: 65_536, contextWindow: 1_048_576 },
  ],
  // Cursor AgentService adapter (HTTP/2 Connect/protobuf).
  cursor: [
    { id: 'composer-2.5', name: 'Composer 2.5' },
    { id: 'claude-4.6-opus-high', name: 'Claude 4.6 Opus High' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  ],
}

/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models: Config['models']): Record<ProviderId, ModelEntry[]> {
  const resolve = (provider: ProviderId): ModelEntry[] => {
    // Schemastery injects `[]` for omitted array fields, so an empty list
    // cannot be told apart from an absent one: both mean the built-ins.
    const configured = models?.[provider]
    const entries = configured !== undefined && configured.length > 0 ? configured : DEFAULT_MODELS[provider]
    return validateModels(entries, `${name}: models.${provider}`)
  }
  return {
    codex: resolve('codex'),
    claude: resolve('claude'),
    grok: resolve('grok'),
    gemini: resolve('gemini'),
    cursor: resolve('cursor'),
  }
}

/** The display account of a stored session, for the status endpoint. */
function accountOf(provider: ProviderId, session: StoredSession | undefined): string | undefined {
  if (session === undefined) return undefined
  switch (provider) {
    case 'codex': {
      const codex = session as CodexSession
      // Sessions stored before identity claims were persisted still carry the
      // id token: decode the email on the fly instead of forcing a re-login.
      return codex.emailAddress ?? codexProfileClaims(codex.idToken).emailAddress ?? codex.accountId
    }
    case 'claude': return (session as ClaudeSession).emailAddress
    case 'grok': return (session as GrokSession).account
    case 'gemini': return (session as GeminiSession).account
    case 'cursor': return (session as CursorSession).emailAddress
  }
}

/** Per-provider usage lookup; providers without a usage endpoint are absent. */
type UsageFetchers = Partial<Record<ProviderId, (signal: AbortSignal) => Promise<ProviderUsage>>>

/**
 * Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
 * OAuth attempts in the background, feed pasted codes, cancel, log out, and
 * answer usage lookups.
 */
class SubscriptionsAuthController implements AuthController {
  /** Last login failure per provider, surfaced as `detail` until the next success. */
  private lastError = new Map<ProviderId, string>()
  /** In-flight Cursor deep-control poll (at most one; not a loopback OAuth attempt). */
  private cursorLogin: CursorLoginAttempt | undefined

  constructor(
    private readonly flows: OAuthFlowManager,
    /** Announces a provider's auth-state change so catalog readers re-query (fires `llm/adapters-updated`). */
    private readonly onAuthChanged: (provider: ProviderId) => void,
    /** Lazy attachment-store lookup for the `image` endpoint. */
    private readonly resolveAttachments: () => AttachmentStore | undefined,
    /** Usage lookups for providers that expose a usage endpoint. */
    private readonly usageFetchers: UsageFetchers = {},
    /** Warning sink so a background exchange failure also lands in the host log. */
    private readonly onError: (provider: ProviderId, detail: string) => void = () => {},
    /** Registered LLM adapters for model listing and connectivity testing. */
    private readonly adapters: Map<ProviderId, LlmAdapter> = new Map(),
  ) {}

  usage(provider: ProviderId, signal: AbortSignal): Promise<ProviderUsage> {
    const fetcher = this.usageFetchers[provider]
    if (fetcher === undefined) return Promise.resolve({ supported: false })
    return fetcher(signal)
  }

  async readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult> {
    const attachments = this.resolveAttachments()
    if (attachments === undefined) {
      throw new Error('no attachment service is mounted; generated-image bytes are unavailable')
    }
    const stored = await attachments.readImage(ref, signal)
    return { mediaType: stored.ref.mediaType, dataBase64: Buffer.from(stored.data).toString('base64') }
  }

  async readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult> {
    // The RPC layer validated `name` down to a bare file name, so this join
    // cannot escape the videos directory.
    const data = await readFile(join(videosDirectory(), name), { signal })
    return { mediaType: 'video/mp4', dataBase64: data.toString('base64') }
  }

  async status(provider: ProviderId): Promise<ProviderStatus> {
    const session = await getSession(provider)
    const account = accountOf(provider, session)
    // The plan name is shown by the usage section, so `detail` only carries errors.
    const detail = this.lastError.get(provider)
    const busy = provider === 'cursor'
      ? this.cursorLogin?.busy === true
      : this.flows.isBusy(provider)
    return {
      loggedIn: session !== undefined,
      busy,
      ...session === undefined ? {} : { expiresAt: session.expiresAt },
      ...account === undefined ? {} : { account },
      ...detail === undefined ? {} : { detail },
    }
  }

  async login(provider: ProviderId): Promise<{ authorizeUrl: string }> {
    if (provider === 'claude') {
      const session = readClaudeCodeCredentials()
      if (session) {
        await this.persist('claude', session)
        this.lastError.delete('claude')
        this.onAuthChanged('claude')
        return { authorizeUrl: '' }
      }
      throw new Error('Claude Code credentials not found. Run "claude" first to log in.')
    }
    if (provider === 'cursor') {
      if (this.cursorLogin?.busy === true) {
        throw new Error('a cursor login attempt is already in progress')
      }
      const attempt = new CursorLoginAttempt()
      this.cursorLogin = attempt
      void this.completeCursor(attempt)
      return { authorizeUrl: attempt.loginUrl }
    }
    const spec = provider === 'grok' ? await grokFlow()
      : provider === 'gemini' ? geminiFlow
      : codexFlow
    const attempt = await this.flows.start(provider, spec)
    void this.complete(provider, attempt)
    return { authorizeUrl: attempt.authorizeUrl }
  }

  /** Drive one Cursor deep-control poll to a stored session. */
  private async completeCursor(attempt: CursorLoginAttempt): Promise<void> {
    try {
      const session = await attempt.wait()
      await this.persist('cursor', session)
      this.lastError.delete('cursor')
      this.onAuthChanged('cursor')
    } catch (error) {
      const cancelled = error instanceof Error
        && (error.message === 'login cancelled' || error.name === 'AbortError')
      if (!cancelled) {
        const detail = errorChain(error)
        this.lastError.set('cursor', detail)
        this.onError('cursor', detail)
      }
    } finally {
      if (this.cursorLogin === attempt) this.cursorLogin = undefined
    }
  }

  /** Drive one attempt to a stored session; records failures for the status endpoint. */
  private async complete(provider: ProviderId, attempt: OAuthAttempt): Promise<void> {
    try {
      const code = await attempt.waitCode()
      const session = await this.exchange(provider, code, attempt)
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider)
    } catch (error) {
      // A user-cancelled attempt is not a failure worth surfacing.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        const detail = errorChain(error)
        this.lastError.set(provider, detail)
        this.onError(provider, detail)
      }
    }
  }

  private exchange(provider: ProviderId, code: string, attempt: OAuthAttempt): Promise<StoredSession> {
    switch (provider) {
      case 'codex':
        return exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri)
      case 'claude':
        return exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state)
      case 'grok':
        return exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge)
      case 'gemini':
        return exchangeGeminiCode(code, attempt.redirectUri)
      case 'cursor':
        throw new Error('cursor login uses deep-control poll or API key paste, not an authorization code')
    }
  }

  private persist(provider: ProviderId, session: StoredSession): Promise<void> {
    // The switch keeps the generic key and the session type aligned.
    switch (provider) {
      case 'codex': return saveSession('codex', session as SessionMap['codex'] & object)
      case 'claude': return saveSession('claude', session as SessionMap['claude'] & object)
      case 'grok': return saveSession('grok', session as SessionMap['grok'] & object)
      case 'gemini': return saveSession('gemini', session as SessionMap['gemini'] & object)
      case 'cursor': return saveSession('cursor', session as SessionMap['cursor'] & object)
    }
  }

  async manual(provider: ProviderId, input: string): Promise<void> {
    if (provider === 'cursor') {
      // API key / refresh token paste — works with or without a pending poll.
      const session = await exchangeCursorApiKey(input)
      this.cursorLogin?.cancel()
      this.cursorLogin = undefined
      await this.persist('cursor', session)
      this.lastError.delete('cursor')
      this.onAuthChanged('cursor')
      return
    }
    const attempt = this.flows.pending(provider)
    if (attempt === undefined) {
      throw new Error(`no ${provider} login attempt is in progress`)
    }
    attempt.manual(input)
  }

  cancel(provider: ProviderId): Promise<void> {
    if (provider === 'cursor') {
      this.cursorLogin?.cancel()
      this.cursorLogin = undefined
      return Promise.resolve()
    }
    this.flows.pending(provider)?.cancel()
    return Promise.resolve()
  }

  async logout(provider: ProviderId): Promise<void> {
    if (provider === 'cursor') {
      this.cursorLogin?.cancel()
      this.cursorLogin = undefined
    } else {
      this.flows.pending(provider)?.cancel()
    }
    await deleteSession(provider)
    this.lastError.delete(provider)
    this.onAuthChanged(provider)
  }

  async models(provider: ProviderId, _signal: AbortSignal): Promise<ModelInfoResult[]> {
    const session = await getSession(provider)
    if (session === undefined) {
      throw new Error(`${provider} is not logged in`)
    }
    const adapter = this.adapters.get(provider)
    if (adapter === undefined) {
      throw new Error(`no adapter registered for provider "${provider}"`)
    }
    const list = await adapter.listModels(provider)
    return list.map(m => ({
      id: m.id,
      name: m.name ?? m.id,
      ...m.description === undefined ? {} : { description: m.description },
    }))
  }

  async testConnectivity(provider: ProviderId, model: string, signal: AbortSignal): Promise<TestConnectivityResult> {
    const session = await getSession(provider)
    if (session === undefined) {
      throw new Error(`${provider} is not logged in`)
    }
    const adapter = this.adapters.get(provider)
    if (adapter === undefined) {
      throw new Error(`no adapter registered for provider "${provider}"`)
    }
    const start = Date.now()
    const options: GenerateOptions = {
      provider,
      model,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Hi' }],
          source: { kind: 'user' },
        }),
      ],
      maxTokens: 16,
      signal,
    }
    let text = ''
    let failure: string | undefined
    for await (const chunk of adapter.stream(options)) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
      } else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          failure = chunk.reason.failure.message
        }
      }
    }
    if (failure !== undefined) {
      throw new Error(failure)
    }
    const latencyMs = Math.max(1, Date.now() - start)
    return {
      ok: true,
      latencyMs,
      ...text.trim().length > 0 ? { text: text.trim() } : {},
    }
  }
}

/**
 * Resolve the session's validated working directory from the harness session
 * store, when the service is mounted. Native Cursor execs default to it so
 * `pwd`/`ls`/bare greps land in the session workspace instead of the plugin
 * process's directory.
 */
function sessionCwd(ctx: Context, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  const store = ctx.get('sessions') as { get(id: string): { header?: { cwd?: string } } | undefined } | undefined
  const cwd = store?.get(sessionId)?.header?.cwd
  return cwd !== undefined && cwd.length > 0 ? cwd : undefined
}

/**
 * Run one Cursor MCP tool call through the harness tool registry. The call
 * honors the same pre-execute/guard/dispatch pipeline as harness-driven tool
 * calls (sandbox, approval, output caps); the flattened text content is what
 * the Cursor agent sees in the `mcpResult`.
 */
async function runCursorMcpTool(
  tools: ToolRuntime,
  exec: { callId: string; name: string; arguments: Record<string, unknown>; signal: AbortSignal },
): Promise<NativeToolOutcome> {
  const result = await tools.execute({
    callId: CallId(exec.callId),
    name: exec.name,
    arguments: exec.arguments,
    signal: exec.signal,
  })
  const content = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return { isError: result.isError, content }
}

export function apply(ctx: Context, config: Config): void {
  const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])]
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const catalog = resolveCatalog(config.models)
  // A non-empty configured catalog is an explicit override: it wins over live
  // discovery entirely (schemastery injects [] for omitted arrays, so only a
  // non-empty list counts as configured).
  const overridden = new Set<ProviderId>(
    PROVIDER_IDS.filter(provider => (config.models?.[provider]?.length ?? 0) > 0),
  )
  const flows = new OAuthFlowManager()
  const onWarn = (message: string): void => {
    ctx.logger.warn(`dsh-plugin-subscriptions: ${message}`)
  }
  // Optional: resolves ImageBlock references to bytes for vision-capable
  // models. Resolved per request — the attachments service may start after
  // this plugin's apply, so a one-time capture would stay undefined forever.
  const resolveAttachments = (): AttachmentStore | undefined =>
    ctx.get('attachments') as AttachmentStore | undefined

  // Registration handles are kept so an auth-state change can re-announce the
  // route (`replace` fires `llm/adapters-updated`), which makes the web model
  // picker re-query `listModels` and show/hide the provider.
  const handles = new Map<ProviderId, AdapterRegistrationHandle>()
  const authChanged = (provider: ProviderId): void => {
    handles.get(provider)?.replace([provider])
  }
  // Token managers double as the tools' credential source, so they are
  // captured beside the registrations for the inject block below.
  let codexTokens: TokenManager<CodexSession> | undefined
  let claudeTokens: TokenManager<ClaudeSession> | undefined
  let grokTokens: TokenManager<GrokSession> | undefined
  // Usage lookups resolve the session through the refresh-aware path, so an
  // expired access token renews instead of failing the lookup.
  const usageFetchers: UsageFetchers = {}
  // The composer Speed toggle's state: per-session, in-memory (a restart
  // restores standard routing), gated per request on the model's discovered
  // fast-tier support so a stale choice cannot leak onto a plain model.
  const speedBySession = new Map<string, SpeedTier>()
  let codexAdapter: CodexAdapter | undefined
  // Cursor native exec: MCP tool calls are served by the harness tool registry
  // once the `tools` service mounts (optional; headless compositions answer
  // `toolNotFound` instead). The getter reads the live variable, so the
  // adapter — constructed before `tools` mounts — still resolves it later.
  let cursorExecuteMcpTool: ExecuteMcpTool | undefined
  const adapters = new Map<ProviderId, LlmAdapter>()

  for (const provider of providers) {
    switch (provider) {
      case 'codex': {
        const tokens = new TokenManager<CodexSession>({
          displayName: 'ChatGPT (Codex)',
          preemptMs: CODEX_PREEMPT_MS,
          load: () => getSession('codex'),
          save: session => saveSession('codex', session),
          remove: () => deleteSession('codex'),
          refresh: refreshCodex,
          isPermanent: isCodexPermanentRefreshError,
          onRemoved: () => { authChanged('codex') },
        })
        codexTokens = tokens
        usageFetchers.codex = async signal => fetchCodexUsage(await tokens.session(), fetch, signal)
        let adapter!: CodexAdapter
        adapter = new CodexAdapter({
          models: catalog.codex,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('codex'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('codex'),
          speedFor: (sessionId: string | undefined, model: string): boolean | Promise<boolean> =>
            sessionId !== undefined
            && speedBySession.get(sessionId) === 'fast'
            && adapter.supportsFastTier(model),
        })
        codexAdapter = adapter
        adapters.set('codex', adapter)
        handles.set('codex', ctx.llm.registerAdapter(['codex'], adapter))
        break
      }
      case 'claude': {
        const tokens = new TokenManager<ClaudeSession>({
          displayName: 'Claude (Subscription)',
          preemptMs: CLAUDE_PREEMPT_MS,
          load: () => getSession('claude'),
          save: session => saveSession('claude', session),
          remove: () => deleteSession('claude'),
          refresh: session => refreshClaudeSynced(session, refreshClaude),
          isPermanent: isClaudePermanentRefreshError,
          onRemoved: () => { authChanged('claude') },
        })
        claudeTokens = tokens
        usageFetchers.claude = async signal => fetchClaudeUsage(await tokens.session(), fetch, signal)
        const adapter = new ClaudeAdapter({
          models: catalog.claude,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('claude'),
          onWarn,
          maxRetries: 10,
          resolveAttachments,
          catalogStore: catalogStore('claude'),
        })
        adapters.set('claude', adapter)
        handles.set('claude', ctx.llm.registerAdapter(['claude'], adapter))
        break
      }
      case 'grok': {
        const tokens = new TokenManager<GrokSession>({
          displayName: 'Grok (Subscription)',
          preemptMs: GROK_PREEMPT_MS,
          load: () => getSession('grok'),
          save: session => saveSession('grok', session),
          remove: () => deleteSession('grok'),
          refresh: refreshGrok,
          isPermanent: isGrokPermanentRefreshError,
          onRemoved: () => { authChanged('grok') },
        })
        grokTokens = tokens
        usageFetchers.grok = async signal => fetchGrokUsage(await tokens.session(), fetch, signal)
        const adapter = new GrokAdapter({
          models: catalog.grok,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('grok'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('grok'),
        })
        adapters.set('grok', adapter)
        handles.set('grok', ctx.llm.registerAdapter(['grok'], adapter))
        break
      }
      case 'gemini': {
        const tokens = new TokenManager<GeminiSession>({
          displayName: 'Gemini (Subscription)',
          preemptMs: GEMINI_PREEMPT_MS,
          load: () => getSession('gemini'),
          save: session => saveSession('gemini', session),
          remove: () => deleteSession('gemini'),
          refresh: refreshGemini,
          isPermanent: isGeminiPermanentRefreshError,
          onRemoved: () => { authChanged('gemini') },
        })
        usageFetchers.gemini = async signal => fetchGeminiUsage(await tokens.session(), fetch, signal)
        const adapter = new GeminiAdapter({
          models: catalog.gemini,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('gemini'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata survives restarts, so a
          // resumed session's model keeps its discovered context window.
          catalogStore: catalogStore('gemini'),
        })
        adapters.set('gemini', adapter)
        handles.set('gemini', ctx.llm.registerAdapter(['gemini'], adapter))
        break
      }
      case 'cursor': {
        const tokens = new TokenManager<CursorSession>({
          displayName: 'Cursor (Subscription)',
          preemptMs: CURSOR_PREEMPT_MS,
          load: () => getSession('cursor'),
          save: session => saveSession('cursor', session),
          remove: () => deleteSession('cursor'),
          refresh: refreshCursor,
          isPermanent: isCursorPermanentRefreshError,
          onRemoved: () => { authChanged('cursor') },
        })
        usageFetchers.cursor = async signal => fetchCursorUsage(await tokens.session(), fetch, signal)
        const adapter = new CursorAdapter({
          models: catalog.cursor,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('cursor'),
          onWarn,
          resolveAttachments,
          catalogStore: catalogStore('cursor'),
          executeMcpTool: () => cursorExecuteMcpTool,
          // Native execs default their working directory to the session's
          // validated cwd so tools run in the session workspace.
          resolveSessionCwd: (sessionId: string | undefined) => sessionCwd(ctx, sessionId),
        })
        adapters.set('cursor', adapter)
        handles.set('cursor', ctx.llm.registerAdapter(['cursor'], adapter))
        break
      }
    }
  }

  const speed: SpeedController = {
    async speed(sessionId) {
      return {
        tier: speedBySession.get(sessionId) ?? 'standard',
        fastModels: await codexAdapter?.fastCapableModels() ?? [],
      }
    },
    async setSpeed(sessionId, tier) {
      if (tier === 'standard') speedBySession.delete(sessionId)
      else speedBySession.set(sessionId, tier)
    },
  }
  registerAuthRpc(ctx, new SubscriptionsAuthController(
    flows,
    authChanged,
    resolveAttachments,
    usageFetchers,
    (provider, detail) => {
      ctx.logger.warn(`dsh-plugin-subscriptions: ${provider} login failed: ${detail}`)
    },
    adapters,
  ), speed)

  // Proactively keep the Claude session synced with Claude Code's own store
  // (Keychain/file) every 5 minutes, so a session left idle between requests
  // does not go stale from a token rotation that happened outside this
  // plugin (the `claude` CLI refreshing on its own, or another consumer).
  if (claudeTokens !== undefined) {
    const syncTimer = setInterval(() => {
      claudeTokens?.session().catch(() => {
        // Best-effort: TokenManager already surfaces failures via onRemoved.
      })
    }, 5 * 60_000)
    ctx.effect(() => () => { clearInterval(syncTimer) }, 'dsh-plugin-subscriptions: claude background sync timer')
  }

  // `tools` is optional (headless/minimal compositions may not mount it), so
  // registration waits for the service instead of injecting it at load.
  // x_search and video_generate follow the grok provider; image_generate
  // prefers the codex provider and falls back to grok.
  ctx.inject(['tools'], (toolsCtx) => {
    if (grokTokens !== undefined) {
      toolsCtx.tools.register(createXSearchTool({ tokens: grokTokens }))
      toolsCtx.tools.register(createVideoGenerateTool({ tokens: grokTokens }))
    }
    if (codexTokens !== undefined || grokTokens !== undefined) {
      toolsCtx.tools.register(createImageGenerateTool({
        ...codexTokens === undefined ? {} : { codexTokens },
        ...grokTokens === undefined ? {} : { grokTokens },
        resolveAttachments,
        resolveLlm: () => ctx.get('llm'),
      }))
    }
    // Native Cursor MCP tool calls run through the same registry pipeline as
    // harness-driven calls (sandbox, approval, output caps).
    cursorExecuteMcpTool = exec => runCursorMcpTool(toolsCtx.tools, exec)
  })
}
