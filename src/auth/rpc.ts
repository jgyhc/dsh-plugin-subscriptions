/**
 * The `/subscriptions-auth` host RPC channel the web Settings page drives. The
 * channel is registered only when a host `connection` service exists (the web
 * profile); headless compositions load the plugin without it. All business
 * outcomes are returned as RpcResult values; handlers never throw.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { PROVIDER_IDS, type ProviderId } from './store.js'
import type { ProviderUsage } from '../providers/common.js'

/** The RPC channel this plugin registers on the host connection. */
export const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth'

/** Media types the attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Decoded image bytes returned by the `image` endpoint. */
export interface ImageBytesResult {
  mediaType: string
  dataBase64: string
}

/** Decoded video bytes returned by the `video` endpoint. */
export interface VideoBytesResult {
  mediaType: string
  dataBase64: string
}

/** One model entry returned by the `models` endpoint. */
export interface ModelInfoResult {
  id: string
  name: string
  description?: string
}

/** Outcome returned by the `testConnectivity` endpoint. */
export interface TestConnectivityResult {
  ok: true
  latencyMs: number
  text?: string
}

/** Bare MP4 file names the `video` endpoint accepts (no path separators). */
const VIDEO_NAME_PATTERN = /^[\w.-]+\.mp4$/

/** One session's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast'

/** `speed` endpoint value: the session's choice plus the visibility list. */
export interface SpeedState {
  /** The session's current speed tier (default `standard`). */
  tier: SpeedTier
  /** Codex model ids whose catalog advertises a fast tier. */
  fastModels: string[]
}

/** Speed state the RPC handler delegates to (in-memory, per session). */
export interface SpeedController {
  /** Current speed state: the session's tier and the fast-capable codex models. */
  speed(sessionId: string): Promise<SpeedState>
  /** Set one session's speed tier. */
  setSpeed(sessionId: string, tier: SpeedTier): Promise<void>
}

/** Login state of one provider, as rendered by the Settings page. */
export interface ProviderStatus {
  /** Whether a session exists in the store. */
  loggedIn: boolean
  /** Whether a login attempt is currently waiting for its code. */
  busy: boolean
  /** Epoch milliseconds at which the stored access token expires. */
  expiresAt?: number
  /** Account email or account id, when known. */
  account?: string
  /** Subscription detail (plan) or the last login error. */
  detail?: string
}

/** Provider-agnostic auth operations the RPC handler delegates to. */
export interface AuthController {
  /** Current status of one provider. */
  status(provider: ProviderId): Promise<ProviderStatus>
  /**
   * Start a background login attempt.
   * @returns the authorize URL for the user's browser.
   * @throws when an attempt is already running for this provider.
   */
  login(provider: ProviderId): Promise<{ authorizeUrl: string }>
  /**
   * Feed a pasted callback URL or bare code into the pending attempt.
   * @throws when no attempt is pending or the input is unusable.
   */
  manual(provider: ProviderId, input: string): Promise<void>
  /** Abort the pending attempt; a no-op when none is pending. */
  cancel(provider: ProviderId): Promise<void>
  /** Delete the stored session. */
  logout(provider: ProviderId): Promise<void>
  /**
   * Current subscription usage of one provider.
   * @param signal - caller cancellation from the RPC transport.
   * @returns `{ supported: false }` when the provider has no usage endpoint.
   * @throws when logged out or the usage lookup fails.
   */
  usage(provider: ProviderId, signal: AbortSignal): Promise<ProviderUsage>
  /**
   * Read one image attachment's bytes for inline display.
   * @param ref - the full durable reference (`readImage` verifies against it).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when no attachment service is mounted or the read fails.
   */
  readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult>
  /**
   * Read one generated video's bytes for inline playback.
   * @param name - bare MP4 file name inside the plugin's videos directory
   *   (validated against {@link VIDEO_NAME_PATTERN}; never a path).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when the file does not exist or cannot be read.
   */
  readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult>
  /**
   * List models available for one logged-in provider.
   * @param provider - provider id.
   * @param signal - caller cancellation from the RPC transport.
   * @throws when logged out or model lookup fails.
   */
  models(provider: ProviderId, signal: AbortSignal): Promise<ModelInfoResult[]>
  /**
   * Test connectivity to one model on a logged-in provider.
   * @param provider - provider id.
   * @param model - model id.
   * @param signal - caller cancellation from the RPC transport.
   * @throws when logged out or the test request fails.
   */
  testConnectivity(provider: ProviderId, model: string, signal: AbortSignal): Promise<TestConnectivityResult>
}

/** Payload carried no usable provider id — an RPC client bug, not a server failure. */
class BadRequest extends Error {}

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function failure(error: unknown): RpcResult<unknown> {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof BadRequest) {
    // The issues array is zod-shaped upstream; this channel validates by hand.
    return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
  }
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function readProvider(payload: unknown): ProviderId {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const provider = (payload as Record<string, unknown>).provider
  if (typeof provider !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new BadRequest(`payload.provider must be one of ${PROVIDER_IDS.join(', ')}`)
  }
  return provider as ProviderId
}

function readString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`payload.${field} must be a non-empty string`)
  }
  return value
}

/** Validate the `setSpeed` endpoint's tier. */
function readSpeedTier(payload: unknown): SpeedTier {
  const tier = (payload as Record<string, unknown>).tier
  if (tier !== 'standard' && tier !== 'fast') {
    throw new BadRequest('payload.tier must be "standard" or "fast"')
  }
  return tier
}

/** Validate the `image` endpoint's payload into a full attachment reference. */
function readImageRef(payload: unknown): ImageAttachmentRef {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const record = payload as Record<string, unknown>
  const attachmentId = record.attachmentId
  if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
    throw new BadRequest('payload.attachmentId must be a non-empty string')
  }
  const mediaType = record.mediaType
  if (typeof mediaType !== 'string' || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new BadRequest(`payload.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`)
  }
  for (const field of ['bytes', 'width', 'height'] as const) {
    const value = record[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new BadRequest(`payload.${field} must be a positive integer`)
    }
  }
  const name = record.name
  if (name !== undefined && typeof name !== 'string') {
    throw new BadRequest('payload.name must be a string when present')
  }
  return {
    attachmentId: AttachmentId(attachmentId),
    mediaType: mediaType as ImageAttachmentRef['mediaType'],
    bytes: record.bytes as number,
    width: record.width as number,
    height: record.height as number,
    ...name === undefined ? {} : { name: name as string },
  }
}

/**
 * Validate the `video` endpoint's payload into a bare file name. Rejecting
 * anything with a path separator (the pattern allows none) pins every read
 * inside the plugin's videos directory.
 */
function readVideoName(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const name = (payload as Record<string, unknown>).name
  if (typeof name !== 'string' || !VIDEO_NAME_PATTERN.test(name)) {
    throw new BadRequest('payload.name must be a bare .mp4 file name')
  }
  return name
}

/** Validate the session id both speed endpoints carry. */
function readSessionId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  return readString(payload, 'sessionId')
}

async function dispatch(
  controller: AuthController,
  speed: SpeedController,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<RpcResult<unknown>> {
  switch (endpoint) {
    case 'status': {
      const entries = await Promise.all(PROVIDER_IDS.map(
        async provider => [provider, await controller.status(provider)] as const,
      ))
      return ok({ providers: Object.fromEntries(entries) })
    }
    case 'login':
      return ok(await controller.login(readProvider(payload)))
    case 'manual': {
      const provider = readProvider(payload)
      await controller.manual(provider, readString(payload, 'input'))
      return ok({ ok: true })
    }
    case 'cancel':
      await controller.cancel(readProvider(payload))
      return ok({ ok: true })
    case 'logout':
      await controller.logout(readProvider(payload))
      return ok({ ok: true })
    case 'usage':
      return ok(await controller.usage(readProvider(payload), signal))
    case 'image':
      return ok(await controller.readImage(readImageRef(payload), signal))
    case 'video':
      return ok(await controller.readVideo(readVideoName(payload), signal))
    case 'models':
      return ok({ models: await controller.models(readProvider(payload), signal) })
    case 'testConnectivity':
      return ok(await controller.testConnectivity(readProvider(payload), readString(payload, 'model'), signal))
    case 'speed':
      return ok(await speed.speed(readSessionId(payload)))
    case 'setSpeed':
      await speed.setSpeed(readSessionId(payload), readSpeedTier(payload))
      return ok({ ok: true })
    default:
      throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`)
  }
}

/**
 * Register the `/subscriptions-auth` RPC channel when a host connection exists.
 * @param ctx - the plugin context (headless profiles have no `connection`).
 * @param controller - the auth operations backing the endpoints.
 * @param speed - the per-session speed-tier state backing the Speed toggle.
 */
export function registerAuthRpc(ctx: Context, controller: AuthController, speed: SpeedController): void {
  // `connection` is not in this plugin's inject list (headless compositions
  // lack it), so its startup order is unconstrained: defer registration until
  // the service exists instead of probing once at apply time.
  ctx.inject(['connection'], (ctx) => {
    const connection = ctx.get('connection') as HostConnectionHandle
    ctx.effect(
      () => connection.rpc.handle(
        SUBSCRIPTIONS_AUTH_CHANNEL,
        async (endpoint, payload, signal) => {
          try {
            return await dispatch(controller, speed, endpoint, payload, signal)
          } catch (error) {
            return failure(error)
          }
        },
        { authority: 'loopback' },
      ),
      'dsh-plugin-subscriptions: /subscriptions-auth rpc channel',
    )
  })
}
