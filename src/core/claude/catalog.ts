// What the installed Claude Code offers: which models, and whether it is signed
// in. Asking means starting Claude Code briefly (no message is sent, so nothing
// is used up), so the answer is kept in a small file and only refreshed when it
// is old or when the user asks.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeStatus, Effort, ModelInfo, SlashCommand, ClaudePlanUsage, ClaudeUsageSpan } from '@shared/types'
import { claudeEnv, locateClaude } from './locate'
import { CLAUDE_ENDPOINT, CLAUDE_ENDPOINT_NAME } from './translate'

const STALE_MS = 24 * 3600_000

const FALLBACK: ClaudeStatus['models'] = [
  { value: 'default', name: 'Default', description: 'The model your Claude Code is set to use' },
  { value: 'opus', name: 'Opus', description: 'Most capable for complex work' },
  { value: 'sonnet', name: 'Sonnet', description: 'Efficient for routine tasks' },
  { value: 'haiku', name: 'Haiku', description: 'Fastest for quick answers' }
]

function version(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: 8000, env: claudeEnv() as NodeJS.ProcessEnv, windowsHide: true }, (err, stdout) => {
      const m = !err && /\d+\.\d+\.\d+/.exec(String(stdout))
      resolve(m ? m[0] : null)
    })
  })
}

const RECOMMENDED = /\s*\(recommended\)/i

export class ClaudeCatalog {
  private status: ClaudeStatus
  private busy: Promise<ClaudeStatus> | null = null

  constructor(
    private file: string,
    private cfg: () => { enabled: boolean; path: string | null },
    private changed: (s: ClaudeStatus) => void = () => {}
  ) {
    this.status = this.load()
  }

  private blank(): ClaudeStatus {
    return { enabled: true, path: null, version: null, plan: null, signedIn: false, models: [], commands: [], error: null, checkedAt: 0 }
  }

  private load(): ClaudeStatus {
    try {
      if (existsSync(this.file)) return { ...this.blank(), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ClaudeStatus>) }
    } catch {
      /* a damaged cache is rebuilt */
    }
    return this.blank()
  }

  /** The program to run, or null when Claude Code is not installed (or switched off). */
  exe(): string | null {
    const c = this.cfg()
    return c.enabled ? locateClaude(c.path) : null
  }

  current(): ClaudeStatus {
    const c = this.cfg()
    return { ...this.status, enabled: c.enabled, path: locateClaude(c.path) }
  }

  models(): ModelInfo[] {
    if (!this.exe()) return []
    const list = this.status.models.length ? this.status.models : FALLBACK
    return list.map((m) => ({
      key: `${CLAUDE_ENDPOINT}::${m.value}`,
      endpointId: CLAUDE_ENDPOINT,
      endpointName: CLAUDE_ENDPOINT_NAME,
      adapter: 'anthropic',
      modelId: m.value,
      label: m.name,
      note: m.description,
      favorite: false,
      contextWindow: /\b1M\b/i.test(`${m.name} ${m.description}`) ? 1_000_000 : 200_000,
      maxOutput: null,
      supportsTools: true,
      supportsVision: true,
      reasoning: true,
      inputPrice: null,
      outputPrice: null,
      ...(m.efforts?.length ? { efforts: m.efforts } : {})
    }))
  }

  /** Claude Code's own slash commands, offered in sessions that use it. */
  commands(): SlashCommand[] {
    return this.exe() ? this.status.commands.map((c) => ({ name: c.name, description: c.description, source: 'claude' as const })) : []
  }

  /** Refresh when there is no answer yet, it is a day old, or the program changed. */
  ensure(cwd: string): void {
    const exe = this.exe()
    if (!exe) return
    if (this.status.models.length && this.status.path === exe && Date.now() - this.status.checkedAt < STALE_MS) return
    void this.refresh(cwd).catch(() => {})
  }

  refresh(cwd: string): Promise<ClaudeStatus> {
    this.busy ??= this.ask(cwd).finally(() => {
      this.busy = null
    })
    return this.busy
  }

  private planBusy: Promise<ClaudePlanUsage> | null = null
  private planLast: ClaudePlanUsage | null = null

  /**
   * How much of the Claude plan's limits is used, and what is using it: the same data
   * as Claude Code's own /usage, asked of Claude Code through the Agent SDK (its
   * usage request is marked experimental, so a change in its answer shows as "not
   * available" rather than breaking anything). No message is sent, so it costs nothing.
   * Asked at most once a minute; the account's e-mail is shown, never stored.
   */
  planUsage(cwd: string, fresh = false): Promise<ClaudePlanUsage> {
    if (!fresh && this.planLast && Date.now() - this.planLast.at < 60_000) return Promise.resolve(this.planLast)
    this.planBusy ??= this.askPlan(cwd).finally(() => {
      this.planBusy = null
    })
    return this.planBusy
  }

  private async askPlan(cwd: string): Promise<ClaudePlanUsage> {
    const exe = locateClaude(this.cfg().path)
    const out: ClaudePlanUsage = { at: Date.now(), available: false, plan: null, email: null, organization: null, windows: [], extra: null, behaviors: null, error: null }
    if (!exe) return { ...out, error: 'Claude Code was not found on this computer.' }
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    async function* nothing(): AsyncGenerator<SDKUserMessage> {
      await hold
    }
    const timer = setTimeout(() => release(), 40_000)
    try {
      const q = query({ prompt: nothing(), options: { cwd, env: claudeEnv(), pathToClaudeCodeExecutable: exe, permissionMode: 'plan', strictMcpConfig: true } })
      const drain = (async () => {
        for await (const _ of q) void _
      })().catch(() => {})
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Claude Code did not answer in time.')), 35_000))
      const ask = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o?: { skipBehaviors?: boolean }) => Promise<unknown> }).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof ask !== 'function') throw new Error('This version of Claude Code cannot report its usage.')
      const [u, account] = (await Promise.race([Promise.all([ask.call(q, { skipBehaviors: false }), q.accountInfo()]), timeout])) as [Record<string, unknown>, { email?: string; organization?: string; subscriptionType?: string }]
      release()
      await Promise.race([drain, new Promise((r) => setTimeout(r, 3000))])
      try {
        q.close()
      } catch {
        /* already closed */
      }
      Object.assign(out, readPlanUsage(u))
      out.plan = (u['subscription_type'] as string | null) ?? account.subscriptionType ?? null
      out.email = account.email ?? null
      out.organization = account.organization ?? null
    } catch (e) {
      release()
      out.error = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }
    this.planLast = out
    return out
  }

  private async ask(cwd: string): Promise<ClaudeStatus> {
    const c = this.cfg()
    const exe = locateClaude(c.path)
    if (!exe) {
      this.status = { ...this.blank(), enabled: c.enabled, error: c.path ? 'There is no Claude Code program at that location.' : 'Claude Code was not found on this computer.', checkedAt: Date.now() }
      return this.current()
    }
    const next: ClaudeStatus = { ...this.blank(), enabled: c.enabled, path: exe, checkedAt: Date.now(), version: await version(exe) }
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    async function* nothing(): AsyncGenerator<SDKUserMessage> {
      await hold
    }
    let errTail = ''
    const timer = setTimeout(() => release(), 25_000)
    try {
      // no message is sent; its own MCP servers are skipped so this stays quick
      const q = query({ prompt: nothing(), options: { cwd, env: claudeEnv(), pathToClaudeCodeExecutable: exe, permissionMode: 'plan', strictMcpConfig: true, stderr: (d) => (errTail = (errTail + d).slice(-2000)) } })
      const drain = (async () => {
        for await (const _ of q) void _
      })().catch(() => {})
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Claude Code did not answer in time.')), 20_000))
      const [models, account, commands] = (await Promise.race([Promise.all([q.supportedModels(), q.accountInfo(), q.supportedCommands()]), timeout])) as [
        Awaited<ReturnType<typeof q.supportedModels>>,
        Awaited<ReturnType<typeof q.accountInfo>>,
        Awaited<ReturnType<typeof q.supportedCommands>>
      ]
      next.models = models.map((m) => ({
        value: m.value,
        name: m.displayName.replace(RECOMMENDED, ''),
        description: m.description,
        ...(m.supportsEffort && m.supportedEffortLevels?.length ? { efforts: m.supportedEffortLevels as Effort[] } : {})
      }))
      // only the plan name is kept; the account's e-mail address is not stored
      next.plan = account.subscriptionType ?? (account.apiKeySource && account.apiKeySource !== 'none' ? 'API key' : null)
      next.signedIn = !!(account.subscriptionType || account.email || account.tokenSource || (account.apiKeySource && account.apiKeySource !== 'none') || (account.apiProvider && account.apiProvider !== 'firstParty'))
      next.commands = commands.map((x) => ({ name: x.name, description: x.description })).slice(0, 200)
      release()
      await Promise.race([drain, new Promise((r) => setTimeout(r, 3000))])
      try {
        q.close()
      } catch {
        /* already closed */
      }
    } catch (e) {
      release()
      next.error = e instanceof Error ? e.message : String(e)
      const last = errTail.trim().split('\n').pop()
      if (last && !next.error.includes(last)) next.error += ` (${last})`
    } finally {
      clearTimeout(timer)
    }
    this.status = next
    try {
      writeFileSync(this.file, JSON.stringify(next, null, 2))
    } catch {
      /* the cache is a convenience */
    }
    this.changed(this.current())
    return this.current()
  }
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: 'This 5-hour session',
  seven_day: 'This week, all models',
  seven_day_opus: 'This week, Opus',
  seven_day_sonnet: 'This week, Sonnet',
  seven_day_oauth_apps: 'This week, other apps'
}

/** Claude Code's usage answer, taken only as far as it has the expected shape. */
function readPlanUsage(u: Record<string, unknown>): Pick<ClaudePlanUsage, 'available' | 'windows' | 'extra' | 'behaviors'> {
  const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null)
  const when = (v: unknown): number | null => (typeof v === 'string' && !isNaN(Date.parse(v)) ? Date.parse(v) : null)
  const rl = (u['rate_limits'] ?? null) as Record<string, unknown> | null
  const windows: ClaudePlanUsage['windows'] = []
  if (rl) {
    for (const [key, label] of Object.entries(WINDOW_NAMES)) {
      const w = rl[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined
      if (w && num(w.utilization) != null) windows.push({ key, label, used: num(w.utilization)!, resetsAt: when(w.resets_at) })
    }
    for (const m of (Array.isArray(rl['model_scoped']) ? rl['model_scoped'] : []) as Array<{ display_name?: unknown; utilization?: unknown; resets_at?: unknown }>) {
      if (typeof m.display_name === 'string' && num(m.utilization) != null) windows.push({ key: `model:${m.display_name}`, label: `This week, ${m.display_name}`, used: num(m.utilization)!, resetsAt: when(m.resets_at) })
    }
    // per-model weekly windows also come in the limits list (seen 2026-10-09)
    for (const l of (Array.isArray(rl['limits']) ? rl['limits'] : []) as Array<{ kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } } | null }>) {
      const name = l.scope?.model?.display_name
      if (l.kind === 'weekly_scoped' && typeof name === 'string' && num(l.percent) != null && !windows.some((w) => w.key === `model:${name}`)) windows.push({ key: `model:${name}`, label: `This week, ${name}`, used: num(l.percent)!, resetsAt: when(l.resets_at) })
    }
  }
  const ex = (rl?.['extra_usage'] ?? null) as { is_enabled?: unknown; monthly_limit?: unknown; used_credits?: unknown; utilization?: unknown; currency?: unknown } | null
  const extra = ex && ex.is_enabled === true ? { limit: num(ex.monthly_limit), used: num(ex.used_credits), percent: num(ex.utilization), currency: typeof ex.currency === 'string' ? ex.currency : null } : null
  const b = (u['behaviors'] ?? null) as Record<string, unknown> | null
  const span = (x: unknown): ClaudeUsageSpan | null => {
    if (!x || typeof x !== 'object') return null
    const s = x as Record<string, unknown>
    const items = (k: string): Array<{ name: string; pct: number }> => (Array.isArray(s[k]) ? (s[k] as Array<{ name?: unknown; pct?: unknown }>).filter((i) => typeof i.name === 'string' && num(i.pct) != null).map((i) => ({ name: i.name as string, pct: num(i.pct)! })) : [])
    return {
      requests: num(s['request_count']) ?? 0,
      sessions: num(s['session_count']) ?? 0,
      behaviors: (Array.isArray(s['behaviors']) ? (s['behaviors'] as Array<{ key?: unknown; pct?: unknown; count?: unknown }>) : []).filter((i) => typeof i.key === 'string' && num(i.pct) != null).map((i) => ({ key: i.key as string, pct: num(i.pct)!, count: num(i.count) ?? 0 })),
      skills: items('skills'),
      agents: items('agents'),
      plugins: items('plugins'),
      mcpServers: items('mcp_servers')
    }
  }
  return { available: u['rate_limits_available'] === true && windows.length > 0, windows, extra, behaviors: b ? { day: span(b['day']), week: span(b['week']) } : null }
}
