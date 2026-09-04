/**
 * Bridge Cursor MCP execs onto the harness tool registry.
 *
 * Agent-scoped tools (`skill`, preset-local MCP tools, …) are invisible to
 * `tools.execute()` unless the live Agent is passed as the viewing scope.
 * The Cursor cloud agent drives its own tool loop, so this plugin must
 * re-attach that scope when it re-enters the registry.
 */

import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { NativeToolInput, NativeToolOutcome } from './cursor-native-exec.js'

/** Minimal `ctx.agents` face used to recover the live Agent from a session id. */
interface AgentsLookup {
  get(id: string): unknown
}

/**
 * Resolve the live harness Agent for a session. `tool-skill` (and other
 * preset plugins) register into that Agent's scope; an unscoped execute
 * reports them as `unknown tool`.
 */
export function sessionAgent(ctx: Context, sessionId: string | undefined): unknown {
  if (sessionId === undefined || sessionId.length === 0) return undefined
  const agents = ctx.get('agents') as AgentsLookup | undefined
  return agents?.get(sessionId)
}

/**
 * Run one Cursor MCP tool call through the harness tool registry. The call
 * honors the same pre-execute/guard/dispatch pipeline as harness-driven tool
 * calls (sandbox, approval, output caps); the flattened text content is what
 * the Cursor agent sees in the `mcpResult`.
 */
export async function runCursorMcpTool(
  tools: ToolRuntime,
  exec: NativeToolInput,
): Promise<NativeToolOutcome> {
  const result = await tools.execute({
    callId: ToolCallId(exec.callId),
    name: exec.name,
    arguments: exec.arguments,
    signal: exec.signal,
    ...(exec.agent === undefined ? {} : { agent: exec.agent as never }),
  })
  const content = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return { isError: result.isError, content }
}
