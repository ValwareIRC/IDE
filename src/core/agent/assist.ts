import type { InlineCompletionRequest, InlineEditRequest } from '@shared/types'
import { getAdapter } from '../providers'
import type { ResolvedModel } from './engine'

async function complete(model: ResolvedModel, system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  const adapter = getAdapter(model.ep.adapter)
  const gen = adapter.chat(model.ep, model.key, {
    model: model.info.modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    maxTokens,
    reasoning: false,
    temperature: 0.2,
    signal,
    cache: false
  })
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  return r.value.text
}

function stripFence(s: string): string {
  const m = s.match(/^```[\w-]*\n([\s\S]*?)\n?```\s*$/)
  return m ? m[1]! : s
}

/** Ghost-text completion at the cursor: returns the text to insert, or null. */
export async function inlineCompletion(model: ResolvedModel, req: InlineCompletionRequest, signal?: AbortSignal): Promise<string | null> {
  const prefix = req.prefix.slice(-6000)
  const suffix = req.suffix.slice(0, 2000)
  const system = `You are a code completion engine inside an editor. Given the code before the cursor (PREFIX) and after it (SUFFIX), output ONLY the text that should be inserted at the cursor to continue the code naturally. Rules:
- Output raw code, no markdown, no explanations, no code fences.
- Complete the current statement or block; stop at a sensible boundary (usually 1-8 lines).
- Never repeat text that is already in PREFIX or SUFFIX.
- Match the file's indentation and style exactly.
- If nothing sensible should be inserted, output nothing.`
  const user = `Language: ${req.language}\nFile: ${req.path}\n\n<PREFIX>\n${prefix}\n</PREFIX>\n<SUFFIX>\n${suffix}\n</SUFFIX>`
  const raw = stripFence(await complete(model, system, user, 256, signal))
  const text = raw.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (!text.trim()) return null
  // Guard against the model echoing the tail of the prefix.
  const tail = prefix.slice(-80)
  if (tail && text.startsWith(tail.trimStart())) return null
  return text
}

/** Inline edit of a selection with an instruction: returns the replacement text. */
export async function inlineEdit(model: ResolvedModel, req: InlineEditRequest, signal?: AbortSignal): Promise<string> {
  const system = `You are an expert programmer editing code in place. The user selected a region of a file and gave an instruction. Output ONLY the replacement for the selected region: raw code, no markdown fences, no commentary. Preserve indentation of the first line exactly as in the selection. Keep surrounding context (BEFORE/AFTER) unchanged and do not repeat it. If the selection is empty, output the new code to insert at that point. If earlier rounds are given, the newest instruction refines your last result: output the complete replacement again, not a patch.`
  const user = `Language: ${req.language}\nFile: ${req.path}\nInstruction: ${req.instruction}\n\n<BEFORE>\n${req.before.slice(-4000)}\n</BEFORE>\n<SELECTION>\n${req.selection}\n</SELECTION>\n<AFTER>\n${req.after.slice(0, 2000)}\n</AFTER>${
    req.history?.length
      ? `\n\nEarlier rounds (the instruction above is the newest):\n${req.history
          .slice(-4)
          .map((h, i) => `Round ${i + 1} instruction: ${h.instruction}\n<RESULT_${i + 1}>\n${h.result}\n</RESULT_${i + 1}>`)
          .join('\n')}`
      : ''
  }`
  const raw = await complete(model, system, user, Math.max(512, Math.min(16_000, req.selection.length + 2000)), signal)
  return stripFence(raw.trim()).replace(/\r\n/g, '\n')
}
