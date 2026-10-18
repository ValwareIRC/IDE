// Search across every conversation in the project, with filters: which part (your messages, answers, steps,
// thinking), errors only, conversations that changed a file, when, how they ended (proven or not), and model.
import type { ModelRef, TranscriptItem } from '@shared/types'
import { findAll, partsOf, snippetOf, terms, type ConvHit, type ConvQuery } from '@shared/convSearch'
import type { Repo } from '../store/repo'

const DAY = 86_400_000

function sinceOf(s: ConvQuery['since']): number | null {
  if (s === 'any') return null
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return s === 'today' ? midnight : s === 'week' ? Date.now() - 7 * DAY : Date.now() - 30 * DAY
}

const modelName = (m: unknown): string => {
  if (!m) return ''
  if (typeof m === 'string') {
    try {
      return modelName(JSON.parse(m))
    } catch {
      return m
    }
  }
  return (m as ModelRef).modelId ?? ''
}

export function searchConversations(repo: Repo, workspace: string, q: ConvQuery): { hits: ConvHit[]; more: boolean } {
  const ts = terms(q.text)
  if (!ts.length && !q.errorsOnly && !q.file.trim()) return { hits: [], more: false }

  let sessions: string[] | null = q.file.trim() ? repo.sessionsChanging(workspace, q.file.trim()) : null
  if (q.outcome !== 'any') {
    // a conversation's outcome is its latest proof result
    const last = new Map<string, boolean>()
    for (const r of repo.verdictRows(workspace)) {
      const it = JSON.parse(r.data) as TranscriptItem
      if (it.kind === 'system' && Array.isArray(it.meta?.['verdict'])) last.set(r.session_id, (it.meta!['verdict'] as Array<{ ok: boolean }>).every((c) => c.ok))
    }
    const want = [...last].filter(([, ok]) => ok === (q.outcome === 'proven')).map(([id]) => id)
    sessions = sessions ? sessions.filter((id) => want.includes(id)) : want
  }

  // words with quotes, backslashes or line breaks are stored escaped, so only the others narrow the first pass
  const rough = ts.filter((t) => !/["\\\n\t]/.test(t))
  const rows = repo.searchItemRows(workspace, rough, sinceOf(q.since), sessions)
  const model = q.model.trim().toLowerCase()
  const hits: ConvHit[] = []
  let more = false
  for (const r of rows) {
    const it = JSON.parse(r.data) as TranscriptItem
    const itemModel = it.kind === 'assistant' ? modelName(it.model) : modelName(r.model)
    if (model && !itemModel.toLowerCase().includes(model)) continue
    for (const p of partsOf(it)) {
      if (q.where.length && !q.where.includes(p.part)) continue
      if (q.errorsOnly && !p.error) continue
      const marks = ts.length ? findAll(p.text.toLowerCase(), ts) : []
      if (!marks) continue
      const s = snippetOf(p.text, marks)
      hits.push({ sessionId: r.session_id, sessionTitle: r.title, itemId: it.id, part: p.part, label: p.label, ts: it.ts, snippet: s.snippet, marks: s.marks, model: itemModel || null })
      if (hits.length >= 400) {
        more = true
        break
      }
    }
    if (more) break
  }
  return { hits, more }
}
