import { readFile } from 'node:fs/promises'
import type { Attachment, TranscriptItem } from '@shared/types'
import type { ImagePart, Message } from '../providers/types'
import { estimateTokens } from '../tokens'

export const MAX_TOOL_RESULT_CHARS = 60_000

async function attachmentImages(atts: Attachment[]): Promise<ImagePart[]> {
  const out: ImagePart[] = []
  for (const a of atts) {
    if (!a.mime.startsWith('image/')) continue
    try {
      const buf = await readFile(a.path)
      if (buf.length <= 8 * 1024 * 1024) out.push({ mime: a.mime, base64: buf.toString('base64') })
    } catch {
      /* missing attachment */
    }
  }
  return out
}

/**
 * Rebuild provider messages from the persisted transcript. `liveImages` holds
 * images produced by tool results during the current run (they are not persisted).
 */
export async function messagesFromItems(
  system: string,
  items: TranscriptItem[],
  liveImages: Map<string, ImagePart[]>,
  opts: { vision: boolean }
): Promise<Message[]> {
  const out: Message[] = [{ role: 'system', content: system }]
  const pendingTools = new Set<string>()
  for (const it of items) {
    switch (it.kind) {
      case 'user': {
        const images = opts.vision ? await attachmentImages(it.attachments) : []
        const base = it.expanded ?? it.text
        const notes: string[] = []
        for (const a of it.attachments) {
          const isImage = a.mime.startsWith('image/')
          if (isImage && opts.vision) continue
          if (isImage && a.description) notes.push(`[image ${a.name}, as seen by the vision model]\n${a.description}`)
          else notes.push(`[attached: ${a.name}${isImage ? ' (image, not visible to you)' : ''}]`)
        }
        const text = notes.length ? `${base}\n\n${notes.join('\n\n')}` : base
        out.push({ role: 'user', content: text, ...(images.length ? { images } : {}) })
        break
      }
      case 'assistant': {
        out.push({
          role: 'assistant',
          content: it.text,
          reasoning: it.reasoning,
          reasoningSignature: it.reasoningSignature ?? null,
          toolCalls: it.toolCalls,
          blocks: it.blocks ?? null
        })
        for (const c of it.toolCalls) pendingTools.add(c.id)
        break
      }
      case 'tool': {
        pendingTools.delete(it.callId)
        const images = opts.vision ? liveImages.get(it.callId) : undefined
        out.push({
          role: 'tool',
          callId: it.callId,
          name: it.name,
          content: it.content.length > MAX_TOOL_RESULT_CHARS ? it.content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]' : it.content,
          isError: it.isError,
          ...(images?.length ? { images } : {})
        })
        break
      }
      case 'system': {
        if (it.subkind === 'notice') {
          // the user typed this while the agent worked; anything else is news from Prism
          const steer = it.meta?.['source'] === 'steer'
          out.push({ role: 'user', content: steer ? `[The user sent this while you were working; take it into account now]\n${it.text}` : `[Notice from Prism, not written by the user]\n${it.text}` })
          break
        }
        if (it.subkind === 'compaction') {
          out.push({ role: 'user', content: `[Summary of the conversation so far]\n\n${it.text}\n\n[End of summary. Continue from the current state described above.]` })
          out.push({ role: 'assistant', content: 'Understood. I have the full context from the summary and will continue from the current state.' })
        }
        break
      }
    }
  }
  // Providers reject assistant tool calls with no matching result (aborted mid-run).
  if (pendingTools.size) {
    for (const id of pendingTools) out.push({ role: 'tool', callId: id, name: 'unknown', content: '(interrupted before this tool ran)', isError: true })
  }
  return out
}

export function estimateMessages(messages: Message[]): number {
  let n = 0
  for (const m of messages) {
    n += 4
    if (m.role === 'tool') n += estimateTokens(m.content)
    else n += estimateTokens(m.content)
    if (m.role === 'assistant') {
      if (m.reasoning) n += estimateTokens(m.reasoning)
      for (const c of m.toolCalls ?? []) n += estimateTokens(JSON.stringify(c.args)) + 8
    }
    if (m.role === 'user' || m.role === 'tool') n += (m.images?.length ?? 0) * 1200
  }
  return n
}

/** Items that can be summarised: everything except the trailing user turn. */
export function compactionSplit(items: TranscriptItem[]): { toSummarise: TranscriptItem[]; keep: TranscriptItem[] } {
  let lastUser = -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser <= 0) return { toSummarise: [], keep: items }
  return { toSummarise: items.slice(0, lastUser), keep: items.slice(lastUser) }
}

export function transcriptAsText(items: TranscriptItem[]): string {
  const parts: string[] = []
  for (const it of items) {
    if (it.kind === 'user') parts.push(`USER:\n${it.text}`)
    else if (it.kind === 'assistant') {
      let s = `ASSISTANT:\n${it.text}`
      if (it.toolCalls.length) s += `\n[called: ${it.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 200)})`).join(', ')}]`
      parts.push(s)
    } else if (it.kind === 'tool') {
      parts.push(`TOOL ${it.name}${it.isError ? ' (error)' : ''}:\n${it.content.slice(0, 2500)}${it.content.length > 2500 ? '\n…' : ''}`)
    } else if (it.kind === 'system' && it.subkind === 'notice') {
      parts.push(`NOTICE:\n${it.text}`)
    } else if (it.kind === 'system' && it.subkind === 'compaction') {
      parts.push(`EARLIER SUMMARY:\n${it.text}`)
    }
  }
  return parts.join('\n\n')
}
