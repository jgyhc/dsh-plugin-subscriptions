/**
 * On-disk OAuth session store at `~/.dsh/plugins/subscriptions/auth.json`.
 *
 * The file is a JSON object keyed by provider id. Writes are atomic
 * (tmp file + rename) with mode 0600 because they carry bearer tokens.
 * Session shapes live here (not in the provider modules) because this file
 * owns the durable format.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Provider routes this plugin can serve. */
export type ProviderId = 'codex' | 'claude' | 'grok' | 'gemini'

/** Every provider route, in display order. */
export const PROVIDER_IDS: readonly ProviderId[] = ['codex', 'claude', 'grok', 'gemini']

/** Stored ChatGPT/Codex subscription session. */
export interface CodexSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /** `chatgpt_account_id` claim from the id token; sent as the `chatgpt-account-id` header. */
  accountId: string
  idToken?: string
  /** User email from the id token, when the token carried it. */
  emailAddress?: string
  /** `chatgpt_plan_type` claim from the id token (e.g. `plus`, `pro`), when present. */
  planType?: string
}

/** Stored Claude Pro/Max subscription session. */
export interface ClaudeSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /** Scope string the tokens were issued with; echoed on refresh. */
  scopes: string
  emailAddress?: string
  subscriptionType?: string
}

/** Stored Grok (X Premium / xAI) subscription session. */
export interface GrokSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /** Token endpoint from OIDC discovery; retained for refreshes. */
  tokenEndpoint: string
  scopes?: string
  /** Display account: email, username, or subject claim from the id token. */
  account?: string
}

/** Stored Gemini (Google AI / Antigravity) subscription session. */
export interface GeminiSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /**
   * Cloud Code Assist project id the tokens are scoped to; every chat and
   * usage request carries it (discovered/provisioned at login).
   */
  projectId: string
  /** Display account: the Google account email from userinfo, when known. */
  account?: string
}

/** The durable store shape: one optional session per provider. */
export interface SessionMap {
  codex?: CodexSession
  claude?: ClaudeSession
  grok?: GrokSession
  gemini?: GeminiSession
}

/** Any stored session, for provider-agnostic plumbing. */
export type StoredSession = CodexSession | ClaudeSession | GrokSession | GeminiSession

/**
 * Absolute path of the auth store file.
 * @returns `dshHomePath('plugins', 'subscriptions', 'auth.json')`.
 */
export function authFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'auth.json')
}

/** Store location used before the plugin was renamed; migrated on first read. */
function legacyAuthFilePath(): string {
  return dshHomePath('plugins', 'router', 'auth.json')
}

/** Check that one durable entry carries the fields every session needs. */
function assertSessionShape(provider: ProviderId, value: unknown): asserts value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`subscriptions auth store: entry "${provider}" is not an object; fix or delete the store file`)
  }
  const entry = value as Record<string, unknown>
  if (typeof entry.accessToken !== 'string' || entry.accessToken.length === 0
    || typeof entry.refreshToken !== 'string' || entry.refreshToken.length === 0
    || typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) {
    throw new Error(
      `subscriptions auth store: entry "${provider}" is missing accessToken/refreshToken/expiresAt; fix or delete the store file`,
    )
  }
}

/**
 * Read the whole store. A missing file is an empty store; malformed JSON or a
 * malformed entry throws, because silently discarding tokens would strand the
 * user without a diagnosis.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the parsed session map.
 */
export async function loadStore(path = authFilePath()): Promise<SessionMap> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Migrate the pre-rename store once, preserving existing logins.
    if (path !== authFilePath()) return {}
    try {
      text = await readFile(legacyAuthFilePath(), 'utf8')
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw legacyError
    }
    const migrated = parseStore(text, legacyAuthFilePath())
    await writeStore(migrated, path)
    await rm(legacyAuthFilePath(), { force: true })
    return migrated
  }
  return parseStore(text, path)
}

/** Parse and validate store JSON read from `path`. */
function parseStore(text: string, path: string): SessionMap {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`subscriptions auth store at ${path} is not valid JSON; fix or delete the file`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`subscriptions auth store at ${path} must be a JSON object keyed by provider; fix or delete the file`)
  }
  const store = parsed as SessionMap
  for (const provider of PROVIDER_IDS) {
    const entry = store[provider]
    if (entry !== undefined) assertSessionShape(provider, entry)
  }
  return store
}

/** Persist the whole store atomically with owner-only permissions. */
async function writeStore(store: SessionMap, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
    // An existing destination keeps its old mode through rename on some
    // filesystems; enforce 0600 on the source before the swap.
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * Read one provider's session.
 * @param provider - the provider route.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the stored session, or `undefined` when logged out.
 */
export async function getSession<K extends ProviderId>(
  provider: K,
  path = authFilePath(),
): Promise<SessionMap[K] | undefined> {
  return (await loadStore(path))[provider]
}

/**
 * Write one provider's session, preserving the others.
 * @param provider - the provider route.
 * @param session - the fresh session from a login or refresh.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function saveSession<K extends ProviderId>(
  provider: K,
  session: NonNullable<SessionMap[K]>,
  path = authFilePath(),
): Promise<void> {
  const store = await loadStore(path)
  store[provider] = session
  await writeStore(store, path)
}

/**
 * Delete one provider's session (logout).
 * @param provider - the provider route.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function deleteSession(provider: ProviderId, path = authFilePath()): Promise<void> {
  const store = await loadStore(path)
  if (store[provider] === undefined) return
  delete store[provider]
  await writeStore(store, path)
}
