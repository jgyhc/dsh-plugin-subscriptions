/**
 * Cursor MCP → harness registry: agent-scope lookup and execute wiring.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { runCursorMcpTool, sessionAgent } from '../src/translate/cursor-mcp.js'

const signal = (): AbortSignal => new AbortController().signal

test('sessionAgent returns undefined without a session id or agents service', () => {
  const ctx = { get: () => undefined } as unknown as Context
  assert.equal(sessionAgent(ctx, undefined), undefined)
  assert.equal(sessionAgent(ctx, ''), undefined)
  assert.equal(sessionAgent(ctx, 'sess-1'), undefined)
})

test('sessionAgent resolves the live agent from ctx.agents.get', () => {
  const agent = { id: 'sess-1' }
  const ctx = {
    get(name: string) {
      if (name !== 'agents') return undefined
      return { get: (id: string) => id === 'sess-1' ? agent : undefined }
    },
  } as unknown as Context
  assert.equal(sessionAgent(ctx, 'sess-1'), agent)
  assert.equal(sessionAgent(ctx, 'other'), undefined)
})

test('runCursorMcpTool passes the session agent into tools.execute', async () => {
  const agent = { id: 'sess-1' }
  const seen: Array<Record<string, unknown>> = []
  const tools = {
    async execute(input: Record<string, unknown>) {
      seen.push(input)
      return {
        isError: false,
        content: [{ type: 'text', text: '<skill_content name="archify">ok</skill_content>' }],
      }
    },
  } as unknown as ToolRuntime

  const outcome = await runCursorMcpTool(tools, {
    callId: 'call-1',
    name: 'skill',
    arguments: { name: 'archify' },
    signal: signal(),
    agent,
  })

  assert.equal(outcome.isError, false)
  assert.match(outcome.content, /skill_content/)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.name, 'skill')
  assert.deepEqual(seen[0]?.arguments, { name: 'archify' })
  assert.equal(seen[0]?.callId, ToolCallId('call-1'))
  assert.equal(seen[0]?.agent, agent)
})

test('runCursorMcpTool omits agent when the session has none', async () => {
  const seen: Array<Record<string, unknown>> = []
  const tools = {
    async execute(input: Record<string, unknown>) {
      seen.push(input)
      return { isError: true, content: [{ type: 'text', text: 'Error: unknown tool "skill"' }] }
    },
  } as unknown as ToolRuntime

  const outcome = await runCursorMcpTool(tools, {
    callId: 'call-2',
    name: 'skill',
    arguments: { name: 'archify' },
    signal: signal(),
  })

  assert.equal(outcome.isError, true)
  assert.equal('agent' in (seen[0] ?? {}), false)
})
