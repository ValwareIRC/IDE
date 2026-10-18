import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { IPty } from 'node-pty'
import type { TerminalInfo, TerminalKind } from '@shared/types'
import { placeOf, remotePath } from '@shared/place'
import { sq, sshArgs } from '../remote/command'

export interface TerminalRecord {
  info: TerminalInfo
  pty: IPty
  /** Rolling scrollback so a re-mounted view can repaint. */
  buffer: string
}

const SCROLLBACK_CHARS = 200_000

export function defaultShell(override: string | null): string {
  if (override && override.trim()) return override.trim()
  if (process.platform === 'win32') {
    return process.env['COMSPEC'] && /pwsh|powershell/i.test(process.env['SHELL'] ?? '')
      ? process.env['SHELL']!
      : 'powershell.exe'
  }
  return process.env['SHELL'] || '/bin/bash'
}

export class Terminals {
  private records = new Map<string, TerminalRecord>()
  private dataListeners = new Map<string, Set<(d: string) => void>>()
  private exitListeners = new Map<string, Set<(code: number) => void>>()
  private createdListeners = new Set<(info: TerminalInfo) => void>()

  constructor(private shellOverride: () => string | null) {}

  async create(opts: { cwd: string; kind?: TerminalKind; title?: string; cols?: number; rows?: number; env?: Record<string, string> }): Promise<TerminalInfo> {
    const pty = await import('node-pty')
    const place = placeOf(opts.cwd)
    // a WSL folder gets a WSL shell, an SSH folder a shell on that computer, each starting in the folder
    // the terminal library wants the program's full file name on Windows
    const shell = place.kind === 'wsl' ? 'wsl.exe' : place.kind === 'ssh' ? (process.platform === 'win32' ? 'ssh.exe' : 'ssh') : defaultShell(this.shellOverride())
    const args =
      place.kind === 'wsl'
        ? ['-d', place.distro, '--cd', remotePath(opts.cwd)]
        : place.kind === 'ssh'
          ? [...sshArgs(place.host, true), `cd ${sq(remotePath(opts.cwd))} && exec "${'$'}{SHELL:-sh}" -l`]
          : process.platform === 'win32' && /powershell|pwsh/i.test(shell)
            ? ['-NoLogo']
            : []
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd: place.kind === 'local' ? opts.cwd : undefined,
      env: { ...process.env, ...opts.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PRISM: '1' } as Record<string, string>,
      useConpty: true
    })
    const id = randomUUID()
    const kind = opts.kind ?? 'user'
    const info: TerminalInfo = {
      id,
      title: opts.title ?? (kind === 'agent' ? 'agent' : place.kind === 'wsl' ? place.distro : place.kind === 'ssh' ? place.host : (shell.replace(/\.exe$/i, '').split(/[\\/]/).pop() ?? 'shell')),
      cwd: opts.cwd,
      pid: proc.pid,
      kind,
      shell
    }
    const rec: TerminalRecord = { info, pty: proc, buffer: '' }
    this.records.set(id, rec)
    proc.onData((d) => {
      rec.buffer = (rec.buffer + d).slice(-SCROLLBACK_CHARS)
      for (const l of this.dataListeners.get(id) ?? []) l(d)
    })
    proc.onExit(({ exitCode }) => {
      for (const l of this.exitListeners.get(id) ?? []) l(exitCode)
      this.records.delete(id)
      this.dataListeners.delete(id)
      this.exitListeners.delete(id)
    })
    for (const l of this.createdListeners) l(info)
    return info
  }

  get(id: string): TerminalRecord | null {
    return this.records.get(id) ?? null
  }

  write(id: string, data: string): void {
    this.records.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 1) return
    try {
      this.records.get(id)?.pty.resize(cols, rows)
    } catch {
      /* resizing a dying pty */
    }
  }

  kill(id: string): void {
    const rec = this.records.get(id)
    if (!rec) return
    try {
      rec.pty.kill()
    } catch {
      /* already gone */
    }
    this.records.delete(id)
  }

  list(): TerminalInfo[] {
    return [...this.records.values()].map((r) => r.info)
  }

  onData(id: string, cb: (d: string) => void): () => void {
    let set = this.dataListeners.get(id)
    if (!set) {
      set = new Set()
      this.dataListeners.set(id, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  }

  onExit(id: string, cb: (code: number) => void): () => void {
    let set = this.exitListeners.get(id)
    if (!set) {
      set = new Set()
      this.exitListeners.set(id, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  }

  onCreated(cb: (info: TerminalInfo) => void): () => void {
    this.createdListeners.add(cb)
    return () => this.createdListeners.delete(cb)
  }

  /**
   * The project changed: terminals sitting idle in another folder close, and those with something running (a dev
   * server, a build) stay, their tab saying which project they belong to. Returns whether the list changed.
   */
  async retarget(root: string): Promise<boolean> {
    const away = [...this.records.values()].filter((r) => r.info.kind === 'user' && r.info.cwd !== root)
    if (!away.length) return false
    const busy = await busyShells(away.map((r) => r.info))
    for (const r of away) {
      if (busy.has(r.info.id)) {
        const tag = basename(r.info.cwd.replace(/[\\/]+$/, '')) || r.info.cwd
        if (!r.info.title.endsWith(` · ${tag}`)) r.info = { ...r.info, title: `${r.info.title} · ${tag}` }
      } else this.kill(r.info.id)
    }
    return true
  }

  killAll(): void {
    for (const id of [...this.records.keys()]) this.kill(id)
  }
}

/** Terminals whose shell is running something. A shell in WSL or over SSH counts as busy: its programs cannot be seen from here. */
function busyShells(list: TerminalInfo[]): Promise<Set<string>> {
  const busy = new Set(list.filter((t) => /^(wsl|ssh)(\.exe)?$/i.test(basename(t.shell))).map((t) => t.id))
  const local = list.filter((t) => !busy.has(t.id))
  if (!local.length) return Promise.resolve(busy)
  const parents = (lines: string): Set<number> => new Set(lines.split(/\r?\n/).map((l) => Number.parseInt(l.trim(), 10)).filter((n) => Number.isFinite(n)))
  return new Promise((resolve) => {
    const done = (ppids: Set<number> | null): void => {
      // when it cannot be told, keep them all: closing a running server by mistake is worse than an extra tab
      for (const t of local) if (!ppids || ppids.has(t.pid)) busy.add(t.id)
      resolve(busy)
    }
    if (process.platform === 'win32') {
      // the console host belongs to every shell; anything else under it is a program the user started
      const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${local.map((t) => t.pid).join(' OR ParentProcessId=')}" | Where-Object { $_.Name -notmatch '^(conhost|OpenConsole)\\.exe$' } | ForEach-Object { $_.ParentProcessId }`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (err, out) => done(err ? null : parents(String(out))))
    } else execFile('ps', ['-A', '-o', 'ppid='], { timeout: 10_000 }, (err, out) => done(err ? null : parents(String(out))))
  })
}
