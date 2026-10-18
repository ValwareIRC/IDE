// Splitting uncommitted work into several commits. The changes are cut into pieces (each hunk of a changed
// file; a new, deleted, renamed or binary file whole), a model groups them, and each group is staged exactly
// (git apply --cached with just its hunks) and committed in order. The files on disk are never touched.
import type { Workspace } from '../fs/workspace'
import { git } from './git'
import type { SplitCommit, SplitPiece } from '@shared/types'

export type { SplitCommit, SplitPiece }

interface FilePatch {
  path: string
  head: string[]
  hunks: string[][]
  whole: boolean
}

function parse(diff: string): FilePatch[] {
  const files: FilePatch[] = []
  let cur: FilePatch | null = null
  let hunk: string[] | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line)
      cur = { path: m?.[1] ?? line, head: [line], hunks: [], whole: false }
      files.push(cur)
      hunk = null
      continue
    }
    if (!cur) continue
    if (line.startsWith('@@')) {
      hunk = [line]
      cur.hunks.push(hunk)
      continue
    }
    if (hunk) hunk.push(line)
    else {
      cur.head.push(line)
      if (/^(new file mode|deleted file mode|rename from|old mode|Binary files|GIT binary patch|similarity index)/.test(line)) cur.whole = true
    }
  }
  // the diff's last line break
  for (const f of files) for (const h of f.hunks) while (h.length > 1 && h[h.length - 1] === '') h.pop()
  return files
}

/** Every uncommitted change, in pieces. */
export async function splitPieces(root: string): Promise<{ pieces: SplitPiece[]; patches: Map<string, { file: FilePatch; hunk: number | null }> }> {
  const d = await git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-U3', '--binary', '--find-renames'])
  if (!d.ok) throw new Error(d.stderr.trim() || 'git diff failed (is there a first commit?)')
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  const pieces: SplitPiece[] = []
  const patches = new Map<string, { file: FilePatch; hunk: number | null }>()
  parse(d.stdout).forEach((f, i) => {
    const count = (lines: string[], c: string): number => lines.filter((l) => l.startsWith(c) && !l.startsWith(c + c + c)).length
    if (f.whole || !f.hunks.length) {
      const id = `f${i}`
      const all = f.hunks.flat()
      pieces.push({ id, path: f.path, kind: 'file', title: f.head.find((l) => /^(new file|deleted file|rename from|Binary)/.test(l)) ?? 'whole file', added: count(all, '+'), removed: count(all, '-'), text: [...f.head, ...all].join('\n').slice(0, 6000) })
      patches.set(id, { file: f, hunk: null })
      return
    }
    f.hunks.forEach((h, j) => {
      const id = `f${i}h${j}`
      pieces.push({ id, path: f.path, kind: 'hunk', title: (h.slice(1).find((l) => /^[+-]\s*\S/.test(l)) ?? '').slice(1).trim().slice(0, 80) || `part ${j + 1}`, added: count(h, '+'), removed: count(h, '-'), text: h.join('\n').slice(0, 6000) })
      patches.set(id, { file: f, hunk: j })
    })
  })
  for (const p of untracked.stdout.split('\0').filter(Boolean)) {
    const id = `n${pieces.length}`
    pieces.push({ id, path: p, kind: 'file', title: 'new file (not tracked yet)', added: 0, removed: 0, text: '' })
    patches.set(id, { file: { path: p, head: [], hunks: [], whole: true }, hunk: null })
  }
  return { pieces, patches }
}

/** Stage and commit each group in order. Stops at the first problem; nothing on disk changes either way. */
export async function applySplit(ws: Workspace, commits: SplitCommit[]): Promise<{ ok: boolean; made: number; output: string }> {
  const root = ws.root
  const { patches } = await splitPieces(root)
  const who = await git(root, ['config', 'user.email'])
  const id = who.stdout.trim() ? [] : ['-c', 'user.name=Prism', '-c', 'user.email=prism@localhost']
  // start from nothing staged, so each commit holds exactly its pieces
  const reset = await git(root, ['reset', '-q'])
  if (!reset.ok) return { ok: false, made: 0, output: reset.stderr }
  const tmp = '.prism-split.patch'
  let made = 0
  const log: string[] = []
  try {
    for (const c of commits) {
      const byFile = new Map<string, { file: FilePatch; hunks: number[]; whole: boolean }>()
      for (const pid of c.pieces) {
        const p = patches.get(pid)
        if (!p) return { ok: false, made, output: `${log.join('\n')}\nThe changes are not as they were when the split was planned (piece ${pid} is gone). Plan it again.`.trim() }
        const e = byFile.get(p.file.path) ?? { file: p.file, hunks: [], whole: false }
        if (p.hunk === null) e.whole = true
        else e.hunks.push(p.hunk)
        byFile.set(p.file.path, e)
      }
      for (const e of byFile.values()) {
        if (e.whole && !e.file.head.length) {
          // a file git does not track yet
          const r = await git(root, ['add', '--', e.file.path])
          if (!r.ok) return { ok: false, made, output: r.stderr }
          continue
        }
        const hunks = e.whole ? e.file.hunks : e.hunks.sort((a, b) => a - b).map((h) => e.file.hunks[h]!)
        await ws.write(tmp, [...e.file.head, ...hunks.flat(), ''].join('\n'))
        const r = await git(root, ['apply', '--cached', '--recount', '--whitespace=nowarn', tmp])
        if (!r.ok) return { ok: false, made, output: `${log.join('\n')}\nCould not stage part of ${e.file.path}: ${r.stderr.trim()}`.trim() }
      }
      const r = await git(root, [...id, 'commit', '-q', '-m', c.message])
      if (!r.ok) return { ok: false, made, output: `${log.join('\n')}\n${(r.stdout + r.stderr).trim()}`.trim() }
      made++
      log.push(`Committed: ${c.message.split('\n')[0]}`)
    }
  } finally {
    await ws.delete(tmp).catch(() => {})
  }
  return { ok: true, made, output: log.join('\n') }
}
