import { execFile } from 'node:child_process'
import { command } from '../remote/command'
import type { GitFile, GitFileStatus, GitLogEntry, GitStatus } from '@shared/types'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

export function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    // a WSL or SSH folder's git is the one on that side
    const c = command(cwd, ['git', ...args])
    execFile(c.file, c.args, { cwd: c.cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') })
    })
  })
}

/** A file as it is in the last commit, raw (for pictures and other binary files). Null when it is not in the commit. */
export function blobAtHead(cwd: string, path: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const c = command(cwd, ['git', 'show', `HEAD:${path.split('\\').join('/')}`])
    execFile(c.file, c.args, { cwd: c.cwd, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => resolve(err ? null : (stdout as Buffer)))
  })
}

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.stdout.trim() === 'true'
}

function statusChar(c: string): GitFileStatus {
  switch (c) {
    case 'M':
    case 'T':
      return 'M'
    case 'A':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    case 'C':
      return 'C'
    case 'U':
      return 'U'
    case '?':
      return '?'
    case '!':
      return '!'
    default:
      return 'M'
  }
}

export async function status(cwd: string): Promise<GitStatus> {
  if (!(await isRepo(cwd))) return { isRepo: false, branch: null, ahead: 0, behind: 0, files: [], head: null }
  const r = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'])
  const files: GitFile[] = []
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  if (r.ok) {
    const parts = r.stdout.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!
      if (!p) continue
      if (p.startsWith('## ')) {
        const m = p.slice(3).match(/^([^.\s]+)(?:\.\.\.\S+)?(?:\s+\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/)
        branch = m?.[1] ?? p.slice(3)
        ahead = Number(m?.[2] ?? 0)
        behind = Number(m?.[3] ?? 0)
        if (branch.startsWith('No commits yet on ')) branch = branch.slice('No commits yet on '.length)
        continue
      }
      const x = p[0] ?? ' '
      const y = p[1] ?? ' '
      const path = p.slice(3)
      const entry: GitFile = {
        path,
        status: x === '?' ? '?' : y !== ' ' ? statusChar(y) : statusChar(x),
        staged: x !== ' ' && x !== '?',
        unstaged: y !== ' ' || x === '?'
      }
      if (x === 'R' || x === 'C') {
        entry.oldPath = parts[i + 1]
        i++
      }
      files.push(entry)
    }
  }
  const headR = await git(cwd, ['log', '-1', '--format=%H%x00%s'])
  const [sha, msg] = headR.ok ? headR.stdout.trim().split('\0') : []
  return { isRepo: true, branch, ahead, behind, files, head: sha ? { sha, message: msg ?? '' } : null }
}

export async function diffFile(cwd: string, path: string, staged: boolean): Promise<{ before: string; after: string }> {
  const beforeRef = staged ? 'HEAD' : ':0'
  const before = await git(cwd, ['show', `${beforeRef}:${path}`])
  let after = ''
  if (staged) {
    const r = await git(cwd, ['show', `:0:${path}`])
    after = r.ok ? r.stdout : ''
  } else {
    const r = await git(cwd, ['show', `:0:${path}`])
    // working tree content is read by the caller for untracked/modified files
    after = r.ok ? r.stdout : ''
  }
  return { before: before.ok ? before.stdout : '', after }
}

export async function stage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length) await git(cwd, ['add', '-A', '--', ...paths])
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length) await git(cwd, ['reset', '-q', 'HEAD', '--', ...paths])
}

export async function discard(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  await git(cwd, ['checkout', '--', ...paths])
  await git(cwd, ['clean', '-f', '--', ...paths])
}

export async function commit(cwd: string, message: string): Promise<{ ok: boolean; output: string }> {
  const r = await git(cwd, ['commit', '-m', message])
  return { ok: r.ok, output: (r.stdout + '\n' + r.stderr).trim() }
}

export async function log(cwd: string, limit = 30): Promise<GitLogEntry[]> {
  const r = await git(cwd, ['log', `-${limit}`, '--format=%H%x00%h%x00%s%x00%an%x00%at'])
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, short, message, author, at] = line.split('\0')
      return { sha: sha ?? '', short: short ?? '', message: message ?? '', author: author ?? '', date: Number(at ?? 0) * 1000 }
    })
}

/** Short summary for the agent's system prompt. */
export async function summary(cwd: string): Promise<string | null> {
  const s = await status(cwd)
  if (!s.isRepo) return null
  const lines = [`branch: ${s.branch ?? '(detached)'}`]
  if (s.head) lines.push(`head: ${s.head.sha.slice(0, 8)} ${s.head.message}`)
  if (s.files.length) {
    lines.push(`changed files (${s.files.length}):`)
    for (const f of s.files.slice(0, 25)) lines.push(`  ${f.status} ${f.path}`)
    if (s.files.length > 25) lines.push(`  … ${s.files.length - 25} more`)
  } else {
    lines.push('working tree clean')
  }
  const recent = await log(cwd, 5)
  if (recent.length) {
    lines.push('recent commits:')
    for (const c of recent) lines.push(`  ${c.short} ${c.message}`)
  }
  return lines.join('\n')
}
