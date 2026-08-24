/**
 * Cursor subscription auth, usage, and AgentService streaming (phase 2).
 *
 * Auth mirrors oh-my-pi's Cursor OAuth: PKCE deep-control login with poll, or
 * an API key / refresh token exchanged at `auth/exchange_user_api_key`. Chat
 * uses HTTP/2 Connect/protobuf against `AgentService/Run`.
 *
 * Reference: https://github.com/can1357/oh-my-pi (MIT)
 *   packages/ai/src/registry/oauth/cursor.ts
 *   packages/ai/src/usage/cursor.ts
 */

import { randomUUID } from 'node:crypto'
import { decodeJwtPayload } from '../auth/jwt.js'
import { createPkce } from '../auth/pkce.js'
import type { CursorSession } from '../auth/store.js'
import { OAuthEndpointError } from './common.js'
import type { FetchFn, ProviderUsage, UsageWindow } from './common.js'

export const CURSOR_API_URL = 'https://api2.cursor.sh'
export const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl'
export const CURSOR_POLL_URL = `${CURSOR_API_URL}/auth/poll`
export const CURSOR_REFRESH_URL = `${CURSOR_API_URL}/auth/exchange_user_api_key`
export const CURSOR_USAGE_URL = `${CURSOR_API_URL}/auth/usage`
/** Bearer-auth usage summary on the API host (works for API-key / exchanged sessions). */
export const CURSOR_API_USAGE_SUMMARY_URL = `${CURSOR_API_URL}/auth/usage-summary`
export const CURSOR_AUTH_ME_URL = 'https://cursor.com/api/auth/me'
/** Dashboard cookie session summary; often 401 for CLI/API-key tokens. */
export const CURSOR_USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary'

/** Refresh when the access token has less than this much life left. */
export const CURSOR_PREEMPT_MS = 5 * 60_000

const POLL_MAX_ATTEMPTS = 150
const POLL_BASE_DELAY_MS = 1_000
const POLL_MAX_DELAY_MS = 10_000
const POLL_BACKOFF = 1.2

/** Sleep that respects an AbortSignal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    // Do not unref: an in-flight login poll must keep the process alive.
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Epoch ms at which we should refresh, derived from the JWT `exp` claim
 * (minus a five-minute preempt), or one hour from now when the token is opaque.
 */
export function cursorExpiresAt(accessToken: string): number {
  const payload = decodeJwtPayload(accessToken)
  if (typeof payload?.exp === 'number' && Number.isFinite(payload.exp)) {
    return payload.exp * 1000 - CURSOR_PREEMPT_MS
  }
  return Date.now() + 3_600_000
}

/**
 * WorkOS / Cursor user id from the access-token `sub` claim (`…|user_…`).
 * @returns the trailing user id segment, or undefined when absent.
 */
export function cursorUserId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken)
  if (typeof payload?.sub !== 'string' || payload.sub.length === 0) return undefined
  const parts = payload.sub.split('|')
  const id = (parts.length > 1 ? parts[parts.length - 1] : payload.sub).trim()
  return id.length > 0 ? id : undefined
}

/** Build a durable session from access/refresh tokens, optionally filling profile. */
export async function cursorSession(
  accessToken: string,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<CursorSession> {
  if (accessToken.length === 0) throw new Error('cursor returned no access token')
  if (refreshToken.length === 0) throw new Error('cursor returned no refresh token')
  const email = await fetchCursorEmail(accessToken, fetchFn)
  return {
    accessToken,
    refreshToken,
    expiresAt: cursorExpiresAt(accessToken),
    ...email === undefined ? {} : { emailAddress: email },
  }
}

/** Best-effort account email via the dashboard session cookie. */
async function fetchCursorEmail(accessToken: string, fetchFn: FetchFn): Promise<string | undefined> {
  const userId = cursorUserId(accessToken)
  if (userId === undefined) return undefined
  try {
    const response = await fetchFn(CURSOR_AUTH_ME_URL, {
      headers: {
        accept: 'application/json',
        cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`,
      },
    })
    if (!response.ok) return undefined
    const profile = await response.json() as Record<string, unknown>
    if (typeof profile.email === 'string' && profile.email.trim().length > 0) {
      return profile.email.trim()
    }
  } catch {
    // Profile is decorative; login success is owned by the token exchange.
  }
  return undefined
}

/** PKCE + uuid params for one deep-control login attempt. */
export interface CursorAuthParams {
  verifier: string
  challenge: string
  uuid: string
  loginUrl: string
}

/**
 * Mint Cursor deep-control login params (PKCE challenge + uuid).
 * @returns the authorize URL and secrets needed to poll for tokens.
 */
export function generateCursorAuthParams(): CursorAuthParams {
  const { verifier, challenge } = createPkce()
  const uuid = randomUUID()
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'cli',
  })
  return {
    verifier,
    challenge,
    uuid,
    loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}`,
  }
}

/**
 * Poll `auth/poll` until the user completes browser login or the attempt is aborted.
 * @param uuid - login attempt id embedded in the authorize URL.
 * @param verifier - PKCE verifier paired with the challenge.
 * @param signal - cancel the poll (user Cancel / timeout).
 * @param fetchFn - injectable fetch for tests.
 * @returns access + refresh tokens from a successful poll.
 */
export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  signal?: AbortSignal,
  fetchFn: FetchFn = fetch,
): Promise<{ accessToken: string; refreshToken: string }> {
  let delay = POLL_BASE_DELAY_MS
  let consecutiveErrors = 0
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay, signal)
    try {
      const response = await fetchFn(
        `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
        { ...signal === undefined ? {} : { signal } },
      )
      if (response.status === 404) {
        consecutiveErrors = 0
        delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS)
        continue
      }
      if (response.ok) {
        const data = await response.json() as { accessToken?: string; refreshToken?: string }
        if (typeof data.accessToken !== 'string' || data.accessToken.length === 0
          || typeof data.refreshToken !== 'string' || data.refreshToken.length === 0) {
          throw new Error('cursor poll returned incomplete tokens')
        }
        return { accessToken: data.accessToken, refreshToken: data.refreshToken }
      }
      throw new OAuthEndpointError(
        `cursor auth poll failed (HTTP ${String(response.status)})`,
        response.status,
      )
    } catch (error) {
      if (signal?.aborted === true) throw error
      if (error instanceof OAuthEndpointError) throw error
      consecutiveErrors++
      if (consecutiveErrors >= 3) {
        throw new Error('too many consecutive errors during Cursor auth polling', { cause: error })
      }
    }
  }
  throw new Error('Cursor authentication polling timed out')
}

/**
 * Exchange a Cursor user API key or refresh token for a fresh access/refresh pair.
 * @param apiKeyOrRefreshToken - Dashboard API key or stored refresh token.
 * @param fetchFn - injectable fetch for tests.
 * @returns a session ready to persist.
 */
export async function exchangeCursorApiKey(
  apiKeyOrRefreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<CursorSession> {
  const trimmed = apiKeyOrRefreshToken.trim()
  if (trimmed.length === 0) throw new Error('Cursor API key must be a non-empty string')
  const response = await fetchFn(CURSOR_REFRESH_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${trimmed}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new OAuthEndpointError(
      detail.length > 0
        ? `cursor token exchange failed (HTTP ${String(response.status)}): ${detail}`
        : `cursor token exchange failed (HTTP ${String(response.status)})`,
      response.status,
    )
  }
  const data = await response.json() as { accessToken?: string; refreshToken?: string }
  if (typeof data.accessToken !== 'string' || data.accessToken.length === 0) {
    throw new Error('cursor token exchange returned no access token')
  }
  const refreshToken = typeof data.refreshToken === 'string' && data.refreshToken.length > 0
    ? data.refreshToken
    : trimmed
  return cursorSession(data.accessToken, refreshToken, fetchFn)
}

/**
 * Refresh a stored Cursor session via `auth/exchange_user_api_key`.
 * @param session - the persisted session.
 * @param fetchFn - injectable fetch for tests.
 * @returns the refreshed session (preserves email when the profile lookup fails).
 */
export async function refreshCursor(
  session: CursorSession,
  fetchFn: FetchFn = fetch,
): Promise<CursorSession> {
  const next = await exchangeCursorApiKey(session.refreshToken, fetchFn)
  return {
    ...next,
    ...session.emailAddress !== undefined && next.emailAddress === undefined
      ? { emailAddress: session.emailAddress }
      : {},
  }
}

/** Permanent refresh failures that require a re-login. */
export function isCursorPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError
    && (error.status === 401 || error.status === 403)
}

/**
 * One in-flight Cursor deep-control login: exposes the authorize URL, waits for
 * poll completion, and can be cancelled from the Settings page.
 */
export class CursorLoginAttempt {
  readonly loginUrl: string
  private readonly controller = new AbortController()
  private readonly result: Promise<CursorSession>
  private settled = false

  constructor(
    private readonly fetchFn: FetchFn = fetch,
  ) {
    const params = generateCursorAuthParams()
    this.loginUrl = params.loginUrl
    this.result = pollCursorAuth(params.uuid, params.verifier, this.controller.signal, this.fetchFn)
      .then(({ accessToken, refreshToken }) => cursorSession(accessToken, refreshToken, this.fetchFn))
      .finally(() => { this.settled = true })
  }

  /** Whether the poll is still running. */
  get busy(): boolean {
    return !this.settled
  }

  /**
   * Wait for browser login to finish.
   * @returns the session to persist.
   * @throws when cancelled or the poll fails.
   */
  wait(): Promise<CursorSession> {
    return this.result
  }

  /** Abort the poll; {@link wait} rejects with `login cancelled`. */
  cancel(): void {
    if (this.settled) return
    this.controller.abort(new Error('login cancelled'))
  }
}

/** Coerce an unknown numeric field. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Prefer dashboard percent fields; fall back to used/limit ratios. */
function usedPercentOf(bucket: Record<string, unknown>): number | undefined {
  for (const key of ['autoPercentUsed', 'apiPercentUsed', 'totalPercentUsed', 'usedPercent']) {
    const pct = asNumber(bucket[key])
    if (pct !== undefined && pct >= 0) return Math.min(100, pct)
  }
  const used = asNumber(bucket.numRequests)
    ?? asNumber(bucket.used)
    ?? asNumber(bucket.amountUsed)
    ?? asNumber(bucket.usdUsed)
  const limit = asNumber(bucket.maxRequestUsage)
    ?? asNumber(bucket.limit)
    ?? asNumber(bucket.amountLimit)
    ?? asNumber(bucket.usdLimit)
  if (used === undefined) return undefined
  // Cursor often reports request buckets with `maxRequestUsage: null` (no
  // numeric cap). Surface an empty meter so the card is not blank when this
  // is the only source.
  if (limit === undefined || limit <= 0) return used === 0 ? 0 : undefined
  return Math.min(100, Math.max(0, (used / limit) * 100))
}

/** Parse a reset timestamp (seconds or ms or ISO string). */
function resetsAtOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Billing-cycle end from a usage payload (or start-of-month + 1 month). */
function deriveCursorResetsAt(payload: Record<string, unknown>): number | undefined {
  for (const key of ['billingCycleEnd', 'endOfMonth', 'resetsAt', 'nextReset', 'resetTime']) {
    const parsed = resetsAtOf(payload[key])
    if (parsed !== undefined) return parsed
  }
  for (const key of ['startOfMonth', 'billingCycleStart', 'startOfBillingCycle']) {
    const parsed = resetsAtOf(payload[key])
    if (parsed !== undefined) {
      const date = new Date(parsed)
      date.setUTCMonth(date.getUTCMonth() + 1)
      return date.getTime()
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** USD-cents bucket → used percent, when limit is present and positive. */
function centsBucketPercent(bucket: Record<string, unknown>): number | undefined {
  if (bucket.enabled === false) return undefined
  const limit = asNumber(bucket.limit)
  if (limit === undefined || limit <= 0) return undefined
  const used = asNumber(bucket.used)
  const remaining = asNumber(bucket.remaining)
  let usedCents: number | undefined
  if (used !== undefined && used > 0) usedCents = used
  else if (remaining !== undefined && remaining < limit) usedCents = Math.max(0, limit - remaining)
  else if (used !== undefined) usedCents = used
  if (usedCents === undefined) return undefined
  return Math.min(100, Math.max(0, (usedCents / limit) * 100))
}

/**
 * Map Cursor `auth/usage` (and optional dashboard summary) into the plugin's
 * usage windows. Buckets without a usable percent are skipped.
 */
export function parseCursorUsage(payload: unknown, summary?: unknown): ProviderUsage {
  const windows: UsageWindow[] = []
  let plan: string | undefined
  const seen = new Set<string>()

  const pushWindow = (
    scope: string | undefined,
    usedPercent: number,
    kind: UsageWindow['kind'],
    resetsAt?: number,
  ): void => {
    const key = `${scope ?? ''}:${kind}:${usedPercent.toFixed(2)}`
    if (seen.has(key)) return
    seen.add(key)
    windows.push({
      kind,
      usedPercent,
      ...scope === undefined ? {} : { scope },
      ...resetsAt === undefined ? {} : { resetsAt },
    })
  }

  const pushBucket = (
    scope: string | undefined,
    bucket: Record<string, unknown>,
    kind: UsageWindow['kind'],
    resetsAt?: number,
  ): void => {
    const usedPercent = usedPercentOf(bucket) ?? centsBucketPercent(bucket)
    if (usedPercent === undefined) return
    const bucketReset = resetsAtOf(bucket.resetsAt)
      ?? resetsAtOf(bucket.resetTime)
      ?? resetsAtOf(bucket.billingCycleEnd)
      ?? resetsAtOf(bucket.endOfMonth)
      ?? resetsAt
    pushWindow(scope, usedPercent, kind, bucketReset)
  }

  // Dashboard summary is the authoritative Pro/Pro+/Ultra view.
  if (isRecord(summary)) {
    if (typeof summary.membershipType === 'string' && summary.membershipType.length > 0) {
      plan = summary.membershipType
    } else if (typeof summary.plan === 'string' && summary.plan.length > 0) {
      plan = summary.plan
    }
    const summaryReset = deriveCursorResetsAt(summary)
    const individual = summary.individualUsage
    if (isRecord(individual)) {
      const overall = individual.overall
      const planBucket = individual.plan
      let usedOverall = false
      if (isRecord(overall)) {
        const pct = centsBucketPercent(overall) ?? usedPercentOf(overall)
        if (pct !== undefined) {
          usedOverall = true
          pushWindow('Personal Usage', pct, 'other', summaryReset)
        }
      }
      if (!usedOverall && isRecord(planBucket)) {
        const auto = asNumber(planBucket.autoPercentUsed)
        const api = asNumber(planBucket.apiPercentUsed)
        const total = asNumber(planBucket.totalPercentUsed)
        if (auto !== undefined) {
          pushWindow('Cursor Models', Math.min(100, auto), 'other', summaryReset)
        }
        if (api !== undefined) {
          pushWindow('API Models', Math.min(100, api), 'other', summaryReset)
        }
        if (auto === undefined && api === undefined) {
          if (total !== undefined) {
            pushWindow('Personal Usage', Math.min(100, total), 'other', summaryReset)
          } else {
            pushBucket('Personal Usage', planBucket, 'other', summaryReset)
          }
        }
      }
      if (isRecord(individual.onDemand)) {
        const pct = centsBucketPercent(individual.onDemand)
        if (pct !== undefined) {
          pushWindow('On-Demand Usage', pct, 'other', summaryReset)
        }
      }
    }
  }

  // Legacy auth/usage buckets fill gaps (and cover accounts without a dashboard summary).
  if (isRecord(payload)) {
    if (plan === undefined && typeof payload.planType === 'string' && payload.planType.length > 0) {
      plan = payload.planType
    }
    const legacyReset = deriveCursorResetsAt(payload)
    for (const [key, value] of Object.entries(payload)) {
      if (!isRecord(value)) continue
      // Skip decorative non-bucket keys.
      if (key === 'startOfMonth' || key === 'billingCycleStart') continue
      pushBucket(key, value, 'other', legacyReset)
    }
  }

  return {
    supported: true,
    windows,
    ...plan === undefined ? {} : { plan },
  }
}

/**
 * Fetch Cursor subscription usage for the Settings page.
 * @param session - a logged-in Cursor session.
 * @param fetchFn - injectable fetch for tests.
 * @param signal - caller cancellation.
 * @returns usage windows (may be empty when the account reports no meters).
 */
export async function fetchCursorUsage(
  session: CursorSession,
  fetchFn: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${session.accessToken}`,
  }
  const withSignal = signal === undefined ? {} : { signal }

  // Prefer the API-host summary (Bearer). The dashboard cookie endpoint often
  // 401s for API-key / exchanged CLI tokens.
  let summary: unknown
  try {
    const response = await fetchFn(CURSOR_API_USAGE_SUMMARY_URL, { headers, ...withSignal })
    if (response.ok) summary = await response.json()
  } catch {
    // Fall through to cookie dashboard / legacy auth/usage.
  }

  if (summary === undefined) {
    const userId = cursorUserId(session.accessToken)
    if (userId !== undefined) {
      try {
        const response = await fetchFn(CURSOR_USAGE_SUMMARY_URL, {
          headers: {
            accept: 'application/json',
            cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${session.accessToken}`)}`,
          },
          ...withSignal,
        })
        if (response.ok) summary = await response.json()
      } catch {
        // Dashboard summary is optional.
      }
    }
  }

  let payload: unknown
  let legacyStatus: number | undefined
  try {
    const legacy = await fetchFn(CURSOR_USAGE_URL, { headers, ...withSignal })
    legacyStatus = legacy.status
    if (legacy.ok) payload = await legacy.json()
  } catch {
    // Fall through to summary / empty.
  }

  const usage = parseCursorUsage(payload, summary)
  if ((usage.windows?.length ?? 0) > 0 || usage.plan !== undefined) return usage

  if (legacyStatus === 401 || legacyStatus === 403) {
    throw new OAuthEndpointError(
      `cursor usage failed (HTTP ${String(legacyStatus)})`,
      legacyStatus,
    )
  }
  return usage
}
