/**
 * Subscriptions settings section: one card per subscription provider with an
 * OAuth login/logout flow driven by the node half's `/subscriptions-auth` RPC
 * channel. Login state lives server-side; the page polls `status` only while
 * a login attempt is busy, so an idle page never polls. All state is local
 * React state — the page has no store.
 *
 * Every color resolves through a `--dsw-alias-*` design token (the ui-theme
 * design-platform.css values flip under `body[data-ds-dark-theme]`), and
 * every user-visible string goes through the locale-bound `t` of the
 * 'settings.subscriptions' namespace. Buttons and inputs take the
 * ModelsSection vocabulary minus hover rules, which inline styles cannot
 * express.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** Logical RPC channel served by the node half of this plugin. */
const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth'

/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000

/** Subscription provider ids, fixed by the node half's OAuth adapters. */
export type SubscriptionProvider = 'codex' | 'claude' | 'grok' | 'gemini'

/** One provider's login state as answered by the `status` endpoint. */
export interface ProviderStatus {
  loggedIn: boolean
  busy: boolean
  expiresAt?: number
  account?: string
  detail?: string
}

/** `status` endpoint value: the node half owns this shape. */
interface StatusResponse {
  providers: Record<SubscriptionProvider, ProviderStatus>
}

/** One rate-limit window as answered by the `usage` endpoint. */
export interface UsageWindow {
  kind: 'session' | 'weekly' | 'other'
  scope?: string
  usedPercent: number
  resetsAt?: number
}

/** `usage` endpoint value: the node half owns this shape. */
export interface ProviderUsage {
  supported: boolean
  windows?: UsageWindow[]
  plan?: string
}

/** `login` endpoint value: the URL the user completes OAuth at. */
interface LoginResponse {
  authorizeUrl: string
}

/** Injected dependencies of {@link SubscriptionsSection} (slot `inject`). */
export interface SubscriptionsSectionInjected {
  /** Generic logical-RPC caller over the Connection transport. */
  rpc: ConnectionHandle['rpc']
  /** Section copy: translate a 'settings.subscriptions' key with `{name}` template params. */
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type SubscriptionsSectionProps = Partial<SubscriptionsSectionInjected>

/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS: readonly { id: SubscriptionProvider; name: string }[] = [
  { id: 'codex', name: 'Codex (ChatGPT)' },
  { id: 'claude', name: 'Claude' },
  { id: 'grok', name: 'Grok (X Premium)' },
  { id: 'gemini', name: 'Gemini (Google)' },
]

/** Business error returned by the `/subscriptions-auth` channel (error branch message). */
class SubscriptionsAuthError extends Error {}

/**
 * Call one `/subscriptions-auth` endpoint and unwrap the business result.
 * Shared by the settings section and the composer Speed toggle.
 * @param rpc - Connection RPC caller.
 * @param endpoint - channel-relative endpoint.
 * @param payload - channel-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
export async function callSubscriptionsAuth<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T> {
  let result: RpcResult<unknown>
  try {
    result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, endpoint, payload)
  } catch (error) {
    // The transport rejected rather than answering; surface the same way.
    throw new SubscriptionsAuthError(error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) throw new SubscriptionsAuthError(result.error.message)
  return result.value as T
}

/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * English-dictionary fallback for a missing inject `t` (standalone renders);
 * the slot inject always supplies the locale-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

const styles: Record<string, CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560,
    color: 'var(--dsw-alias-label-primary)',
  },
  intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  name: { fontWeight: 500, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
  statusLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  errorLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  actions: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
  button: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 28, padding: '0 10px', borderRadius: 14,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'pointer',
  },
  usage: {
    display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
    borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8,
  },
  usageHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  usageTitle: { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
  usagePlan: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  usageRefresh: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 22, padding: '0 8px', borderRadius: 11, marginLeft: 'auto',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'pointer',
  },
  usageRow: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 },
  usageMeta: {
    display: 'flex', justifyContent: 'space-between', gap: 8,
    fontSize: 12, lineHeight: '18px',
  },
  usageName: { fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  usagePercent: { fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  usageSubtitle: {
    margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
  },
  usageTrack: {
    height: 6, borderRadius: 3, overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
  },
  usageFill: { height: '100%', borderRadius: 3 },
  manual: { marginTop: 4, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  manualRow: { display: 'flex', gap: 8, marginTop: 6 },
  manualInput: {
    flex: 1, height: 32, boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
}

/** Status dot color for one provider state. */
function dotColor(status: ProviderStatus | undefined): string {
  if (status?.busy === true) return 'var(--dsw-alias-state-warn-label)'
  if (status?.loggedIn === true) return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-dimmed)'
}

/**
 * One-line status text for one provider state.
 * @param t - section translate.
 * @param status - the provider's last reported state.
 * @returns the localized status line.
 */
function statusText(t: SubscriptionsSectionInjected['t'], status: ProviderStatus | undefined): string {
  if (status === undefined) return t('checking')
  if (status.busy) return t('loginInProgress')
  if (status.loggedIn) {
    const params: Record<string, unknown> = {}
    if (status.account !== undefined) params.account = status.account
    if (status.expiresAt !== undefined) params.date = new Date(status.expiresAt).toLocaleString()
    if (params.account !== undefined && params.date !== undefined) return t('loggedInAccountExpires', params)
    if (params.account !== undefined) return t('loggedInAccount', params)
    if (params.date !== undefined) return t('loggedInExpires', params)
    return t('loggedIn')
  }
  return t('notLoggedIn')
}

/** Format epoch ms into a localized duration remaining string. */
function formatRelativeTime(t: SubscriptionsSectionInjected['t'], resetsAt: number): string {
  const diffMs = resetsAt - Date.now()
  if (diffMs <= 0) return t('timeLessThanMinute')
  const diffMinutes = Math.round(diffMs / 60_000)
  const diffHours = Math.floor(diffMinutes / 60)
  const remMinutes = diffMinutes % 60
  const diffDays = Math.floor(diffHours / 24)
  const remHours = diffHours % 24

  if (diffDays > 0) {
    if (remHours > 0) return t('timeDaysHours', { days: diffDays, hours: remHours })
    return t('timeDays', { days: diffDays })
  }
  if (diffHours > 0) {
    if (remMinutes > 0) return t('timeHoursMinutes', { hours: diffHours, minutes: remMinutes })
    return t('timeHours', { hours: diffHours })
  }
  if (diffMinutes > 0) return t('timeMinutes', { minutes: diffMinutes })
  return t('timeLessThanMinute')
}

/** Localized descriptive subtitle under a usage window progress bar. */
function usageSubtitle(t: SubscriptionsSectionInjected['t'], window: UsageWindow): string | undefined {
  if (window.resetsAt === undefined) return undefined
  const time = formatRelativeTime(t, window.resetsAt)
  if (window.usedPercent > 0) {
    if (window.kind === 'session') return t('usageUsedSubSession', { time })
    if (window.kind === 'weekly') return t('usageUsedSubWeekly', { time })
    return t('usageUsedSubGeneric', { time })
  }
  return t('usageUnusedSub', { time })
}

/**
 * Localized label of one usage window (kind, plus the model scope when named).
 * @param t - section translate.
 * @param window - the reported window.
 * @returns e.g. "5-hour limit" or "Gemini Models · 5-hour limit".
 */
function usageWindowLabel(t: SubscriptionsSectionInjected['t'], window: UsageWindow): string {
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  if (window.scope === 'Gemini Models') {
    return `${t('geminiModelsScope')} · ${base}`
  }
  if (window.scope === 'Claude and GPT models') {
    return `${t('claudeGptModelsScope')} · ${base}`
  }
  return window.scope !== undefined && window.scope !== '' ? `${window.scope} · ${base}` : base
}

/** Bar fill color: success normally, warn from 80%, error from 95%. */
function usageBarColor(usedPercent: number): string {
  if (usedPercent >= 95) return 'var(--dsw-alias-state-error-primary)'
  if (usedPercent >= 80) return 'var(--dsw-alias-state-warn-label)'
  return 'var(--dsw-alias-state-success-primary)'
}

/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the section body, or a notice while the RPC face is absent.
 */
export function SubscriptionsSection(props: SubscriptionsSectionProps) {
  const { rpc } = props
  const t = props.t ?? fallbackTranslate
  const [statuses, setStatuses] = useState<Partial<Record<SubscriptionProvider, ProviderStatus>>>({})
  const [errors, setErrors] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  const [manualDrafts, setManualDrafts] = useState<Record<SubscriptionProvider, string>>({
    codex: '', claude: '', grok: '', gemini: '',
  })
  /**
   * Providers whose Log in was clicked on this page. Keeps the manual
   * fallback (and Cancel) visible immediately on the first click and immune
   * to a status poll racing the optimistic busy flag; cleared when the
   * attempt settles.
   */
  const [loginActive, setLoginActive] = useState<Record<SubscriptionProvider, boolean>>({
    codex: false, claude: false, grok: false, gemini: false,
  })
  const [usages, setUsages] = useState<Partial<Record<SubscriptionProvider, ProviderUsage>>>({})
  const [usageErrors, setUsageErrors] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  const [usageLoading, setUsageLoading] = useState<Partial<Record<SubscriptionProvider, boolean>>>({})
  const mountedRef = useRef(true)
  const pollersRef = useRef(new Map<SubscriptionProvider, ReturnType<typeof setInterval>>())
  /** Providers with a `usage` call in flight; guards the auto-fetch effect against re-entry. */
  const usageInflightRef = useRef(new Set<SubscriptionProvider>())

  const setProviderError = useCallback((provider: SubscriptionProvider, message: string | undefined): void => {
    if (!mountedRef.current) return
    setErrors((prev) => {
      const next = { ...prev }
      if (message === undefined) delete next[provider]
      else next[provider] = message
      return next
    })
  }, [])

  const stopPolling = useCallback((provider: SubscriptionProvider): void => {
    const poller = pollersRef.current.get(provider)
    if (poller !== undefined) {
      clearInterval(poller)
      pollersRef.current.delete(provider)
    }
  }, [])

  /** Refetch every provider's status; stop a provider's poller once its attempt settles. */
  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    let response: StatusResponse
    try {
      response = await callSubscriptionsAuth<StatusResponse>(rpc, 'status', {})
    } catch {
      // A failed poll must not kill the page; busy providers keep polling and
      // the action paths report their own errors.
      return
    }
    if (!mountedRef.current) return
    setStatuses(response.providers)
    for (const { id } of PROVIDERS) {
      const status = response.providers[id]
      if (status.loggedIn || !status.busy) {
        stopPolling(id)
        // The attempt settled: drop the local login-active flag so the manual
        // fallback collapses and the card returns to its idle buttons.
        setLoginActive(prev => (prev[id] === true ? { ...prev, [id]: false } : prev))
      }
    }
  }, [rpc, stopPolling])

  const startPolling = useCallback((provider: SubscriptionProvider): void => {
    if (pollersRef.current.has(provider)) return
    pollersRef.current.set(provider, setInterval(() => { void refresh() }, POLL_INTERVAL_MS))
  }, [refresh])

  // Initial load; every busy provider (e.g. an attempt started before a page
  // reload) resumes polling. Teardown clears pollers and the mounted guard.
  useEffect(() => {
    mountedRef.current = true
    void refresh().then(() => {
      if (!mountedRef.current) return
      setStatuses((current) => {
        for (const { id } of PROVIDERS) {
          if (current[id]?.busy === true) startPolling(id)
        }
        return current
      })
    })
    return () => {
      mountedRef.current = false
      for (const poller of pollersRef.current.values()) clearInterval(poller)
      pollersRef.current.clear()
    }
  }, [refresh, startPolling])

  const loadUsage = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined || usageInflightRef.current.has(provider)) return
    usageInflightRef.current.add(provider)
    setUsageLoading(prev => ({ ...prev, [provider]: true }))
    try {
      const usage = await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider })
      if (!mountedRef.current) return
      setUsages(prev => ({ ...prev, [provider]: usage }))
      setUsageErrors((prev) => {
        const next = { ...prev }
        delete next[provider]
        return next
      })
    } catch (error) {
      if (mountedRef.current) setUsageErrors(prev => ({ ...prev, [provider]: messageOf(error) }))
    } finally {
      usageInflightRef.current.delete(provider)
      if (mountedRef.current) setUsageLoading(prev => ({ ...prev, [provider]: false }))
    }
  }, [rpc])

  // Fetch usage once a provider is logged in; drop the cached snapshot on
  // logout so a re-login refetches. A failed lookup does not auto-retry — the
  // per-card Refresh button is the retry path.
  useEffect(() => {
    for (const { id } of PROVIDERS) {
      const status = statuses[id]
      if (status === undefined) continue
      if (status.loggedIn) {
        if (usages[id] === undefined && usageErrors[id] === undefined) void loadUsage(id)
      } else if (usages[id] !== undefined || usageErrors[id] !== undefined) {
        setUsages((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        setUsageErrors((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    }
  }, [statuses, usages, usageErrors, loadUsage])

  const login = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    setProviderError(provider, undefined)
    try {
      const response = await callSubscriptionsAuth<LoginResponse>(rpc, 'login', { provider })
      if (typeof response.authorizeUrl === 'string' && response.authorizeUrl === '') {
        // Instant login (e.g. imported from Claude Code credentials)
        await refresh()
        return
      }
      if (typeof response.authorizeUrl !== 'string') {
        throw new SubscriptionsAuthError(t('loginMissingUrl'))
      }
      window.open(response.authorizeUrl, '_blank', 'noopener')
      if (!mountedRef.current) return
      // Optimistic busy so Cancel and the manual fallback appear before the first poll tick.
      setStatuses(prev => ({ ...prev, [provider]: { ...prev[provider], busy: true, loggedIn: false } }))
      // Local flag: the manual paste box must appear on this very click, even
      // if a status poll overwrites the optimistic busy before the attempt is
      // visible server-side.
      setLoginActive(prev => ({ ...prev, [provider]: true }))
      startPolling(provider)
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
  }, [rpc, t, setProviderError, startPolling])

  const cancel = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    stopPolling(provider)
    setLoginActive(prev => ({ ...prev, [provider]: false }))
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'cancel', { provider })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, stopPolling, setProviderError, refresh])

  const submitManual = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    const input = manualDrafts[provider].trim()
    if (input === '') return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'manual', { provider, input })
      if (mountedRef.current) setManualDrafts(prev => ({ ...prev, [provider]: '' }))
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, manualDrafts, setProviderError, refresh])

  const logout = useCallback(async (provider: SubscriptionProvider, name: string): Promise<void> => {
    if (rpc === undefined) return
    if (!window.confirm(t('logoutConfirm', { provider: name }))) return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'logout', { provider })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, t, setProviderError, refresh])

  if (rpc === undefined) {
    return <p style={styles.intro}>{t('unavailable')}</p>
  }

  return (
    <div style={styles.section}>
      <p style={styles.intro}>{t('intro')}</p>
      {PROVIDERS.map(({ id, name }) => {
        const status = statuses[id]
        const busy = status?.busy === true
        // The manual fallback shows from the first Log in click and stays until
        // the attempt settles, independent of the polled busy flag.
        const manualVisible = busy || loginActive[id] === true
        const usage = usages[id]
        const usageError = usageErrors[id]
        // Providers without a usage endpoint answer supported:false — no block.
        const showUsage = status?.loggedIn === true && usage?.supported !== false
          && (usage !== undefined || usageError !== undefined || usageLoading[id] === true)
        return (
          <div key={id} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={{ ...styles.dot, background: dotColor(status) }} />
              <span style={styles.name}>{name}</span>
            </div>
            <p style={styles.statusLine}>{statusText(t, status)}</p>
            {status?.detail !== undefined && status.detail !== '' && (
              <p style={styles.statusLine}>{status.detail}</p>
            )}
            {errors[id] !== undefined && <p style={styles.errorLine}>{errors[id]}</p>}
            <div style={styles.actions}>
              {!manualVisible && status?.loggedIn !== true && (
                <button type="button" style={styles.button} onClick={() => { void login(id) }}>
                  {t('login')}
                </button>
              )}
              {manualVisible && (
                <button type="button" style={styles.button} onClick={() => { void cancel(id) }}>
                  {t('cancel')}
                </button>
              )}
              {status?.loggedIn === true && !manualVisible && (
                <button type="button" style={styles.button} onClick={() => { void logout(id, name) }}>
                  {t('logout')}
                </button>
              )}
            </div>
            {showUsage && (
              <div style={styles.usage}>
                <div style={styles.usageHeader}>
                  <span style={styles.usageTitle}>{t('usageTitle')}</span>
                  {usage?.plan !== undefined && (
                    <span style={styles.usagePlan}>{t('usagePlan', { plan: usage.plan })}</span>
                  )}
                  <button
                    type="button"
                    style={{ ...styles.usageRefresh, ...usageLoading[id] === true ? { opacity: 0.5, cursor: 'default' } : {} }}
                    disabled={usageLoading[id] === true}
                    onClick={() => { void loadUsage(id) }}
                  >
                    {t('usageRefresh')}
                  </button>
                </div>
                {usage === undefined && usageError === undefined && (
                  <p style={styles.statusLine}>{t('usageLoading')}</p>
                )}
                {usageError !== undefined && (
                  <p style={styles.errorLine}>{t('usageError', { message: usageError })}</p>
                )}
                {usage?.windows !== undefined && usage.windows.length === 0 && (
                  <p style={styles.statusLine}>{t('usageEmpty')}</p>
                )}
                {(usage?.windows ?? []).map((window, index) => {
                  const percent = Math.min(100, Math.max(0, window.usedPercent))
                  const remaining = Math.round(100 - percent)
                  const subtitle = usageSubtitle(t, window)
                  return (
                    <div key={index} style={styles.usageRow}>
                      <div style={styles.usageMeta}>
                        <span style={styles.usageName}>{usageWindowLabel(t, window)}</span>
                        <span style={styles.usagePercent}>
                          {t('usageRemaining', { remaining, used: Math.round(percent) })}
                        </span>
                      </div>
                      <div style={styles.usageTrack}>
                        <div style={{ ...styles.usageFill, width: `${String(percent)}%`, background: usageBarColor(percent) }} />
                      </div>
                      {subtitle !== undefined && (
                        <p style={styles.usageSubtitle}>{subtitle}</p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {manualVisible && (
              <details style={styles.manual} open={manualVisible}>
                <summary>{t('manualSummary')}</summary>
                <div style={styles.manualRow}>
                  <input
                    style={styles.manualInput}
                    value={manualDrafts[id]}
                    placeholder={t('manualPlaceholder')}
                    onChange={event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value }))}
                  />
                  <button type="button" style={styles.button} onClick={() => { void submitManual(id) }}>
                    {t('submit')}
                  </button>
                </div>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}
