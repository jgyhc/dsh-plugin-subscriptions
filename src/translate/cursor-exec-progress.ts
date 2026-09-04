/**
 * Surface Cursor AgentService native execs as harness `tool/call` /
 * `tool/result` session events so the Web GUI shows Grep / Read / Write /
 * Edit cards while the cloud agent is still running its own tool loop.
 *
 * These events are display-only: the plugin still executes the tool natively
 * and replies on the Connect stream. They must not be emitted as assistant
 * `tool-call` StreamChunks, or the harness agent loop would re-dispatch them
 * after the Cursor turn ends.
 */

import { isAbsolute, relative, sep } from 'node:path'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ExecServerMessage } from '../providers/cursor-proto/cursor-proto.js'
import { decodeMcpArgs, type NativeExecResult } from './cursor-native-exec.js'

/** One successful native file mutation in the current Cursor turn. */
export interface FileChange {
  path: string
  kind: 'write' | 'delete'
}

/** Turn-local accumulator of successful write/delete paths. */
export interface FileChangeLog {
  record(change: FileChange): void
  list(): FileChange[]
}

/** Create an empty in-order file-change log for one Cursor stream. */
export function createFileChangeLog(): FileChangeLog {
  const changes: FileChange[] = []
  return {
    record(change) {
      if (change.path.length === 0) return
      changes.push({ path: change.path, kind: change.kind })
    },
    list() {
      return changes.slice()
    },
  }
}

/**
 * Map a settled native exec onto a file mutation, or `undefined` when the
 * exec was not a successful write/edit/delete.
 */
export function fileChangeFromExec(
  execMsg: ExecServerMessage,
  isError: boolean,
): FileChange | undefined {
  if (isError) return undefined
  const execCase = execMsg.message.case
  const value = execMsg.message.value as { path?: unknown } | undefined
  const path = typeof value?.path === 'string' ? value.path : ''
  if (path.length === 0) return undefined
  if (execCase === 'writeArgs' || execCase === 'piWriteArgs' || execCase === 'piEditArgs') {
    return { path, kind: 'write' }
  }
  if (execCase === 'deleteArgs') return { path, kind: 'delete' }
  return undefined
}

function collapseFileChanges(changes: readonly FileChange[]): FileChange[] {
  const kindByPath = new Map<string, FileChange['kind']>()
  const order: string[] = []
  for (const change of changes) {
    if (change.path.length === 0) continue
    if (!kindByPath.has(change.path)) order.push(change.path)
    kindByPath.set(change.path, change.kind)
  }
  return order.map(path => ({ path, kind: kindByPath.get(path)! }))
}

function displayPath(filePath: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return filePath
  const rel = relative(cwd, filePath)
  if (rel.length === 0 || rel === '.') return filePath
  if (rel.startsWith('..') || isAbsolute(rel)) return filePath
  return rel.split(sep).join('/')
}

/**
 * Markdown list of files this turn wrote or deleted. Empty when nothing
 * mutated; later writes/deletes of the same path collapse to the last kind.
 */
export function formatModifiedFilesList(
  changes: readonly FileChange[],
  cwd?: string,
): string {
  const unique = collapseFileChanges(changes)
  if (unique.length === 0) return ''
  const lines = unique.map(change => {
    const shown = displayPath(change.path, cwd)
    return change.kind === 'delete' ? `- \`${shown}\` (deleted)` : `- \`${shown}\``
  })
  return `Modified files:\n\n${lines.join('\n')}`
}

/** One native exec, named and shaped like a harness tool card. */
export interface CursorExecPresentation {
  callId: string
  name: string
  arguments: Record<string, unknown>
}

/** Optional harness session used only to append display-only tool events. */
export interface CursorProgressSession {
  readonly events?: readonly { type: string; data?: { turn?: number; step?: number } }[]
  snapshotEvents?: (from?: number, to?: number) => readonly { type: string; data?: { turn?: number; step?: number } }[]
  append(
    type: string,
    data: unknown,
    opts?: { surfaceOp: 'append'; sourceEventSeqs: number[] },
  ): { seq: number }
}

/** Start/finish reporter for one Cursor stream. */
export interface CursorExecProgress {
  start(presentation: CursorExecPresentation): Promise<number | undefined>
  finish(callId: string, started: Promise<number | undefined>, text: string, isError: boolean): void
}

const RESULT_TEXT_LIMIT = 16_384

function callIdOf(toolCallId: string | undefined, execMsg: ExecServerMessage): string {
  if (toolCallId !== undefined && toolCallId.length > 0) return toolCallId
  if (execMsg.execId.length > 0) return execMsg.execId
  return `cursor-exec-${String(execMsg.id)}`
}

function compactArgs(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.length === 0) continue
    out[key] = value
  }
  return out
}

/**
 * Map one Cursor exec frame onto a harness tool name + argument shape so the
 * conversation UI can reuse Grep/Read/Write/Edit/Bash presenters.
 */
export function presentCursorExec(execMsg: ExecServerMessage): CursorExecPresentation | undefined {
  const execCase = execMsg.message.case
  switch (execCase) {
    case 'grepArgs': {
      const args = execMsg.message.value
      return {
        callId: callIdOf(args.toolCallId, execMsg),
        name: 'grep',
        arguments: compactArgs({
          pattern: args.pattern,
          path: args.path,
          include: args.glob,
        }),
      }
    }
    case 'readArgs':
    case 'redactedReadArgs': {
      const args = execMsg.message.value
      return {
        callId: callIdOf(args.toolCallId, execMsg),
        name: 'read',
        arguments: compactArgs({
          file_path: args.path,
          offset: args.offset,
          limit: args.limit,
        }),
      }
    }
    case 'writeArgs': {
      const args = execMsg.message.value
      return {
        callId: callIdOf(args.toolCallId, execMsg),
        name: 'write',
        arguments: compactArgs({
          file_path: args.path,
        }),
      }
    }
    case 'deleteArgs': {
      const args = execMsg.message.value
      return {
        callId: callIdOf(args.toolCallId, execMsg),
        name: 'delete',
        arguments: compactArgs({ path: args.path }),
      }
    }
    case 'lsArgs': {
      const args = execMsg.message.value
      return {
        callId: callIdOf(args.toolCallId, execMsg),
        name: 'glob',
        arguments: compactArgs({
          pattern: '*',
          path: args.path,
        }),
      }
    }
    case 'shellArgs':
    case 'shellStreamArgs':
    case 'miniSweAgentBashArgs': {
      const args = execMsg.message.value
      return {
        callId: callIdOf(args.toolCallId, execMsg),
        name: 'bash',
        arguments: compactArgs({
          command: args.command,
          workdir: args.workingDirectory,
          timeoutMs: args.timeout > 0 ? args.timeout : undefined,
          description: args.description,
        }),
      }
    }
    case 'mcpArgs': {
      const args = execMsg.message.value
      const name = args.toolName.length > 0 ? args.toolName : args.name
      if (name.length === 0) return undefined
      return {
        callId: callIdOf(args.toolCallId, execMsg),
        name,
        arguments: decodeMcpArgs(args),
      }
    }
    case 'piEditArgs': {
      const args = execMsg.message.value
      const first = args.edits[0]
      return {
        callId: callIdOf(undefined, execMsg),
        name: 'edit',
        arguments: compactArgs({
          file_path: args.path,
          old_string: first?.oldText,
          new_string: first?.newText,
        }),
      }
    }
    case 'piWriteArgs': {
      const args = execMsg.message.value as { path?: string; contents?: string; content?: string }
      return {
        callId: callIdOf(undefined, execMsg),
        name: 'write',
        arguments: compactArgs({
          file_path: args.path,
          content: args.contents ?? args.content,
        }),
      }
    }
    case 'piReadArgs': {
      const args = execMsg.message.value as { path?: string; offset?: number; limit?: number }
      return {
        callId: callIdOf(undefined, execMsg),
        name: 'read',
        arguments: compactArgs({
          file_path: args.path,
          offset: args.offset,
          limit: args.limit,
        }),
      }
    }
    case 'piGrepArgs': {
      const args = execMsg.message.value as { pattern?: string; path?: string; glob?: string }
      return {
        callId: callIdOf(undefined, execMsg),
        name: 'grep',
        arguments: compactArgs({
          pattern: args.pattern,
          path: args.path,
          include: args.glob,
        }),
      }
    }
    case 'piFindArgs':
    case 'piLsArgs': {
      const args = execMsg.message.value as { pattern?: string; path?: string }
      return {
        callId: callIdOf(undefined, execMsg),
        name: 'glob',
        arguments: compactArgs({
          pattern: args.pattern ?? '*',
          path: args.path,
        }),
      }
    }
    case 'piBashArgs': {
      const args = execMsg.message.value as { command?: string; workingDirectory?: string }
      return {
        callId: callIdOf(undefined, execMsg),
        name: 'bash',
        arguments: compactArgs({
          command: args.command,
          workdir: args.workingDirectory,
        }),
      }
    }
    default:
      return undefined
  }
}

function truncate(text: string): string {
  if (text.length <= RESULT_TEXT_LIMIT) return text
  return `${text.slice(0, RESULT_TEXT_LIMIT)}\n…(truncated)`
}

function innerResult(value: unknown): { case?: string; value?: unknown } | undefined {
  if (typeof value !== 'object' || value === null || !('result' in value)) return undefined
  const result = (value as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return undefined
  return result as { case?: string; value?: unknown }
}

function extractMcpContent(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const innerContent = (item as { content?: unknown }).content
    if (typeof innerContent === 'object' && innerContent !== null) {
      const caseVal = (innerContent as { case?: string; value?: unknown }).value
      if (typeof caseVal === 'object' && caseVal !== null && 'text' in caseVal) {
        const text = (caseVal as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      } else if (typeof caseVal === 'string') {
        parts.push(caseVal)
      } else if ('text' in innerContent && typeof (innerContent as { text?: unknown }).text === 'string') {
        parts.push((innerContent as { text: string }).text)
      }
    } else if ('text' in item && typeof (item as { text?: unknown }).text === 'string') {
      parts.push((item as { text: string }).text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function extractGrepContent(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const ws = record.workspaceResults
  if (typeof ws !== 'object' || ws === null) return undefined
  const lines: string[] = []
  for (const unionRes of Object.values(ws as Record<string, unknown>)) {
    if (typeof unionRes !== 'object' || unionRes === null) continue
    const result = (unionRes as { result?: unknown }).result
    if (typeof result !== 'object' || result === null) continue
    const content = (result as { case?: string; value?: unknown }).value
    if (typeof content !== 'object' || content === null) continue
    const matches = (content as { matches?: unknown }).matches
    if (!Array.isArray(matches)) continue
    for (const fileMatch of matches) {
      if (typeof fileMatch !== 'object' || fileMatch === null) continue
      const file = (fileMatch as { file?: unknown }).file
      const fileLines = (fileMatch as { matches?: unknown }).matches
      if (typeof file !== 'string' || !Array.isArray(fileLines)) continue
      for (const m of fileLines) {
        if (typeof m !== 'object' || m === null) continue
        const lineNo = (m as { lineNumber?: unknown }).lineNumber
        const text = (m as { content?: unknown }).content
        if (typeof text === 'string') {
          lines.push(`${file}:${String(lineNo ?? '')}: ${text}`)
        }
      }
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'No matches found'
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return ''
  const mcpText = extractMcpContent(value)
  if (mcpText !== undefined) return mcpText
  const grepText = extractGrepContent(value)
  if (grepText !== undefined) return grepText
  const record = value as Record<string, unknown>
  const preferred = [record.stdout, record.content, record.error, record.stderr, record.reason]
  for (const part of preferred) {
    if (typeof part === 'string' && part.length > 0) return part
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Flatten one native exec outcome into model-facing tool-result text. */
export function cursorExecOutcome(result: NativeExecResult): { text: string; isError: boolean } {
  const inner = innerResult(result.message.value)
  const innerCase = inner?.case ?? ''
  const innerValue = inner?.value
  const flaggedError = typeof innerValue === 'object' && innerValue !== null
    && (innerValue as { isError?: unknown }).isError === true
  const isError = flaggedError
    || innerCase === 'error'
    || innerCase === 'failure'
    || innerCase === 'timeout'
    || innerCase === 'fileNotFound'
    || innerCase === 'notFile'
    || innerCase === 'toolNotFound'
    || innerCase === 'spawnError'
  const text = textFromUnknown(innerValue)
  if (text.length > 0) return { text: truncate(text), isError }
  if (innerCase.length > 0) return { text: innerCase, isError }
  return { text: result.message.case, isError }
}

function getSessionEvents(
  session: CursorProgressSession,
): readonly { type: string; data?: { turn?: number; step?: number } }[] {
  if (typeof session.snapshotEvents === 'function') {
    try {
      return session.snapshotEvents()
    } catch {
      return []
    }
  }
  if (Array.isArray(session.events)) {
    return session.events
  }
  return []
}

function openTurnStep(
  events: readonly { type: string; data?: { turn?: number; step?: number } }[] | undefined,
): { turn: number; step: number } | undefined {
  if (!events || !Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    if (event.type === 'step/end' || event.type === 'turn/end') return undefined
    if (event.type === 'step/start') {
      const turn = event.data?.turn
      const step = event.data?.step
      if (typeof turn === 'number' && typeof step === 'number') return { turn, step }
      return undefined
    }
  }
  return undefined
}

/**
 * Append display-only `tool/call` / `tool/result` events onto a live harness
 * session. Failures are swallowed so a UI log cannot abort Cursor exec.
 */
export function createCursorSessionProgress(
  session: CursorProgressSession | undefined,
): CursorExecProgress | undefined {
  if (session === undefined) return undefined
  return {
    start(presentation) {
      return Promise.resolve().then(() => {
        try {
          const events = getSessionEvents(session)
          const location = openTurnStep(events)
          if (location === undefined) return undefined
          return session.append('tool/call', {
            turn: location.turn,
            step: location.step,
            callId: ToolCallId(presentation.callId),
            name: presentation.name,
            arguments: JSON.stringify(presentation.arguments),
          }).seq
        } catch {
          return undefined
        }
      })
    },
    finish(callId, started, text, isError) {
      void started.then(callSeq => {
        if (callSeq === undefined) return
        try {
          const events = getSessionEvents(session)
          const location = openTurnStep(events)
          if (location === undefined) return
          const message = createToolResultMessage({
            callId: ToolCallId(callId),
            content: [{ type: 'text', text }],
            isError,
          })
          session.append('tool/result', {
            turn: location.turn,
            step: location.step,
            message,
          }, {
            surfaceOp: 'append',
            sourceEventSeqs: [callSeq],
          })
        } catch {
          // Display-only: never fail the Cursor exec correlation.
        }
      }).catch(() => {
        // Display-only: never fail the Cursor exec correlation.
      })
    },
  }
}
