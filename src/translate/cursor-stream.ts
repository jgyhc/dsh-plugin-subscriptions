/**
 * Stream Cursor AgentService/Run responses into harness StreamChunk events.
 */

import { createHash, randomUUID } from 'node:crypto'
import http2 from 'node:http2'
import {
  EMPTY_RESPONSE_CODE,
  LlmError,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  type AgentServerMessage,
  ClientHeartbeatSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  ExecClientThrowSchema,
  GetBlobResultSchema,
  KvClientMessageSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  type ConversationStateStructure,
  type CursorRule,
  type ExecServerMessage,
  type KvServerMessage,
  type McpToolDefinition,
  type ShellStream,
} from '../providers/cursor-proto/cursor-proto.js'
import { create, fromBinary, toBinary } from '../providers/cursor-proto/protobuf.js'
import {
  execDelete,
  execGrep,
  execLs,
  execMcp,
  execRead,
  execShell,
  execShellStream,
  execWrite,
  type ExecuteMcpTool,
  type NativeExecContext,
  type NativeExecProgress,
  type NativeExecResult,
} from './cursor-native-exec.js'
import {
  createFileChangeLog,
  cursorExecOutcome,
  fileChangeFromExec,
  formatModifiedFilesList,
  presentCursorExec,
} from './cursor-exec-progress.js'
import { CURSOR_API_URL } from '../providers/cursor.js'
import type { CursorSession } from '../auth/store.js'
import { handleInteractionQuery } from './cursor-interaction.js'
import {
  buildCursorRunRequest,
  rememberCursorConversationState,
  type BuildCursorRunOptions,
} from './cursor-request.js'
import {
  CONNECT_END_STREAM_FLAG,
  CURSOR_AGENT_RUN_PATH,
  cursorAgentHeaders,
  frameConnectMessage,
  mapH2TransportError,
  parseConnectEndStream,
} from './cursor-wire.js'

/** Stream assembly state: block indexes and token counters. */
export interface StreamParseState {
  nextIndex: number
  textIndex?: number
  textBuffer: string
  reasoningIndex?: number
  reasoningBuffer: string
  reasoningStepEnded?: boolean
  outputTokens: number
}

export function createStreamState(): StreamParseState {
  return { nextIndex: 0, textBuffer: '', reasoningBuffer: '', outputTokens: 0 }
}

export function pushTextDelta(state: StreamParseState, push: (chunk: StreamChunk) => void, delta: string): void {
  if (delta.length === 0) return
  if (state.textIndex === undefined) {
    state.textIndex = state.nextIndex++
    state.textBuffer = ''
    push({ type: 'block-start', index: state.textIndex, blockType: 'text' })
  }
  state.textBuffer += delta
  push({ type: 'text-delta', index: state.textIndex, text: delta })
}

export function endTextBlock(state: StreamParseState, push: (chunk: StreamChunk) => void): void {
  if (state.textIndex === undefined) return
  const index = state.textIndex
  push({ type: 'block-end', index, block: { type: 'text', text: state.textBuffer } })
  delete state.textIndex
  state.textBuffer = ''
}

export function endReasoningBlock(state: StreamParseState, push: (chunk: StreamChunk) => void): void {
  if (state.reasoningIndex === undefined) return
  const index = state.reasoningIndex
  push({ type: 'block-end', index, block: { type: 'reasoning', text: state.reasoningBuffer } })
  delete state.reasoningIndex
  state.reasoningBuffer = ''
  delete state.reasoningStepEnded
}

export function pushReasoningDelta(state: StreamParseState, push: (chunk: StreamChunk) => void, delta: string): void {
  if (delta.length === 0) return
  if (state.reasoningIndex === undefined) {
    state.reasoningIndex = state.nextIndex++
    state.reasoningBuffer = ''
    push({ type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' })
  }
  if (state.reasoningStepEnded && state.reasoningBuffer.length > 0) {
    const sep = state.reasoningBuffer.endsWith('\n\n') ? '' : state.reasoningBuffer.endsWith('\n') ? '\n' : '\n\n'
    if (sep.length > 0) {
      state.reasoningBuffer += sep
      push({ type: 'reasoning-delta', index: state.reasoningIndex, text: sep })
    }
  }
  state.reasoningStepEnded = false
  state.reasoningBuffer += delta
  push({ type: 'reasoning-delta', index: state.reasoningIndex, text: delta })
}

export function processInteractionUpdate(
  update: unknown,
  state: StreamParseState,
  push: (chunk: StreamChunk) => void,
): void {
  const record = update as { message?: { case?: string; value?: Record<string, unknown> } }
  const updateCase = record.message?.case
  const value = record.message?.value ?? {}
  if (updateCase === 'textDelta') {
    const delta = typeof value.text === 'string' ? value.text : ''
    pushTextDelta(state, push, delta)
  } else if (updateCase === 'thinkingDelta') {
    const delta = typeof value.text === 'string' ? value.text : ''
    pushReasoningDelta(state, push, delta)
  } else if (updateCase === 'thinkingCompleted') {
    state.reasoningStepEnded = true
  } else if (updateCase === 'tokenDelta') {
    const tokens = typeof value.tokens === 'number' && Number.isFinite(value.tokens) ? value.tokens : 0
    state.outputTokens += tokens
  }
}

function sendExecClientMessage(
  h2Request: http2.ClientHttp2Stream,
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  localExecutionTimeMs?: number,
): void {
  // In-flight exec results can settle after the stream was torn down.
  if (h2Request.closed || h2Request.destroyed) return
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    ...(localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs }),
    message: { case: messageCase, value } as never,
  })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'execClientMessage', value: execClientMessage },
  })
  h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
}

function sendExecClientThrow(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage, error: string): void {
  if (h2Request.closed || h2Request.destroyed) return
  const controlMessage = create(ExecClientControlMessageSchema, {
    message: {
      case: 'throw',
      value: create(ExecClientThrowSchema, { id: execMsg.id, error }),
    },
  })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'execClientControlMessage', value: controlMessage },
  })
  h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
  sendExecClientStreamClose(h2Request, execMsg)
}

/** Close one exec frame after its result, signalling the frame is complete. */
function sendExecClientStreamClose(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage): void {
  if (h2Request.closed || h2Request.destroyed) return
  const closeMessage = create(ExecClientControlMessageSchema, {
    message: { case: 'streamClose', value: create(ExecClientStreamCloseSchema, { id: execMsg.id }) },
  })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'execClientControlMessage', value: closeMessage },
  })
  h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
}

function handleKvServerMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  h2Request: http2.ClientHttp2Stream,
): void {
  const kvCase = kvMsg.message.case
  if (kvCase === 'getBlobArgs') {
    const blobId = kvMsg.message.value.blobId
    const blobIdKey = Buffer.from(blobId).toString('hex')
    const blobData = blobStore.get(blobIdKey)
    const response = create(KvClientMessageSchema, {
      id: kvMsg.id,
      message: {
        case: 'getBlobResult',
        value: create(GetBlobResultSchema, blobData !== undefined ? { blobData } : {}),
      },
    })
    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: 'kvClientMessage', value: response },
    })
    h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
    return
  }
  if (kvCase === 'setBlobArgs') {
    const { blobId, blobData } = kvMsg.message.value
    blobStore.set(Buffer.from(blobId).toString('hex'), blobData)
    const response = create(KvClientMessageSchema, {
      id: kvMsg.id,
      message: { case: 'setBlobResult', value: create(SetBlobResultSchema, {}) },
    })
    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: 'kvClientMessage', value: response },
    })
    h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
  }
}

/**
 * Execute one Cursor exec message natively and send the matching result back
 * on the Connect stream. The Cursor cloud agent drives its own tool loop, so
 * results are relayed on Connect rather than dispatched by the harness loop.
 * Display-only `tool/call` / `tool/result` events are appended when a session
 * progress reporter is present, so the GUI can show Grep/Read/Write cards live.
 * Execution runs in the background and results are correlated by `execMsg.id`,
 * so out-of-order completion is fine.
 *
 * Exported for tests.
 */
export async function handleExecServerMessage(
  execMsg: ExecServerMessage,
  h2Request: http2.ClientHttp2Stream,
  requestContextTools: McpToolDefinition[],
  requestContextRules: CursorRule[],
  nativeExec: NativeExecContext,
): Promise<void> {
  const execCase = execMsg.message.case
  if (execCase === 'requestContextArgs') {
    const requestContext = create(RequestContextSchema, {
      rules: requestContextRules,
      repositoryInfo: [],
      tools: requestContextTools,
      gitRepos: [],
      projectLayouts: [],
      mcpInstructions: [],
      fileContents: {},
      customSubagents: [],
    })
    const requestContextResult = create(RequestContextResultSchema, {
      result: { case: 'success', value: create(RequestContextSuccessSchema, { requestContext }) },
    })
    sendExecClientMessage(h2Request, execMsg, 'requestContextResult', requestContextResult)
    return
  }

  // Every remaining case runs a tool: send the shaped result once the native
  // executor settles. Display-only tool cards are logged beside that reply.
  const presented = presentCursorExec(execMsg)
  const started = presented !== undefined && nativeExec.progress !== undefined
    ? nativeExec.progress.start(presented)
    : undefined
  const finishProgress = (text: string, isError: boolean): void => {
    if (presented === undefined || started === undefined || nativeExec.progress === undefined) return
    nativeExec.progress.finish(presented.callId, started, text, isError)
  }
  const runResult = (run: () => Promise<NativeExecResult>): void => {
    void run().then(outcome => {
      sendExecClientMessage(
        h2Request,
        execMsg,
        outcome.message.case,
        outcome.message.value,
        outcome.localExecutionTimeMs,
      )
      const summary = cursorExecOutcome(outcome)
      finishProgress(summary.text, summary.isError)
      const change = fileChangeFromExec(execMsg, summary.isError)
      if (change !== undefined) nativeExec.fileChanges?.record(change)
    }).catch(error => {
      const message = errorMessage(error)
      sendExecClientThrow(h2Request, execMsg, message)
      finishProgress(message, true)
    })
  }
  const runStream = (stream: (send: (message: ShellStream) => void) => Promise<void>): void => {
    void stream(message => {
      sendExecClientMessage(h2Request, execMsg, 'shellStream', message)
    }).catch(error => {
      const message = errorMessage(error)
      sendExecClientThrow(h2Request, execMsg, message)
      finishProgress(message, true)
    })
  }

  // The cloud agent often leaves the working directory / root path unset and
  // expects the client to run tools in its own cwd. Default to the session's
  // validated cwd (when known) so `pwd`, `ls`, and bare greps land in the
  // session workspace instead of the plugin process's directory.
  const sessionCwd = nativeExec.cwd ?? ''
  const shellDir = (workingDirectory: string): string =>
    workingDirectory.length > 0 ? workingDirectory : sessionCwd
  const rootPath = (path: string | undefined): string =>
    path !== undefined && path.length > 0 ? path : sessionCwd

  switch (execCase) {
    case 'mcpArgs': {
      const args = execMsg.message.value
      runResult(() => execMcp(args, nativeExec))
      return
    }
    case 'shellArgs': {
      const args = execMsg.message.value
      runResult(() => execShell({ ...args, workingDirectory: shellDir(args.workingDirectory) }, nativeExec.signal))
      return
    }
    case 'shellStreamArgs': {
      const args = execMsg.message.value
      runStream(send => execShellStream(
        { ...args, workingDirectory: shellDir(args.workingDirectory) },
        nativeExec.signal,
        send,
        (result, localExecutionTimeMs) => {
          // The server keeps the turn pending when it receives only stream
          // deltas; the final structured result + streamClose acknowledge the
          // exec frame's completion so the agent can move on and finish.
          sendExecClientMessage(h2Request, execMsg, 'shellResult', result, localExecutionTimeMs)
          sendExecClientStreamClose(h2Request, execMsg)
          const summary = cursorExecOutcome({
            message: { case: 'shellResult', value: result },
            localExecutionTimeMs,
          })
          finishProgress(summary.text, summary.isError)
        },
      ))
      return
    }
    case 'readArgs': {
      const args = execMsg.message.value
      runResult(() => execRead(args, nativeExec.signal))
      return
    }
    case 'writeArgs': {
      const args = execMsg.message.value
      runResult(() => execWrite(args, nativeExec.signal))
      return
    }
    case 'grepArgs': {
      const args = execMsg.message.value
      runResult(() => execGrep({ ...args, path: rootPath(args.path) }, nativeExec.signal))
      return
    }
    case 'lsArgs': {
      const args = execMsg.message.value
      runResult(() => execLs({ ...args, path: rootPath(args.path) }, nativeExec.signal))
      return
    }
    case 'deleteArgs': {
      const args = execMsg.message.value
      runResult(() => execDelete(args, nativeExec.signal))
      return
    }
  }
  const unsupported = execCase === undefined
    ? 'Unknown Cursor exec message variant'
    : `Cursor native exec "${execCase}" is not supported by dsh-plugin-subscriptions`
  sendExecClientThrow(h2Request, execMsg, unsupported)
  finishProgress(unsupported, true)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Fire-and-forget wrapper used by the frame parser; failures become a throw. */
function dispatchExecServerMessage(
  execMsg: ExecServerMessage,
  h2Request: http2.ClientHttp2Stream,
  requestContextTools: McpToolDefinition[],
  requestContextRules: CursorRule[],
  nativeExec: NativeExecContext,
): void {
  void handleExecServerMessage(
    execMsg,
    h2Request,
    requestContextTools,
    requestContextRules,
    nativeExec,
  ).catch(error => {
    sendExecClientThrow(h2Request, execMsg, errorMessage(error))
  })
}

/** Resolve the per-stream native exec context (optional harness MCP hook). */
function buildNativeExecContext(
  resolveExecuteMcpTool: (() => ExecuteMcpTool | undefined) | undefined,
  signal: AbortSignal | undefined,
  cwd: string | undefined,
  progress: NativeExecProgress | undefined,
  onToolActivity?: () => void,
  fileChanges?: NativeExecContext['fileChanges'],
  agent?: unknown,
): NativeExecContext {
  const executeMcpTool = resolveExecuteMcpTool?.()
  const wrappedProgress: NativeExecProgress | undefined = progress !== undefined
    ? {
      start(presentation) {
        onToolActivity?.()
        return progress.start(presentation)
      },
      finish(callId, started, text, isError) {
        progress.finish(callId, started, text, isError)
      },
    }
    : undefined
  return {
    signal: signal ?? new AbortController().signal,
    ...(cwd === undefined ? {} : { cwd }),
    ...(agent === undefined ? {} : { agent }),
    ...(executeMcpTool === undefined ? {} : { executeMcpTool }),
    ...(wrappedProgress === undefined ? {} : { progress: wrappedProgress }),
    ...(fileChanges === undefined ? {} : { fileChanges }),
  }
}

/** Append a trailing text block listing files this turn wrote or deleted. */
export function pushModifiedFilesList(
  state: StreamParseState,
  push: (chunk: StreamChunk) => void,
  changes: Parameters<typeof formatModifiedFilesList>[0],
  cwd?: string,
): void {
  const text = formatModifiedFilesList(changes, cwd)
  if (text.length === 0) return
  pushTextDelta(state, push, text)
  endTextBlock(state, push)
}

function handleServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  h2Request: http2.ClientHttp2Stream,
  requestContextTools: McpToolDefinition[],
  requestContextRules: CursorRule[],
  conversationId: string,
  nativeExec: NativeExecContext,
  state: StreamParseState,
  push: (chunk: StreamChunk) => void,
): boolean {
  const msgCase = msg.message.case
  if (msgCase === 'interactionUpdate') {
    processInteractionUpdate(msg.message.value, state, push)
    return msg.message.value.message?.case === 'turnEnded'
  }
  if (msgCase === 'kvServerMessage') {
    handleKvServerMessage(msg.message.value as KvServerMessage, blobStore, h2Request)
  } else if (msgCase === 'execServerMessage') {
    endTextBlock(state, push)
    dispatchExecServerMessage(
      msg.message.value as ExecServerMessage,
      h2Request,
      requestContextTools,
      requestContextRules,
      nativeExec,
    )
  } else if (msgCase === 'interactionQuery') {
    handleInteractionQuery(msg.message.value, h2Request)
  } else if (msgCase === 'conversationCheckpointUpdate') {
    rememberCursorConversationState(conversationId, msg.message.value as ConversationStateStructure)
  }
  return false
}

export interface CursorStreamOptions extends BuildCursorRunOptions {
  session: CursorSession
  signal?: AbortSignal
  baseUrl?: string
  /** Called on every inbound Connect frame (keeps an idle watchdog alive). */
  onActivity?: () => void
  /**
   * Default working directory for native execs whose args omit one (the
   * session's validated cwd); executors fall back to the plugin process cwd
   * when unset.
   */
  cwd?: string
  /**
   * Resolves the harness tool executor for native MCP tool calls, when the
   * `tools` service is mounted. Resolved once per stream.
   */
  executeMcpTool?: () => ExecuteMcpTool | undefined
  /** Display-only harness tool-card reporter for native Cursor execs. */
  progress?: NativeExecProgress
  /**
   * Live harness Agent for this session. Forwarded into native MCP execs so
   * agent-scoped tools (`skill`, …) remain visible.
   */
  agent?: unknown
}

const HEARTBEAT_INTERVAL_MS = 5_000
const CURSOR_MODEL_NOT_FOUND_PATTERN = /^(?:Cursor Connect error not_found:|Connect error not_found:|gRPC error 5:)/i

function isCursorModelNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return CURSOR_MODEL_NOT_FOUND_PATTERN.test(message)
}

/** Stream one Cursor AgentService/Run turn as harness StreamChunks. */
export async function* streamCursor(options: CursorStreamOptions): AsyncIterable<StreamChunk> {
  const wireMode = options.wireMode ?? 'normalized'
  let yielded = false
  try {
    for await (const chunk of streamCursorOnce(options, wireMode)) {
      yielded = true
      yield chunk
    }
  } catch (error: unknown) {
    if (
      wireMode === 'normalized'
      && !yielded
      && options.signal?.aborted !== true
      && isCursorModelNotFound(error)
    ) {
      yield* streamCursorOnce(options, 'discovered')
      return
    }
    throw error
  }
}

async function* streamCursorOnce(
  options: CursorStreamOptions,
  wireMode: 'normalized' | 'discovered',
): AsyncIterable<StreamChunk> {
  const built = buildCursorRunRequest({ ...options, wireMode })
  const queue: StreamChunk[] = []
  let notify: (() => void) | undefined
  let done = false
  let streamError: Error | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  const push = (chunk: StreamChunk): void => {
    queue.push(chunk)
    notify?.()
  }
  const waitForQueue = (): Promise<void> => new Promise(resolve => {
    notify = resolve
  })
  const settle = (): void => {
    done = true
    notify?.()
  }

  const parseState = createStreamState()
  const fileChanges = createFileChangeLog()
  const nativeExec = buildNativeExecContext(
    options.executeMcpTool,
    options.signal,
    options.cwd,
    options.progress,
    () => {
      // Whenever a native tool starts, notify activity to reset the watchdog timer
      options.onActivity?.()
    },
    fileChanges,
    options.agent,
  )
  let sawTurnEnded = false

  const baseUrl = options.baseUrl ?? CURSOR_API_URL
  const client = http2.connect(baseUrl)
  client.on('error', error => {
    streamError = error instanceof Error ? error : new Error(String(error))
    settle()
  })

  const headers = {
    ...cursorAgentHeaders(options.session.accessToken, 'application/connect+proto'),
    ':path': CURSOR_AGENT_RUN_PATH,
    'x-request-id': randomUUID(),
  }
  // Bidirectional Connect stream: do NOT end() after the run request — the
  // server expects client heartbeats plus exec/kv replies on the same stream.
  const h2Request = client.request(headers)

  h2Request.on('response', responseHeaders => {
    options.onActivity?.()
    const status = Number(responseHeaders[':status'] ?? 0)
    if (status === 401 || status === 403) {
      streamError = new LlmError(`Cursor AgentService unauthorized (HTTP ${String(status)})`, 'AUTH')
      h2Request.close()
      settle()
      return
    }
    if (status !== 0 && (status < 200 || status >= 300)) {
      streamError = new LlmError(`Cursor AgentService error (HTTP ${String(status)})`, 'SERVER')
      h2Request.close()
      settle()
    }
  })

  let pendingBuffer = Buffer.alloc(0) as Buffer
  h2Request.on('data', (chunk: Buffer) => {
    options.onActivity?.()
    pendingBuffer = pendingBuffer.length === 0
      ? chunk
      : Buffer.concat([pendingBuffer, chunk]) as Buffer
    while (pendingBuffer.length >= 5) {
      const flags = pendingBuffer[0]!
      const msgLen = pendingBuffer.readUInt32BE(1)
      if (pendingBuffer.length < 5 + msgLen) break
      const messageBytes = pendingBuffer.subarray(5, 5 + msgLen)
      pendingBuffer = pendingBuffer.subarray(5 + msgLen)
      if ((flags & CONNECT_END_STREAM_FLAG) !== 0) {
        const endError = parseConnectEndStream(messageBytes)
        if (endError !== null) streamError = endError
        continue
      }
      try {
        const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes)
        if (handleServerMessage(
          serverMessage,
          built.blobStore,
          h2Request,
          built.mcpTools,
          built.rules,
          built.conversationId,
          nativeExec,
          parseState,
          push,
        )) {
          sawTurnEnded = true
        }
      } catch (error) {
        streamError = error instanceof Error ? error : new Error(String(error))
      }
    }
    notify?.()
  })

  h2Request.on('end', () => {
    settle()
  })
  h2Request.on('error', error => {
    streamError = error instanceof Error ? error : new Error(String(error))
    settle()
  })

  if (options.signal !== undefined) {
    options.signal.addEventListener('abort', () => {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      h2Request.close()
      client.close()
      settle()
    }, { once: true })
  }

  h2Request.write(frameConnectMessage(built.requestBytes))
  heartbeatTimer = setInterval(() => {
    if (h2Request.closed || h2Request.destroyed) return
    try {
      const heartbeatMessage = create(AgentClientMessageSchema, {
        message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) },
      })
      h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeatMessage)))
    } catch {
      // Stream may have closed between the check and the write.
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()

  try {
    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        yield queue.shift()!
      }
      if (done) break
      await waitForQueue()
    }
  } finally {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    if (!h2Request.closed) h2Request.close()
    client.close()
  }

  if (streamError !== undefined) {
    throw mapH2TransportError(streamError, baseUrl)
  }
  if (!sawTurnEnded) {
    throw new LlmError('Cursor stream ended before turnEnded', EMPTY_RESPONSE_CODE)
  }

  endTextBlock(parseState, push)
  endReasoningBlock(parseState, push)
  pushModifiedFilesList(parseState, push, fileChanges.list(), options.cwd)
  while (queue.length > 0) yield queue.shift()!

  if (parseState.outputTokens > 0) {
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: parseState.outputTokens } }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Exported for tests. */
export function createBlobId(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

export type { ToolSchema }
