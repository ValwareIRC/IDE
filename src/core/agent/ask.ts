// One quick question to a model outside any conversation (spec checks, turning
// a correction into a skill or a rule, the next edit), with the answer as text
// or as the first JSON value in it.
import { getAdapter } from '../providers'
import type { Usage } from '@shared/types'
import type { ResolvedModel } from './engine'

export async function ask(model: ResolvedModel, system: string, user: string, maxTokens = 1500, signal?: AbortSignal): Promise<{ text: string; usage: Usage }> {
  const adapter = getAdapter(model.ep.adapter)
  const gen = adapter.chat(model.ep, model.key, {
    model: model.info.modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    maxTokens: model.info.maxOutput ? Math.min(model.info.maxOutput, maxTokens) : maxTokens,
    reasoning: false,
    signal,
    cache: false
  })
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  return { text: r.value.text, usage: r.value.usage }
}

/** The first JSON object or array in a model's answer (models like to wrap it in prose or a code fence). */
export function firstJson<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  for (const candidate of [fenced, text]) {
    if (!candidate) continue
    const start = candidate.search(/[[{]/)
    if (start < 0) continue
    const open = candidate[start]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inStr = false
    for (let i = start; i < candidate.length; i++) {
      const c = candidate[i]
      if (inStr) {
        if (c === '\\') i++
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === open) depth++
      else if (c === close && --depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T
        } catch {
          break
        }
      }
    }
  }
  return null
}
