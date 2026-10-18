// The same edit, elsewhere. After the user saves a change, Prism looks for the
// other places in the project that need the same change, and offers them all
// as one change set:
//  1. the same lines (whitespace aside) anywhere else: replaced, keeping each place's indentation;
//  2. the same small change inside a line (an argument added, a name changed): applied wherever that text occurs;
//  3. failing both, the lines elsewhere that use the same names are shown to a quick model, which applies the same
//     kind of change where it fits.
import * as Diff from 'diff'
import type { RefactorPlan, ReviewFile } from '@shared/types'
import type { Workspace } from '../fs/workspace'
import { searchWorkspace } from '../fs/search'
import { ask, firstJson } from '../agent/ask'
import type { ResolvedModel } from '../agent/engine'

const CODE = /\.([cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|vue|svelte|css|scss|html?|sql|c|cc|cpp|h|hpp|swift)$/i
const MAX_CHANGED = 12
const MAX_FILES = 40

interface Piece {
  removed: string[]
  added: string[]
  /** Where the edit was, 0-based line in the new text, so that place is left out. */
  at: number
}

function pieces(before: string, after: string): Piece[] {
  const out: Piece[] = []
  let line = 0
  let cur: Piece | null = null
  for (const part of Diff.diffLines(before, after)) {
    const ls = part.value.replace(/\n$/, '').split('\n')
    if (part.added || part.removed) {
      cur ??= { removed: [], added: [], at: line }
      if (part.removed) cur.removed.push(...ls)
      else {
        cur.added.push(...ls)
        line += ls.length
      }
    } else {
      if (cur) out.push(cur)
      cur = null
      line += ls.length
    }
  }
  if (cur) out.push(cur)
  return out
}

const squeeze = (s: string): string => s.trim().replace(/\s+/g, ' ')
const indentOf = (s: string): string => /^\s*/.exec(s)![0]

/** Where `block` (whitespace aside) appears in `lines`, as start indexes. */
function findBlock(lines: string[], block: string[]): number[] {
  const want = block.map(squeeze)
  if (!want.some((l) => l.length >= 3)) return []
  const out: number[] = []
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < want.length && ok; j++) ok = squeeze(lines[i + j]!) === want[j]
    if (ok) out.push(i)
  }
  return out
}

/** `added`, re-indented from how `removed` was indented to how `found` is. */
function reindent(added: string[], removed: string[], found: string): string[] {
  const from = indentOf(removed[0] ?? '')
  const to = indentOf(found)
  return added.map((l) => (l.startsWith(from) ? to + l.slice(from.length) : l))
}

/** For a change inside one line: the smallest old and new text that differ, widened to whole words. */
function inLine(oldLine: string, newLine: string): { from: string; to: string } | null {
  let a = 0
  while (a < oldLine.length && a < newLine.length && oldLine[a] === newLine[a]) a++
  let b = 0
  while (b < oldLine.length - a && b < newLine.length - a && oldLine[oldLine.length - 1 - b] === newLine[newLine.length - 1 - b]) b++
  // widen to the word (or call) the change sits in, so "foo(a" is matched rather than "a"
  while (a > 0 && /[\w$.]/.test(oldLine[a - 1]!)) a--
  while (b > 0 && /[\w$]/.test(oldLine[oldLine.length - b]!)) b--
  const from = oldLine.slice(a, oldLine.length - b)
  const to = newLine.slice(a, newLine.length - b)
  if (from.trim().length < 3 || !/[A-Za-z_$]/.test(from) || from === to) return null
  return { from, to }
}

export async function sameEditElsewhere(ws: Workspace, path: string, before: string, after: string, model: ResolvedModel | null): Promise<RefactorPlan | null> {
  const ps = pieces(before.replace(/\r\n/g, '\n'), after.replace(/\r\n/g, '\n')).filter((p) => p.removed.length)
  if (!ps.length || ps.reduce((n, p) => n + p.removed.length + p.added.length, 0) > MAX_CHANGED) return null
  const changed = new Map<string, { before: string; lines: string[]; eol: string }>()
  const fileOf = async (p: string): Promise<{ before: string; lines: string[]; eol: string } | null> => {
    if (changed.has(p)) return changed.get(p)!
    try {
      const f = await ws.read(p)
      if (f.binary || f.truncated) return null
      const v = { before: f.content, lines: f.content.split(/\r?\n/), eol: f.content.includes('\r\n') ? '\r\n' : '\n' }
      changed.set(p, v)
      return v
    } catch {
      return null
    }
  }
  let places = 0

  for (const piece of ps) {
    // 1. the same lines elsewhere
    const key = piece.removed.map(squeeze).find((l) => l.length >= 6) ?? ''
    if (key) {
      const hits = await searchWorkspace(ws.root, { query: key.slice(0, 120), regex: false, caseSensitive: true, wholeWord: false, maxResults: 300 }).catch(() => null)
      for (const file of [...new Set((hits?.matches ?? []).map((m) => m.path))].filter((p) => CODE.test(p)).slice(0, MAX_FILES)) {
        const f = await fileOf(file)
        if (!f) continue
        for (const at of findBlock(f.lines, piece.removed).reverse()) {
          if (file === path && at === piece.at) continue
          f.lines.splice(at, piece.removed.length, ...reindent(piece.added, piece.removed, f.lines[at]!))
          places++
        }
      }
    }
    // 2. the same change inside a line
    if (!places && piece.removed.length === 1 && piece.added.length === 1) {
      const span = inLine(piece.removed[0]!, piece.added[0]!)
      if (span) {
        const hits = await searchWorkspace(ws.root, { query: span.from, regex: false, caseSensitive: true, wholeWord: false, maxResults: 300 }).catch(() => null)
        for (const m of (hits?.matches ?? []).filter((x) => CODE.test(x.path)).slice(0, 200)) {
          if (m.path === path && m.line - 1 === piece.at) continue
          const f = await fileOf(m.path)
          if (!f) continue
          const l = f.lines[m.line - 1]
          if (l === undefined || !l.includes(span.from)) continue
          f.lines[m.line - 1] = l.split(span.from).join(span.to)
          places++
        }
      }
    }
  }

  // 3. the same kind of change, judged by a model, on the lines that use the same names
  if (!places && model && ps.length === 1) {
    const piece = ps[0]!
    const names = [...new Set((piece.removed.join(' ').match(/[A-Za-z_$][\w$]{2,}/g) ?? []).filter((w) => !/^(const|let|var|function|return|this|true|false|null|undefined|await|async|import|export|from|new|if|else)$/.test(w)))].slice(0, 4)
    const cands: Array<{ id: number; path: string; line: number; text: string }> = []
    for (const name of names) {
      const hits = await searchWorkspace(ws.root, { query: name, regex: false, caseSensitive: true, wholeWord: true, maxResults: 80 }).catch(() => null)
      for (const m of hits?.matches ?? []) {
        if (!CODE.test(m.path) || (m.path === path && Math.abs(m.line - 1 - piece.at) <= piece.added.length) || cands.some((c) => c.path === m.path && c.line === m.line)) continue
        if (cands.length < 40) cands.push({ id: cands.length, path: m.path, line: m.line, text: m.text })
      }
    }
    if (cands.length) {
      const { text } = await ask(
        model,
        'A programmer just made an edit. Find the other lines that need the same kind of edit, and make it. Only change a line when the same change clearly applies to it; leave the rest out. Keep each line\'s indentation. Reply with JSON only: {"lines":[{"id":<number>,"new":"<the whole new line>"}]}',
        `In ${path} they changed:\n${piece.removed.map((l) => `- ${l}`).join('\n')}\nto:\n${piece.added.map((l) => `+ ${l}`).join('\n')}\n\nCandidate lines elsewhere:\n${cands.map((c) => `${c.id}. ${c.path}:${c.line}: ${c.text}`).join('\n')}`,
        2000
      ).catch(() => ({ text: '' }))
      const r = firstJson<{ lines?: Array<{ id?: number; new?: string }> }>(text)
      for (const x of r?.lines ?? []) {
        const c = cands.find((k) => k.id === x.id)
        if (!c || typeof x.new !== 'string') continue
        const f = await fileOf(c.path)
        if (!f || f.lines[c.line - 1] === undefined || f.lines[c.line - 1] === x.new) continue
        f.lines[c.line - 1] = x.new
        places++
      }
    }
  }

  const files: ReviewFile[] = []
  for (const [p, f] of changed) {
    const next = f.lines.join(f.eol)
    if (next !== f.before) files.push({ path: p, before: f.before, after: next })
  }
  if (!files.length) return null
  return { title: `The same change in ${places} other place${places === 1 ? '' : 's'}`, files, byMeaning: true, note: `You changed ${path}. These places look like they need the same change. Nothing is written until you apply it.` }
}
