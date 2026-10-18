// Claude Code's own conversations (~/.claude/projects/<folder>/<id>.jsonl), so one started elsewhere (the terminal,
// VS Code) can be carried on in Prism. The transcript is copied in for reading; Claude Code itself resumes its own
// record of the conversation, so it remembers everything, not a summary.
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { AssistantItem, Attachment, ClaudeConversation, ClaudeSessionState, ModelRef, PermissionMode, SystemItem, ToolCall, ToolItem, TranscriptItem, UserItem } from '@shared/types'
import { CLAUDE_ENDPOINT, prismMode, toPrismCall } from './translate'


export function claudeHome(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
}

/** Claude Code keeps a project's conversations in a folder named after its path, every other character a dash. */
export function projectFolder(root: string): string {
  return join(claudeHome(), 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'))
}

async function headTail(file: string, size: number, n = 256 * 1024): Promise<{ head: string; tail: string }> {
  const fh = await open(file, 'r')
  try {
    const head = Buffer.alloc(Math.min(n, size))
    await fh.read(head, 0, head.length, 0)
    const tail = Buffer.alloc(Math.min(n, size))
    await fh.read(tail, 0, tail.length, Math.max(0, size - tail.length))
    return { head: head.toString('utf8'), tail: tail.toString('utf8') }
  } finally {
    await fh.close()
  }
}

function lines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const l of text.split('\n')) {
    try {
      out.push(JSON.parse(l) as Record<string, unknown>)
    } catch {
      /* a line cut by the window */
    }
  }
  return out
}

/** Every Claude Code conversation on this computer, newest first. */
export async function listClaudeConversations(): Promise<ClaudeConversation[]> {
  const base = join(claudeHome(), 'projects')
  if (!existsSync(base)) return []
  const out: ClaudeConversation[] = []
  for (const dir of await readdir(base).catch(() => [] as string[])) {
    const files = await readdir(join(base, dir)).catch(() => [] as string[])
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const file = join(base, dir, f)
      const st = await stat(file).catch(() => null)
      if (!st || st.size < 200) continue
      const { head, tail } = await headTail(file, st.size)
      const first = lines(head)
      const last = lines(tail).reverse()
      const firstAsk = first.find((o) => o['type'] === 'user' && !o['isMeta'] && !o['isSidechain'] && textOf(o).trim())
      if (!firstAsk) continue
      const named = last.find((o) => o['type'] === 'ai-title' || o['type'] === 'summary' || o['type'] === 'custom-title')
      const title = String(named?.['title'] ?? named?.['aiTitle'] ?? named?.['summary'] ?? named?.['customTitle'] ?? '').trim() || clean(textOf(firstAsk)).slice(0, 80)
      out.push({ id: f.slice(0, -6), file, title, cwd: String(first.find((o) => o['cwd'])?.['cwd'] ?? ''), updatedAt: st.mtimeMs, bytes: st.size })
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

type Block = { type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { type: string; media_type?: string; data?: string } }

function blocks(o: Record<string, unknown>): Block[] {
  const c = (o['message'] as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return [{ type: 'text', text: c }]
  return Array.isArray(c) ? (c as Block[]) : []
}

function textOf(o: Record<string, unknown>): string {
  return blocks(o)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
}

/** What the editor or Claude Code wrapped around a message, taken off. */
function clean(t: string): string {
  return t
    .replace(/<(system-reminder|ide_selection|ide_opened_file|local-command-caveat|pasted_content[^>]*)>[\s\S]*?<\/\1>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim()
}

const RESULT_CHARS = 4000

function resultText(c: unknown): { text: string; pictures: number } {
  if (typeof c === 'string') return { text: c, pictures: 0 }
  if (!Array.isArray(c)) return { text: '', pictures: 0 }
  let pictures = 0
  const parts: string[] = []
  for (const b of c as Block[]) {
    if (b.type === 'text') parts.push(b.text ?? '')
    else if (b.type === 'image') pictures++
  }
  return { text: parts.join('\n'), pictures }
}

function modelFor(id: string, available: string[]): string {
  const fam = /opus/.test(id) ? 'opus' : /sonnet/.test(id) ? 'sonnet' : /haiku/.test(id) ? 'haiku' : /fable/.test(id) ? 'fable' : ''
  const hits = available.filter((m) => fam && m.includes(fam))
  // a long conversation wants the biggest window there is
  return hits.find((m) => m.includes('[1m]')) ?? hits[0] ?? (available.includes('default') ? 'default' : (available[0] ?? 'default'))
}

export interface BroughtIn {
  title: string
  items: TranscriptItem[]
  model: ModelRef
  mode: PermissionMode
  claude: ClaudeSessionState
}

/** A Claude Code conversation as Prism transcript items, plus what Prism needs to resume it. */
export async function readClaudeConversation(c: ClaudeConversation, root: string, claudeModels: string[], savePicture: (mime: string, data: Buffer) => Promise<Attachment>): Promise<BroughtIn> {
  const items: TranscriptItem[] = []
  let cur: AssistantItem | null = null
  let curMsg = ''
  let lastUuid: string | null = null
  let lastModel = ''
  let mode: PermissionMode = 'ask'
  const calls = new Map<string, ToolCall>()
  let step = 0

  const rl = createInterface({ input: createReadStream(c.file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (o['isSidechain']) continue
    const ts = Date.parse(String(o['timestamp'] ?? '')) || Date.now()
    if (typeof o['permissionMode'] === 'string') mode = prismMode(o['permissionMode']) ?? mode
    if (o['type'] === 'assistant') {
      const msg = o['message'] as { id?: string; model?: string } | undefined
      if (msg?.model && msg.model !== '<synthetic>') lastModel = msg.model
      lastUuid = String(o['uuid'] ?? lastUuid)
      // Claude Code writes one line per block of the same answer
      if (!cur || msg?.id !== curMsg) {
        cur = { kind: 'assistant', id: randomUUID(), ts, text: '', reasoning: null, toolCalls: [], model: { endpointId: CLAUDE_ENDPOINT, modelId: lastModel || 'default' }, usage: null, step: step++ }
        curMsg = msg?.id ?? ''
        items.push(cur)
      }
      // what each step sent, so the conversation's size is known before it carries on
      const u = (o['message'] as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined)?.usage
      if (u) {
        const read = u.cache_read_input_tokens ?? 0
        const write = u.cache_creation_input_tokens ?? 0
        cur.usage = { inputTokens: (u.input_tokens ?? 0) + read + write, outputTokens: u.output_tokens ?? 0, cacheReadTokens: read, cacheWriteTokens: write }
      }
      for (const b of blocks(o)) {
        if (b.type === 'text' && b.text) cur.text = cur.text ? `${cur.text}\n\n${b.text}` : b.text
        else if (b.type === 'thinking' && b.thinking) cur.reasoning = (cur.reasoning ? cur.reasoning + '\n\n' : '') + b.thinking
        else if (b.type === 'tool_use' && b.id) {
          const call = toPrismCall(b.id, b.name ?? 'tool', b.input ?? {}, root)
          cur.toolCalls.push(call)
          calls.set(b.id, call)
        }
      }
      continue
    }
    // a message typed while Claude was busy is kept as a queued command
    const att = o['attachment'] as { type?: string; prompt?: unknown; origin?: { kind?: string } } | undefined
    if (o['type'] === 'attachment' && att?.type === 'queued_command' && att.origin?.kind === 'human') {
      const p = att.prompt
      const text = clean(typeof p === 'string' ? p : Array.isArray(p) ? (p as Block[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : '')
      if (text) {
        cur = null
        items.push({ kind: 'user', id: randomUUID(), ts, text, attachments: [] })
      }
      continue
    }
    if (o['type'] !== 'user') continue
    lastUuid = String(o['uuid'] ?? lastUuid)
    if (o['isCompactSummary']) {
      cur = null
      const s: SystemItem = { kind: 'system', id: randomUUID(), ts, subkind: 'compaction', text: textOf(o), meta: { from: 'claude-code' } }
      items.push(s)
      continue
    }
    if (o['isMeta']) continue
    const bs = blocks(o)
    const results = bs.filter((b) => b.type === 'tool_result')
    if (results.length) {
      for (const r of results) {
        const call = calls.get(r.tool_use_id ?? '')
        const { text, pictures } = resultText(r.content)
        const shown = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
        const t: ToolItem = {
          kind: 'tool',
          id: randomUUID(),
          ts,
          callId: r.tool_use_id ?? randomUUID(),
          name: call?.name ?? 'tool',
          args: call?.args ?? {},
          content: (shown.length > RESULT_CHARS ? shown.slice(0, RESULT_CHARS) + '\n…' : shown) + (pictures ? `\n[${pictures} picture${pictures === 1 ? '' : 's'}]` : ''),
          isError: !!r.is_error,
          durationMs: 0,
          diff: null,
          meta: null
        }
        items.push(t)
      }
      continue
    }
    const origin = (o['origin'] as { kind?: string } | undefined)?.kind
    const text = clean(bs.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'))
    // Claude Code's own bookkeeping (interruptions, local commands, background-job news) is not something anyone typed
    if (origin && origin !== 'human') continue
    if (!origin && (/^\[Request interrupted/.test(text) || /^<(command-name|local-command|task-notification)/.test(text))) continue
    const attachments: Attachment[] = []
    for (const b of bs) {
      if (b.type !== 'image' || b.source?.type !== 'base64' || !b.source.data) continue
      attachments.push(await savePicture(b.source.media_type ?? 'image/png', Buffer.from(b.source.data, 'base64')).catch(() => null as never))
    }
    if (!text && !attachments.filter(Boolean).length) continue
    cur = null
    const u: UserItem = { kind: 'user', id: randomUUID(), ts, text, attachments: attachments.filter(Boolean) }
    items.push(u)
  }

  const modelId = modelFor(lastModel, claudeModels)
  return {
    title: c.title,
    items,
    model: { endpointId: CLAUDE_ENDPOINT, modelId },
    mode,
    claude: { sessionId: c.id, lastUuid, resumeAt: null, turns: [], synced: items[items.length - 1]?.id ?? null }
  }
}

/** Claude Code finds a conversation by the folder it runs in: the file goes where a run from this project looks. */
export async function placeForResume(c: ClaudeConversation, root: string): Promise<void> {
  const dir = projectFolder(root)
  const to = join(dir, basename(c.file))
  if (to.toLowerCase() === c.file.toLowerCase()) return
  // already carried on from this project: that copy is the newer one
  const there = await stat(to).catch(() => null)
  if (there && there.mtimeMs >= c.updatedAt) return
  await mkdir(dir, { recursive: true })
  await copyFile(c.file, to)
}
