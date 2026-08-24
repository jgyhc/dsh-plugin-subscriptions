/**
 * Stream Cursor AgentService/Run responses into harness StreamChunk events.
 */

import { createHash, randomUUID } from 'node:crypto'
import http2 from 'node:http2'
import {
  CallId,
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
} from '../providers/cursor-proto/cursor-proto.js'
import { create, fromBinary, toBinary } from '../providers/cursor-proto/protobuf.js'
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

interface ToolCallState {
  index: number
  id: string
  name: string
  argsBuffer: string
  envelopeId?: string
}

interface StreamParseState {
  nextIndex: number
  textIndex?: number
  reasoningIndex?: number
  toolCalls: Map<string, ToolCallState>
  openByEnvelope: Map<string, ToolCallState>
  sawToolCall: boolean
  outputTokens: number
}

function createStreamState(): StreamParseState {
  return { nextIndex: 0, toolCalls: new Map(), openByEnvelope: new Map(), sawToolCall: false, outputTokens: 0 }
}

function selectMcpCall(toolCall: { tool?: { case?: string; value?: unknown } } | undefined): {
  args?: { toolCallId?: string; toolName?: string; name?: string; args?: Record<string, Uint8Array> }
} | undefined {
  const oneof = toolCall?.tool
  if (oneof?.case === 'mcpToolCall') return oneof.value as ReturnType<typeof selectMcpCall>
  return undefined
}

function pushTextDelta(state: StreamParseState, push: (chunk: StreamChunk) => void, delta: string): void {
  if (delta.length === 0) return
  if (state.textIndex === undefined) {
    state.textIndex = state.nextIndex++
    push({ type: 'block-start', index: state.textIndex, blockType: 'text' })
  }
  push({ type: 'text-delta', index: state.textIndex, text: delta })
}

function endTextBlock(state: StreamParseState, push: (chunk: StreamChunk) => void, text: string): void {
  if (state.textIndex === undefined) return
  const index = state.textIndex
  push({ type: 'block-end', index, block: { type: 'text', text } })
  delete state.textIndex
}

function endReasoningBlock(state: StreamParseState, push: (chunk: StreamChunk) => void, text: string): void {
  if (state.reasoningIndex === undefined) return
  const index = state.reasoningIndex
  push({ type: 'block-end', index, block: { type: 'reasoning', text } })
  delete state.reasoningIndex
}

function pushReasoningDelta(state: StreamParseState, push: (chunk: StreamChunk) => void, delta: string): void {
  if (delta.length === 0) return
  if (state.reasoningIndex === undefined) {
    state.reasoningIndex = state.nextIndex++
    push({ type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' })
  }
  push({ type: 'reasoning-delta', index: state.reasoningIndex, text: delta })
}

function resolveToolCall(state: StreamParseState, envelopeId: string | undefined, fallbackId?: string): ToolCallState | undefined {
  if (envelopeId !== undefined) {
    const byEnvelope = state.openByEnvelope.get(envelopeId)
    if (byEnvelope !== undefined) return byEnvelope
  }
  if (fallbackId !== undefined) return state.toolCalls.get(fallbackId)
  return undefined
}

function processInteractionUpdate(
  update: unknown,
  state: StreamParseState,
  textBuffers: { text: string; reasoning: string },
  push: (chunk: StreamChunk) => void,
): void {
  const record = update as { message?: { case?: string; value?: Record<string, unknown> } }
  const updateCase = record.message?.case
  const value = record.message?.value ?? {}
  if (updateCase === 'textDelta') {
    const delta = typeof value.text === 'string' ? value.text : ''
    textBuffers.text += delta
    pushTextDelta(state, push, delta)
  } else if (updateCase === 'thinkingDelta') {
    const delta = typeof value.text === 'string' ? value.text : ''
    textBuffers.reasoning += delta
    pushReasoningDelta(state, push, delta)
  } else if (updateCase === 'thinkingCompleted') {
    endReasoningBlock(state, push, textBuffers.reasoning)
  } else if (updateCase === 'toolCallStarted') {
    endTextBlock(state, push, textBuffers.text)
    endReasoningBlock(state, push, textBuffers.reasoning)
    const toolCall = value.toolCall as { tool?: { case?: string; value?: unknown } } | undefined
    const mcpCall = selectMcpCall(toolCall)
    if (mcpCall === undefined) return
    const args = mcpCall.args ?? {}
    const id = args.toolCallId ?? randomUUID()
    const name = args.toolName ?? args.name ?? ''
    const index = state.nextIndex++
    const block: ToolCallState = { index, id: String(id), name: String(name), argsBuffer: '' }
    state.toolCalls.set(block.id, block)
    const envelopeId = typeof value.callId === 'string' ? value.callId : undefined
    if (envelopeId !== undefined) state.openByEnvelope.set(envelopeId, block)
    state.sawToolCall = true
    push({ type: 'block-start', index, blockType: 'tool-call' })
    push({ type: 'tool-call-delta', index, id: CallId(String(id)), name: String(name), argumentsDelta: '' })
  } else if (updateCase === 'toolCallDelta' || updateCase === 'partialToolCall') {
    const envelopeId = typeof value.callId === 'string' ? value.callId : undefined
    const target = resolveToolCall(state, envelopeId)
    if (target === undefined) return
    const snapshot = typeof value.argsTextDelta === 'string' ? value.argsTextDelta : ''
    const chunk = snapshot.startsWith(target.argsBuffer) ? snapshot.slice(target.argsBuffer.length) : snapshot
    if (chunk.length === 0) return
    target.argsBuffer = target.argsBuffer + chunk
    push({
      type: 'tool-call-delta',
      index: target.index,
      id: CallId(target.id),
      name: target.name,
      argumentsDelta: chunk,
    })
  } else if (updateCase === 'toolCallCompleted') {
    const envelopeId = typeof value.callId === 'string' ? value.callId : undefined
    const target = resolveToolCall(state, envelopeId)
    if (target === undefined) return
    push({
      type: 'block-end',
      index: target.index,
      block: {
        type: 'tool-call',
        id: CallId(target.id),
        name: target.name,
        arguments: target.argsBuffer.length > 0 ? target.argsBuffer : '{}',
      },
    })
    state.toolCalls.delete(target.id)
    if (envelopeId !== undefined) state.openByEnvelope.delete(envelopeId)
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
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: { case: messageCase, value } as never,
  })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'execClientMessage', value: execClientMessage },
  })
  h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
}

function sendExecClientThrow(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage, error: string): void {
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
  const closeMessage = create(ExecClientControlMessageSchema, {
    message: { case: 'streamClose', value: create(ExecClientStreamCloseSchema, { id: execMsg.id }) },
  })
  h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
    message: { case: 'execClientControlMessage', value: closeMessage },
  }))))
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

function handleExecServerMessage(
  execMsg: ExecServerMessage,
  h2Request: http2.ClientHttp2Stream,
  requestContextTools: McpToolDefinition[],
  requestContextRules: CursorRule[],
): void {
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
  sendExecClientThrow(
    h2Request,
    execMsg,
    execCase === undefined
      ? 'Unknown Cursor exec message variant'
      : `Cursor native exec "${execCase}" is not supported by dsh-plugin-subscriptions`,
  )
}

function handleServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  h2Request: http2.ClientHttp2Stream,
  requestContextTools: McpToolDefinition[],
  requestContextRules: CursorRule[],
  conversationId: string,
  state: StreamParseState,
  textBuffers: { text: string; reasoning: string },
  push: (chunk: StreamChunk) => void,
): boolean {
  const msgCase = msg.message.case
  if (msgCase === 'interactionUpdate') {
    processInteractionUpdate(msg.message.value, state, textBuffers, push)
    return msg.message.value.message?.case === 'turnEnded'
  }
  if (msgCase === 'kvServerMessage') {
    handleKvServerMessage(msg.message.value as KvServerMessage, blobStore, h2Request)
  } else if (msgCase === 'execServerMessage') {
    handleExecServerMessage(msg.message.value as ExecServerMessage, h2Request, requestContextTools, requestContextRules)
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
  const textBuffers = { text: '', reasoning: '' }
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
          parseState,
          textBuffers,
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

  h2Request.on('end', settle)
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

  endTextBlock(parseState, push, textBuffers.text)
  endReasoningBlock(parseState, push, textBuffers.reasoning)
  while (queue.length > 0) yield queue.shift()!

  if (parseState.outputTokens > 0) {
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: parseState.outputTokens } }
  }
  yield { type: 'finish', reason: { kind: parseState.sawToolCall ? 'tool-calls' : 'stop' } }
}

/** Exported for tests. */
export function createBlobId(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

export type { ToolSchema }
