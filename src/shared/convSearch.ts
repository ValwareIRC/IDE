// Searching conversations: the same rules for the find bar inside one conversation and for the search across
// every conversation in the project. A query is words and "quoted phrases"; a part of a message matches when it
// holds all of them, in any case.
import type { TranscriptItem } from './types'

/** Which part of a conversation a match is in. */
export type ConvPart = 'you' | 'answers' | 'steps' | 'thinking' | 'notes'

export interface ConvQuery {
  text: string
  /** Empty: every part. */
  where: ConvPart[]
  /** Only failed steps, errors and failed checks. */
  errorsOnly: boolean
  /** Only conversations that changed a file whose path contains this. */
  file: string
  since: 'any' | 'today' | 'week' | 'month'
  outcome: 'any' | 'proven' | 'not-proven'
  /** Part of a model's name; empty for any. */
  model: string
}

export const EMPTY_QUERY: ConvQuery = { text: '', where: [], errorsOnly: false, file: '', since: 'any', outcome: 'any', model: '' }

export interface ConvHit {
  sessionId: string
  sessionTitle: string
  itemId: string
  part: ConvPart
  /** What the matching thing was, in a few words ("ran npm test", "your message"). */
  label: string
  ts: number
  snippet: string
  /** [start, length] of each match inside the snippet. */
  marks: Array<[number, number]>
  model: string | null
}

export function terms(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const t = (m[1] ?? m[2] ?? '').trim().toLowerCase()
    if (t) out.push(t)
  }
  return out
}

/** The searchable parts of one item: its words, which part they belong to, and a short label. */
export function partsOf(it: TranscriptItem): Array<{ part: ConvPart; text: string; label: string; error: boolean }> {
  switch (it.kind) {
    case 'user':
      return [{ part: 'you', text: it.text, label: 'your message', error: false }]
    case 'assistant': {
      const out: Array<{ part: ConvPart; text: string; label: string; error: boolean }> = []
      if (it.text.trim()) out.push({ part: 'answers', text: it.text, label: it.toolCalls.length ? 'said while working' : 'answer', error: false })
      if (it.reasoning?.trim()) out.push({ part: 'thinking', text: it.reasoning, label: 'thinking', error: false })
      return out
    }
    case 'tool': {
      const exit = typeof it.meta?.['exitCode'] === 'number' ? (it.meta['exitCode'] as number) : 0
      const a = it.args
      const pick = (...keys: string[]): string | undefined => keys.map((k) => a[k]).find((v): v is string => typeof v === 'string' && !!v.trim())
      const arg = pick('path', 'command', 'pattern', 'query', 'url', 'symbol', 'name', 'assumption') ?? (Object.values(a).find((v) => typeof v === 'string') as string | undefined)
      const label = `${it.name.replace(/_/g, ' ')}${arg ? ` ${arg.split('\n')[0]!.slice(0, 60)}` : ''}`
      const argText = Object.values(a)
        .filter((v): v is string => typeof v === 'string')
        .join('\n')
        .slice(0, 6000)
      const text = `${argText}\n${it.content.slice(0, 20_000)}${it.diff?.after ? `\n${it.diff.after.slice(0, 20_000)}` : ''}`
      return [{ part: 'steps', text, label, error: it.isError || exit !== 0 }]
    }
    case 'system': {
      const verdict = Array.isArray(it.meta?.['verdict']) ? (it.meta!['verdict'] as Array<{ ok: boolean }>) : null
      const label = verdict ? 'checks' : it.subkind === 'opinion' ? 'review' : it.subkind === 'notice' ? 'news' : it.subkind
      return [{ part: 'notes', text: it.text, label, error: it.subkind === 'error' || (verdict ? verdict.some((c) => !c.ok) : false) }]
    }
  }
}

/** Where each term falls in `text` (lower-cased already), or null when one is missing. */
export function findAll(lower: string, ts: string[]): Array<[number, number]> | null {
  const marks: Array<[number, number]> = []
  for (const t of ts) {
    let at = lower.indexOf(t)
    if (at < 0) return null
    while (at >= 0 && marks.length < 400) {
      marks.push([at, t.length])
      at = lower.indexOf(t, at + t.length)
    }
  }
  return marks.sort((a, b) => a[0] - b[0])
}

/** A short piece of text around the first match, with the matches inside it. */
export function snippetOf(text: string, marks: Array<[number, number]>, width = 220): { snippet: string; marks: Array<[number, number]> } {
  const flat = text.replace(/\s+/g, ' ')
  // whitespace is collapsed, so the first match is found again in the flattened text
  const first = marks[0]
  if (!first) return { snippet: flat.slice(0, width), marks: [] }
  const word = text.slice(first[0], first[0] + first[1]).replace(/\s+/g, ' ').toLowerCase()
  const lower = flat.toLowerCase()
  const at = Math.max(0, lower.indexOf(word))
  const start = Math.max(0, at - Math.floor(width / 3))
  const end = Math.min(flat.length, start + width)
  const snippet = (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '')
  const words = [...new Set(marks.map(([s, l]) => text.slice(s, s + l).replace(/\s+/g, ' ').toLowerCase()))]
  const out: Array<[number, number]> = []
  const sl = snippet.toLowerCase()
  for (const w of words) {
    for (let i = sl.indexOf(w); i >= 0; i = sl.indexOf(w, i + w.length)) out.push([i, w.length])
  }
  return { snippet, marks: out.sort((a, b) => a[0] - b[0]) }
}

/** Matches inside one conversation, in order. */
export function matchItems(items: TranscriptItem[], q: Pick<ConvQuery, 'text' | 'where' | 'errorsOnly'>): Array<{ itemId: string; part: ConvPart; count: number }> {
  const ts = terms(q.text)
  if (!ts.length && !q.errorsOnly) return []
  const out: Array<{ itemId: string; part: ConvPart; count: number }> = []
  for (const it of items) {
    for (const p of partsOf(it)) {
      if (q.where.length && !q.where.includes(p.part)) continue
      if (q.errorsOnly && !p.error) continue
      const marks = ts.length ? findAll(p.text.toLowerCase(), ts) : []
      if (marks) out.push({ itemId: it.id, part: p.part, count: Math.max(1, marks.length) })
    }
  }
  return out
}
