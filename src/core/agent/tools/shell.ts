import { spawn, type ChildProcess } from 'node:child_process'
import { placeOf } from '@shared/place'
import { shellCommand } from '../../remote/command'
import { snapshotProject } from '../../history/snapshot'
import { randomUUID } from 'node:crypto'
import { shellRisk } from '../permissions'
import { findPwsh } from '../../pty/pwsh'
import { bool, clipOutput, err, num, str, type AgentTool, type ToolContext, type ToolResult } from './types'

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_CAPTURE = 400_000

export interface ShellConfig {
  /** Explicit shell executable, or null for the platform default. */
  shell: () => string | null
  /** The user's limit for one command, in seconds (Settings, Agent). */
  timeoutSec?: () => number
}

/** What the agent is told its shell is, for a folder in this place. */
export function shellLabelFor(root: string, override: string | null): string {
  return placeOf(root).kind === 'local' ? agentShell(override).label : 'bash'
}

/** Windows PowerShell 5.1 writes files in UTF-16 (> and >>) or the ANSI code page (Set-Content); this makes them UTF-8. */
const PS_UTF8 = "$PSDefaultParameterValues['Out-File:Encoding']='utf8';$PSDefaultParameterValues['Set-Content:Encoding']='utf8';$PSDefaultParameterValues['Add-Content:Encoding']='utf8';[Console]::OutputEncoding=[Text.Encoding]::UTF8;"

/** What the agent is told when its shell is Windows PowerShell 5.1, which loses quotes on the way to other programs. */
const WIN_PS_51 =
  'Windows PowerShell 5.1. It strips double quotes inside arguments it passes to other programs (node -e \'console.log("x")\' reaches node without the quotes, and backtick escapes do not help): put code for node, python and the like in a file and run the file, and avoid double quotes inside arguments'

/** PowerShell 7 writes files as UTF-8 already; what other programs print still needs reading as UTF-8. */
const PWSH_UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;'

export function agentShell(override: string | null): { exe: string; args: (cmd: string) => string[]; label: string } {
  const isWin = process.platform === 'win32'
  if (override && override.trim()) {
    const exe = override.trim()
    if (/pwsh|powershell/i.test(exe)) return { exe, args: (c) => ['-NoProfile', '-NonInteractive', '-Command', /pwsh/i.test(exe) ? `${PWSH_UTF8}${c}` : `${PS_UTF8}${c}`], label: /pwsh/i.test(exe) ? 'PowerShell 7' : WIN_PS_51 }
    if (/cmd(\.exe)?$/i.test(exe)) return { exe, args: (c) => ['/d', '/s', '/c', c], label: 'cmd' }
    return { exe, args: (c) => ['-c', c], label: exe.split(/[\\/]/).pop() ?? 'shell' }
  }
  if (isWin) {
    const pwsh = findPwsh()
    if (pwsh) return { exe: pwsh, args: (c) => ['-NoProfile', '-NonInteractive', '-Command', `${PWSH_UTF8}${c}`], label: 'PowerShell 7' }
    // the agent is told, so it writes code to a file rather than losing its quotes
    return { exe: 'powershell.exe', args: (c) => ['-NoProfile', '-NonInteractive', '-Command', `${PS_UTF8}${c}`], label: WIN_PS_51 }
  }
  return { exe: process.env['SHELL'] || '/bin/bash', args: (c) => ['-c', c], label: 'bash' }
}

interface Job {
  id: string
  command: string
  child: ChildProcess
  output: string
  cursor: number
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  /** Who to tell when it ends or a watched line appears. */
  owner: NonNullable<ToolContext['background']> | null
  /** Tell the owner when it finishes. */
  notifyEnd: boolean
  /** Stopped on purpose: no news about its end. */
  killed: boolean
  watchers: Watcher[]
  /** The unfinished last line, for watchers. */
  partial: string
}

interface Watcher {
  pattern: RegExp
  left: number
  hits: string[]
  timer: ReturnType<typeof setTimeout> | null
}

const jobs = new Map<string, Job>()

const tail = (s: string, lines: number): string => s.trimEnd().split('\n').slice(-lines).join('\n')

/** Lines that match a watcher go to its owner, grouped when several arrive within a moment. */
function feedWatchers(job: Job, chunk: string): void {
  if (!job.watchers.length) return
  const text = job.partial + chunk
  const lines = text.split(/\r?\n/)
  job.partial = lines.pop() ?? ''
  for (const line of lines) {
    for (const w of job.watchers) {
      if (w.left <= 0 || !w.pattern.test(line)) continue
      w.left -= 1
      w.hits.push(line.slice(0, 500))
      if (!w.timer) w.timer = setTimeout(() => flushWatcher(job, w), 1500)
    }
  }
}

function flushWatcher(job: Job, w: Watcher): void {
  w.timer = null
  if (!w.hits.length || !job.owner) return
  const hits = w.hits.splice(0)
  const done = w.left <= 0
  job.owner.host.notify(
    { sessionId: job.owner.sessionId, rootSessionId: job.owner.rootSessionId },
    `Job ${job.id} (${job.command.slice(0, 80)}) printed ${hits.length === 1 ? 'a line' : `${hits.length} lines`} matching /${w.pattern.source}/:\n${hits.join('\n')}${done ? '\n(That was the last match it watches for.)' : ''}`,
    { source: 'watch', job: job.id },
    true
  )
  if (done) {
    job.watchers = job.watchers.filter((x) => x !== w)
    job.owner.host.changed(job.owner.rootSessionId)
  }
}

/** For the watch_job tool. */
export function watchJob(id: string, pattern: RegExp, times: number, owner: NonNullable<ToolContext['background']>): { ok: true } | { ok: false; error: string } {
  const job = jobs.get(id)
  if (!job) return { ok: false, error: 'No such job. Jobs come from shell with background=true.' }
  if (job.exitCode !== null || job.endedAt !== null) return { ok: false, error: `Job ${id} has already ended. job_output shows what it printed.` }
  job.owner ??= owner
  job.watchers.push({ pattern, left: times, hits: [], timer: null })
  owner.host.changed(owner.rootSessionId)
  return { ok: true }
}

function appendOut(job: Job, chunk: string): void {
  job.output += chunk
  if (job.output.length > MAX_CAPTURE * 2) {
    const drop = job.output.length - MAX_CAPTURE
    job.output = job.output.slice(drop)
    job.cursor = Math.max(0, job.cursor - drop)
  }
}

/** After a command: put what it changed into the turn's checkpoint and report each file as changed by this call. */
export async function keepChanges(snap: Awaited<ReturnType<typeof snapshotProject>>, ctx: Pick<Parameters<AgentTool['execute']>[1], 'keepBefore' | 'emit' | 'protectedBy' | 'workspace'>): Promise<{ files: string[]; lost: number; blocked: string | null }> {
  if (!snap) return { files: [], lost: 0, blocked: null }
  const r = await snap.changes().catch(() => ({ files: [], lost: 0 }))
  if (!r.files.length) return { files: [], lost: r.lost, blocked: null }
  // a command cannot get round a rule: what it changed in protected files is put back at once
  const guard = ctx.protectedBy ? await ctx.protectedBy(r.files.map((f) => f.path)).catch(() => null) : null
  let blocked: string | null = null
  if (guard) {
    for (const f of r.files.filter((x) => guard.paths.includes(x.path))) {
      if (f.before === null) await ctx.workspace.delete(f.path).catch(() => {})
      else await ctx.workspace.writeRaw(f.path, f.before).catch(() => {})
    }
    r.files = r.files.filter((x) => !guard.paths.includes(x.path))
    blocked = `Blocked by the user's rule: "${guard.rule}". This command changed ${guard.paths.join(', ')}; Prism put ${guard.paths.length === 1 ? 'it' : 'them'} back. Do not look for a way around the rule; if the task needs it, stop and tell the user.`
  }
  if (!r.files.length) return { files: [], lost: r.lost, blocked }
  ctx.keepBefore?.(r.files.map((f) => ({ path: f.path, content: f.before })))
  for (const f of r.files) ctx.emit({ type: 'file-touched', path: f.path, op: 'write' })
  return { files: r.files.map((f) => f.path), lost: r.lost, blocked }
}

export function createShellTools(cfg: ShellConfig): AgentTool[] {
  const shellTool: AgentTool = {
    spec: {
      name: 'shell',
      description:
        'Run a shell command in the workspace and return its output. Use for builds, tests, git, package managers. ' +
        'Set background=true for anything long (a build, a test suite, a deploy, a server): you get a job id at once and are told when it finishes, with its exit code and last lines, even after your turn has ended. ' +
        'Meanwhile read its output with job_output, and use watch_job to be told when a line you care about appears. Avoid interactive commands.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line' },
          cwd: { type: 'string', description: 'Workspace-relative working directory (default ".")' },
          timeout_ms: { type: 'number', description: `Timeout in ms (default ${(cfg.timeoutSec?.() ?? DEFAULT_TIMEOUT / 1000) * 1000}; longer than that only when needed, max ${Math.max(MAX_TIMEOUT, (cfg.timeoutSec?.() ?? 0) * 1000)})` },
          background: { type: 'boolean', description: 'Return immediately with a job id' },
          notify: { type: 'boolean', description: 'Background only: tell you when it finishes (default true)' }
        },
        required: ['command']
      }
    },
    primaryArg: 'command',
    readOnly: false,
    risk: (a) => shellRisk(str(a, 'command')),
    summary: (a) => str(a, 'command').split('\n')[0]?.slice(0, 120) ?? '',
    async execute(args, ctx): Promise<ToolResult> {
      const command = str(args, 'command').trim()
      if (!command) return err('Empty command.')
      const cwdRel = str(args, 'cwd', '.')
      let cwd: string
      try {
        cwd = ctx.workspace.abs(cwdRel)
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
      const userDefault = Math.max(5, cfg.timeoutSec?.() ?? DEFAULT_TIMEOUT / 1000) * 1000
      const timeoutMs = Math.max(1000, Math.min(Math.max(MAX_TIMEOUT, userDefault), Math.floor(num(args, 'timeout_ms', userDefault))))
      const background = bool(args, 'background')
      // what the command changes can be undone like an edit: note the project first (not for long-running jobs)
      const snap = background ? null : await snapshotProject(ctx.workspace).catch(() => null)
      const sh = agentShell(cfg.shell())
      const vars = { PRISM_AGENT: '1', CI: process.env['CI'] ?? '1', FORCE_COLOR: '0', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' }
      // in a WSL or SSH folder the command runs on that side, in bash
      const run = shellCommand(cwd, command, sh, vars)
      const child = spawn(run.file, run.args, { cwd: run.cwd, windowsHide: true, env: { ...process.env, ...vars } })
      const job: Job = { id: randomUUID().slice(0, 8), command, child, output: '', cursor: 0, exitCode: null, startedAt: Date.now(), endedAt: null, owner: background ? (ctx.background ?? null) : null, notifyEnd: background && args['notify'] !== false, killed: false, watchers: [], partial: '' }
      jobs.set(job.id, job)
      child.stdout?.on('data', (d: Buffer) => {
        const s = d.toString('utf8')
        appendOut(job, s)
        feedWatchers(job, s)
        ctx.output(ctx.callId, s)
      })
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString('utf8')
        appendOut(job, s)
        feedWatchers(job, s)
        ctx.output(ctx.callId, s)
      })
      // A command can end while programs it started carry on holding its output (a server or test run
      // left going in the background). Waiting for the output to close then waits for ever, and Stop
      // cannot reach them: the shell they hung from is already gone. So once the shell itself has
      // ended, or been stopped, Prism waits a moment for the last of the output and then lets go.
      let settle: (code: number | null) => void = () => {}
      const done = new Promise<number | null>((resolve) => {
        settle = (code) => {
          if (job.endedAt !== null) return
          job.exitCode = code
          job.endedAt = Date.now()
          resolve(code)
        }
        child.on('error', (e) => {
          appendOut(job, `\n[failed to start: ${e.message}]`)
          settle(-1)
        })
        child.on('close', (code) => settle(code))
        child.on('exit', (code) => {
          setTimeout(() => {
            if (job.endedAt !== null) return
            appendOut(job, '\n[the command ended, but programs it started are still running and holding its output; Prism stopped waiting for them]')
            letGo(code)
          }, 3000)
        })
      })
      const letGo = (code: number | null): void => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        settle(code)
      }
      /** After a kill: if the output still has not closed a few seconds on, stop waiting for it. */
      const giveUpSoon = (): void => {
        setTimeout(() => letGo(null), 5000)
      }
      if (background) {
        void done.then((code) => {
          if (job.partial) feedWatchers(job, '\n')
          for (const w of job.watchers) {
            if (w.timer) clearTimeout(w.timer)
            flushWatcher(job, w)
          }
          job.watchers = []
          const o = job.owner
          if (!o) return
          o.host.changed(o.rootSessionId)
          if (!job.notifyEnd || job.killed || ctx.signal.aborted) return
          const secs = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000)
          o.host.notify(
            { sessionId: o.sessionId, rootSessionId: o.rootSessionId },
            `Background job ${job.id} finished ${code === 0 ? 'successfully' : `with exit code ${code}`} after ${secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`}: ${command.slice(0, 120)}\nLast lines:\n${tail(job.output, 30) || '(no output)'}`,
            { source: 'job', job: job.id, exitCode: code },
            true
          )
        })
        job.owner?.host.changed(job.owner.rootSessionId)
      }
      const onAbort = (): void => {
        try {
          if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
          else child.kill()
        } catch {
          /* gone */
        }
        giveUpSoon()
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      if (background) {
        return {
          content: `Started background job ${job.id} (pid ${child.pid ?? '?'}). ${job.notifyEnd && job.owner ? 'You will be told when it finishes, even after this turn; no need to wait or poll. ' : ''}job_output { id: "${job.id}" } reads its output so far; watch_job tells you when a particular line appears.`,
          isError: false,
          meta: { job: job.id, background: true }
        }
      }

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
          else child.kill()
        } catch {
          /* gone */
        }
        giveUpSoon()
      }, timeoutMs)
      const code = await done
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      const out = job.output.trim()
      const durationMs = Date.now() - job.startedAt
      let content = out ? clipOutput(out, 60_000) : '(no output)'
      if (timedOut) content += `\n\n[timed out after ${Math.round(timeoutMs / 1000)}s and was killed; use background=true for long-running commands]`
      else if (ctx.signal.aborted) content += '\n\n[aborted]'
      else content += `\n\n[exit code ${code ?? 'unknown'}]`
      if (job.exitCode !== null) jobs.delete(job.id)
      const changed = await keepChanges(snap, ctx)
      if (changed.blocked) content += `\n\n[${changed.blocked}]`
      if (changed.files.length) content += `\n[this command changed ${changed.files.length} file${changed.files.length === 1 ? '' : 's'}; Prism kept the earlier versions${changed.lost ? `, except ${changed.lost} too big to keep` : ''}]`
      return { content, isError: timedOut || !!changed.blocked || (code !== 0 && code !== null), meta: { exitCode: code, durationMs, timedOut, ...(changed.files.length ? { changed: changed.files } : {}) } }
    }
  }

  const jobOutput: AgentTool = {
    spec: {
      name: 'job_output',
      description: 'Read new output from a background job started with shell(background=true). Optionally wait up to wait_ms for more output.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, wait_ms: { type: 'number', description: 'Wait for output (max 60000)' } },
        required: ['id']
      }
    },
    primaryArg: 'id',
    readOnly: true,
    risk: () => null,
    summary: (a) => `job output ${str(a, 'id')}`,
    async execute(args) {
      const job = jobs.get(str(args, 'id'))
      if (!job) return err('No such job (it may have finished and been collected).')
      const wait = Math.max(0, Math.min(60_000, Math.floor(num(args, 'wait_ms', 0))))
      if (wait > 0 && job.exitCode === null && job.output.length === job.cursor) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, wait)
          const poll = setInterval(() => {
            if (job.output.length > job.cursor || job.exitCode !== null) {
              clearInterval(poll)
              clearTimeout(t)
              resolve()
            }
          }, 200)
        })
      }
      const fresh = job.output.slice(job.cursor)
      job.cursor = job.output.length
      const status = job.exitCode === null ? 'running' : `exited with code ${job.exitCode}`
      if (job.exitCode !== null) jobs.delete(job.id)
      return { content: `${fresh.trim() || '(no new output)'}\n\n[job ${job.id}: ${status}]`, isError: false, meta: { status } }
    }
  }

  const jobKill: AgentTool = {
    spec: {
      name: 'job_kill',
      description: 'Stop a background job.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    },
    primaryArg: 'id',
    readOnly: false,
    risk: () => null,
    summary: (a) => `stop job ${str(a, 'id')}`,
    async execute(args) {
      const job = jobs.get(str(args, 'id'))
      if (!job) return err('No such job.')
      job.killed = true
      try {
        if (process.platform === 'win32' && job.child.pid) spawn('taskkill', ['/pid', String(job.child.pid), '/t', '/f'], { windowsHide: true })
        else job.child.kill()
      } catch {
        /* gone */
      }
      jobs.delete(job.id)
      job.owner?.host.changed(job.owner.rootSessionId)
      return { content: `Stopped job ${job.id}.`, isError: false }
    }
  }

  return [shellTool, jobOutput, jobKill]
}

export function listJobs(): Array<{ id: string; command: string; running: boolean; exitCode: number | null; startedAt: number; endedAt: number | null; tail: string }> {
  return [...jobs.values()].map((j) => ({ id: j.id, command: j.command, running: j.exitCode === null && j.endedAt === null, exitCode: j.exitCode, startedAt: j.startedAt, endedAt: j.endedAt, tail: j.output.slice(-1500) }))
}

/** Background commands a session started that are still running, for the list in its header. */
export function jobsOf(rootSessionId: string): Array<{ id: string; command: string; startedAt: number; watching: string[] }> {
  return [...jobs.values()]
    .filter((j) => j.owner?.rootSessionId === rootSessionId && j.exitCode === null && j.endedAt === null)
    .map((j) => ({ id: j.id, command: j.command, startedAt: j.startedAt, watching: j.watchers.map((w) => `/${w.pattern.source}/`) }))
}

export function killJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  job.killed = true
  const o = job.owner
  setTimeout(() => o?.host.changed(o.rootSessionId), 200)
  try {
    if (process.platform === 'win32' && job.child.pid) spawn('taskkill', ['/pid', String(job.child.pid), '/t', '/f'], { windowsHide: true })
    else job.child.kill()
  } catch {
    /* gone */
  }
  jobs.delete(id)
  return true
}

export function killAllJobs(): void {
  for (const job of jobs.values()) {
    try {
      job.child.kill()
    } catch {
      /* gone */
    }
  }
  jobs.clear()
}
