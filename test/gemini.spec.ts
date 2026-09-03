/**
 * Gemini provider: wire translation (contents/tools + SSE → StreamChunk),
 * usage and model-discovery payload mapping (via an injected fetch, no
 * network), and adapter login-gated catalogs.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallId, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OAuthEndpointError } from '../src/providers/common.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'
import {
  GeminiStreamTranslator,
  toGeminiContents,
  toGeminiTools,
} from '../src/translate/gemini.js'
import type { GeminiStreamEvent } from '../src/translate/gemini.js'
import {
  GeminiAdapter,
  fetchGeminiModels,
  fetchGeminiUsage,
  geminiWireModelId,
  isGeminiPermanentRefreshError,
} from '../src/providers/gemini.js'
import { TokenManager } from '../src/providers/common.js'
import type { FetchFn } from '../src/providers/common.js'
import type { GeminiSession } from '../src/auth/store.js'

const geminiSession: GeminiSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  projectId: 'projects/cloud-code-assist',
}

/** A TokenManager over an in-memory session; refresh never fires in these tests. */
function memoryTokens(initial: GeminiSession | undefined): TokenManager<GeminiSession> {
  let stored = initial
  return new TokenManager<GeminiSession>({
    displayName: 'Test',
    preemptMs: 0,
    load: () => Promise.resolve(stored),
    save: (session) => {
      stored = session
      return Promise.resolve()
    },
    remove: () => {
      stored = undefined
      return Promise.resolve()
    },
    refresh: session => Promise.resolve(session),
    isPermanent: () => false,
  })
}

/** A fetch implementation answering one JSON payload; records the request. */
function fakeFetch(payload: unknown, status = 200): {
  fetchFn: FetchFn
  requests: { url: string; method: string; headers: Record<string, string>; body: string }[]
} {
  const requests: { url: string; method: string; headers: Record<string, string>; body: string }[] = []
  const fetchFn: FetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
    requests.push({ url: String(url), method: init?.method ?? 'GET', headers, body: String(init?.body ?? '') })
    return Promise.resolve(new Response(JSON.stringify(payload), { status }))
  }) as FetchFn
  return { fetchFn, requests }
}

// --- wire translation -------------------------------------------------------

function msg(role: TranslatableMessage['role'], content: ContentBlock[]): TranslatableMessage {
  return { role, content }
}

test('toGeminiContents: text, tool call, tool result, and consecutive-role merging', () => {
  const contents = toGeminiContents([
    msg('system', [{ type: 'text', text: 'ignored here' }]),
    msg('user', [{ type: 'text', text: 'first' }]),
    msg('user', [
      { type: 'text', text: 'second' },
      {
        type: 'tool-result',
        toolCallId: ToolCallId('call-1'),
        toolName: undefined as never, // not a harness field; name comes from the call turn
        content: [{ type: 'text', text: 'ok' }],
      } as never,
    ]),
    msg('assistant', [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{"cmd":"ls"}' },
    ]),
    msg('user', [{
      type: 'tool-result',
      toolCallId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'file-a' }],
    } as never]),
  ])
  assert.deepEqual(contents, [
    {
      role: 'user',
      parts: [
        { text: 'first' },
        { text: 'second' },
        { functionResponse: { name: 'call-1', response: { output: 'ok' }, id: 'call-1' } },
      ],
    },
    {
      role: 'model',
      parts: [
        { text: 'calling' },
        { functionCall: { name: 'bash', args: { cmd: 'ls' }, id: 'call-1' }, thoughtSignature: 'skip_thought_signature_validator' },
      ],
    },
    {
      role: 'user',
      parts: [{ functionResponse: { name: 'bash', response: { output: 'file-a' }, id: 'call-1' } }],
    },
  ])
})

test('toGeminiContents: tool names follow their calls across turns and errors map to response.error', () => {
  const contents = toGeminiContents([
    msg('assistant', [{ type: 'tool-call', id: ToolCallId('c2'), name: 'grep', arguments: '{"q":"x"}' } as never]),
    msg('user', [{
      type: 'tool-result',
      toolCallId: ToolCallId('c2'),
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    } as never]),
  ])
  assert.deepEqual(contents, [
    {
      role: 'model',
      parts: [{ functionCall: { name: 'grep', args: { q: 'x' }, id: 'c2' }, thoughtSignature: 'skip_thought_signature_validator' }],
    },
    { role: 'user', parts: [{ functionResponse: { name: 'grep', response: { error: 'boom' }, id: 'c2' } }] },
  ])
})

test('toGeminiContents: resolved images become inlineData parts; malformed args degrade to {}', () => {
  const contents = toGeminiContents([
    msg('user', [
      { type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' } as never,
      { type: 'text', text: 'what is this?' },
    ]),
    msg('assistant', [{ type: 'tool-call', id: ToolCallId('c'), name: 'n', arguments: '{bad' } as never]),
  ])
  assert.deepEqual(contents, [
    {
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data: 'aGk=' } },
        { text: 'what is this?' },
      ],
    },
    {
      role: 'model',
      parts: [{ functionCall: { name: 'n', args: {}, id: 'c' }, thoughtSignature: 'skip_thought_signature_validator' }],
    },
  ])
})

test('thought signatures: captured on the stream, echoed on the next request', () => {
  // Response side: the translator records the signature under session + call id.
  const signatures = new Map<string, string>()
  const translator = new GeminiStreamTranslator(signatures, 'sess-1')
  translator.push({
    response: {
      candidates: [{
        content: {
          parts: [{ functionCall: { name: 'bash', args: { cmd: 'ls' }, id: 'call-9' }, thoughtSignature: 'sig-abc' }],
        },
        finishReason: 'STOP',
      }],
    },
  })
  assert.equal(signatures.get('sess-1:call-9'), 'sig-abc')

  // Request side: the captured signature is echoed on the call, unsigned
  // calls get the skip sentinel, and functionResponse parts carry no signature.
  const contents = toGeminiContents(
    [
      msg('assistant', [{ type: 'tool-call', id: ToolCallId('call-9'), name: 'bash', arguments: '{"cmd":"ls"}' } as never]),
      msg('user', [{ type: 'tool-result', toolCallId: ToolCallId('call-9'), content: [{ type: 'text', text: 'ok' }] } as never]),
      msg('assistant', [{ type: 'tool-call', id: ToolCallId('call-10'), name: 'grep', arguments: '{"q":"x"}' } as never]),
    ],
    { signatures, sessionId: 'sess-1' },
  )
  const first = contents[0].parts[0] as { functionCall?: unknown; thoughtSignature?: string }
  const second = contents[1].parts[0] as { functionResponse?: unknown; thoughtSignature?: string }
  const third = contents[2].parts[0] as { functionCall?: unknown; thoughtSignature?: string }
  assert.equal(first.thoughtSignature, 'sig-abc')
  assert.equal(second.thoughtSignature, undefined)
  assert.equal(third.thoughtSignature, 'skip_thought_signature_validator')
})

test('toGeminiTools wraps tools in functionDeclarations', () => {
  assert.deepEqual(toGeminiTools([{ name: 'bash', description: 'run', parameters: { type: 'object' } }]), [
    { functionDeclarations: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }] },
  ])
  assert.deepEqual(toGeminiTools([]), [])
})

test('toGeminiTools strips empty enum sentinels Gemini rejects', () => {
  const parameters = {
    type: 'object',
    properties: {
      permission: {
        type: 'string',
        enum: [
          'read-only',
          'workspace-write',
          'danger-full-access',
          'READ-ONLY',
          'WORKSPACE-WRITE',
          'DANGER-FULL-ACCESS',
          '',
        ],
      },
      nested: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['', 'standard'] },
          emptyOnly: { type: 'string', enum: [''] },
        },
      },
    },
  }
  const mapped = toGeminiTools([{ name: 'task_update', description: 'update a task', parameters }])
  const decls = mapped[0]?.functionDeclarations as Array<{ parameters: typeof parameters }>
  assert.deepEqual(decls[0].parameters.properties.permission.enum, [
    'read-only',
    'workspace-write',
    'danger-full-access',
    'READ-ONLY',
    'WORKSPACE-WRITE',
    'DANGER-FULL-ACCESS',
  ])
  assert.deepEqual(decls[0].parameters.properties.nested.properties.mode.enum, ['standard'])
  assert.equal('enum' in decls[0].parameters.properties.nested.properties.emptyOnly, false)
  // Original harness schema is left unchanged for other providers.
  assert.equal(parameters.properties.permission.enum.includes(''), true)
})

test('toGeminiTools strips $schema and collapses type unions Gemini rejects', () => {
  const parameters = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    exclusiveMinimum: 0,
    default: {},
    properties: {
      categoryId: { type: ['string', 'null'] },
      parentId: { type: ['string', 'null'], description: 'target parent' },
      title: { type: 'string' },
      tags: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
    },
    required: ['title'],
  }
  const mapped = toGeminiTools([{ name: 'create_case', description: 'create a case', parameters }])
  const decls = mapped[0]?.functionDeclarations as Array<{ parameters: Record<string, unknown> }>
  const sanitized = decls[0].parameters
  assert.equal('$schema' in sanitized, false)
  assert.equal('additionalProperties' in sanitized, false)
  assert.equal('exclusiveMinimum' in sanitized, false)
  assert.equal('default' in sanitized, false)
  assert.deepEqual(sanitized.properties, {
    categoryId: { type: 'string', nullable: true },
    parentId: { type: 'string', nullable: true, description: 'target parent' },
    title: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  })
  assert.deepEqual(sanitized.required, ['title'])
  assert.equal(sanitized.type, 'object')
  // Original harness schema is left unchanged for other providers.
  assert.equal(parameters.$schema, 'http://json-schema.org/draft-07/schema#')
  assert.deepEqual(parameters.properties.categoryId.type, ['string', 'null'])
})

/** Feed every event through a translator, then the terminal finish; flatten the chunks. */
function drainGemini(events: GeminiStreamEvent[]): StreamChunk[] {
  const translator = new GeminiStreamTranslator()
  const pushed = events.flatMap(event => translator.push(event))
  return [...pushed, ...translator.finish()]
}

test('Gemini translator: text + thinking + tool call stream with usage before finish', () => {
  const chunks = drainGemini([
    {
      response: {
        candidates: [{ content: { parts: [{ text: 'Hel' }] } }],
      },
    },
    {
      response: {
        candidates: [{ content: { parts: [{ text: 'lo' }, { text: 'thinking…', thought: true }] } }],
      },
    },
    {
      response: {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'bash', args: { cmd: 'ls' }, id: 'fc-1' } }] },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 30,
          candidatesTokenCount: 12,
          thoughtsTokenCount: 5,
          totalTokenCount: 147,
        },
      },
    },
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: 'thinking…' },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'thinking…' } },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'fc-1', name: 'bash', argumentsDelta: '{"cmd":"ls"}' },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'fc-1', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'usage', usage: { inputTokens: 70, outputTokens: 17, cacheReadTokens: 30, reasoningTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

test('Gemini translator: plain text completion finishes with stop; max tokens maps to max-tokens', () => {
  const chunks = drainGemini([
    { response: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } },
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  const maxed = drainGemini([
    {
      response: {
        candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      },
    },
  ])
  assert.deepEqual(maxed.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('Gemini translator: bare (unenveloped) SSE shape is accepted', () => {
  const chunks = drainGemini([
    { candidates: [{ content: { parts: [{ text: 'bare' }] }, finishReason: 'STOP' }] },
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'bare' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'bare' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('Gemini translator: empty completion is an EMPTY_RESPONSE error finish', () => {
  const chunks = drainGemini([
    { response: { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] } },
  ])
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
    },
  })
})

test('Gemini translator: safety finish reason surfaces as an error finish', () => {
  const chunks = drainGemini([
    { response: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }] } },
  ])
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'generation failed with finish reason: SAFETY', code: 'SERVER' } },
  })
})

test('Gemini translator: in-band error events throw, prompt block reason throws', () => {
  const translator = new GeminiStreamTranslator()
  assert.throws(
    () => translator.push({ error: { code: 429, message: 'rate limit exceeded', status: 'RESOURCE_EXHAUSTED' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'RATE_LIMIT',
  )
  const blocked = new GeminiStreamTranslator()
  assert.throws(
    () => blocked.push({ response: { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'nope' } } }),
    (error: unknown) => error instanceof LlmError && /blocked by Google/.test(error.message),
  )
})

// --- usage ------------------------------------------------------------------

test('fetchGeminiUsage maps buckets response into Gemini and Claude/GPT model pools', async () => {
  const futureSession = Date.now() + 4 * 3600 * 1000
  const futureWeekly = Date.now() + 6 * 24 * 3600 * 1000
  const sessionIso = new Date(futureSession).toISOString()
  const weeklyIso = new Date(futureWeekly).toISOString()
  const { fetchFn, requests } = fakeFetch({
    buckets: [
      { modelId: 'chat_20706', remainingFraction: 1 }, // denylisted
      { modelId: 'gemini-2.5-pro', remainingFraction: 0.9 }, // denylisted
      { modelId: 'gemini-3.1-flash-image', remainingFraction: 0.9 }, // dropped
      { modelId: 'gemini-3.7-flash-high', remainingFraction: 0.75, resetTime: weeklyIso },
      { modelId: 'gemini-3.7-flash-low', remainingFraction: 0.98, resetTime: sessionIso },
      { modelId: 'gemini-3.1-flash-lite', remainingFraction: 0.98, resetTime: sessionIso },
      { modelId: 'claude-sonnet-4-6', remainingFraction: 1, resetTime: weeklyIso },
      { modelId: 'gpt-oss-120b-medium', remainingFraction: 1, resetTime: sessionIso },
    ],
  })
  const usage = await fetchGeminiUsage(geminiSession, fetchFn)
  assert.deepEqual(usage, {
    supported: true,
    windows: [
      { kind: 'weekly', scope: 'Gemini Models', usedPercent: 25, resetsAt: Date.parse(weeklyIso) },
      { kind: 'session', scope: 'Gemini Models', usedPercent: 2.0000000000000018, resetsAt: Date.parse(sessionIso) },
      { kind: 'weekly', scope: 'Claude and GPT models', usedPercent: 0, resetsAt: Date.parse(weeklyIso) },
      { kind: 'session', scope: 'Claude and GPT models', usedPercent: 0, resetsAt: Date.parse(sessionIso) },
    ],
  })
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /v1internal:retrieveUserQuota/)
})

test('fetchGeminiUsage maps remaining fractions to used percents with reset times', async () => {
  const { fetchFn, requests } = fakeFetch({
    models: {
      'gemini-3-pro': {
        quotaInfo: { remainingFraction: 0.75, resetTime: '2026-08-18T10:14:00Z' },
      },
      'gemini-3-flash': {
        dailyQuotaInfo: { remainingFraction: 0.2, resetTime: '2026-08-18T10:14:00Z' },
        weeklyQuotaInfo: { remainingFraction: 0.5, resetTime: '2026-08-23T00:00:00Z' },
      },
      'gemini-2.5-flash': {
        quotaInfos: [
          { remainingFraction: 0, resetTime: '2026-08-19T00:00:00Z' },
          { remainingFraction: 1 }, // no reset time → window without resetsAt
          { resetTime: '2026-08-18T10:14:00Z' }, // no fraction → skipped
        ],
      },
      'gemini-internal': {
        quotaInfoByTier: { free: { remainingFraction: 0.875, resetTime: '2026-08-18T10:14:00Z' } },
      },
    },
  })
  const usage = await fetchGeminiUsage(geminiSession, fetchFn)
  assert.deepEqual(usage, {
    supported: true,
    windows: [
      { kind: 'other', scope: 'gemini-3-pro', usedPercent: 25, resetsAt: Date.parse('2026-08-18T10:14:00Z') },
      { kind: 'other', scope: 'gemini-3-flash', usedPercent: 80, resetsAt: Date.parse('2026-08-18T10:14:00Z') },
      { kind: 'other', scope: 'gemini-3-flash', usedPercent: 50, resetsAt: Date.parse('2026-08-23T00:00:00Z') },
      { kind: 'other', scope: 'gemini-2.5-flash', usedPercent: 100, resetsAt: Date.parse('2026-08-19T00:00:00Z') },
      { kind: 'other', scope: 'gemini-2.5-flash', usedPercent: 0 },
      { kind: 'other', scope: 'gemini-internal', usedPercent: 12.5, resetsAt: Date.parse('2026-08-18T10:14:00Z') },
    ],
  })
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /v1internal:retrieveUserQuota/)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].headers.authorization, 'Bearer at')
  assert.match(requests[0].headers['user-agent'] ?? '', /antigravity\/hub\//)
  assert.equal(requests[0].body, JSON.stringify({ project: geminiSession.projectId }))
})

test('fetchGeminiUsage: non-2xx response throws', async () => {
  const { fetchFn } = fakeFetch({ error: 'nope' }, 403)
  await assert.rejects(fetchGeminiUsage(geminiSession, fetchFn), /gemini usage/)
})

// --- model discovery ---------------------------------------------------------

const GEMINI_MODELS_PAYLOAD = {
  models: {
    'gemini-3.7-flash-high': { displayName: 'Gemini 3.7 Flash (High)', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
    'gemini-3.7-flash-medium': { displayName: 'Gemini 3.7 Flash (Medium)', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
    'gemini-3.7-flash-low': { displayName: 'Gemini 3.7 Flash (Low)', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
    'gemini-3.6-flash-medium': { displayName: 'Gemini 3.6 Flash (Medium)', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
    'gemini-3.5-flash-extra-low': { displayName: 'Gemini 3.5 Flash (Low)', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
    'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash (High)', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
    'gemini-3.1-pro-low': { displayName: 'Gemini 3.1 Pro (Low)', maxTokens: 1_048_576, maxOutputTokens: 65_535 },
    'gemini-pro-agent': { displayName: 'Gemini 3.1 Pro (High)', maxTokens: 1_048_576, maxOutputTokens: 65_535 },
    'gemini-3.1-flash-lite': { displayName: 'Gemini 3.1 Flash Lite', maxTokens: 1_048_576, maxOutputTokens: 65_535 },
    'gemini-2.5-flash': { displayName: 'Gemini 3.1 Flash Lite', maxTokens: 1_048_576, maxOutputTokens: 65_535 },
    'gemini-2.5-flash-thinking': { displayName: 'Gemini 3.1 Flash Lite', maxTokens: 1_048_576, maxOutputTokens: 65_535 },
    'gemini-3-flash': { displayName: 'Gemini 3 Flash', supportsImages: true, maxTokens: 1_048_576, maxOutputTokens: 65_536 },
    'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image' },
    'gemini-3.7-flash-tiered': {},
    'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', maxTokens: 1_000_000 },
    'chat_20706': { displayName: 'Internal Chat', isInternal: true },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxTokens: 200_000 },
    'gemini-internal-x': { displayName: 'Internal', isInternal: true },
  },
}

test('fetchGeminiModels maps, collapses, filters, and sorts the discovery payload', async () => {
  const { fetchFn, requests } = fakeFetch(GEMINI_MODELS_PAYLOAD)
  const models = await fetchGeminiModels(geminiSession, fetchFn)
  // Effort variants, recycled aliases, and agent ids collapse into one entry
  // per logical model; the list is clean and current.
  assert.deepEqual(models.map(model => model.id), [
    'gemini-3-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro',
    'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash',
  ])
  assert.deepEqual(models.map(model => model.name), [
    'Gemini 3 Flash', 'Gemini 3.1 Flash Lite', 'Gemini 3.1 Pro',
    'Gemini 3.5 Flash', 'Gemini 3.6 Flash', 'Gemini 3.7 Flash',
  ])
  // The collapsed entry inherits the first live member's caps.
  assert.equal(models[2].contextWindow, 1_048_576)
  assert.equal(models[2].maxTokens, 65_535)
  // Denylisted ids, internal models, non-Gemini (Claude) entries, image
  // checkpoints, and tiered internal ids are all dropped.
  assert.equal(models.some(model => model.id === 'gemini-2.5-pro'), false)
  assert.equal(models.some(model => model.id.includes('claude')), false)
  assert.equal(models.some(model => model.id.includes('2.5')), false)
  assert.equal(models.some(model => model.id === 'gemini-pro-agent'), false)
  assert.equal(models.some(model => model.id.includes('-tiered')), false)
  assert.equal(models.some(model => model.id.includes('flash-image')), false)
  // The sandbox fallback is never reached when the primary answers.
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /daily-cloudcode-pa\.googleapis\.com\/v1internal:fetchAvailableModels/)
  assert.equal(requests[0].headers['user-agent'], 'antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)')
})

test('geminiWireModelId routes logical ids to their default effort wire id', () => {
  assert.equal(geminiWireModelId('gemini-3.7-flash'), 'gemini-3.7-flash-medium')
  assert.equal(geminiWireModelId('gemini-3.6-flash'), 'gemini-3.6-flash-medium')
  assert.equal(geminiWireModelId('gemini-3.5-flash'), 'gemini-3.5-flash-extra-low')
  assert.equal(geminiWireModelId('gemini-3.1-pro'), 'gemini-3.1-pro-low')
  assert.equal(geminiWireModelId('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite')
  // Non-collapsed ids pass through unchanged.
  assert.equal(geminiWireModelId('gemini-3-flash'), 'gemini-3-flash')
  assert.equal(geminiWireModelId('gemini-unknown'), 'gemini-unknown')
})

test('fetchGeminiModels falls through to the sandbox endpoint when the primary fails', async () => {
  const calls: string[] = []
  const fetchFn = ((url: unknown) => {
    calls.push(String(url))
    if (String(url).includes('daily-cloudcode-pa.googleapis.com')) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    }
    return Promise.resolve(new Response(JSON.stringify(GEMINI_MODELS_PAYLOAD), { status: 200 }))
  }) as FetchFn
  const models = await fetchGeminiModels(geminiSession, fetchFn)
  assert.equal(models.length, 6)
  assert.equal(calls.length, 2)
  assert.match(calls[1] ?? '', /sandbox\.googleapis\.com/)
})

test('fetchGeminiModels throws when every endpoint fails', async () => {
  const failing: FetchFn = () => Promise.reject(new Error('offline'))
  await assert.rejects(fetchGeminiModels(geminiSession, failing), /gemini model discovery failed/)
})

// --- adapter ----------------------------------------------------------------

const STATIC_GEMINI = [{ id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }]

test('GeminiAdapter listModels returns [] when logged out', async () => {
  const adapter = new GeminiAdapter({
    models: STATIC_GEMINI,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(undefined),
    discovery: true,
    fetchFn: fakeFetch(GEMINI_MODELS_PAYLOAD).fetchFn,
  })
  assert.deepEqual(await adapter.listModels('gemini'), [])
})

test('GeminiAdapter discovery maps the live catalog; resolveModel prefers it', async () => {
  const { fetchFn, requests } = fakeFetch(GEMINI_MODELS_PAYLOAD)
  const adapter = new GeminiAdapter({
    models: STATIC_GEMINI,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(geminiSession),
    discovery: true,
    fetchFn,
  })
  const models = await adapter.listModels('gemini')
  assert.deepEqual(models.map(model => model.id), [
    'gemini-3-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro',
    'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash',
  ])
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  // The TTL cache serves the second call without another fetch.
  await adapter.listModels('gemini')
  assert.equal(requests.length, 1)

  const resolved = await adapter.resolveModel('gemini', 'gemini-3.1-pro')
  assert.equal(resolved.name, 'Gemini 3.1 Pro')
  assert.equal(resolved.context?.contextWindow, 1_048_576)
  assert.equal(resolved.defaultMaxTokens, 65_535)
  // A model the catalog did not advertise falls back to static defaults.
  const fallback = await adapter.resolveModel('gemini', 'gemini-unknown')
  assert.equal(fallback.context?.contextWindow, 1_000_000)
  assert.equal(fallback.defaultMaxTokens, 64_000)
})

test('GeminiAdapter exposes prepareCall for DSH 0.1.1 adapter contract', async () => {
  const adapter = new GeminiAdapter({
    models: STATIC_GEMINI,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(geminiSession),
    discovery: false,
  })
  assert.equal(typeof adapter.prepareCall, 'function')
  const prepared = await adapter.prepareCall('gemini', 'gemini-3.7-flash')
  assert.equal(prepared.model.id, 'gemini-3.7-flash')
  assert.equal(typeof prepared.stream, 'function')
})

test('GeminiAdapter discovery failure falls back to the static catalog with a warning', async () => {
  const warnings: string[] = []
  const adapter = new GeminiAdapter({
    models: STATIC_GEMINI,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(geminiSession),
    discovery: true,
    fetchFn: fakeFetch({ error: 'boom' }, 500).fetchFn,
    onWarn: message => warnings.push(message),
  })
  const models = await adapter.listModels('gemini')
  assert.deepEqual(models.map(model => model.id), ['gemini-3.1-pro'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /gemini model discovery failed/)
})

test('GeminiAdapter config override wins over discovery entirely', async () => {
  const { fetchFn, requests } = fakeFetch(GEMINI_MODELS_PAYLOAD)
  const adapter = new GeminiAdapter({
    models: STATIC_GEMINI,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(geminiSession),
    discovery: false,
    fetchFn,
  })
  const models = await adapter.listModels('gemini')
  assert.deepEqual(models.map(model => model.id), ['gemini-3.1-pro'])
  assert.equal(requests.length, 0)
})

test('isGeminiPermanentRefreshError matches invalid_grant / invalid_client', () => {
  const oauthError = (code: string): OAuthEndpointError =>
    new OAuthEndpointError('nope', 400, code)
  assert.equal(isGeminiPermanentRefreshError(oauthError('invalid_grant')), true)
  assert.equal(isGeminiPermanentRefreshError(oauthError('invalid_client')), true)
  assert.equal(isGeminiPermanentRefreshError(oauthError('temporarily_unavailable')), false)
  assert.equal(isGeminiPermanentRefreshError(new Error('network')), false)
})
