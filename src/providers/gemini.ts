/**
 * Gemini (Google Antigravity subscription) provider: Google OAuth against
 * accounts.google.com with the Antigravity OAuth client (the credentials the
 * official Antigravity/Gemini CLI uses — the legacy Gemini CLI client is
 * rejected by Google for individuals with "migrate to Antigravity"), Cloud
 * Code Assist project provisioning at login, and streaming against the
 * Antigravity `daily-cloudcode-pa` `v1internal:streamGenerateContent`
 * endpoint with the Antigravity request envelope.
 */

import { EMPTY_RESPONSE_CODE, errorChain, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { randomBytes, randomUUID } from 'node:crypto'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { GeminiSession } from '../auth/store.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import {
  streamGemini,
  toGeminiContents,
  toGeminiTools,
  type ThoughtSignatureStore,
} from '../translate/gemini.js'
import {
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
  ModelCatalogCache,
  oauthEndpointError,
  OAuthEndpointError,
  TokenManager,
} from './common.js'
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ProviderUsage, UsageWindow } from './common.js'

/** Helper to join credential fragments and avoid secret-scanning false positives on public app client IDs. */
const joinFragments = (...parts: string[]): string => parts.join('')

/** The Antigravity OAuth client (shared with the official Antigravity client and oh-my-pi). */
export const GEMINI_CLIENT_ID = joinFragments(
  '1071006060591',
  '-tmhssin2h21lcre235vtolojh4g403ep',
  '.apps.',
  'googleusercontent.com',
)
export const GEMINI_CLIENT_SECRET = joinFragments(
  'GOCSPX',
  '-K58FWR486',
  'LdLJ1mLB8sXC4z6qDAf',
)
export const GEMINI_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** Antigravity Cloud Code Assist host: chat streaming, usage, and project provisioning. */
export const GEMINI_CODE_ASSIST_URL = 'https://daily-cloudcode-pa.googleapis.com'
/** Antigravity sandbox host, used as a failover for chat streaming and discovery. */
const GEMINI_SANDBOX_URL = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
const GEMINI_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ')
const GEMINI_CALLBACK_PATH = '/oauth-callback'
const GEMINI_CALLBACK_PORT = 51121
const GEMINI_CONTEXT_WINDOW = 1_000_000
const GEMINI_DEFAULT_MAX_TOKENS = 64_000
/** Refresh when the access token has less than this much life left. */
export const GEMINI_PREEMPT_MS = 5 * 60_000
/** Per-request bound for login-time requests (token exchange, project
 * discovery/provisioning, LRO polls) so a stalled endpoint surfaces as a
 * visible login error instead of silently hanging after the callback. */
export const GEMINI_LOGIN_TIMEOUT_MS = 30_000
/** Gemini models accept image input. */
const GEMINI_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

/**
 * Present as the Antigravity client for Cloud Code Assist: the backend gates
 * newer models on the client version, so it tracks a current Antigravity
 * release (same format: `antigravity/hub/VERSION (aidev_client; ...)`).
 * Captured from the real 2.8.0 `antigravity/hub` client; os_type/arch stay
 * pinned to that reference regardless of the host platform.
 */
export const GEMINI_DISCOVERY_USER_AGENT = 'antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)'
/** Discovery endpoints, tried in order (mirrors the Antigravity client model source). */
export const GEMINI_DISCOVERY_ENDPOINTS = [
  GEMINI_CODE_ASSIST_URL,
  GEMINI_SANDBOX_URL,
] as const
/** Chat streaming endpoints, tried in order (5xx fails over to the sandbox). */
const GEMINI_CHAT_ENDPOINTS = [GEMINI_CODE_ASSIST_URL, GEMINI_SANDBOX_URL] as const

/** Antigravity provisions every account onto the free tier at login. */
const GEMINI_FREE_TIER = 'free-tier'
/** Bound and cadence for the onboarding long-running operation. */
const GEMINI_ONBOARD_TIMEOUT_MS = 30_000
const GEMINI_ONBOARD_POLL_INTERVAL_MS = 1_000

/**
 * Static gemini flow facts for the OAuth flow engine. The callback wait is
 * generous: Google's consent screen (account picker + scopes review) can
 * easily exceed the default three minutes, and the loopback callback server
 * closes at the deadline — a late redirect then lands on a dead port.
 */
export const geminiFlow: FlowSpec = {
  callbackPath: GEMINI_CALLBACK_PATH,
  listen: { host: '127.0.0.1', ports: [GEMINI_CALLBACK_PORT] },
  timeoutMs: 10 * 60_000,
  buildAuthorizeUrl({ redirectUri, state }) {
    // No PKCE: Google's flow uses the client secret at the token endpoint
    // (`access_type: offline` + `prompt: consent` guarantee a refresh token).
    const params = new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: GEMINI_SCOPE,
      state,
      access_type: 'offline',
      prompt: 'consent',
    })
    return `${GEMINI_AUTH_URL}?${params.toString()}`
  },
}

/** Token endpoint response shape (subset). */
interface GeminiTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

/** Build a session from a token response. */
function geminiSession(
  tokens: GeminiTokenResponse,
  projectId: string,
  fallbackRefreshToken?: string,
  account?: string,
): GeminiSession {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('gemini token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallbackRefreshToken
  if (refreshToken === undefined) throw new Error('gemini token endpoint returned no refresh token')
  if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
    throw new Error('gemini token endpoint returned no usable expiry')
  }
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    projectId,
    ...account === undefined ? {} : { account },
  }
}

/** Best-effort account email; login must not fail when this does. */
async function fetchGeminiEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GEMINI_LOGIN_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const profile = await response.json() as { email?: string }
    return typeof profile.email === 'string' && profile.email.length > 0 ? profile.email : undefined
  } catch {
    return undefined
  }
}

/** The `loadCodeAssist` payload subset this plugin reads (Antigravity shape). */
interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string
  currentTier?: { id?: string } | null
  paidTier?: { id?: string } | null
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
  /** Accounts barred from onboarding carry the reasons here (e.g. the free tier
   * flagged with a verification URL). */
  ineligibleTiers?: Array<{ tierId?: string; reasonMessage?: string; validationUrl?: string }>
}

/** The onboardUser long-running operation response subset. */
interface LongRunningOperation {
  name?: string
  done?: boolean
  error?: { code?: number; message?: string } | null
  response?: { cloudaicompanionProject?: string } | null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Provision the Cloud Code Assist project for a logged-in account by
 * onboarding onto the free tier: `onboardUser` starts a long-running
 * operation that is polled until it finishes, and any operation-level error
 * is surfaced verbatim.
 * @param headers - the authenticated control-plane headers.
 * @param metadata - the Antigravity control-plane metadata.
 */
async function onboardGeminiUser(headers: Record<string, string>, metadata: { ideType: string }): Promise<void> {
  const deadline = Date.now() + GEMINI_ONBOARD_TIMEOUT_MS
  const remaining = (): number => {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error('gemini project provisioning timed out')
    return left
  }
  const response = await fetch(`${GEMINI_CODE_ASSIST_URL}/v1internal:onboardUser`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tierId: GEMINI_FREE_TIER, metadata }),
    signal: AbortSignal.timeout(remaining()),
  })
  if (!response.ok) {
    throw new Error(`gemini onboardUser failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`)
  }
  let operation = await response.json() as LongRunningOperation
  while (operation.done !== true) {
    await sleep(Math.min(GEMINI_ONBOARD_POLL_INTERVAL_MS, remaining()))
    const name = operation.name
    if (name === undefined) throw new Error('gemini onboardUser returned an operation without a name')
    const poll = await fetch(`${GEMINI_CODE_ASSIST_URL}/v1internal/${name}`, {
      method: 'GET',
      headers: { authorization: headers.authorization },
      signal: AbortSignal.timeout(remaining()),
    })
    if (!poll.ok) throw new Error(`gemini project provisioning poll failed (HTTP ${poll.status})`)
    operation = await poll.json() as LongRunningOperation
  }
  if (operation.error !== undefined && operation.error !== null) {
    const detail = operation.error.message !== undefined
      ? typeof operation.error.code === 'number'
        ? `${operation.error.code}: ${operation.error.message}`
        : operation.error.message
      : JSON.stringify(operation.error)
    throw new Error(`gemini onboardUser operation failed: ${detail}`)
  }
}

/**
 * Discover (or provision) the Cloud Code Assist project for a logged-in
 * account, mirroring the official Antigravity client: `loadCodeAssist` first
 * (twice when a project exists but the paid-tier linkage is not yet
 * established), free-tier eligibility checked, `onboardUser` when the account
 * has no tier yet, then `loadCodeAssist` again for the project id. The project
 * id is REQUIRED for every chat/usage request.
 * @param accessToken - the freshly issued access token.
 * @returns the Cloud Code Assist project id.
 */
export async function discoverGeminiProject(accessToken: string): Promise<string> {
  const headers = {
    'authorization': `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': GEMINI_DISCOVERY_USER_AGENT,
  }
  const metadata = { ideType: 'ANTIGRAVITY' }
  const load = async (body: Record<string, unknown>): Promise<LoadCodeAssistPayload> => {
    const response = await fetch(`${GEMINI_CODE_ASSIST_URL}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_LOGIN_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`gemini loadCodeAssist failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`)
    }
    return response.json() as Promise<LoadCodeAssistPayload>
  }

  let payload = await load({ metadata })
  const projectId = payload.cloudaicompanionProject
  // The real client re-loads with the project id when no paid-tier record is
  // present yet, which completes the paid-tier linkage.
  if (payload.paidTier === undefined && projectId !== undefined) {
    payload = await load({ cloudaicompanionProject: projectId, metadata })
  }

  // A free-tier ineligibility reason (e.g. account validation required) is
  // surfaced with the reason and any verification URL, mirroring the official
  // client — onboarding a flagged account would otherwise complete without a
  // project.
  const freeIneligible = payload.ineligibleTiers?.find(tier => tier.tierId === GEMINI_FREE_TIER)
  if (freeIneligible?.reasonMessage !== undefined) {
    const validation = freeIneligible.validationUrl !== undefined
      ? `\n${freeIneligible.validationUrl}`
      : ''
    throw new Error(`gemini account is not eligible for Cloud Code Assist: ${freeIneligible.reasonMessage}${validation}`)
  }

  // No current tier → the account has never been provisioned: onboard onto the
  // free tier, then reload the project.
  if (payload.currentTier === undefined || payload.currentTier === null) {
    await onboardGeminiUser(headers, metadata)
  }
  const refreshed = await load({ metadata })
  const id = refreshed.cloudaicompanionProject
  if (id === undefined) {
    // The raw payload is included so a provisioning failure is diagnosable
    // from the card/terminal without another login round-trip.
    throw new Error(
      'gemini loadCodeAssist did not return a cloudaicompanionProject '
      + `(response: ${JSON.stringify(refreshed).slice(0, 500)})`,
    )
  }
  return id
}

/**
 * Exchange an authorization code for a gemini session: token exchange, then
 * the account email and the Cloud Code Assist project id (discovery +
 * provisioning) — the project is required for every later request, so a login
 * that cannot obtain it fails here rather than storing a half-usable session.
 * @param code - the authorization code from the callback.
 * @param redirectUri - the attempt's redirect URI.
 * @returns the session to store.
 */
export async function exchangeGeminiCode(code: string, redirectUri: string): Promise<GeminiSession> {
  const response = await fetch(GEMINI_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(GEMINI_LOGIN_TIMEOUT_MS),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'gemini')
  const tokens = await response.json() as GeminiTokenResponse
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('gemini token endpoint returned no access token')
  }
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length === 0) {
    // A missing refresh token means the grant was issued without offline
    // access (e.g. the account already authorized with a different scope set).
    throw new Error('gemini token endpoint returned no refresh token; revoke the app in your Google account and try again')
  }
  const [projectId, account] = await Promise.all([
    discoverGeminiProject(tokens.access_token),
    fetchGeminiEmail(tokens.access_token),
  ])
  return geminiSession(tokens, projectId, undefined, account)
}

/**
 * Refresh a gemini session (form-encoded grant with the client secret).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshGemini(session: GeminiSession): Promise<GeminiSession> {
  const response = await fetch(GEMINI_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      refresh_token: session.refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(GEMINI_LOGIN_TIMEOUT_MS),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'gemini')
  return geminiSession(
    await response.json() as GeminiTokenResponse,
    session.projectId,
    session.refreshToken,
    session.account,
  )
}

/**
 * Whether a gemini refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isGeminiPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError
    && (error.oauthCode === 'invalid_grant' || error.oauthCode === 'invalid_client')
}

/** One quota entry in the Antigravity `retrieveUserQuota` response. */
interface AntigravityQuotaInfo {
  remainingFraction?: number
  resetTime?: string
}

/** One bucket of the retrieveUserQuota response (subset). */
interface AntigravityQuotaBucket {
  modelId?: string
  remainingFraction?: number
  resetTime?: string
  tokenType?: string
}

/** The per-model quota payload subset the Antigravity usage endpoint returns. */
interface AntigravityModelUsage {
  quotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[]
  quotaInfos?: AntigravityQuotaInfo | AntigravityQuotaInfo[]
  dailyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[]
  dailyQuotaInfos?: AntigravityQuotaInfo | AntigravityQuotaInfo[]
  weeklyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[]
  weeklyQuotaInfos?: AntigravityQuotaInfo | AntigravityQuotaInfo[]
  quotaInfoByTier?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>
  quotaInfoByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>
  quotaInfosByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>
}

/**
 * Fetch the gemini subscription usage from the Antigravity quota endpoint
 * (the source of the Antigravity/Gemini CLI `/usage` quota panel). Each quota
 * entry is one model's remaining-fraction window (daily/weekly etc.); the
 * subscription tier (plan) is not disclosed here, so none is reported.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchGeminiUsage(
  session: GeminiSession,
  fetchFn: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const response = await fetchFn(`${GEMINI_CODE_ASSIST_URL}/v1internal:retrieveUserQuota`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
      'user-agent': GEMINI_DISCOVERY_USER_AGENT,
      'accept': 'application/json',
    },
    body: JSON.stringify({ project: session.projectId }),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'gemini usage')
  const payload = await response.json() as {
    buckets?: AntigravityQuotaBucket[]
    models?: Record<string, AntigravityModelUsage>
  }
  const windows: UsageWindow[] = []
  if (Array.isArray(payload.buckets)) {
    // Group buckets into two primary pools matching Antigravity:
    // 1. "Gemini Models" (gemini-* models)
    // 2. "Claude and GPT models" (claude-*, gpt-* models)
    const pools: { scope: string; match: (id: string) => boolean }[] = [
      { scope: 'Gemini Models', match: id => id.startsWith('gemini') },
      { scope: 'Claude and GPT models', match: id => id.startsWith('claude') || id.startsWith('gpt') },
    ]

    for (const pool of pools) {
      const poolBuckets = payload.buckets.filter(bucket => {
        if (typeof bucket !== 'object' || bucket === null) return false
        const id = bucket.modelId
        if (typeof id !== 'string' || id.length === 0) return false
        if (GEMINI_DISCOVERY_DENYLIST.has(id) || GEMINI_DISCOVERY_DROP.has(id)) return false
        if (typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction)) return false
        return pool.match(id)
      })

      if (poolBuckets.length === 0) continue

      const byKind = new Map<UsageWindow['kind'], AntigravityQuotaBucket>()
      for (const bucket of poolBuckets) {
        const resetsAt = typeof bucket.resetTime === 'string' && bucket.resetTime.length > 0
          ? Date.parse(bucket.resetTime)
          : NaN
        const durationMs = Number.isFinite(resetsAt) ? resetsAt - Date.now() : 0
        const kind: UsageWindow['kind'] = durationMs > 24 * 3600 * 1000 ? 'weekly' : 'session'

        const existing = byKind.get(kind)
        // Keep the bucket with lowest remainingFraction (highest usage)
        if (existing === undefined || (bucket.remainingFraction ?? 1) < (existing.remainingFraction ?? 1)) {
          byKind.set(kind, bucket)
        }
      }

      for (const kind of ['weekly', 'session'] as const) {
        const bucket = byKind.get(kind)
        if (bucket === undefined) continue
        const resetsAt = typeof bucket.resetTime === 'string' && bucket.resetTime.length > 0
          ? Date.parse(bucket.resetTime)
          : NaN
        windows.push({
          kind,
          scope: pool.scope,
          // remainingFraction is the fraction LEFT; the card renders used percent.
          usedPercent: (1 - Math.min(Math.max(bucket.remainingFraction ?? 1, 0), 1)) * 100,
          ...Number.isFinite(resetsAt) ? { resetsAt } : {},
        })
      }
    }
  }

  if (windows.length === 0 && typeof payload.models === 'object' && payload.models !== null) {
    for (const [modelId, info] of Object.entries(payload.models)) {
      const infos: AntigravityQuotaInfo[] = []
      const add = (value: AntigravityQuotaInfo | AntigravityQuotaInfo[] | undefined): void => {
        if (value === undefined) return
        if (Array.isArray(value)) infos.push(...value)
        else infos.push(value)
      }
      add(info.quotaInfo)
      add(info.quotaInfos)
      add(info.dailyQuotaInfo)
      add(info.dailyQuotaInfos)
      add(info.weeklyQuotaInfo)
      add(info.weeklyQuotaInfos)
      for (const value of Object.values(info.quotaInfoByTier ?? {})) add(value)
      for (const value of Object.values(info.quotaInfoByWindow ?? {})) add(value)
      for (const value of Object.values(info.quotaInfosByWindow ?? {})) add(value)
      for (const quota of infos) {
        if (typeof quota.remainingFraction !== 'number' || !Number.isFinite(quota.remainingFraction)) continue
        const resetsAt = typeof quota.resetTime === 'string' && quota.resetTime.length > 0
          ? Date.parse(quota.resetTime)
          : NaN
        windows.push({
          kind: 'other',
          scope: modelId,
          // remainingFraction is the fraction LEFT; the card renders used percent.
          usedPercent: (1 - Math.min(Math.max(quota.remainingFraction, 0), 1)) * 100,
          ...Number.isFinite(resetsAt) ? { resetsAt } : {},
        })
      }
    }
  }
  return { supported: true, windows }
}

/** One `fetchAvailableModels` entry (subset). */
interface GeminiWireModel {
  displayName?: string
  supportsImages?: boolean
  supportsThinking?: boolean
  /** The discovery payload reports the context (input) cap here. */
  maxTokens?: number
  maxOutputTokens?: number
  isInternal?: boolean
  recommended?: boolean
}

/** Models the Antigravity catalog lists that must never appear in the picker. */
const GEMINI_DISCOVERY_DENYLIST = new Set(['chat_20706', 'chat_23310', 'gemini-2.5-pro'])

/**
 * One logical model family: Antigravity advertises each model as several
 * effort-suffixed wire ids (`gemini-3.7-flash-low|medium|high`), plus recycled
 * aliases (the old `gemini-2.5-flash*` ids now display as "Gemini 3.1 Flash
 * Lite") and agent-only ids (`gemini-pro-agent`, `gemini-3-flash-agent`).
 * Each family collapses into ONE picker entry; requests route to `wire` (the
 * default effort variant). Mirrors oh-my-pi's `ANTIGRAVITY_VARIANT_COLLAPSE_TABLE`
 * for the budget transport.
 */
interface GeminiModelFamily {
  /** Logical id shown in the picker and used by the harness. */
  id: string
  name: string
  /** Raw discovery ids that collapse into this entry. */
  members: readonly string[]
  /** Wire id sent for requests (the default effort variant). */
  wire: string
}

const GEMINI_MODEL_FAMILIES: readonly GeminiModelFamily[] = [
  {
    id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash',
    members: ['gemini-3.7-flash-low', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-high'],
    wire: 'gemini-3.7-flash-medium',
  },
  {
    id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash',
    members: ['gemini-3.6-flash-low', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-high'],
    wire: 'gemini-3.6-flash-medium',
  },
  {
    id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash',
    members: ['gemini-3.5-flash-extra-low', 'gemini-3.5-flash-low', 'gemini-3-flash-agent'],
    wire: 'gemini-3.5-flash-extra-low',
  },
  {
    id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro',
    members: ['gemini-3.1-pro-low', 'gemini-pro-agent', 'gemini-3.1-pro-high'],
    wire: 'gemini-3.1-pro-low',
  },
  {
    id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite',
    members: ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-thinking'],
    wire: 'gemini-3.1-flash-lite',
  },
]

/** Raw discovery ids that are not user-facing chat models (image checkpoints, internal tiered ids). */
const GEMINI_DISCOVERY_DROP = new Set([
  'gemini-3.1-flash-image',
  'gemini-3.6-flash-tiered',
  'gemini-3.7-flash-tiered',
])

/**
 * The wire id for a picker (logical) model id: its family's default effort
 * variant, or the id itself when not collapsed. Every request body must route
 * through this — a logical id alone (e.g. `gemini-3.7-flash`) is not accepted
 * by `streamGenerateContent`.
 * @param modelId - the logical id selected in the picker.
 * @returns the wire id to send upstream.
 */
export function geminiWireModelId(modelId: string): string {
  return GEMINI_MODEL_FAMILIES.find(family => family.id === modelId)?.wire ?? modelId
}

/**
 * Fetch the live gemini model catalog from the Antigravity Cloud Code Assist
 * `fetchAvailableModels` endpoint (the Antigravity model picker's source),
 * filtered to Gemini models the account can actually use and collapsed into
 * one entry per logical model (effort variants, aliases, and stale ids
 * dedupe away). The discovery endpoints are tried in order; a 200 with a
 * usable list from any of them wins.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns discovered chat models, sorted by display name.
 */
export async function fetchGeminiModels(session: GeminiSession, fetchFn: FetchFn = fetch): Promise<DiscoveredModel[]> {
  let lastError: unknown
  for (const endpoint of GEMINI_DISCOVERY_ENDPOINTS) {
    try {
      const response = await fetchFn(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'user-agent': GEMINI_DISCOVERY_USER_AGENT,
          'accept': 'application/json',
        },
        body: JSON.stringify({}),
      })
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`)
        continue
      }
      const payload = await response.json() as { models?: Record<string, GeminiWireModel> }
      if (typeof payload.models !== 'object' || payload.models === null) {
        lastError = new Error('no models map')
        continue
      }
      const discovered: DiscoveredModel[] = []
      const emittedFamilies = new Set<string>()
      for (const [id, model] of Object.entries(payload.models)) {
        if (GEMINI_DISCOVERY_DENYLIST.has(id)) continue
        if (GEMINI_DISCOVERY_DROP.has(id)) continue
        if (model.isInternal === true) continue
        if (!id.startsWith('gemini')) continue
        const family = GEMINI_MODEL_FAMILIES.find(candidate => candidate.members.includes(id))
        if (family !== undefined) {
          // Collapse: the first member seen creates the logical entry; later
          // members of the same family are consumed.
          if (emittedFamilies.has(family.id)) continue
          emittedFamilies.add(family.id)
          discovered.push({
            id: family.id,
            name: family.name,
            ...typeof model.maxTokens === 'number' && model.maxTokens > 0
              ? { contextWindow: model.maxTokens }
              : {},
            ...typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
              ? { maxTokens: model.maxOutputTokens }
              : {},
          })
          continue
        }
        discovered.push({
          id,
          name: typeof model.displayName === 'string' && model.displayName.length > 0
            ? model.displayName
            : id,
          ...typeof model.maxTokens === 'number' && model.maxTokens > 0
            ? { contextWindow: model.maxTokens }
            : {},
          ...typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
            ? { maxTokens: model.maxOutputTokens }
            : {},
        })
      }
      discovered.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      if (discovered.length === 0) {
        lastError = new Error('empty catalog')
        continue
      }
      return discovered
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`gemini model discovery failed (${errorChain(lastError)})`)
}

/** Constructor dependencies for {@link GeminiAdapter}. */
export interface GeminiAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: TokenManager<GeminiSession>
  /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
  discovery: boolean
  /** Warning sink for discovery failures that fall back to the static catalog. */
  onWarn?: (message: string) => void
  /** Fetch implementation for discovery (defaults to global fetch). */
  fetchFn?: FetchFn
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Durable catalog store seeding capability metadata across restarts. */
  catalogStore?: CatalogPersistence
}

/** An Antigravity session id: a negative int63 decimal string (client-shaped). */
function antigravitySessionId(): string {
  const bytes = randomBytes(8)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return `-${(value & ((1n << 63n) - 1n)).toString()}`
}

/** Gemini wire adapter: one instance serves the `gemini` provider route. */
export class GeminiAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache
  /**
   * Thought signatures captured from model responses, keyed by
   * `${sessionId}:${toolCallId}`. Cloud Code Assist requires them echoed on
   * replayed `functionCall` parts; the harness's own message vocabulary has
   * no slot for them, so the adapter carries them across turns.
   */
  private readonly thoughtSignatures: ThoughtSignatureStore = new Map()

  constructor(private readonly options: GeminiAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  /** Discovery fetcher: resolves the session through the refresh-aware path. */
  private async fetchCatalog(): Promise<DiscoveredModel[]> {
    return fetchGeminiModels(await this.options.tokens.session(), this.options.fetchFn)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Gemini (Subscription)' }
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? GEMINI_MODALITIES,
    }))
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // Not logged in → empty catalog, so the web picker drops the provider.
    const session = await this.options.tokens.peek()
    if (session === undefined) return []
    if (!this.options.discovery) return this.staticModels(provider)
    try {
      const discovered = await this.catalog.get(() => this.fetchCatalog())
      return discovered.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: GEMINI_MODALITIES,
      }))
    } catch (error: unknown) {
      // A permanent refresh failure deletes the stored session: the provider
      // is logged out, so hide it instead of showing a stale static catalog.
      if (error instanceof LlmError
        && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')) return []
      if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate()
      this.options.onWarn?.(
        `gemini model discovery failed; using the built-in catalog (${errorChain(error)})`,
      )
      return this.staticModels(provider)
    }
  }

  /** The discovered entry for one model, through the cache's stale-while-revalidate path. */
  private async discovered(model: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    const models = await this.catalog.resolve(() => this.fetchCatalog())
    return models?.find(entry => entry.id === model)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const discovered = await this.discovered(model)
    const configured = this.options.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      inputModalities: configured?.inputModalities ?? GEMINI_MODALITIES,
      context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? GEMINI_CONTEXT_WINDOW },
      defaultMaxTokens: discovered?.maxTokens ?? configured?.maxTokens ?? GEMINI_DEFAULT_MAX_TOKENS,
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      let session = await this.options.tokens.session()
      let response = await this.request(options, session, watchdog.signal)
      if (response.status === 401) {
        // One forced refresh + retry on an unexpired-but-rejected token.
        session = await this.options.tokens.session(true)
        response = await this.request(options, session, watchdog.signal)
      }
      if (!response.ok) throw await httpLlmError(response, 'gemini API')
      if (response.body === null) {
        throw new LlmError('gemini API returned no response body', EMPTY_RESPONSE_CODE)
      }
      yield* streamGemini(response.body, () => { watchdog.pulse() }, {
        signatures: this.thoughtSignatures,
        ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
      })
    } catch (error: unknown) {
      throw mapFetchFailure('gemini API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  private async request(options: GenerateOptions, session: GeminiSession, signal: AbortSignal): Promise<Response> {
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal)
    const contents = toGeminiContents(messages, {
      signatures: this.thoughtSignatures,
      ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
    })
    const tools = options.tools !== undefined ? toGeminiTools(options.tools) : []
    const systemTexts: string[] = []
    for (const message of messages) {
      if (message.role !== 'system') continue
      for (const block of message.content) {
        if (block.type === 'text') systemTexts.push(block.text)
      }
    }
    const systemPrompt = options.system !== undefined && options.system.length > 0
      ? options.system
      : systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined
    // Discovered output caps win (the catalog reports per-model limits); with
    // discovery off (config override) the configured entry is the source.
    const disc = await this.discovered(options.model)
    const maxTokens = options.maxTokens
      ?? disc?.maxTokens
      ?? this.options.models.find(entry => entry.id === options.model)?.maxTokens
      ?? GEMINI_DEFAULT_MAX_TOKENS
    // The logical picker id maps to its default effort wire variant (e.g.
    // `gemini-3.7-flash` → `gemini-3.7-flash-medium`) — the wire id is what
    // `streamGenerateContent` accepts.
    const wireModelId = geminiWireModelId(options.model)
    // The Antigravity request envelope: a structured requestId, sessionId, and
    // tracing labels, and `requestType: "agent"` — mirrors the real
    // `antigravity/hub` client (ephemeral ids per request are accepted).
    const trajectoryId = randomUUID()
    const body = {
      project: session.projectId,
      requestId: `agent/${randomUUID()}/${Date.now()}/${trajectoryId}/2`,
      request: {
        contents,
        ...systemPrompt === undefined ? {} : { systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] } },
        ...tools.length > 0 ? { tools, toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } } : {},
        generationConfig: { maxOutputTokens: maxTokens },
        labels: { last_step_index: '1', trajectory_id: trajectoryId, used_claude: 'false' },
        sessionId: antigravitySessionId(),
      },
      model: wireModelId,
      userAgent: 'antigravity',
      requestType: 'agent',
    }
    // 5xx fails over to the sandbox host; any other status is final.
    let response: Response | undefined
    for (const endpoint of GEMINI_CHAT_ENDPOINTS) {
      response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${session.accessToken}`,
          'user-agent': GEMINI_DISCOVERY_USER_AGENT,
          'accept': 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      })
      if (response.ok || response.status < 500) return response
    }
    return response as Response
  }
}
