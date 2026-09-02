/**
 * Cursor subscription LLM adapter: AgentService/Run over HTTP/2 Connect/protobuf.
 */

import { errorChain, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CursorSession } from '../auth/store.js'
import { resolveImages } from '../translate/resolved.js'
import { fetchCursorModels } from '../translate/cursor-request.js'
import { streamCursor } from '../translate/cursor-stream.js'
import type { ExecuteMcpTool, NativeExecProgress } from '../translate/cursor-native-exec.js'
import {
  idleWatchdog,
  mapFetchFailure,
  ModelCatalogCache,
  OAuthEndpointError,
  TokenManager,
} from './common.js'
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry } from './common.js'

const CURSOR_CONTEXT_WINDOW = 200_000
const CURSOR_DEFAULT_MAX_TOKENS = 64_000
const CURSOR_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

function cursorModalities(modelId: string): readonly ('text' | 'image')[] {
  return /claude|gemini|gpt-|codex|composer/i.test(modelId) ? CURSOR_MODALITIES : ['text']
}

/** Options for {@link CursorAdapter}. */
export interface CursorAdapterOptions {
  models: ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: TokenManager<CursorSession>
  discovery?: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  catalogStore?: CatalogPersistence
  baseUrl?: string
  /**
   * Resolves the harness tool executor used for native Cursor MCP tool calls,
   * when the `tools` service is mounted. Resolved per stream.
   */
  executeMcpTool?: () => ExecuteMcpTool | undefined
  /**
   * Resolves the session's validated working directory (from the harness
   * session store) so native Cursor execs default to the session workspace
   * instead of the plugin process's cwd. Optional; falls back to the process
   * cwd when unset or unresolved.
   */
  resolveSessionCwd?: (sessionId: string | undefined) => string | undefined
  /**
   * Resolves a display-only tool-card reporter for the current harness session
   * so native Cursor execs appear as Grep/Read/Write cards in the GUI.
   */
  resolveExecProgress?: (sessionId: string | undefined) => NativeExecProgress | undefined
}

/** Cursor wire adapter: one instance serves the `cursor` provider route. */
export class CursorAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache

  constructor(private readonly options: CursorAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  private async fetchCatalog(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const session = await this.options.tokens.session()
    return fetchCursorModels(session, signal, this.options.baseUrl)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cursor (Subscription)' }
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? cursorModalities(model.id),
    }))
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const session = await this.options.tokens.peek()
    if (session === undefined) return []
    if (this.options.discovery !== true) return this.staticModels(provider)
    try {
      const discovered = await this.catalog.get(() => this.fetchCatalog())
      if (discovered.length === 0) return this.staticModels(provider)
      return discovered.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: cursorModalities(model.id),
      }))
    } catch (error: unknown) {
      if (error instanceof LlmError
        && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')) return []
      if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate()
      this.options.onWarn?.(
        `cursor model discovery failed; using the built-in catalog (${errorChain(error)})`,
      )
      return this.staticModels(provider)
    }
  }

  private async discovered(model: string): Promise<DiscoveredModel | undefined> {
    if (this.options.discovery !== true) return undefined
    const models = await this.catalog.resolve(() => this.fetchCatalog())
    return models?.find(entry => entry.id === model)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const discovered = await this.discovered(model)
    const configured = this.options.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: configured?.inputModalities ?? cursorModalities(model),
      context: {
        contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? CURSOR_CONTEXT_WINDOW,
      },
      defaultMaxTokens: configured?.maxTokens ?? discovered?.maxTokens ?? CURSOR_DEFAULT_MAX_TOKENS,
      ...discovered?.reasoning === undefined ? {} : { reasoning: discovered.reasoning },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      let session = await this.options.tokens.session()
      try {
        yield* this.runTurn(options, session, watchdog.signal, () => { watchdog.pulse() })
      } catch (error: unknown) {
        if (error instanceof LlmError && error.code === 'AUTH') {
          session = await this.options.tokens.session(true)
          yield* this.runTurn(options, session, watchdog.signal, () => { watchdog.pulse() })
        } else {
          throw error
        }
      }
    } catch (error: unknown) {
      throw mapFetchFailure('Cursor API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  private async *runTurn(
    options: GenerateOptions,
    session: CursorSession,
    signal: AbortSignal,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal)
    // Default native execs to the session's workspace directory so `pwd`,
    // `ls`, and bare greps land in the session instead of the plugin process.
    const cwd = this.options.resolveSessionCwd?.(options.sessionId)
    yield* streamCursor({
      model: options.model,
      messages,
      session,
      signal,
      onActivity,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl }),
      ...(this.options.executeMcpTool === undefined ? {} : { executeMcpTool: this.options.executeMcpTool }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(this.options.resolveExecProgress === undefined
        ? {}
        : (() => {
            const progress = this.options.resolveExecProgress(options.sessionId)
            return progress === undefined ? {} : { progress }
          })()),
    })
  }
}
