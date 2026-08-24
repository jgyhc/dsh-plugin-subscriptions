/**
 * Connect framing helpers shared by Cursor AgentService HTTP/2 RPC calls.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** Cursor CLI client version sent on every AgentService request. */
export const CURSOR_CLIENT_VERSION = 'cli-2026.07.23-e383d2b'

export const CURSOR_AGENT_RUN_PATH = '/agent.v1.AgentService/Run'
export const CURSOR_GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels'

/** Connect end-stream flag on inbound frames. */
export const CONNECT_END_STREAM_FLAG = 0b00000010

/** Frame one Connect/protobuf payload for HTTP/2 request or response bodies. */
export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + data.length)
  frame[0] = flags
  frame.writeUInt32BE(data.length, 1)
  frame.set(data, 5)
  return frame
}

/** Parse a Connect end-stream JSON error envelope, if present. */
export function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data)) as { error?: { code?: string; message?: string } }
    const error = payload.error
    if (error !== undefined) {
      const code = typeof error.code === 'string' ? error.code : 'unknown'
      const message = typeof error.message === 'string' ? error.message : 'Unknown error'
      return new LlmError(`Cursor Connect error ${code}: ${message}`, 'SERVER')
    }
    return null
  } catch {
    return new LlmError('Failed to parse Cursor Connect end stream', 'SERVER')
  }
}

/** Map opaque HTTP/2 ALPN failures into an actionable message. */
export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ERR_HTTP2_ERROR' && /h2 is not supported/i.test(message)) {
    return new LlmError(
      `Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: the TLS handshake did not negotiate h2 via ALPN.`,
      'SERVER',
      { cause: error },
    )
  }
  return error
}

/** Standard AgentService request headers for one bearer-authenticated call. */
export function cursorAgentHeaders(accessToken: string, contentType: string): Record<string, string> {
  return {
    ':method': 'POST',
    'content-type': contentType,
    'connect-protocol-version': '1',
    te: 'trailers',
    authorization: `Bearer ${accessToken}`,
    'x-ghost-mode': 'true',
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    'x-cursor-client-type': 'cli',
  }
}
