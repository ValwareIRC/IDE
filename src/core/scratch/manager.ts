// The scratchpad's sessions. A session is a name (the notebook's, or one per
// agent session) with up to two long-lived helper processes: one for JavaScript
// and TypeScript cells, one for Python cells. Cells of a process run one after
// another, and what a cell defines stays for the next until the session is stopped.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScratchLang, ScratchOutput, ScratchStatus } from '@shared/types'
import { prepareCell } from './transform'
import { placeOf } from '@shared/place'

const PY_MARK = '\x1ePRISM '
// Electron-as-Node prints these on every start; they are not the cell's output.
const NOISE = /crashpad|registration_protocol_win|DevTools listening/i

interface Job {
  cell: string
  code: string
  onOutput: (o: ScratchOutput) => void
  resolve: (r: { ok: boolean; ms: number }) => void
}

interface Proc {
  kind: 'node' | 'python'
  child: ChildProcess
  ready: Promise<string>
  queue: Job[]
  running: Job | null
  started: number
  /** When it last ran something, for ending forgotten agent sessions. */
  used: number
  dead: boolean
}

export interface ScratchDeps {
  userData: string
  /** The Electron program, run as plain Node for JavaScript cells. */
  nodeExe: string
  runtimeJs: string
  runtimePy: string
}

export class ScratchManager {
  private procs = new Map<string, Proc>()
  private jsPath: string
  private pyPath: string
  private python = new Map<string, Promise<{ cmd: string; args: string[] } | null>>()
  private pyVersion: string | null = null

  constructor(private deps: ScratchDeps) {
    this.jsPath = join(deps.userData, 'scratch-runtime.mjs')
    this.pyPath = join(deps.userData, 'scratch-runtime.py')
    writeFileSync(this.jsPath, deps.runtimeJs, 'utf8')
    writeFileSync(this.pyPath, deps.runtimePy, 'utf8')
    // the notebook's own session lasts until the user ends it; an agent's is tidied away after 20 idle minutes
    setInterval(() => {
      for (const [key, proc] of [...this.procs]) {
        if (!key.startsWith('agent:') || proc.running || proc.queue.length || Date.now() - proc.used < 20 * 60_000) continue
        this.procs.delete(key)
        proc.child.kill()
      }
    }, 5 * 60_000).unref()
  }

  /** The project's own environment first, then whatever Python the computer has. */
  private findPython(root: string): Promise<{ cmd: string; args: string[] } | null> {
    let p = this.python.get(root)
    if (p) return p
    p = (async () => {
      for (const rel of ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe', '.venv/bin/python', 'venv/bin/python']) {
        if (existsSync(join(root, rel))) return { cmd: join(root, rel), args: [] }
      }
      const works = (cmd: string, args: string[]): Promise<boolean> => new Promise((resolve) => execFile(cmd, [...args, '--version'], { timeout: 6000, windowsHide: true }, (err, out, errOut) => resolve(!err && /Python 3/.test(`${out}${errOut}`))))
      for (const [cmd, args] of [['python', []], ['python3', []], ['py', ['-3']]] as Array<[string, string[]]>) if (await works(cmd, args)) return { cmd, args }
      // installed, but not on the PATH: the usual per-user and per-machine places on Windows
      const homes = [join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Python'), 'C:\\', join(process.env['ProgramFiles'] ?? 'C:\\Program Files')]
      for (const home of homes) {
        try {
          const dirs = readdirSync(home)
            .filter((n) => /^Python3\d+$/i.test(n))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          for (const d of dirs) if (existsSync(join(home, d, 'python.exe'))) return { cmd: join(home, d, 'python.exe'), args: [] }
        } catch {
          /* that folder does not exist */
        }
      }
      return null
    })()
    this.python.set(root, p)
    return p
  }

  private async start(key: string, kind: 'node' | 'python', root: string): Promise<Proc> {
    let child: ChildProcess
    if (kind === 'node') {
      child = spawn(this.deps.nodeExe, [this.jsPath, root], { cwd: root, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    } else {
      const py = await this.findPython(root)
      if (!py) throw new Error('Python was not found on this computer. Install Python 3, or make a virtual environment in the project (a .venv folder), then run the cell again.')
      child = spawn(py.cmd, [...py.args, '-u', '-X', 'utf8', this.pyPath, root], { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] })
    }
    let markReady!: (v: string) => void
    let failReady!: (e: Error) => void
    const ready = new Promise<string>((res, rej) => {
      markReady = res
      failReady = rej
    })
    ready.catch(() => {})
    const proc: Proc = { kind, child, ready, queue: [], running: null, started: 0, used: Date.now(), dead: false }
    const text = (kindOf: 'text' | 'stderr', s: string): void => {
      if (s && !NOISE.test(s)) proc.running?.onOutput({ kind: kindOf, text: s })
    }
    const onMessage = (m: { type?: string; output?: ScratchOutput; ok?: boolean; ms?: number; version?: string }): void => {
      if (m.type === 'ready') {
        if (kind === 'python') this.pyVersion = m.version ?? null
        markReady(m.version ?? '')
      } else if (m.type === 'output' && m.output) proc.running?.onOutput(m.output)
      else if (m.type === 'done') {
        const job = proc.running
        proc.running = null
        job?.resolve({ ok: m.ok !== false, ms: m.ms ?? Date.now() - proc.started })
        this.next(proc)
      }
    }
    if (kind === 'node') {
      child.on('message', onMessage)
      child.stdout?.on('data', (d: Buffer) => text('text', d.toString('utf8')))
    } else {
      let buf = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (d: string) => {
        buf += d
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (line.startsWith(PY_MARK)) {
            try {
              onMessage(JSON.parse(line.slice(PY_MARK.length)))
            } catch {
              /* not ours after all */
            }
          } else text('text', `${line}\n`)
        }
      })
    }
    child.stderr?.on('data', (d: Buffer) => text('stderr', d.toString('utf8')))
    child.on('error', (e) => failReady(e))
    child.on('exit', () => {
      proc.dead = true
      failReady(new Error('The helper program stopped before it was ready.'))
      if (this.procs.get(key) === proc) this.procs.delete(key)
      const lost = [proc.running, ...proc.queue].filter((j): j is Job => !!j)
      proc.running = null
      proc.queue = []
      for (const j of lost) {
        j.onOutput({ kind: 'stderr', text: 'Stopped. What earlier cells defined is gone; run them again.\n' })
        j.resolve({ ok: false, ms: 0 })
      }
    })
    this.procs.set(key, proc)
    return proc
  }

  private next(proc: Proc): void {
    if (proc.running || proc.dead) return
    const job = proc.queue.shift()
    if (!job) return
    proc.running = job
    proc.started = Date.now()
    proc.used = proc.started
    void proc.ready.then(
      () => {
        if (proc.kind === 'node') proc.child.send({ type: 'run', cell: job.cell, code: job.code })
        else proc.child.stdin?.write(`${JSON.stringify({ code: job.code })}\n`)
      },
      (e: Error) => {
        proc.running = null
        job.onOutput({ kind: 'error', text: e.message })
        job.resolve({ ok: false, ms: 0 })
      }
    )
  }

  /** Run one cell. Outputs arrive through onOutput as they happen; the promise settles when the cell has finished. */
  async run(session: string, root: string, cell: string, lang: ScratchLang, source: string, onOutput: (o: ScratchOutput) => void): Promise<{ ok: boolean; ms: number }> {
    const kind = lang === 'python' ? 'python' : 'node'
    if (placeOf(root).kind === 'ssh') {
      onOutput({ kind: 'error', text: 'The scratchpad runs on this computer, so it cannot run code in a folder on another computer yet. Use the terminal there instead.' })
      return { ok: false, ms: 0 }
    }
    let code = source
    if (kind === 'node') {
      try {
        code = prepareCell(source, lang === 'ts' ? 'ts' : 'js')
      } catch (e) {
        onOutput({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
        return { ok: false, ms: 0 }
      }
    }
    const key = `${session}\n${kind}\n${root}`
    let proc = this.procs.get(key)
    if (!proc || proc.dead) {
      try {
        proc = await this.start(key, kind, root)
      } catch (e) {
        onOutput({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
        return { ok: false, ms: 0 }
      }
    }
    const p = proc
    return new Promise((resolve) => {
      p.queue.push({ cell, code, onOutput, resolve })
      this.next(p)
    })
  }

  /** End a session's helper programs: whatever is running stops, and everything the cells defined is forgotten. */
  stop(session: string): void {
    for (const [key, proc] of [...this.procs]) {
      if (!key.startsWith(`${session}\n`)) continue
      this.procs.delete(key)
      try {
        proc.child.kill()
      } catch {
        /* already gone */
      }
    }
  }

  busy(session: string): boolean {
    return [...this.procs].some(([key, p]) => key.startsWith(`${session}\n`) && (p.running !== null || p.queue.length > 0))
  }

  async status(root: string | null): Promise<ScratchStatus> {
    const py = root ? await this.findPython(root) : null
    return { node: process.versions.node, python: py ? { path: py.cmd, version: this.pyVersion } : null }
  }

  dispose(): void {
    for (const [, proc] of this.procs) {
      try {
        proc.child.kill()
      } catch {
        /* already gone */
      }
    }
    this.procs.clear()
  }
}
