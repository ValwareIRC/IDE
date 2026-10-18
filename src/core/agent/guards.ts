// Guards around a running turn: noticing when the agent goes round in circles, keeping to the user's
// budget, and the checks the agent promised would prove its work ("done when").
import { spawn } from 'node:child_process'
import type { ToolItem } from '@shared/types'
import { shellCommand } from '../remote/command'
import { agentShell } from './tools/shell'
import { err, str, type AgentTool } from './tools/types'

// ------------------------------------------------------------ stuck

/** Watches the tool calls of one turn for signs of going round in circles. */
export class StuckWatch {
  private calls = new Map<string, number>()
  private failures = new Map<string, number>()
  private errors = new Map<string, number>()

  /** Feed the results of one step. Returns what looks stuck, or null. */
  observe(items: ToolItem[]): string | null {
    let found: string | null = null
    for (const it of items) {
      const sig = `${it.name} ${JSON.stringify(it.args)}`
      // the same call with the same answer means nothing changed in between (reading a file again after editing it is fine)
      const same = `${sig}\n${it.content.slice(0, 4000)}`
      const n = (this.calls.get(same) ?? 0) + 1
      this.calls.set(same, n)
      if (n % 4 === 0) found ??= `it has made the same ${it.name} call four times and got the same answer each time`
      if (it.isError) {
        const f = (this.failures.get(sig) ?? 0) + 1
        this.failures.set(sig, f)
        if (f % 3 === 0) found ??= `the same ${it.name} call has failed three times`
        // the same error from different calls (a build that keeps failing the same way)
        const e = it.content.replace(/\d+(\.\d+)?\s*(ms|s)\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 240)
        if (e.length > 20) {
          const k = (this.errors.get(e) ?? 0) + 1
          this.errors.set(e, k)
          if (k % 3 === 0) found ??= `the same error came back three times: "${e.slice(0, 140)}"`
        }
      }
    }
    return found
  }
}

// ------------------------------------------------------------ budget

export interface Budget {
  /** Most this one request may cost, in dollars. */
  cost?: number | null
  /** Most time this one request may take, in minutes. */
  minutes?: number | null
}

export function budgetState(b: Budget | null | undefined, spent: number, startedAt: number): { over: string | null; near: string | null } {
  if (!b) return { over: null, near: null }
  const mins = (Date.now() - startedAt) / 60_000
  const money = (n: number): string => `$${n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : Number(n.toPrecision(2)).toString()}`
  if (b.cost && spent >= b.cost) return { over: `it has spent ${money(spent)} of the ${money(b.cost)} budget for this request`, near: null }
  if (b.minutes && mins >= b.minutes) return { over: `it has worked for ${Math.round(mins)} of the ${b.minutes} minutes allowed for this request`, near: null }
  if (b.cost && spent >= b.cost * 0.8) return { over: null, near: `${money(spent)} of ${money(b.cost)} spent` }
  if (b.minutes && mins >= b.minutes * 0.8) return { over: null, near: `${Math.round(mins)} of ${b.minutes} minutes used` }
  return { over: null, near: null }
}

// ------------------------------------------------------------ done when

export interface DoneCheck {
  name: string
  command: string
}

export interface CheckResult extends DoneCheck {
  ok: boolean
  code: number | null
  output: string
  ms: number
}

/** Run each check in the project; a check passes when its command exits with 0. */
export async function runChecks(root: string, checks: DoneCheck[], shell: string | null, signal: AbortSignal): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  for (const c of checks) {
    if (signal.aborted) break
    const st = Date.now()
    const run = shellCommand(root, c.command, agentShell(shell), { PRISM_AGENT: '1', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' })
    const r = await new Promise<{ code: number | null; output: string }>((resolve) => {
      let text = ''
      const child = spawn(run.file, run.args, { cwd: run.cwd, windowsHide: true, env: { ...process.env, CI: '1', NO_COLOR: '1' } })
      const add = (d: Buffer): void => {
        text += d.toString('utf8')
        if (text.length > 200_000) text = text.slice(-100_000)
      }
      child.stdout?.on('data', add)
      child.stderr?.on('data', add)
      const stop = (): void => {
        try {
          if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
          else child.kill()
        } catch {
          /* gone */
        }
      }
      const timer = setTimeout(stop, 10 * 60_000)
      signal.addEventListener('abort', stop, { once: true })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ code: -1, output: e.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, output: text })
      })
    })
    out.push({ ...c, ok: r.code === 0, code: r.code, output: r.output.trimEnd().split('\n').slice(-40).join('\n'), ms: Date.now() - st })
  }
  return out
}

export const doneWhenTool: AgentTool = {
  spec: {
    name: 'done_when',
    description:
      'Say how your work will be proven before you call it finished: one or more shell commands that must succeed (exit code 0), such as the test suite, the type checker, a build, or a script that checks the behaviour asked for. ' +
      'Call it early, once you know what "done" means for this request. When you finish, Prism runs them all and shows the user the result; if one fails you are sent back to fix it. ' +
      'Choose commands that test what was asked, not only that the code compiles. Calling it again replaces the list.',
    parameters: {
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string', description: 'What it proves, in a few words' }, command: { type: 'string' } }, required: ['name', 'command'] }
        }
      },
      required: ['checks']
    }
  },
  primaryArg: null,
  readOnly: false,
  risk: () => 'medium',
  summary: (a) => {
    const list = Array.isArray(a['checks']) ? (a['checks'] as Array<Record<string, unknown>>) : []
    return `done when: ${list.map((c) => String(c['command'] ?? '')).join(' && ').slice(0, 120)}`
  },
  async execute(args, ctx) {
    const raw = Array.isArray(args['checks']) ? (args['checks'] as Array<Record<string, unknown>>) : []
    const checks = raw.map((c) => ({ name: String(c['name'] ?? '').trim() || String(c['command'] ?? '').slice(0, 40), command: String(c['command'] ?? '').trim() })).filter((c) => c.command).slice(0, 8)
    if (!checks.length) return err('Give at least one check with a command.')
    if (!ctx.setDoneWhen) return err('Not available here.')
    ctx.setDoneWhen(checks)
    return { content: `Noted. When you finish, Prism will run: ${checks.map((c) => `\`${c.command}\``).join(', ')}.`, isError: false, meta: { doneWhen: checks } }
  }
}

export const assumeTool: AgentTool = {
  spec: {
    name: 'assume',
    description:
      'Write down an assumption you are making instead of asking: about what the user wants, how something works, or a choice you made for them. The user sees each one with a button to say it is wrong, and their correction reaches you at once. ' +
      'Use it for real guesses that would change the work if wrong, one per call, in one plain sentence. Not for things you checked.',
    parameters: { type: 'object', properties: { assumption: { type: 'string' } }, required: ['assumption'] }
  },
  primaryArg: 'assumption',
  readOnly: true,
  risk: () => null,
  summary: (a) => `assume: ${str(a, 'assumption').slice(0, 90)}`,
  async execute(args) {
    const a = str(args, 'assumption').trim()
    if (!a) return err('Say what you are assuming.')
    return { content: 'Noted; the user can correct it.', isError: false, meta: { assumption: a } }
  }
}

/** What the agent is told about the user's budget for each request. */
export function budgetLine(b: Budget | null | undefined): string {
  if (!b || (!b.cost && !b.minutes)) return ''
  const parts = [b.cost ? `$${b.cost} of model usage` : '', b.minutes ? `${b.minutes} minutes` : ''].filter(Boolean)
  return `Budget: the user allows each request at most ${parts.join(' and ')}. Prism pauses you when it runs out, so do the most important part first and keep side quests out.`
}
