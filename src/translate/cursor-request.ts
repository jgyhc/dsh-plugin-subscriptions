/**
 * Build Cursor AgentService/Run protobuf requests from harness messages.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { ReasoningEffortId, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AssistantMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  CursorRuleSchema,
  CursorRuleSource,
  CursorRuleTypeGlobalSchema,
  CursorRuleTypeSchema,
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
  McpArgsSchema,
  McpToolCallSchema,
  McpToolDefinitionSchema,
  ModelDetailsSchema,
  RequestedModelSchema,
  ResumeActionSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  ThinkingMessageSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  type ConversationStateStructure,
  type CursorRule,
  type McpToolDefinition,
} from '../providers/cursor-proto/cursor-proto.js'
import {
  create,
  encodeJsonValue,
  fromBinary,
  toBinary,
  type JsonValue,
} from '../providers/cursor-proto/protobuf.js'
import { CURSOR_API_URL } from '../providers/cursor.js'
import type { CursorSession } from '../auth/store.js'
import type { DiscoveredModel } from '../providers/common.js'
import type { TranslatableMessage } from './resolved.js'
import {
  CURSOR_GET_USABLE_MODELS_PATH,
  cursorAgentHeaders,
} from './cursor-wire.js'
import http2 from 'node:http2'

const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 64_000
const THINKING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Per-session conversation checkpoint cache keyed by harness session id. */
const conversationStateCache = new Map<string, ConversationStateStructure>()

export interface BuildCursorRunOptions {
  model: string
  messages: readonly TranslatableMessage[]
  system?: string
  tools?: ToolSchema[]
  reasoningEffort?: ReasoningEffortId
  sessionId?: string
  /** `normalized` strips OpenAI effort suffixes; `discovered` sends the catalog id as-is. */
  wireMode?: 'normalized' | 'discovered'
}

export interface CursorRunRequest {
  requestBytes: Uint8Array
  conversationId: string
  conversationState: ConversationStateStructure
  blobStore: Map<string, Uint8Array>
  mcpTools: McpToolDefinition[]
  rules: CursorRule[]
  /** When normalized rewrote the id, the original catalog id for a not_found retry. */
  fallbackWireModelId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  for (const key in value) {
    if (!isJsonValue(value[key])) return false
  }
  return true
}

function createBlobId(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

function storeCursorBlob(blobStore: Map<string, Uint8Array>, data: Uint8Array): Uint8Array {
  const blobId = createBlobId(data)
  blobStore.set(Buffer.from(blobId).toString('hex'), data)
  return blobId
}

function readCursorBlob(blobStore: Map<string, Uint8Array>, blobId: Uint8Array): Uint8Array {
  const data = blobStore.get(Buffer.from(blobId).toString('hex'))
  if (data === undefined) throw new Error('Cursor blob not found')
  return data
}

function toolResultText(block: { content: readonly { type: string; text?: string }[] }): string {
  return block.content.map(part => (part.type === 'text' ? part.text ?? '' : '')).join('')
}

function isToolResultOnly(message: TranslatableMessage): boolean {
  return message.content.length > 0 && message.content.every(block => block.type === 'tool-result')
}

function findLastUserMessageIndex(messages: readonly TranslatableMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'user' && !isToolResultOnly(message)) return i
  }
  return -1
}

function buildCursorSystemPromptJsons(systemPrompt: string | undefined): string[] {
  const trimmed = systemPrompt?.trim()
  if (trimmed === undefined || trimmed.length === 0) {
    return [JSON.stringify({ role: 'system', content: 'You are a helpful assistant.' })]
  }
  return trimmed.split(/\n\n+/).filter(part => part.length > 0).map(
    content => JSON.stringify({ role: 'system', content }),
  )
}

/** Map harness system text to Cursor global rules (survives server-side prompt reconstruction). */
export function buildCursorRequestContextRules(systemPrompt: string | undefined): CursorRule[] {
  return buildCursorSystemPromptJsons(systemPrompt).map((json, index) => {
    const parsed = JSON.parse(json) as { content?: string }
    return create(CursorRuleSchema, {
      fullPath: `/dsh/system-prompt/${String(index)}.mdc`,
      content: parsed.content ?? '',
      source: CursorRuleSource.USER,
      type: create(CursorRuleTypeSchema, {
        type: { case: 'global', value: create(CursorRuleTypeGlobalSchema, {}) },
      }),
    })
  })
}

/**
 * Advertise harness tools as MCP tools. Native Cursor tools (bash/read/write/
 * delete/ls/grep/edit/todo) are omitted: the Cursor agent invokes those
 * through its own exec messages, which the plugin executes natively and
 * relays back on the Connect stream. Routing them through MCP instead would
 * make the harness re-dispatch them and lose the native result correlation.
 */
export function buildMcpToolDefinitions(tools: readonly ToolSchema[] | undefined): McpToolDefinition[] {
  if (tools === undefined || tools.length === 0) return []
  const native = new Set(['bash', 'read', 'write', 'delete', 'ls', 'grep', 'edit', 'todo', 'todo_write'])
  return tools.filter(tool => !native.has(tool.name)).map(tool => {
    const schemaValue: JsonValue = isJsonValue(tool.parameters)
      ? tool.parameters
      : { type: 'object', properties: {}, required: [] }
    const schemaJson = JSON.stringify(schemaValue)
    return create(McpToolDefinitionSchema, {
      name: tool.name,
      description: tool.description,
      providerIdentifier: 'dsh-plugin-subscriptions',
      toolName: tool.name,
      inputSchema: encodeJsonValue(schemaValue),
      inputSchemaJson: schemaJson,
    })
  })
}

/**
 * OpenAI-family Cursor ids (gpt-*, o1/o3/o4, *-codex*). Only these may be
 * split into base model + reasoning parameter; Claude/Composer/Grok siblings
 * must keep their discovered slug or Run returns `not_found`.
 */
function isOpenAiFamilyCursorModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return /(?:^|\/)(?:gpt-|o[1-9]|chatgpt)/.test(lower) || /codex/.test(lower)
}

/** Resolve the Cursor Run wire model id (exported for tests). */
export function resolveCursorWireModel(
  modelId: string,
  reasoningEffort: ReasoningEffortId | undefined,
  wireMode: 'normalized' | 'discovered',
): { modelId: string; parameters: Array<{ id: string; value: string }>; discoveredModelId: string } {
  if (wireMode === 'discovered') {
    return { modelId, parameters: [], discoveredModelId: modelId }
  }
  const effortFromOption = reasoningEffort !== undefined ? String(reasoningEffort) : undefined
  const match = /^(.*)-(minimal|low|medium|high|xhigh|max)(-fast)?$/.exec(modelId)
  const base = match?.[1]
  const effort = effortFromOption ?? match?.[2]
  const fastSuffix = match?.[3] ?? ''
  if (
    base !== undefined
    && effort !== undefined
    && (THINKING_EFFORTS as readonly string[]).includes(effort)
    && isOpenAiFamilyCursorModel(base)
  ) {
    return {
      modelId: `${base}${fastSuffix}`,
      parameters: [{ id: 'reasoning', value: effort }],
      discoveredModelId: modelId,
    }
  }
  return { modelId, parameters: [], discoveredModelId: modelId }
}

function extractUserText(message: TranslatableMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function hasUserImages(message: TranslatableMessage): boolean {
  return message.content.some(block => block.type === 'image')
}

function createCursorUserMessage(message: TranslatableMessage, text: string) {
  const images = message.content
    .filter((block): block is { type: 'image'; mediaType: string; dataBase64: string } => block.type === 'image')
    .map(image => create(SelectedImageSchema, {
      uuid: randomUUID(),
      mimeType: image.mediaType,
      dataOrBlobId: { case: 'data', value: Uint8Array.from(Buffer.from(image.dataBase64, 'base64')) },
    }))
  return create(UserMessageSchema, {
    text,
    messageId: randomUUID(),
    ...(images.length > 0 ? { selectedContext: create(SelectedContextSchema, { selectedImages: images }) } : {}),
  })
}

function buildRootPromptMessagesJson(
  messages: readonly TranslatableMessage[],
  systemPromptIds: Uint8Array[],
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex: number,
): Uint8Array[] {
  const entries: Uint8Array[] = [...systemPromptIds]
  const toolNames = new Map<string, string>()
  const pushJson = (obj: unknown): void => {
    entries.push(storeCursorBlob(blobStore, new TextEncoder().encode(JSON.stringify(obj))))
  }
  for (let i = 0; i < messages.length; i++) {
    if (i === activeUserMessageIndex) break
    const msg = messages[i]
    if (msg === undefined) continue
    if (msg.role === 'user') {
      const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }> = []
      for (const block of msg.content) {
        if (block.type === 'text' && block.text.trim().length > 0) parts.push({ type: 'text', text: block.text })
        if (block.type === 'image' && 'dataBase64' in block) {
          parts.push({ type: 'image', image: `data:${block.mediaType};base64,${block.dataBase64}`, mediaType: block.mediaType })
        }
        if (block.type === 'tool-result') {
          // Display-only Cursor native execs have no matching assistant tool-call
          // in harness history; echoing them into the next Run prompt would
          // duplicate Cursor's own conversation checkpoint.
          const toolName = toolNames.get(String(block.toolCallId))
          if (toolName === undefined) continue
          pushJson({
            role: 'tool',
            id: String(block.toolCallId),
            content: [{
              type: 'tool-result',
              toolName,
              toolCallId: String(block.toolCallId),
              result: toolResultText(block),
              ...(block.isError === true ? { isError: true } : {}),
            }],
          })
        }
      }
      if (parts.length > 0) pushJson({ role: 'user', content: parts })
    } else if (msg.role === 'assistant') {
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
      > = []
      for (const block of msg.content) {
        if (block.type === 'text' && block.text.length > 0) content.push({ type: 'text', text: block.text })
        if (block.type === 'tool-call') {
          toolNames.set(String(block.id), block.name)
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(block.arguments) as Record<string, unknown>
          } catch {
            args = {}
          }
          content.push({ type: 'tool-call', toolCallId: String(block.id), toolName: block.name, args })
        }
      }
      if (content.length > 0) pushJson({ role: 'assistant', content })
    }
  }
  return entries
}

function encodeMcpArgs(args: Record<string, unknown>): Record<string, Uint8Array> {
  const encoded: Record<string, Uint8Array> = Object.create(null)
  for (const [name, value] of Object.entries(args)) {
    encoded[name] = encodeJsonValue(value as JsonValue)
  }
  return encoded
}

function createCursorToolCallStep(
  toolCall: { id: unknown; name: string; arguments: string },
) {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(toolCall.arguments) as Record<string, unknown>
  } catch {
    args = {}
  }
  const mcpCall = create(McpToolCallSchema, {
    args: create(McpArgsSchema, {
      name: toolCall.name,
      args: encodeMcpArgs(args),
      toolCallId: String(toolCall.id),
      providerIdentifier: 'dsh-plugin-subscriptions',
      toolName: toolCall.name,
    }),
  })
  return create(ConversationStepSchema, {
    message: {
      case: 'toolCall',
      value: create(ToolCallSchema, {
        tool: { case: 'mcpToolCall', value: mcpCall },
        toolCallId: String(toolCall.id),
      }),
    },
  })
}

function buildConversationTurns(
  messages: readonly TranslatableMessage[],
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex: number,
): Uint8Array[] {
  const turns: Uint8Array[] = []
  const toolResults = new Map<string, { text: string; isError?: boolean }>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        toolResults.set(String(block.toolCallId), {
          text: toolResultText(block),
          ...(block.isError === true ? { isError: true } : {}),
        })
      }
    }
  }
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (msg === undefined || msg.role !== 'user') {
      i++
      continue
    }
    if (i === activeUserMessageIndex) break
    if (isToolResultOnly(msg)) {
      i++
      continue
    }
    const userText = extractUserText(msg)
    if (userText.length === 0 && !hasUserImages(msg)) {
      i++
      continue
    }
    const userMessage = createCursorUserMessage(msg, userText)
    const userMessageBlobId = storeCursorBlob(blobStore, toBinary(UserMessageSchema, userMessage))
    const stepBlobIds: Uint8Array[] = []
    i++
    while (i < messages.length) {
      const stepMsg = messages[i]
      if (stepMsg === undefined) break
      if (stepMsg.role === 'user') {
        if (isToolResultOnly(stepMsg)) {
          i++
          continue
        }
        break
      }
      if (stepMsg.role === 'assistant') {
        for (const item of stepMsg.content) {
          if (item.type === 'text' && item.text.length > 0) {
            const step = create(ConversationStepSchema, {
              message: { case: 'assistantMessage', value: create(AssistantMessageSchema, { text: item.text }) },
            })
            stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)))
          } else if (item.type === 'tool-call') {
            const step = createCursorToolCallStep(item)
            stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)))
          } else if (item.type === 'reasoning' && item.text.length > 0) {
            const step = create(ConversationStepSchema, {
              message: { case: 'thinkingMessage', value: create(ThinkingMessageSchema, { text: item.text }) },
            })
            stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)))
          }
        }
      }
      i++
    }
    const agentTurn = create(AgentConversationTurnStructureSchema, {
      userMessage: userMessageBlobId,
      steps: stepBlobIds,
    })
    const turn = create(ConversationTurnStructureSchema, {
      turn: { case: 'agentConversationTurn', value: agentTurn },
    })
    turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)))
  }
  return turns
}

/** Build one AgentService/Run client message for a harness request. */
export function buildCursorRunRequest(options: BuildCursorRunOptions): CursorRunRequest {
  const blobStore = new Map<string, Uint8Array>()
  const conversationId = options.sessionId ?? randomUUID()
  const cachedState = conversationStateCache.get(conversationId)
  const systemPromptIds = buildCursorSystemPromptJsons(options.system).map(json =>
    storeCursorBlob(blobStore, new TextEncoder().encode(json)),
  )
  const activeUserMessageIndex = findLastUserMessageIndex(options.messages)
  const activeMessage = activeUserMessageIndex >= 0 ? options.messages[activeUserMessageIndex] : undefined
  const userText = activeMessage !== undefined ? extractUserText(activeMessage) : ''
  const hasImages = activeMessage !== undefined && hasUserImages(activeMessage)
  const action = create(ConversationActionSchema, {
    action: activeMessage !== undefined && (userText.length > 0 || hasImages)
      ? {
        case: 'userMessageAction',
        value: create(UserMessageActionSchema, {
          userMessage: createCursorUserMessage(activeMessage, userText),
        }),
      }
      : { case: 'resumeAction', value: create(ResumeActionSchema, {}) },
  })
  const rootPromptMessagesJson = buildRootPromptMessagesJson(
    options.messages,
    systemPromptIds,
    blobStore,
    activeUserMessageIndex,
  )
  const turns = buildConversationTurns(options.messages, blobStore, activeUserMessageIndex)
  const cachedPromptHead = cachedState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? []
  const hasMatchingPrompt = cachedPromptHead.length === systemPromptIds.length
    && systemPromptIds.every((id, idx) => {
      const cached = cachedPromptHead[idx]
      return cached !== undefined && Buffer.from(cached).equals(id)
    })
  const baseState = cachedState !== undefined && hasMatchingPrompt
    ? cachedState
    : create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: systemPromptIds,
      turns: [],
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [],
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      selfSummaryCount: 0,
      readPaths: [],
    })
  const conversationState = create(ConversationStateStructureSchema, {
    ...baseState,
    rootPromptMessagesJson,
    turns,
  })
  conversationStateCache.set(conversationId, conversationState)
  const wireMode = options.wireMode ?? 'normalized'
  const {
    modelId: wireModelId,
    parameters: wireParameters,
    discoveredModelId,
  } = resolveCursorWireModel(options.model, options.reasoningEffort, wireMode)
  const modelDetails = create(ModelDetailsSchema, {
    modelId: wireModelId,
    displayModelId: options.model,
    displayName: options.model,
  })
  const requestedModel = create(RequestedModelSchema, {
    modelId: wireModelId,
    maxMode: false,
    parameters: wireParameters as never,
  })
  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    requestedModel,
    conversationId,
  })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'runRequest', value: runRequest },
  })
  const mcpTools = buildMcpToolDefinitions(options.tools)
  const rules = buildCursorRequestContextRules(options.system)
  const fallbackWireModelId = wireMode === 'normalized' && wireModelId !== discoveredModelId
    ? discoveredModelId
    : undefined
  return {
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    conversationId,
    conversationState,
    blobStore,
    mcpTools,
    rules,
    ...(fallbackWireModelId === undefined ? {} : { fallbackWireModelId }),
  }
}

/** Update cached conversation state after a server checkpoint. */
export function rememberCursorConversationState(conversationId: string, state: ConversationStateStructure): void {
  conversationStateCache.set(conversationId, state)
}

/** Clear cached conversation state (tests). */
export function resetCursorConversationCache(): void {
  conversationStateCache.clear()
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeDiscoveredModel(entry: Record<string, unknown>): DiscoveredModel | undefined {
  const id = asString(entry.modelId) ?? asString(entry.displayModelId)
  if (id === undefined) return undefined
  const name = asString(entry.displayName) ?? asString(entry.displayNameShort) ?? id
  const maxMode = entry.maxMode === true
  const contextWindow = maxMode || /\b1m\b/i.test(name) ? 1_000_000 : DEFAULT_CONTEXT_WINDOW
  return {
    id,
    name,
    contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
  }
}

/** Discover Cursor models via AgentService/GetUsableModels over HTTP/2. */
export async function fetchCursorModels(
  session: CursorSession,
  signal?: AbortSignal,
  baseUrl = CURSOR_API_URL,
): Promise<DiscoveredModel[]> {
  const requestPayload = create(GetUsableModelsRequestSchema, { customModelIds: [] })
  const body = toBinary(GetUsableModelsRequestSchema, requestPayload)
  const responseBuffer = await cursorHttp2Unary(baseUrl, CURSOR_GET_USABLE_MODELS_PATH, body, session.accessToken, 'application/proto', signal)
  if (responseBuffer === null) return []
  const decoded = fromBinary(GetUsableModelsResponseSchema, responseBuffer)
  const modelsRaw = decoded.models
  if (!Array.isArray(modelsRaw)) return []
  const out: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const entry of modelsRaw) {
    if (typeof entry !== 'object' || entry === null) continue
    const model = normalizeDiscoveredModel(entry as unknown as Record<string, unknown>)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}

function cursorHttp2Unary(
  baseUrl: string,
  path: string,
  body: Uint8Array,
  accessToken: string,
  contentType: string,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve(null)
      return
    }
    const client = http2.connect(baseUrl)
    const onAbort = (): void => {
      client.destroy()
      resolve(null)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    client.on('error', () => {
      signal?.removeEventListener('abort', onAbort)
      client.close()
      resolve(null)
    })
    const headers = { ...cursorAgentHeaders(accessToken, contentType), ':path': path }
    const req = client.request(headers)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      client.close()
      resolve(new Uint8Array(Buffer.concat(chunks)))
    })
    req.on('error', () => {
      signal?.removeEventListener('abort', onAbort)
      client.close()
      resolve(null)
    })
    req.on('response', responseHeaders => {
      const status = Number(responseHeaders[':status'] ?? 0)
      if (status < 200 || status >= 300) {
        signal?.removeEventListener('abort', onAbort)
        client.close()
        resolve(null)
      }
    })
    req.end(Buffer.from(body))
  })
}

export { readCursorBlob, storeCursorBlob }
