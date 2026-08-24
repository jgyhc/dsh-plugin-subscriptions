/**
 * Cursor auth helpers and usage mapping (phase 1): PKCE params, API-key
 * exchange, and `auth/usage` / summary → ProviderUsage, via injected fetch.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCursorRequestContextRules,
  buildMcpToolDefinitions,
  buildCursorRunRequest,
  resetCursorConversationCache,
} from '../src/translate/cursor-request.js'
import { CursorAdapter } from '../src/providers/cursor-adapter.js'
import { TokenManager } from '../src/providers/common.js'
import type { FetchFn } from '../src/providers/common.js'
import type { CursorSession } from '../src/auth/store.js'
import {
  CURSOR_AUTH_ME_URL,
  CURSOR_API_USAGE_SUMMARY_URL,
  CURSOR_POLL_URL,
  CURSOR_REFRESH_URL,
  CURSOR_USAGE_SUMMARY_URL,
  CURSOR_USAGE_URL,
  cursorExpiresAt,
  cursorUserId,
  exchangeCursorApiKey,
  fetchCursorUsage,
  generateCursorAuthParams,
  parseCursorUsage,
  pollCursorAuth,
} from '../src/providers/cursor.js'

/** Build a compact unsigned-looking JWT with a JSON payload (signature unused). */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

/** Match an exact URL or the same path with a query string. */
function urlIs(base: string, href: string): boolean {
  return href === base || href.startsWith(`${base}?`)
}

/** A fetch implementation that routes by URL substring. */
function routedFetch(routes: {
  match: (url: string, init?: RequestInit) => boolean
  status?: number
  body?: unknown
  text?: string
}[]): { fetchFn: FetchFn; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = []
  const fetchFn: FetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, method: (init?.method ?? 'GET').toUpperCase() })
    for (const route of routes) {
      if (!route.match(href, init)) continue
      if (route.text !== undefined) {
        return Promise.resolve(new Response(route.text, { status: route.status ?? 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify(route.body ?? {}), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }) as FetchFn
  return { fetchFn, calls }
}

test('generateCursorAuthParams embeds PKCE challenge and uuid', () => {
  const params = generateCursorAuthParams()
  assert.match(params.loginUrl, /^https:\/\/cursor\.com\/loginDeepControl\?/)
  const url = new URL(params.loginUrl)
  assert.equal(url.searchParams.get('challenge'), params.challenge)
  assert.equal(url.searchParams.get('uuid'), params.uuid)
  assert.equal(url.searchParams.get('mode'), 'login')
  assert.equal(url.searchParams.get('redirectTarget'), 'cli')
  assert.equal(params.challenge.length > 0, true)
  assert.equal(params.verifier.length > 0, true)
  assert.notEqual(params.challenge, params.verifier)
})

test('cursorUserId and cursorExpiresAt read JWT claims', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = fakeJwt({ sub: 'auth0|user_abc', exp })
  assert.equal(cursorUserId(token), 'user_abc')
  const expiresAt = cursorExpiresAt(token)
  assert.ok(expiresAt < exp * 1000)
  assert.ok(expiresAt > Date.now())
})

test('exchangeCursorApiKey posts to exchange_user_api_key and builds a session', async () => {
  const access = fakeJwt({ sub: 'auth0|u1', exp: Math.floor(Date.now() / 1000) + 7200 })
  const { fetchFn, calls } = routedFetch([
    {
      match: url => url.startsWith(CURSOR_REFRESH_URL),
      body: { accessToken: access, refreshToken: 'rt-new' },
    },
    {
      match: url => url.startsWith(CURSOR_AUTH_ME_URL),
      body: { sub: 'u1', email: 'dev@example.com' },
    },
  ])
  const session = await exchangeCursorApiKey('cursor_api_key', fetchFn)
  assert.equal(session.accessToken, access)
  assert.equal(session.refreshToken, 'rt-new')
  assert.equal(session.emailAddress, 'dev@example.com')
  assert.ok(session.expiresAt > Date.now())
  assert.equal(calls[0]?.method, 'POST')
  assert.match(calls[0]!.url, /exchange_user_api_key/)
})

test('exchangeCursorApiKey falls back to the pasted key as refresh token', async () => {
  const access = fakeJwt({ sub: 'auth0|u2', exp: Math.floor(Date.now() / 1000) + 7200 })
  const { fetchFn } = routedFetch([
    {
      match: url => url.startsWith(CURSOR_REFRESH_URL),
      body: { accessToken: access },
    },
  ])
  const session = await exchangeCursorApiKey('  pasted-key  ', fetchFn)
  assert.equal(session.refreshToken, 'pasted-key')
})

test('pollCursorAuth returns tokens after a 404 then 200', async () => {
  let polls = 0
  const fetchFn: FetchFn = ((url: string | URL | Request) => {
    const href = String(url)
    assert.match(href, new RegExp(CURSOR_POLL_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    polls++
    if (polls === 1) return Promise.resolve(new Response('', { status: 404 }))
    return Promise.resolve(new Response(JSON.stringify({
      accessToken: fakeJwt({ sub: 'auth0|u3', exp: Math.floor(Date.now() / 1000) + 3600 }),
      refreshToken: 'rt-poll',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as FetchFn
  const tokens = await pollCursorAuth('uuid-1', 'verifier-1', undefined, fetchFn)
  assert.equal(tokens.refreshToken, 'rt-poll')
  assert.equal(polls, 2)
})

test('parseCursorUsage prefers dashboard plan percents', () => {
  const usage = parseCursorUsage(
    { planUsage: { used: 1, limit: 10 } },
    {
      membershipType: 'pro',
      individualUsage: {
        plan: { autoPercentUsed: 12.5, apiPercentUsed: 40 },
      },
    },
  )
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, 'pro')
  const windows = usage.windows ?? []
  assert.ok(windows.some(w => w.scope === 'Cursor Models' && w.usedPercent === 12.5))
  assert.ok(windows.some(w => w.scope === 'API Models' && w.usedPercent === 40))
})

test('parseCursorUsage falls back to auth/usage buckets', () => {
  const usage = parseCursorUsage({
    planType: 'pro+',
    gpt4: { numRequests: 25, maxRequestUsage: 100 },
  })
  assert.equal(usage.plan, 'pro+')
  assert.deepEqual(usage.windows, [
    { kind: 'other', scope: 'gpt4', usedPercent: 25 },
  ])
})

test('parseCursorUsage reads overall and on-demand cents buckets', () => {
  const usage = parseCursorUsage(undefined, {
    membershipType: 'ultra',
    billingCycleEnd: '2026-09-01T00:00:00.000Z',
    individualUsage: {
      overall: { used: 2500, limit: 10_000 },
      onDemand: { used: 100, limit: 5000, enabled: true },
    },
  })
  assert.equal(usage.plan, 'ultra')
  const windows = usage.windows ?? []
  assert.ok(windows.some(w => w.scope === 'Personal Usage' && w.usedPercent === 25))
  assert.ok(windows.some(w => w.scope === 'On-Demand Usage' && w.usedPercent === 2))
  assert.ok(windows.every(w => typeof w.resetsAt === 'number'))
})

test('fetchCursorUsage survives a failed auth/usage when summary works', async () => {
  const access = fakeJwt({ sub: 'auth0|user_x', exp: Math.floor(Date.now() / 1000) + 3600 })
  const { fetchFn } = routedFetch([
    {
      match: url => urlIs(CURSOR_USAGE_URL, url),
      status: 500,
      text: 'boom',
    },
    {
      match: url => urlIs(CURSOR_API_USAGE_SUMMARY_URL, url),
      body: {
        membershipType: 'pro',
        individualUsage: { plan: { autoPercentUsed: 8 } },
      },
    },
  ])
  const usage = await fetchCursorUsage({
    accessToken: access,
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
  }, fetchFn)
  assert.equal(usage.plan, 'pro')
  assert.equal(usage.windows?.[0]?.usedPercent, 8)
})

test('fetchCursorUsage prefers api2 usage-summary over dashboard cookie', async () => {
  const access = fakeJwt({ sub: 'auth0|user_x', exp: Math.floor(Date.now() / 1000) + 3600 })
  const { fetchFn, calls } = routedFetch([
    {
      match: url => urlIs(CURSOR_API_USAGE_SUMMARY_URL, url),
      body: {
        membershipType: 'pro_plus',
        billingCycleEnd: '2026-09-05T14:18:17.000Z',
        individualUsage: {
          plan: { autoPercentUsed: 13.2, apiPercentUsed: 0, enabled: true },
          onDemand: { enabled: false, used: 0, limit: null },
        },
      },
    },
    {
      match: url => urlIs(CURSOR_USAGE_URL, url),
      body: { 'gpt-4': { numRequests: 0, maxRequestUsage: null } },
    },
    {
      match: url => urlIs(CURSOR_USAGE_SUMMARY_URL, url),
      status: 401,
      text: 'not_authenticated',
    },
  ])
  const usage = await fetchCursorUsage({
    accessToken: access,
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
  }, fetchFn)
  assert.equal(usage.plan, 'pro_plus')
  const windows = usage.windows ?? []
  assert.ok(windows.some(w => w.scope === 'Cursor Models' && Math.abs(w.usedPercent - 13.2) < 0.01))
  assert.ok(windows.some(w => w.scope === 'API Models' && w.usedPercent === 0))
  assert.ok(calls.some(call => urlIs(CURSOR_API_USAGE_SUMMARY_URL, call.url)))
  assert.equal(calls.some(call => urlIs(CURSOR_USAGE_SUMMARY_URL, call.url)), false)
})

test('buildCursorRunRequest encodes a user turn with MCP tools and rules', () => {
  resetCursorConversationCache()
  const built = buildCursorRunRequest({
    model: 'composer-2.5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    system: 'Be concise.',
    tools: [{ name: 'search', description: 'search the web', parameters: { type: 'object', properties: {} } }],
    sessionId: 'sess-1',
  })
  assert.ok(built.requestBytes.byteLength > 0)
  assert.equal(built.mcpTools.length, 1)
  assert.equal(built.rules.length, 1)
})

test('CursorAdapter listModels returns [] when logged out', async () => {
  const tokens = new TokenManager<CursorSession>({
    displayName: 'Cursor',
    preemptMs: 0,
    load: () => Promise.resolve(undefined),
    save: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    refresh: session => Promise.resolve(session),
    isPermanent: () => false,
  })
  const adapter = new CursorAdapter({
    models: [{ id: 'composer-2.5', name: 'Composer 2.5' }],
    streamIdleTimeoutMs: 30_000,
    tokens,
    discovery: true,
  })
  assert.deepEqual(await adapter.listModels('cursor'), [])
})

test('buildMcpToolDefinitions skips native Cursor tool names', () => {
  const tools = buildMcpToolDefinitions([
    { name: 'bash', description: 'shell', parameters: { type: 'object', properties: {} } },
    { name: 'search', description: 'search', parameters: { type: 'object', properties: {} } },
  ])
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.name, 'search')
})

test('resolveCursorWireModel keeps Claude effort slugs intact', async () => {
  const { resolveCursorWireModel } = await import('../src/translate/cursor-request.js')
  const claude = resolveCursorWireModel('claude-4.6-opus-high', undefined, 'normalized')
  assert.equal(claude.modelId, 'claude-4.6-opus-high')
  assert.equal(claude.parameters.length, 0)
  const gpt = resolveCursorWireModel('gpt-5.3-codex-high', undefined, 'normalized')
  assert.equal(gpt.modelId, 'gpt-5.3-codex')
  assert.deepEqual(gpt.parameters, [{ id: 'reasoning', value: 'high' }])
  const discovered = resolveCursorWireModel('gpt-5.3-codex-high', undefined, 'discovered')
  assert.equal(discovered.modelId, 'gpt-5.3-codex-high')
})

test('fetchCursorUsage hits auth/usage and optional summary', async () => {
  const access = fakeJwt({ sub: 'auth0|user_x', exp: Math.floor(Date.now() / 1000) + 3600 })
  const { fetchFn, calls } = routedFetch([
    {
      match: url => urlIs(CURSOR_USAGE_URL, url),
      body: { planType: 'pro' },
    },
    {
      match: url => urlIs(CURSOR_API_USAGE_SUMMARY_URL, url),
      body: {
        membershipType: 'pro',
        individualUsage: { plan: { autoPercentUsed: 8 } },
      },
    },
  ])
  const usage = await fetchCursorUsage({
    accessToken: access,
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
  }, fetchFn)
  assert.equal(usage.plan, 'pro')
  assert.equal(usage.windows?.[0]?.usedPercent, 8)
  assert.ok(calls.some(call => urlIs(CURSOR_USAGE_URL, call.url)))
  assert.ok(calls.some(call => urlIs(CURSOR_API_USAGE_SUMMARY_URL, call.url)))
})
