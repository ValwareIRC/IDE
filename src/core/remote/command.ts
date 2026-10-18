// Builds the local process that runs something in a workspace folder, wherever
// that folder lives (see shared/place.ts). A folder on this computer runs the
// program directly; a WSL folder runs it through wsl.exe; an SSH folder through
// the system's ssh client. Callers spawn what they are given and read its
// output as usual, so git, the agent's shell, checks and hooks need not know.
import { exec, spawn } from 'node:child_process'
import { placeOf, remotePath } from '@shared/place'

export interface Spawnable {
  file: string
  args: string[]
  /** Working directory for the local process; unset when the real one is on the other side. */
  cwd?: string
}

/** Quote for a POSIX shell. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Arguments for ssh up to and including the host. The key of a host seen for the first time is accepted and
 * remembered; a host whose key has changed is refused. `interactive` is for a terminal, where ssh may ask things.
 */
export function sshArgs(host: string, interactive = false): string[] {
  const m = /^(.*?)(?::(\d+))?$/.exec(host)!
  return [...(interactive ? ['-t'] : ['-T', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR']), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=30', ...(m[2] ? ['-p', m[2]] : []), m[1]!]
}

/** Run a program with exact arguments (no shell on this side) in `cwd`. */
export function command(cwd: string, argv: string[]): Spawnable {
  const place = placeOf(cwd)
  if (place.kind === 'wsl') return { file: 'wsl.exe', args: ['-d', place.distro, '--cd', remotePath(cwd), '--exec', ...argv] }
  if (place.kind === 'ssh') return { file: 'ssh', args: [...sshArgs(place.host), '--', `cd ${sq(remotePath(cwd))} && ${argv.map(sq).join(' ')}`] }
  return { file: argv[0]!, args: argv.slice(1), cwd }
}

/**
 * Run a command line through a shell in `cwd`. On this computer that is `local` (the user's shell); in WSL and over
 * SSH it is a login bash, so the PATH is the one the user has in their own terminal there. `env` is set on the other side.
 */
export function shellCommand(cwd: string, line: string, local: { exe: string; args: (cmd: string) => string[] }, env: Record<string, string> = {}): Spawnable {
  const place = placeOf(cwd)
  if (place.kind === 'local') return { file: local.exe, args: local.args(line), cwd }
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`)
  if (place.kind === 'wsl') return { file: 'wsl.exe', args: ['-d', place.distro, '--cd', remotePath(cwd), '--exec', 'env', ...vars, 'bash', '-lc', line] }
  return { file: 'ssh', args: [...sshArgs(place.host), '--', `cd ${sq(remotePath(cwd))} && env ${vars.map(sq).join(' ')} bash -lc ${sq(line)}`] }
}

export interface LineResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a command line to the end and collect what it printed. Used for checks and hooks. */
export function runLine(cwd: string, line: string, opts: { timeoutMs: number; env?: Record<string, string>; stdin?: string; maxBuffer?: number }): Promise<LineResult> {
  const max = opts.maxBuffer ?? 16 * 1024 * 1024
  if (placeOf(cwd).kind === 'local') {
    return new Promise((resolve) => {
      const child = exec(line, { cwd, windowsHide: true, timeout: opts.timeoutMs, maxBuffer: max, env: { ...process.env, ...opts.env } }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
      )
      try {
        if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
      } catch {
        /* the command does not read stdin */
      }
    })
  }
  const c = shellCommand(cwd, line, { exe: '', args: () => [] }, opts.env)
  return collect(c, opts.timeoutMs, opts.stdin, max).then((r) => ({ code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr }))
}

/** Spawn and gather output as bytes (files travel this way over SSH). A program that cannot start counts as failed. */
export function collect(c: Spawnable, timeoutMs: number, stdin?: string | Buffer, maxBytes = 64 * 1024 * 1024): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(c.file, c.args, { cwd: c.cwd, windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      size += d.length
      if (size <= maxBytes) chunks.push(d)
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 20_000) stderr += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout: Buffer.concat(chunks), stderr: `${stderr}${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr })
    })
    child.stdin.on('error', () => {})
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}
