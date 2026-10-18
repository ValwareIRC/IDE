import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContextReport, SessionExtras, TranscriptItem } from '@shared/types'
import type { Workspace } from '../fs/workspace'
import { estimateJsonTokens, estimateTokens } from '../tokens'
import { INSTRUCTION_FILES } from './prompt'

const PIN_FILE_CHARS = 24_000
const PIN_TOTAL_CHARS = 80_000

/** Current content of a session's pinned files, capped so pins cannot crowd out the conversation. */
export async function readPins(ws: Workspace, pins: string[]): Promise<Array<{ path: string; content: string; truncated: boolean }>> {
  const out: Array<{ path: string; content: string; truncated: boolean }> = []
  let total = 0
  for (const p of pins) {
    if (total >= PIN_TOTAL_CHARS) break
    try {
      const f = await ws.read(p)
      if (f.binary) continue
      const room = Math.min(PIN_FILE_CHARS, PIN_TOTAL_CHARS - total)
      out.push({ path: p, content: f.content.slice(0, room), truncated: f.content.length > room })
      total += Math.min(f.content.length, room)
    } catch {
      /* a pinned file that was deleted is simply skipped */
    }
  }
  return out
}

function label(it: TranscriptItem): string {
  switch (it.kind) {
    case 'user':
      return it.text.replace(/\s+/g, ' ').slice(0, 90)
    case 'assistant':
      return (it.text || (it.toolCalls.length ? `asks for ${it.toolCalls.map((c) => c.name).join(', ')}` : 'thinking')).replace(/\s+/g, ' ').slice(0, 90)
    case 'tool': {
      const first = Object.values(it.args ?? {}).find((v) => typeof v === 'string') as string | undefined
      return `${it.name}${first ? ` · ${first.replace(/\s+/g, ' ').slice(0, 60)}` : ''}`
    }
    case 'system':
      return it.subkind === 'compaction' ? 'Summary of the earlier conversation' : it.text.replace(/\s+/g, ' ').slice(0, 90)
  }
}

/** What the model would be sent for this session right now, measured part by part. Estimates, not billing figures. */
export async function contextReport(args: {
  workspace: Workspace
  items: TranscriptItem[]
  extras: SessionExtras
  system: string
  toolSpecs: unknown
  window: number | null
  /** The skills part of the system text, and what it is made of. */
  skills?: { text: string; list: ContextReport['skills'] }
}): Promise<ContextReport> {
  const { workspace, items, extras, system } = args
  const notes: ContextReport['notes'] = []
  let notesTokens = 0
  for (const f of INSTRUCTION_FILES) {
    try {
      const text = await readFile(join(workspace.root, f), 'utf8')
      if (!text.trim()) continue
      const tokens = estimateTokens(text.slice(0, 24_000))
      notes.push({ path: f, tokens })
      notesTokens += tokens
    } catch {
      /* absent */
    }
  }
  const pins = await readPins(workspace, extras.pins)
  const pinRows = pins.map((p) => ({ path: p.path, tokens: estimateTokens(p.content), truncated: p.truncated }))
  const pinTokens = pinRows.reduce((n, p) => n + p.tokens, 0)
  const extraTokens = estimateTokens(extras.instructions)
  const skillTokens = estimateTokens(args.skills?.text ?? '')
  const toolsTokens = estimateJsonTokens(args.toolSpecs)

  const rows: ContextReport['items'] = []
  let conversation = 0
  let toolResults = 0
  let summary = 0
  for (const it of items) {
    let tokens = 0
    if (it.kind === 'user') tokens = estimateTokens(it.expanded ?? it.text) + it.attachments.length * 800
    else if (it.kind === 'assistant') tokens = estimateTokens(it.text) + estimateJsonTokens(it.toolCalls)
    else if (it.kind === 'tool') tokens = estimateTokens(it.content.slice(0, 60_000))
    else if (it.subkind === 'compaction') tokens = estimateTokens(it.text)
    else continue
    if (it.kind === 'tool') toolResults += tokens
    else if (it.kind === 'system') summary += tokens
    else conversation += tokens
    rows.push({ id: it.id, kind: it.kind, label: label(it), tokens, removable: it.kind === 'tool' && tokens > 300 && !it.meta?.['pruned'] })
  }
  // the base prompt is what is left of the system text once notes, pins and session instructions are taken out
  const base = Math.max(0, estimateTokens(system) - notesTokens - pinTokens - extraTokens - skillTokens)
  const parts: ContextReport['parts'] = [
    { id: 'base', label: 'How Prism works', tokens: base },
    { id: 'tools', label: 'Tool descriptions', tokens: toolsTokens },
    { id: 'notes', label: 'Project notes', tokens: notesTokens },
    { id: 'pins', label: 'Pinned files', tokens: pinTokens },
    { id: 'skills', label: 'Skills', tokens: skillTokens },
    { id: 'extra', label: 'Session instructions', tokens: extraTokens },
    { id: 'summary', label: 'Summary of earlier turns', tokens: summary },
    { id: 'conversation', label: 'Conversation', tokens: conversation },
    { id: 'results', label: 'Tool results', tokens: toolResults }
  ]
  return {
    window: args.window,
    total: parts.reduce((n, p) => n + p.tokens, 0),
    parts,
    items: rows.sort((a, b) => b.tokens - a.tokens).slice(0, 60),
    notes,
    pins: pinRows,
    skills: args.skills?.list ?? []
  }
}
