import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitBlameLine, GitBranch, GitCommitFile, GitConflict, GitGraphCommit, GitOpResult, GitStash } from '@shared/types'
import { git } from './git'

/** Everything beyond status/stage/commit: branches, remotes, stash, history, blame, conflicts. All plain git commands. */

const US = '\x1f'

function done(r: { ok: boolean; stdout: string; stderr: string }): GitOpResult {
  return { ok: r.ok, output: `${r.stdout}\n${r.stderr}`.trim() }
}

// ---------------------------------------------------------------- branches

export async function branches(cwd: string): Promise<GitBranch[]> {
  const fmt = ['%(refname)', '%(refname:short)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)', '%(committerdate:unix)', '%(contents:subject)'].join(US)
  const r = await git(cwd, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'])
  if (!r.ok) return []
  const out: GitBranch[] = []
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    const [ref, name, head, upstream, track, sha, date, subject] = line.split(US)
    if (!ref || !name || name.endsWith('/HEAD')) continue
    const ahead = /ahead (\d+)/.exec(track ?? '')
    const behind = /behind (\d+)/.exec(track ?? '')
    out.push({
      name,
      remote: ref.startsWith('refs/remotes/'),
      current: head === '*',
      upstream: upstream || null,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      sha: sha ?? '',
      date: Number(date ?? 0) * 1000,
      subject: subject ?? ''
    })
  }
  return out
}

export async function checkout(cwd: string, name: string): Promise<GitOpResult> {
  // a remote branch becomes a local one that follows it
  const local = name.replace(/^[^/]+\//, '')
  const isRemote = (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/${name}`])).ok
  if (isRemote && !(await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${local}`])).ok) return done(await git(cwd, ['checkout', '-b', local, '--track', name]))
  return done(await git(cwd, ['checkout', isRemote ? local : name]))
}

export async function createBranch(cwd: string, name: string, from?: string): Promise<GitOpResult> {
  return done(await git(cwd, ['checkout', '-b', name, ...(from ? [from] : [])]))
}

export async function deleteBranch(cwd: string, name: string, force: boolean): Promise<GitOpResult> {
  return done(await git(cwd, ['branch', force ? '-D' : '-d', name]))
}

export async function mergeBranch(cwd: string, name: string): Promise<GitOpResult> {
  return done(await git(cwd, ['merge', '--no-edit', name], 120_000))
}

// ---------------------------------------------------------------- remotes

export async function fetch(cwd: string): Promise<GitOpResult> {
  return done(await git(cwd, ['fetch', '--all', '--prune'], 120_000))
}

export async function pull(cwd: string): Promise<GitOpResult> {
  return done(await git(cwd, ['pull', '--ff-only'], 180_000))
}

export async function push(cwd: string): Promise<GitOpResult> {
  const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (up.ok) return done(await git(cwd, ['push'], 180_000))
  // first push of a new branch: publish it under the same name
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const remote = (await git(cwd, ['remote'])).stdout.split('\n').filter(Boolean)[0]
  if (!remote) return { ok: false, output: 'This repository has no remote to push to.' }
  return done(await git(cwd, ['push', '-u', remote, branch], 180_000))
}

// ---------------------------------------------------------------- stash

export async function stashList(cwd: string): Promise<GitStash[]> {
  const r = await git(cwd, ['stash', 'list', `--format=%gd${US}%gs${US}%ct`])
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, message, at] = l.split(US)
      return { ref: ref ?? '', message: (message ?? '').replace(/^(WIP on|On) [^:]+:\s*/, ''), date: Number(at ?? 0) * 1000 }
    })
}

export async function stashSave(cwd: string, message: string): Promise<GitOpResult> {
  return done(await git(cwd, ['stash', 'push', '--include-untracked', ...(message.trim() ? ['-m', message.trim()] : [])]))
}

export async function stashApply(cwd: string, ref: string, drop: boolean): Promise<GitOpResult> {
  return done(await git(cwd, ['stash', drop ? 'pop' : 'apply', ref]))
}

export async function stashDrop(cwd: string, ref: string): Promise<GitOpResult> {
  return done(await git(cwd, ['stash', 'drop', ref]))
}

// ---------------------------------------------------------------- history

export async function graph(cwd: string, limit = 300): Promise<GitGraphCommit[]> {
  const fmt = ['%H', '%P', '%an', '%at', '%D', '%s'].join(US)
  const r = await git(cwd, ['log', '--all', '--date-order', `-${Math.min(2000, Math.max(1, limit))}`, `--format=${fmt}`])
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, parents, author, at, refs, subject] = l.split(US)
      return {
        sha: sha ?? '',
        parents: (parents ?? '').split(' ').filter(Boolean),
        author: author ?? '',
        date: Number(at ?? 0) * 1000,
        refs: (refs ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        subject: subject ?? ''
      }
    })
}

export async function commitFiles(cwd: string, sha: string): Promise<GitCommitFile[]> {
  // a merge is shown as what it brought into the branch it was merged into (its first parent)
  const parents = (await git(cwd, ['rev-list', '--parents', '-n', '1', sha])).stdout.trim().split(' ').length - 1
  const r = parents > 1 ? await git(cwd, ['diff-tree', '--name-status', '-r', '-M', `${sha}^1`, sha]) : await git(cwd, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', '-M', sha])
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = l.split('\t')
      const status = (p[0] ?? 'M')[0] as GitCommitFile['status']
      return status === 'R' || status === 'C' ? { status, oldPath: p[1] ?? '', path: p[2] ?? '' } : { status, path: p[1] ?? '' }
    })
}

/** One file before and after a commit. */
export async function commitFileDiff(cwd: string, sha: string, path: string, oldPath?: string): Promise<{ before: string; after: string }> {
  const before = await git(cwd, ['show', `${sha}^:${oldPath ?? path}`])
  const after = await git(cwd, ['show', `${sha}:${path}`])
  return { before: before.ok ? before.stdout : '', after: after.ok ? after.stdout : '' }
}

// ---------------------------------------------------------------- blame

export async function blame(cwd: string, path: string): Promise<GitBlameLine[]> {
  const r = await git(cwd, ['blame', '--line-porcelain', '--', path], 60_000)
  if (!r.ok) return []
  const out: GitBlameLine[] = []
  let cur: Partial<GitBlameLine> = {}
  for (const line of r.stdout.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line)
    if (head) {
      cur = { sha: head[1]!, line: Number(head[2]) }
    } else if (line.startsWith('author ')) cur.author = line.slice(7)
    else if (line.startsWith('author-time ')) cur.date = Number(line.slice(12)) * 1000
    else if (line.startsWith('summary ')) cur.summary = line.slice(8)
    else if (line.startsWith('\t')) {
      out.push({ sha: cur.sha ?? '', line: cur.line ?? out.length + 1, author: cur.author ?? '', date: cur.date ?? 0, summary: cur.summary ?? '' })
    }
  }
  return out
}

// ---------------------------------------------------------------- conflicts

/** What git is in the middle of, if anything. */
export async function operation(cwd: string): Promise<'merge' | 'rebase' | 'cherry-pick' | null> {
  const dir = (await git(cwd, ['rev-parse', '--git-dir'])).stdout.trim()
  if (!dir) return null
  const g = dir.startsWith('/') || /^[A-Za-z]:/.test(dir) ? dir : join(cwd, dir)
  if (existsSync(join(g, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(g, 'rebase-merge')) || existsSync(join(g, 'rebase-apply'))) return 'rebase'
  if (existsSync(join(g, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  return null
}

export async function abortOperation(cwd: string): Promise<GitOpResult> {
  const op = await operation(cwd)
  if (!op) return { ok: false, output: 'Nothing is in progress.' }
  return done(await git(cwd, [op, '--abort']))
}

/** Split a file with conflict markers into the parts both sides agree on and the parts they do not. */
export function parseConflicts(text: string): GitConflict['parts'] {
  const parts: GitConflict['parts'] = []
  const lines = text.split('\n')
  let plain: string[] = []
  let i = 0
  const flush = (): void => {
    if (plain.length) parts.push({ kind: 'text', text: plain.join('\n') })
    plain = []
  }
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith('<<<<<<< ')) {
      const oursLabel = line.slice(8).trim()
      const ours: string[] = []
      const theirs: string[] = []
      let j = i + 1
      let side: 'ours' | 'base' | 'theirs' = 'ours'
      let theirsLabel = ''
      let closed = false
      for (; j < lines.length; j++) {
        const l = lines[j]!
        if (l.startsWith('||||||| ')) side = 'base'
        else if (l === '=======' || l.startsWith('======= ')) side = 'theirs'
        else if (l.startsWith('>>>>>>> ')) {
          theirsLabel = l.slice(8).trim()
          closed = true
          break
        } else if (side === 'ours') ours.push(l)
        else if (side === 'theirs') theirs.push(l)
      }
      if (closed) {
        flush()
        parts.push({ kind: 'conflict', ours: ours.join('\n'), theirs: theirs.join('\n'), oursLabel, theirsLabel })
        i = j + 1
        continue
      }
    }
    plain.push(line)
    i++
  }
  flush()
  return parts
}

export async function conflict(cwd: string, path: string): Promise<GitConflict> {
  const text = await readFile(join(cwd, path), 'utf8')
  return { path, parts: parseConflicts(text.replace(/\r\n/g, '\n')) }
}

/** Write the resolved file and tell git it is settled. */
export async function resolveConflict(cwd: string, path: string, content: string): Promise<GitOpResult> {
  if (/^(<<<<<<< |>>>>>>> )/m.test(content)) return { ok: false, output: 'There are still unresolved parts in this file.' }
  await writeFile(join(cwd, path), content, 'utf8')
  return done(await git(cwd, ['add', '--', path]))
}
