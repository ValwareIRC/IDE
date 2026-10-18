import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GitOpResult, ReviewFile, SessionWorktree } from '@shared/types'
import { git, isRepo } from './git'

/**
 * A session's own copy of the project: a git worktree on a fresh branch, kept
 * outside the project folder. The agent works there; the user's files change
 * only when the branch is merged in.
 */

export async function createWorktree(root: string, dir: string, branch: string): Promise<SessionWorktree> {
  if (!(await isRepo(root))) throw new Error('This needs a git repository. Ask the agent to set one up first.')
  const head = await git(root, ['rev-parse', 'HEAD'])
  if (!head.ok) throw new Error('This repository has no commits yet. Make a first commit, then try again.')
  await mkdir(dirname(dir), { recursive: true })
  const r = await git(root, ['worktree', 'add', '-b', branch, dir, 'HEAD'], 120_000)
  if (!r.ok) throw new Error(`Could not make the copy: ${(r.stderr || r.stdout).trim()}`)
  return { path: dir, branch, base: head.stdout.trim() }
}

/** Everything the copy changed since it was made, committed or not, as before/after pairs. */
export async function worktreeChanges(wt: SessionWorktree): Promise<ReviewFile[]> {
  if (!existsSync(wt.path)) return []
  // staging everything makes untracked files show up in the comparison; it changes nothing on disk
  await git(wt.path, ['add', '-A'])
  const r = await git(wt.path, ['diff', '--cached', '--name-status', '-z', wt.base])
  if (!r.ok) return []
  const parts = r.stdout.split('\0').filter(Boolean)
  const out: ReviewFile[] = []
  for (let i = 0; i + 1 < parts.length && out.length < 300; i += 2) {
    const status = parts[i]![0]
    const path = parts[i + 1]!
    let before: string | null = null
    let after: string | null = null
    if (status !== 'A') {
      const b = await git(wt.path, ['show', `${wt.base}:${path}`])
      before = b.ok ? b.stdout : null
    }
    if (status !== 'D') {
      try {
        const buf = await readFile(join(wt.path, path))
        if (buf.includes(0)) continue
        after = buf.toString('utf8')
      } catch {
        after = null
      }
    }
    if (before !== after) out.push({ path, before, after })
  }
  return out
}

/** Commit whatever is uncommitted in the copy, then merge its branch into the project's current branch. */
export async function integrateWorktree(root: string, wt: SessionWorktree, message: string): Promise<GitOpResult> {
  await git(wt.path, ['add', '-A'])
  const dirty = await git(wt.path, ['diff', '--cached', '--quiet'])
  if (!dirty.ok) {
    // git refuses to commit without a name and email; use the user's when set, else Prism's own
    const who = await git(wt.path, ['config', 'user.email'])
    const c = await git(wt.path, [...(who.ok && who.stdout.trim() ? [] : ['-c', 'user.name=Prism', '-c', 'user.email=prism@localhost']), 'commit', '-m', message])
    if (!c.ok) return { ok: false, output: `Could not commit the copy's changes:\n${(c.stdout + '\n' + c.stderr).trim()}` }
  }
  const ahead = await git(root, ['rev-list', '--count', `HEAD..${wt.branch}`])
  if (ahead.ok && ahead.stdout.trim() === '0') return { ok: true, output: 'Nothing to bring in: the copy has no changes.' }
  const me = await git(root, ['config', 'user.email'])
  const m = await git(root, [...(me.ok && me.stdout.trim() ? [] : ['-c', 'user.name=Prism', '-c', 'user.email=prism@localhost']), 'merge', '--no-ff', '--no-edit', wt.branch], 120_000)
  return { ok: m.ok, output: (m.stdout + '\n' + m.stderr).trim() }
}

export async function removeWorktree(root: string, wt: SessionWorktree): Promise<GitOpResult> {
  const r = await git(root, ['worktree', 'remove', '--force', wt.path], 60_000)
  await git(root, ['worktree', 'prune'])
  const b = await git(root, ['branch', '-D', wt.branch])
  return { ok: r.ok || !existsSync(wt.path), output: `${r.stdout}\n${r.stderr}\n${b.stdout}\n${b.stderr}`.trim() }
}
