import { runLine } from '../remote/command'
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AutomationHook, AutomationRun, AutomationSchedule, AutomationTrigger, AutomationWatcher, AutomationsConfig, AutomationsState, FsChange, PermissionMode, ToolCall } from '@shared/types'
import { failedRuns, listPulls, recentComments, type RepoRef } from '../review/prs'
import { globMatch } from '../agent/permissions'

/**
 * Things that happen by themselves, kept with the project in
 * .prism/automations.json:
 *  - hooks: a command run around the agent's tools and at the end of a turn
 *    (format after an edit, block a dangerous command, test when a turn ends);
 *  - watchers: a prompt sent to the agent when matching files change;
 *  - schedules: a prompt sent on a timer while Prism is open;
 *  - triggers: a prompt sent when its web address is called, or on a GitHub event (polled).
 * The engine and the agent host call in here; nothing in here knows the UI.
 */

const FILE = '.prism/automations.json'
const MODES: PermissionMode[] = ['plan', 'ask', 'auto-edit', 'auto']
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'propose_changes', 'remember'])

export interface AutomationDeps {
  root(): string | null
  /** Send a prompt to the agent in the session that belongs to this automation. Resolves when the turn has started. */
  runPrompt(automationId: string, name: string, prompt: string, mode: PermissionMode): Promise<string | null>
  /** True while any agent turn runs in this workspace: the agent's own edits must not trigger watchers. */
  agentActive(): boolean
  send(channel: string, payload: unknown): void
  /** The project's GitHub repository and the user's token, when there are both. */
  github?(): Promise<(RepoRef & { token: string }) | null>
  /** A web-address trigger's full address (its secret part is kept outside the project). */
  webhookUrl?(triggerId: string): string | null
}

const GITHUB_EVERY = 3 * 60_000

function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function id(v: unknown, i: number, prefix: string): string {
  const s = str(v, 60).replace(/[^\w-]/g, '')
  return s || `${prefix}-${i + 1}`
}

/** Read whatever is in the file into a well-formed config; bad entries are dropped, not fatal. */
export function parseAutomations(raw: unknown): AutomationsConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const arr = (k: string): Array<Record<string, unknown>> => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])
  const hooks: AutomationHook[] = arr('hooks')
    .map((h, i) => ({
      id: id(h['id'], i, 'hook'),
      name: str(h['name'], 80) || `Hook ${i + 1}`,
      event: (['before-tool', 'after-tool', 'after-edit', 'turn-end'] as const).includes(h['event'] as AutomationHook['event']) ? (h['event'] as AutomationHook['event']) : 'after-edit',
      match: str(h['match'], 200),
      command: str(h['command']),
      feedback: h['feedback'] !== false,
      enabled: h['enabled'] !== false
    }))
    .filter((h) => h.command.trim())
  const watchers: AutomationWatcher[] = arr('watchers')
    .map((w, i) => ({
      id: id(w['id'], i, 'watch'),
      name: str(w['name'], 80) || `Watcher ${i + 1}`,
      glob: str(w['glob'], 200) || '*',
      prompt: str(w['prompt']),
      mode: MODES.includes(w['mode'] as PermissionMode) ? (w['mode'] as PermissionMode) : 'auto-edit',
      debounceMs: Math.min(600_000, Math.max(1000, Number(w['debounceMs']) || 4000)),
      enabled: w['enabled'] !== false
    }))
    .filter((w) => w.prompt.trim())
  const schedules: AutomationSchedule[] = arr('schedules')
    .map((s, i) => ({
      id: id(s['id'], i, 'schedule'),
      name: str(s['name'], 80) || `Schedule ${i + 1}`,
      every: str(s['every'], 40) || '1h',
      prompt: str(s['prompt']),
      mode: MODES.includes(s['mode'] as PermissionMode) ? (s['mode'] as PermissionMode) : 'ask',
      enabled: s['enabled'] !== false
    }))
    .filter((s) => s.prompt.trim() && parseEvery(s.every) !== null)
  const ON: AutomationTrigger['on'][] = ['webhook', 'github-pr-opened', 'github-mention', 'github-ci-failed']
  const triggers: AutomationTrigger[] = arr('triggers')
    .map((t, i) => ({
      id: id(t['id'], i, 'trigger'),
      name: str(t['name'], 80) || `Trigger ${i + 1}`,
      on: ON.includes(t['on'] as AutomationTrigger['on']) ? (t['on'] as AutomationTrigger['on']) : 'webhook',
      prompt: str(t['prompt']),
      mode: MODES.includes(t['mode'] as PermissionMode) ? (t['mode'] as PermissionMode) : 'plan',
      enabled: t['enabled'] !== false
    }))
    .filter((t) => t.prompt.trim())
  return { hooks, watchers, schedules, triggers }
}

/** "20m", "2h" → an interval in ms; "daily 09:00" → a time of day. null when it cannot be read. */
export function parseEvery(every: string): { intervalMs: number } | { dailyAt: number } | null {
  const t = every.trim().toLowerCase()
  let m = /^(\d+)\s*(m|min|mins|minutes?)$/.exec(t)
  if (m) return { intervalMs: Math.max(1, Number(m[1])) * 60_000 }
  m = /^(\d+)\s*(h|hr|hrs|hours?)$/.exec(t)
  if (m) return { intervalMs: Math.max(1, Number(m[1])) * 3_600_000 }
  m = /^(?:daily|every day)(?:\s+at)?\s+(\d{1,2}):(\d{2})$/.exec(t)
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { dailyAt: Number(m[1]) * 60 + Number(m[2]) }
  return null
}

/** `*` crosses folders here; a pattern without a slash also matches by file name. */
function fileMatches(pattern: string, path: string): boolean {
  if (!pattern.trim() || pattern.trim() === '*') return true
  return pattern.split(',').some((p) => {
    const g = p.trim()
    if (!g) return false
    return globMatch(g, path) || (!g.includes('/') && globMatch(g, path.split('/').pop() ?? path))
  })
}

/** {file} and {tool} in a hook's command are filled in here, so one command works in cmd, PowerShell and bash alike. */
function expand(command: string, env: Record<string, string>): string {
  return command
    .replace(/\{file\}|\$\{PRISM_FILE\}|\$PRISM_FILE|%PRISM_FILE%/g, () => env['PRISM_FILE'] ?? '')
    .replace(/\{tool\}|\$\{PRISM_TOOL\}|\$PRISM_TOOL|%PRISM_TOOL%/g, () => env['PRISM_TOOL'] ?? '')
}

function runCommand(root: string, rawCommand: string, env: Record<string, string>, stdin: string, timeoutMs = 120_000): Promise<{ code: number; output: string }> {
  const command = expand(rawCommand, env)
  return runLine(root, command, { timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdin }).then((r) => {
    const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
    return { code: r.code, output: output.length > 12_000 ? `${output.slice(0, 4000)}\n…\n${output.slice(-7000)}` : output }
  })
}

export class AutomationManager {
  private config: AutomationsConfig = { hooks: [], watchers: [], schedules: [], triggers: [] }
  // what GitHub had at the first look, so only what is new after it starts a trigger
  private seen: { prs: Set<number>; runs: Set<number>; commentsSince: number } | null = null
  private lastGithub = 0
  private githubError: string | null = null
  private runs: AutomationRun[] = []
  private error: string | null = null
  private fileWatcher: FSWatcher | null = null
  private watchedRoot: string | null = null
  private debounce = new Map<string, NodeJS.Timeout>()
  private lastRun = new Map<string, number>()
  private lastDay = new Map<string, string>()
  private agentQuietUntil = 0
  private ticker: NodeJS.Timeout
  private runSeq = 0

  constructor(private deps: AutomationDeps) {
    this.ticker = setInterval(() => this.tick(), 20_000)
    this.reload()
  }

  dispose(): void {
    clearInterval(this.ticker)
    this.fileWatcher?.close()
    for (const t of this.debounce.values()) clearTimeout(t)
  }

  // ---------------------------------------------------------------- config

  /** Re-read the project's file. Called when the workspace changes and when the file itself changes. */
  reload(): void {
    const root = this.deps.root()
    // a changed config is looked at on the next tick, not three minutes later
    this.lastGithub = 0
    this.config = { hooks: [], watchers: [], schedules: [], triggers: [] }
    this.error = null
    if (root) {
      const file = join(root, FILE)
      if (existsSync(file)) {
        try {
          this.config = parseAutomations(JSON.parse(readFileSync(file, 'utf8')))
        } catch (e) {
          this.error = `automations.json could not be read: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    }
    if (root !== this.watchedRoot) {
      this.fileWatcher?.close()
      this.fileWatcher = null
      this.watchedRoot = root
      this.lastRun.clear()
      this.lastDay.clear()
      this.seen = null
      // a schedule starts counting from now, and a daily one that is already past waits for tomorrow
      const today = new Date().toDateString()
      for (const s of this.config.schedules) {
        this.lastRun.set(s.id, Date.now())
        this.lastDay.set(s.id, today)
      }
      if (root && existsSync(join(root, '.prism'))) {
        try {
          this.fileWatcher = watch(join(root, '.prism'), { persistent: false }, (_e, name) => {
            if (String(name) === 'automations.json') setTimeout(() => this.reload(), 200)
          })
          // a system that cannot watch files (no inotify) reports it here; unanswered, it would crash Prism
          this.fileWatcher.on('error', () => {
            this.fileWatcher?.close()
            this.fileWatcher = null
          })
        } catch {
          this.fileWatcher = null
        }
      }
    }
    this.broadcast()
  }

  state(): AutomationsState {
    const webhooks: Record<string, string> = {}
    for (const t of this.config.triggers) if (t.on === 'webhook') webhooks[t.id] = this.deps.webhookUrl?.(t.id) ?? ''
    return { config: this.config, runs: this.runs, error: this.error, file: FILE, webhooks, githubError: this.githubError }
  }

  /** A call to a web-address trigger: its prompt, with what the caller sent. False when no enabled trigger has that address. */
  webhook(triggerId: string, body: string): boolean {
    const t = this.config.triggers.find((x) => x.id === triggerId && x.on === 'webhook' && x.enabled)
    if (!t) return false
    const sent = body.trim() ? `\n\nIt came with this:\n\`\`\`\n${body.slice(0, 8000)}\n\`\`\`` : ''
    void this.fire('trigger', t.id, t.name, t.prompt + sent, t.mode)
    return true
  }

  private async github(): Promise<void> {
    const wanted = this.config.triggers.filter((t) => t.enabled && t.on !== 'webhook')
    if (!wanted.length || !this.deps.github) return
    const gh = await this.deps.github().catch(() => null)
    if (!gh) {
      this.githubError = 'GitHub triggers need a GitHub repository as origin and a token (add one in the Pull requests panel).'
      return
    }
    try {
      const [pulls, runs] = await Promise.all([listPulls(gh, gh.token), failedRuns(gh, gh.token).catch(() => [])])
      const since = this.seen?.commentsSince ?? Date.now()
      const comments = await recentComments(gh, gh.token, since).catch(() => [])
      this.githubError = null
      if (!this.seen) {
        this.seen = { prs: new Set(pulls.map((p) => p.number)), runs: new Set(runs.map((r) => r.id)), commentsSince: Date.now() }
        return
      }
      const fire = (on: AutomationTrigger['on'], what: string): void => {
        for (const t of wanted.filter((x) => x.on === on)) void this.fire('trigger', t.id, t.name, `${t.prompt}\n\n${what}`, t.mode)
      }
      for (const p of pulls.filter((x) => !this.seen!.prs.has(x.number))) {
        this.seen.prs.add(p.number)
        fire('github-pr-opened', `A pull request was opened: #${p.number} "${p.title}" by ${p.author}, branch ${p.branch} into ${p.base}. ${p.url}`)
      }
      for (const r of runs.filter((x) => !this.seen!.runs.has(x.id))) {
        this.seen.runs.add(r.id)
        fire('github-ci-failed', `A CI run failed: "${r.name}" on branch ${r.branch} (${r.title}). ${r.url}`)
      }
      for (const c of comments) {
        this.seen.commentsSince = Math.max(this.seen.commentsSince, c.at + 1000)
        if (/@prism\b/i.test(c.body)) fire('github-mention', `${c.author} mentioned @prism in a comment (${c.url}):\n\n${c.body.slice(0, 4000)}`)
      }
    } catch (e) {
      this.githubError = e instanceof Error ? e.message : String(e)
    }
    this.broadcast()
  }

  async save(config: unknown): Promise<AutomationsState> {
    const root = this.deps.root()
    if (!root) throw new Error('Open a folder first.')
    const clean = parseAutomations(config)
    const file = join(root, FILE)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(clean, null, 2) + '\n', 'utf8')
    this.watchedRoot = null
    this.reload()
    return this.state()
  }

  private broadcast(): void {
    this.deps.send('automations:changed', this.state())
  }

  private record(run: Omit<AutomationRun, 'id'>): AutomationRun {
    const full: AutomationRun = { id: `r${++this.runSeq}`, ...run }
    this.runs = [full, ...this.runs].slice(0, 60)
    this.broadcast()
    return full
  }

  // ---------------------------------------------------------------- hooks (called by the engine)

  private env(sessionId: string, call: ToolCall | null, file: string): Record<string, string> {
    return { PRISM_SESSION: sessionId, PRISM_WORKSPACE: this.deps.root() ?? '', PRISM_TOOL: call?.name ?? '', PRISM_FILE: file }
  }

  private hooksFor(event: AutomationHook['event'], toolName: string, file: string): AutomationHook[] {
    return this.config.hooks.filter((h) => {
      if (!h.enabled || h.event !== event) return false
      if (event === 'after-edit') return fileMatches(h.match, file)
      if (event === 'turn-end') return true
      return !h.match.trim() || h.match.split(',').some((p) => globMatch(p.trim(), toolName))
    })
  }

  /** A failing before-tool hook stops the tool; what it printed is the reason given to the agent. */
  async beforeTool(sessionId: string, call: ToolCall): Promise<string | null> {
    const root = this.deps.root()
    if (!root) return null
    for (const h of this.hooksFor('before-tool', call.name, '')) {
      const started = Date.now()
      const r = await runCommand(root, h.command, this.env(sessionId, call, String(call.args['path'] ?? '')), JSON.stringify({ tool: call.name, args: call.args }), 60_000)
      this.record({ kind: 'hook', automationId: h.id, name: h.name, startedAt: started, endedAt: Date.now(), ok: r.code === 0, output: r.output, detail: call.name })
      if (r.code !== 0) return `Stopped by the "${h.name}" hook (exit code ${r.code}).${r.output ? `\n${r.output}` : ''}`
    }
    return null
  }

  /** After a tool ran: after-tool hooks, and after-edit hooks for the file it wrote. Returns text to add to the tool result. */
  async afterTool(sessionId: string, call: ToolCall, isError: boolean): Promise<string | null> {
    const root = this.deps.root()
    if (!root) return null
    const notes: string[] = []
    const file = typeof call.args['path'] === 'string' ? call.args['path'].split('\\').join('/') : ''
    const list = [...this.hooksFor('after-tool', call.name, file), ...(!isError && EDIT_TOOLS.has(call.name) && file ? this.hooksFor('after-edit', call.name, file) : [])]
    for (const h of list) {
      const started = Date.now()
      const r = await runCommand(root, h.command, this.env(sessionId, call, file), JSON.stringify({ tool: call.name, args: call.args, isError }))
      this.record({ kind: 'hook', automationId: h.id, name: h.name, startedAt: started, endedAt: Date.now(), ok: r.code === 0, output: r.output, detail: file || call.name })
      if (h.feedback && (r.code !== 0 || r.output)) notes.push(`[hook "${h.name}"${r.code !== 0 ? ` failed with exit code ${r.code}` : ''}]\n${r.output || '(no output)'}`)
    }
    return notes.length ? notes.join('\n\n') : null
  }

  /** When a turn ends: a failing turn-end hook with feedback on becomes a follow-up for the agent. */
  async turnEnd(sessionId: string, changed: string[]): Promise<string | null> {
    this.agentQuietUntil = Date.now() + 4000
    const root = this.deps.root()
    // a turn that wrote nothing has nothing to check
    if (!root || !changed.length) return null
    const failures: string[] = []
    for (const h of this.hooksFor('turn-end', '', '')) {
      if (h.match.trim() && !changed.some((f) => fileMatches(h.match, f))) continue
      const started = Date.now()
      const r = await runCommand(root, h.command, { ...this.env(sessionId, null, ''), PRISM_CHANGED: changed.join('\n') }, JSON.stringify({ changed }), 300_000)
      this.record({ kind: 'hook', automationId: h.id, name: h.name, startedAt: started, endedAt: Date.now(), ok: r.code === 0, output: r.output, detail: 'turn ended' })
      if (r.code !== 0 && h.feedback) failures.push(`The "${h.name}" check (\`${h.command}\`) failed with exit code ${r.code} after your last turn:\n\n${r.output || '(no output)'}`)
    }
    return failures.length ? `${failures.join('\n\n')}\n\nFix this.` : null
  }

  // ---------------------------------------------------------------- watchers and schedules

  /** File changes in the workspace. The agent's own edits are ignored, or a watcher would feed itself forever. */
  onFsChange(changes: FsChange[]): void {
    if (this.deps.agentActive() || Date.now() < this.agentQuietUntil) return
    const paths = changes.map((c) => c.path).filter((p) => !/^(\.prism|\.git|node_modules|dist|out|target)(\/|$)/.test(p))
    if (!paths.length) return
    for (const w of this.config.watchers) {
      if (!w.enabled || !paths.some((p) => fileMatches(w.glob, p))) continue
      const prev = this.debounce.get(w.id)
      if (prev) clearTimeout(prev)
      this.debounce.set(
        w.id,
        setTimeout(() => {
          this.debounce.delete(w.id)
          if (this.deps.agentActive()) return
          const hit = paths.filter((p) => fileMatches(w.glob, p)).slice(0, 12)
          void this.fire('watcher', w.id, w.name, `${w.prompt}\n\n(These files just changed: ${hit.join(', ')})`, w.mode)
        }, w.debounceMs)
      )
    }
  }

  private tick(): void {
    if (!this.deps.root()) return
    if (this.config.triggers.some((x) => x.enabled && x.on !== 'webhook') && Date.now() - this.lastGithub >= GITHUB_EVERY) {
      this.lastGithub = Date.now()
      void this.github()
    }
    const now = new Date()
    for (const s of this.config.schedules) {
      if (!s.enabled) continue
      const when = parseEvery(s.every)
      if (!when) continue
      if ('intervalMs' in when) {
        const last = this.lastRun.get(s.id) ?? Date.now()
        if (!this.lastRun.has(s.id)) this.lastRun.set(s.id, last)
        if (Date.now() - last < when.intervalMs) continue
      } else {
        const today = now.toDateString()
        if (this.lastDay.get(s.id) === today || now.getHours() * 60 + now.getMinutes() < when.dailyAt) continue
        this.lastDay.set(s.id, today)
      }
      this.lastRun.set(s.id, Date.now())
      void this.fire('schedule', s.id, s.name, s.prompt, s.mode)
    }
  }

  /** Run a watcher or schedule right now (also the "Run now" button). */
  async runNow(automationId: string): Promise<void> {
    const w = this.config.watchers.find((x) => x.id === automationId)
    if (w) return this.fire('watcher', w.id, w.name, w.prompt, w.mode)
    const s = this.config.schedules.find((x) => x.id === automationId)
    if (s) return this.fire('schedule', s.id, s.name, s.prompt, s.mode)
    const t = this.config.triggers.find((x) => x.id === automationId)
    if (t) return this.fire('trigger', t.id, t.name, `${t.prompt}\n\n(Run by hand from the Automations panel.)`, t.mode)
    throw new Error('No automation with that id.')
  }

  private async fire(kind: 'watcher' | 'schedule' | 'trigger', automationId: string, name: string, prompt: string, mode: PermissionMode): Promise<void> {
    const started = Date.now()
    try {
      const sessionId = await this.deps.runPrompt(automationId, name, prompt, mode)
      this.record({ kind, automationId, name, startedAt: started, endedAt: Date.now(), ok: sessionId !== null, output: sessionId ? 'Sent to the agent.' : 'Skipped: its session was still busy.', ...(sessionId ? { sessionId } : {}) })
    } catch (e) {
      this.record({ kind, automationId, name, startedAt: started, endedAt: Date.now(), ok: false, output: e instanceof Error ? e.message : String(e) })
    }
  }
}
