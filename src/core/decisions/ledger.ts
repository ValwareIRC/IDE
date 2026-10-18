// The decisions ledger: every question the agent asked the user, and the answer, kept in
// the project (.prism/decisions.jsonl) so the user can look back at what was decided and
// why, and so any agent reviewing the work later can see the choices it was built on.
//
// Three kinds: a question with options (answered by picking, kept by Prism itself), a
// question asked in words in a reply, and a decision reached some other way. The last
// two are written by the agent: only the one reading the user's reply can tell whether
// it answers the question, so Prism does not guess at it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface Decision {
  id: string
  at: number
  kind: 'choice' | 'words' | 'recorded'
  question: string
  /** What was offered, for a question with options. */
  options?: string[]
  answer: string
  /** Why, when it is known: the agent's deciding factors, or the user's own words. */
  why?: string
  session?: { id: string; title: string }
  /** Who decided, for a decision the agent recorded itself. */
  by?: 'user' | 'agent'
  /** Set in the Decisions panel when the user no longer stands by it; kept rather than deleted. */
  changed?: { at: number; note?: string }
}

export const LEDGER = '.prism/decisions.jsonl'

export function record(root: string, d: Omit<Decision, 'id' | 'at'> & { at?: number }): Decision {
  const entry: Decision = { id: randomUUID().slice(0, 8), at: d.at ?? Date.now(), ...d }
  if (!entry.question.trim() || !entry.answer.trim()) return entry
  mkdirSync(join(root, '.prism'), { recursive: true })
  appendFileSync(join(root, LEDGER), JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

export function readLedger(root: string): Decision[] {
  const file = join(root, LEDGER)
  if (!existsSync(file)) return []
  const out: Decision[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Decision)
    } catch {
      /* a half-written line */
    }
  }
  return out
}
