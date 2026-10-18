// What a shell command changed. Before a command runs, the project's state is
// noted; afterwards the files that differ are listed with their old content, so
// a command's changes can be undone like the agent's own edits.
//
// In a git repository the state is a git tree built with a throwaway index
// (a copy of the real one, so unchanged files are not hashed again). It holds
// tracked and untracked files and skips what .gitignore skips. Elsewhere, on
// this computer only, file sizes and times are noted and small files are kept
// in memory.
import { spawn } from 'node:child_process'
import { copyFile, readFile, rm, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { placeOf } from '@shared/place'
import { collect, command } from '../remote/command'
import type { Workspace } from '../fs/workspace'

const KEEP_FILE = 1024 * 1024
const KEEP_TOTAL = 48 * 1024 * 1024
/** Untracked files above this, in total, are left out of a git snapshot rather than copied into the repository's store. */
const UNTRACKED_LIMIT = 200 * 1024 * 1024

export interface Changed {
  path: string
  /** Null: the file did not exist before. */
  before: Buffer | null
}

export interface Snapshot {
  /** The files that changed since the snapshot, with their earlier content, and how many changed that could not be kept. */
  changes(): Promise<{ files: Changed[]; lost: number }>
}

async function git(root: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<{ code: number; out: Buffer; err: string }> {
  const place = placeOf(root)
  if (place.kind === 'local') {
    return new Promise((resolve) => {
      const child = spawn('git', args, { cwd: root, windowsHide: true, env: { ...process.env, ...env } })
      const chunks: Buffer[] = []
      let err = ''
      child.stdout.on('data', (d: Buffer) => chunks.push(d))
      child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
      child.on('error', (e) => resolve({ code: 127, out: Buffer.alloc(0), err: e.message }))
      child.on('close', (code) => resolve({ code: code ?? 1, out: Buffer.concat(chunks), err }))
      child.stdin.on('error', () => {})
      child.stdin.end(input ?? '')
    })
  }
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`)
  const r = await collect(command(root, vars.length ? ['env', ...vars, 'git', ...args] : ['git', ...args]), 120_000, input)
  return { code: r.code, out: r.stdout, err: r.stderr }
}

async function gitTree(root: string): Promise<string | null> {
  const dir = await git(root, ['rev-parse', '--absolute-git-dir'])
  if (dir.code !== 0) return null
  const gitDir = dir.out.toString('utf8').trim()
  const local = placeOf(root).kind === 'local'
  const index = local ? join(gitDir, `prism-snapshot-${process.pid}`) : posix.join(gitDir, `prism-snapshot-${process.pid}`)
  try {
    if (local) await copyFile(join(gitDir, 'index'), index).catch(() => {})
    else await collect(command(root, ['cp', posix.join(gitDir, 'index'), index]), 20_000)
    const env = { GIT_INDEX_FILE: index }
    // untracked files are taken in too, unless there are so many big ones that copying them would bloat the repository
    const untracked = await git(root, ['ls-files', '-o', '--exclude-standard', '-z'])
    let size = 0
    if (local) {
      for (const p of untracked.out.toString('utf8').split('\0').filter(Boolean).slice(0, 20_000)) {
        size += (await stat(join(root, p)).catch(() => null))?.size ?? 0
        if (size > UNTRACKED_LIMIT) break
      }
    }
    const add = await git(root, ['add', size > UNTRACKED_LIMIT ? '-u' : '-A', '--', '.'], env)
    if (add.code !== 0) return null
    const tree = await git(root, ['write-tree'], env)
    return tree.code === 0 ? tree.out.toString('utf8').trim() : null
  } finally {
    if (local) await rm(index, { force: true }).catch(() => {})
    else await collect(command(root, ['rm', '-f', index]), 20_000).catch(() => null)
  }
}

async function gitSnapshot(root: string): Promise<Snapshot | null> {
  const before = await gitTree(root)
  if (!before) return null
  return {
    async changes() {
      const after = await gitTree(root)
      if (!after || after === before) return { files: [], lost: 0 }
      const diff = await git(root, ['diff-tree', '-r', '--no-renames', '-z', '--name-status', before, after])
      const parts = diff.out.toString('utf8').split('\0').filter(Boolean)
      const files: Changed[] = []
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = parts[i]!
        const path = parts[i + 1]!
        if (status === 'A') files.push({ path, before: null })
        else {
          const blob = await git(root, ['cat-file', 'blob', `${before}:${path}`])
          files.push({ path, before: blob.code === 0 ? blob.out : null })
        }
      }
      return { files, lost: 0 }
    }
  }
}

async function plainSnapshot(ws: Workspace): Promise<Snapshot> {
  const seen = new Map<string, { size: number; mtime: number; content: Buffer | null }>()
  let kept = 0
  for (const p of await ws.walk(20_000)) {
    const st = await stat(join(ws.root, p)).catch(() => null)
    if (!st?.isFile()) continue
    let content: Buffer | null = null
    if (st.size <= KEEP_FILE && kept + st.size <= KEEP_TOTAL) {
      content = await readFile(join(ws.root, p)).catch(() => null)
      if (content) kept += content.length
    }
    seen.set(p, { size: st.size, mtime: st.mtimeMs, content })
  }
  return {
    async changes() {
      const files: Changed[] = []
      let lost = 0
      const now = new Set<string>()
      for (const p of await ws.walk(20_000)) {
        now.add(p)
        const st = await stat(join(ws.root, p)).catch(() => null)
        if (!st?.isFile()) continue
        const was = seen.get(p)
        if (!was) files.push({ path: p, before: null })
        else if (was.size !== st.size || was.mtime !== st.mtimeMs) {
          if (was.content) files.push({ path: p, before: was.content })
          else lost++
        }
      }
      for (const [p, was] of seen) {
        if (now.has(p)) continue
        if (was.content) files.push({ path: p, before: was.content })
        else lost++
      }
      return { files, lost }
    }
  }
}

/** Note the project's state now. Null when it cannot be done here (a folder elsewhere that is not a git repository). */
export async function snapshotProject(ws: Workspace): Promise<Snapshot | null> {
  const viaGit = await gitSnapshot(ws.root).catch(() => null)
  if (viaGit) return viaGit
  if (placeOf(ws.root).kind !== 'local') return null
  return plainSnapshot(ws)
}
