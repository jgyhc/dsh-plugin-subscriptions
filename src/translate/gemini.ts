/**
 * Translate between the harness message vocabulary and the Gemini (Cloud Code
 * Assist) wire format used by the gemini provider: request content assembly,
 * tool schema mapping, and a push-model SSE-event → StreamChunk state machine
 * ({@link GeminiStreamTranslator}) so tests need no streams.
 *
 * The Cloud Code Assist `v1internal:streamGenerateContent` endpoint speaks the
 * Gemini `GenerateContent` vocabulary (contents/parts, functionCall /
 * functionResponse, thought parts, usageMetadata) wrapped in a `response`
 * envelope, with in-band `error` events. Text parts arrive per-chunk with no
 * part index, so the translator maintains one open block per part kind.
 */

import {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  StreamChunk,
  TokenUsage,
  ToolResultBlock,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { parseSse } from './sse.js'
import type { TranslatableMessage } from './resolved.js'

/** One Gemini request content entry. */
export interface GeminiContent {
  role: 'user' | 'model'
  parts: Record<string, unknown>[]
}

/**
 * Captured Gemini thought signatures, keyed by
 * {@link thoughtSignatureKey} (`${sessionId}:${toolCallId}`). Cloud Code
 * Assist requires the model's `thoughtSignature` to be echoed on replayed
 * `functionCall` parts (gemini-3 models reject unsigned calls with a 400);
 * the adapter owns one store per provider route so signatures survive the
 * harness's message round trip.
 */
export type ThoughtSignatureStore = Map<string, string>

/** The store key for one tool call's signature. */
export function thoughtSignatureKey(sessionId: string | undefined, callId: string): string {
  return `${sessionId ?? ''}:${callId}`
}

/**
 * Sentinel Cloud Code Assist accepts in place of a captured signature. The
 * gemini-3 family demands the field on every replayed `functionCall` part,
 * even when the original response carried none (see oh-my-pi / Gemini CLI).
 */
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

/** Flatten a tool result's content to plain text for `functionResponse`. */
function toolResultText(block: ToolResultBlock): string {
  return block.content.map(part => (part.type === 'text' ? part.text : '')).join('')
}

/** Parse a tool call's raw JSON arguments into Gemini's object-shaped `args`. */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    // The model produced malformed JSON; an empty object keeps the request valid.
    return {}
  }
}

/**
 * Convert harness messages into Gemini `contents`. Consecutive same-role
 * messages merge into one content entry (Gemini rejects adjacent same-role
 * turns); tool results become `functionResponse` parts inside a user turn;
 * system-role messages are handled by the caller's `systemInstruction` and
 * skipped here. Reasoning blocks are not replayed (v1). Images must arrive
 * pre-resolved ({@link TranslatableMessage}); an unresolved ImageBlock is
 * skipped because its bytes are unreachable here.
 * @param messages - ordered conversation messages with resolved images.
 * @param options - optional signature context: the adapter's captured
 *   {@link ThoughtSignatureStore} and the request's session id. Replayed
 *   `functionCall` parts carry the captured signature (or the skip sentinel
 *   for gemini-3 models) so Cloud Code Assist accepts the tool turn.
 * @returns Gemini contents in conversation order.
 */
export function toGeminiContents(
  messages: readonly TranslatableMessage[],
  options?: { signatures?: ThoughtSignatureStore; sessionId?: string },
): GeminiContent[] {
  const out: GeminiContent[] = []
  // Gemini matches functionResponse to the earlier functionCall by `id`;
  // the harness tool-result block only carries the call id, so the tool name
  // is remembered from the assistant turn that issued the call.
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'system') continue
    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts: Record<string, unknown>[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          parts.push({ text: block.text })
          break
        case 'tool-call':
          toolNames.set(String(block.id), block.name)
          parts.push({
            functionCall: {
              name: block.name,
              args: parseToolArgs(block.arguments),
              id: String(block.id),
            },
            // Cloud Code Assist requires the thought signature on replayed
            // functionCall parts (gemini-3); the captured signature wins, the
            // skip sentinel keeps unsigned calls replayable.
            thoughtSignature: options?.signatures?.get(thoughtSignatureKey(options.sessionId, String(block.id)))
              ?? SKIP_THOUGHT_SIGNATURE,
          })
          break
        case 'tool-result':
          parts.push({
            functionResponse: {
              name: toolNames.get(String(block.toolCallId)) ?? String(block.toolCallId),
              response: block.isError === true
                ? { error: toolResultText(block) }
                : { output: toolResultText(block) },
              id: String(block.toolCallId),
            },
          })
          break
        case 'image':
          if ('dataBase64' in block) {
            parts.push({
              inlineData: { mimeType: block.mediaType, data: block.dataBase64 },
            })
          }
          // An unresolved ImageBlock carries only an attachment reference; the
          // adapter resolves images before translation, so this is skipped.
          break
        default:
          // reasoning (not replayed), unknown blocks.
          break
      }
    }
    if (parts.length === 0) continue
    const last = out[out.length - 1]
    if (last !== undefined && last.role === role) last.parts.push(...parts)
    else out.push({ role, parts })
  }
  return out
}

/**
 * Map harness tool schemas to Gemini function declarations.
 * @param tools - tool schemas from the request.
 * @returns Gemini `tools` array entries.
 */
export function toGeminiTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  if (tools.length === 0) return []
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }]
}

/** The subset of Cloud Code Assist SSE event shapes this translator reads. */
export interface GeminiStreamEvent {
  /** Cloud Code Assist wraps the standard GenerateContent response in `response`. */
  response?: GeminiWireResponse
  /** Standard Gemini SSE shape (no envelope), accepted for robustness. */
  candidates?: GeminiWireCandidate[]
  usageMetadata?: GeminiWireUsage
  /** In-band stream failure (quota, internal error) delivered as a final JSON event. */
  error?: { code?: number; message?: string; status?: string }
}

/** One `candidates[0].content` part (subset). */
export interface GeminiWirePart {
  text?: string
  /** True marks a thought (reasoning) summary part. */
  thought?: boolean
  thoughtSignature?: string
  functionCall?: {
    name?: string
    args?: Record<string, unknown>
    id?: string
  }
}

/** One GenerateContent response candidate (subset). */
export interface GeminiWireCandidate {
  content?: {
    role?: string
    parts?: GeminiWirePart[]
  }
  finishReason?: string
}

/** The `response` envelope's `usageMetadata` (subset). */
export interface GeminiWireUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
}

/** The `response` envelope body (subset). */
export interface GeminiWireResponse {
  candidates?: GeminiWireCandidate[]
  usageMetadata?: GeminiWireUsage
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string }
}

/**
 * Classify an in-band Gemini/Cloud Code Assist failure payload into a thrown
 * LlmError.
 * @param error - the wire error object.
 * @returns the mapped error (context overflow, quota, otherwise SERVER).
 */
export function geminiFailure(error: { code?: number; message?: string; status?: string } | undefined): LlmError {
  const message = error?.message ?? error?.status ?? 'the provider reported a failed response'
  const detail = `${String(error?.status ?? '')} ${message}`
  if (isContextWindowExceededError(detail)) return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE)
  if (isQuotaExceededError(detail)) return new LlmError(message, QUOTA_EXCEEDED_CODE)
  if (error?.code !== undefined && error.code >= 400 && error.code < 500) {
    // 429 rate limits and 4xx auth failures keep their stable codes.
    if (error.code === 429) return new LlmError(message, 'RATE_LIMIT')
    if (error.code === 401 || error.code === 403) return new LlmError(message, 'AUTH')
  }
  return new LlmError(message, 'SERVER')
}

/** One open harness block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId: string
  name?: string
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: CallId(block.callId),
        name: block.name ?? '',
        arguments: block.text,
      }
  }
}

/**
 * Push-model Cloud Code Assist SSE translator: feed each parsed event object
 * to {@link push} and collect the emitted harness StreamChunks. Text and
 * thinking parts accumulate into one open block per kind (parts carry no
 * index), tool calls arrive whole and open+close in one event, `usage` is
 * emitted before the terminal `finish`, and nothing is emitted after it.
 * In-band `error` events throw {@link LlmError}. When a
 * {@link ThoughtSignatureStore} is supplied, each `functionCall` part's
 * `thoughtSignature` is recorded under its call id so the next request can
 * echo it.
 */
export class GeminiStreamTranslator {
  private textBlock: OpenBlock | undefined
  private reasoningBlock: OpenBlock | undefined
  private nextIndex = 0
  private sawToolCall = false
  private sawAnyBlock = false
  private usage: TokenUsage | undefined
  private usageEmitted = false
  private stopReason: 'stop' | 'tool-calls' | 'max-tokens' = 'stop'
  private finishReasonSeen = false
  /** Set once the terminal `finish` chunk was produced. */
  terminated = false

  constructor(
    private readonly signatures?: ThoughtSignatureStore,
    private readonly sessionId?: string,
  ) {}

  private emitUsage(chunks: StreamChunk[]): void {
    if (this.usageEmitted) return
    this.usageEmitted = true
    if (this.usage !== undefined) chunks.push({ type: 'usage', usage: this.usage })
  }

  /** End the open block of the given kind (if any) and emit its block-end. */
  private endBlock(kind: OpenBlock['kind'], chunks: StreamChunk[]): void {
    const block = kind === 'text' ? this.textBlock : this.reasoningBlock
    if (block === undefined) return
    if (kind === 'text') this.textBlock = undefined
    else this.reasoningBlock = undefined
    chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
  }

  private openBlock(kind: 'text' | 'reasoning', chunks: StreamChunk[]): OpenBlock {
    const block: OpenBlock = {
      index: this.nextIndex++,
      kind,
      text: '',
      callId: '',
    }
    if (kind === 'text') this.textBlock = block
    else this.reasoningBlock = block
    this.sawAnyBlock = true
    chunks.push({ type: 'block-start', index: block.index, blockType: kind })
    return block
  }

  /** Route one part into its open block, switching kinds when needed. */
  private feedPart(part: GeminiWirePart, chunks: StreamChunk[]): void {
    const isThinking = part.thought === true
    const text = part.text
    if (text !== undefined && text !== '') {
      if (isThinking) {
        this.endBlock('text', chunks)
        const block = this.reasoningBlock ?? this.openBlock('reasoning', chunks)
        block.text += text
        chunks.push({ type: 'reasoning-delta', index: block.index, text })
      } else {
        this.endBlock('reasoning', chunks)
        const block = this.textBlock ?? this.openBlock('text', chunks)
        block.text += text
        chunks.push({ type: 'text-delta', index: block.index, text })
      }
    }
    if (part.functionCall !== undefined) {
      this.endBlock('text', chunks)
      this.endBlock('reasoning', chunks)
      this.sawToolCall = true
      const name = part.functionCall.name ?? ''
      const callId = part.functionCall.id ?? ''
      if (this.signatures !== undefined && callId !== ''
        && typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0) {
        this.signatures.set(thoughtSignatureKey(this.sessionId, callId), part.thoughtSignature)
      }
      const argumentsText = JSON.stringify(part.functionCall.args ?? {})
      const block: OpenBlock = {
        index: this.nextIndex++,
        kind: 'tool-call',
        text: argumentsText,
        callId,
        ...name === '' ? {} : { name },
      }
      this.sawAnyBlock = true
      chunks.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
      chunks.push({
        type: 'tool-call-delta',
        index: block.index,
        id: CallId(callId),
        ...name === '' ? {} : { name },
        argumentsDelta: argumentsText,
      })
      chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
    }
  }

  /**
   * Process one parsed Cloud Code Assist SSE event.
   * @param event - the parsed event object.
   * @returns the StreamChunks this event produced (possibly none).
   */
  push(event: GeminiStreamEvent): StreamChunk[] {
    if (this.terminated) return []
    const chunks: StreamChunk[] = []
    if (event.error !== undefined) throw geminiFailure(event.error)
    // Cloud Code Assist wraps the response in `response`; accept the bare
    // GenerateContent SSE shape too by normalizing it into the same type.
    const response: GeminiWireResponse = event.response ?? {
      ...event.candidates === undefined ? {} : { candidates: event.candidates },
      ...event.usageMetadata === undefined ? {} : { usageMetadata: event.usageMetadata },
    }
    if (response.promptFeedback?.blockReason !== undefined
      && (response.candidates === undefined || response.candidates.length === 0)) {
      throw new LlmError(
        `request blocked by Google (${response.promptFeedback.blockReason})`,
        'SERVER',
      )
    }
    const candidate = response.candidates?.[0]
    if (candidate?.content?.parts !== undefined) {
      for (const part of candidate.content.parts) this.feedPart(part, chunks)
    }
    if (candidate?.finishReason !== undefined) {
      this.finishReasonSeen = true
      switch (candidate.finishReason) {
        case 'STOP':
          this.stopReason = this.sawToolCall ? 'tool-calls' : 'stop'
          break
        case 'MAX_TOKENS':
          this.stopReason = 'max-tokens'
          break
        default:
          // SAFETY, RECITATION, MALFORMED_FUNCTION_CALL, etc.
          this.stopReason = 'stop'
          this.terminated = true
          this.endBlock('text', chunks)
          this.endBlock('reasoning', chunks)
          this.emitUsage(chunks)
          chunks.push({
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: `generation failed with finish reason: ${candidate.finishReason}`,
                code: 'SERVER',
              },
            },
          })
          return chunks
      }
    }
    if (response.usageMetadata !== undefined) {
      this.usage = mapGeminiUsage(response.usageMetadata)
    }
    return chunks
  }

  /** Close the stream: flush open blocks, emit usage + the terminal finish. */
  finish(): StreamChunk[] {
    if (this.terminated) return []
    this.terminated = true
    const chunks: StreamChunk[] = []
    this.endBlock('text', chunks)
    this.endBlock('reasoning', chunks)
    this.emitUsage(chunks)
    if (!this.finishReasonSeen) {
      throw new LlmError('Gemini SSE stream ended without a finish reason', 'STREAM_CLOSED')
    }
    if (this.stopReason === 'stop' && !this.sawAnyBlock) {
      chunks.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      })
    } else {
      chunks.push({ type: 'finish', reason: { kind: this.stopReason } })
    }
    return chunks
  }
}

/** Map Gemini usage metadata to disjoint harness counts (cached input subtracted out). */
function mapGeminiUsage(usage: GeminiWireUsage): TokenUsage {
  const cached = usage.cachedContentTokenCount ?? 0
  const thinking = usage.thoughtsTokenCount ?? 0
  return {
    inputTokens: (usage.promptTokenCount ?? 0) - cached,
    outputTokens: (usage.candidatesTokenCount ?? 0) + thinking,
    ...cached > 0 ? { cacheReadTokens: cached } : {},
    ...thinking > 0 ? { reasoningTokens: thinking } : {},
  }
}

/**
 * Consume a Cloud Code Assist SSE byte stream and yield harness StreamChunks.
 * @param stream - raw response body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @param options - optional signature capture context ({@link GeminiStreamTranslator}).
 * @returns the chunk stream; throws when the stream ends before a finish reason.
 */
export async function* streamGemini(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  options?: { signatures?: ThoughtSignatureStore; sessionId?: string },
): AsyncGenerator<StreamChunk> {
  const translator = new GeminiStreamTranslator(options?.signatures, options?.sessionId)
  for await (const sseEvent of parseSse(stream, onActivity)) {
    let event: GeminiStreamEvent
    try {
      event = JSON.parse(sseEvent.data) as GeminiStreamEvent
    } catch {
      throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    yield* translator.push(event)
    if (translator.terminated) return
  }
  yield* translator.finish()
}
