import type { ModelMeta } from '@shared/types'

/**
 * Best-effort metadata for models we recognise by id. Users can override any
 * field from the Models settings; unknown models get conservative defaults.
 * Prices are USD per million tokens and only used for the cost readout.
 */

interface Rule {
  test: RegExp
  meta: Partial<ModelMeta>
}

const K = 1024

const RULES: Rule[] = [
  // Zhipu GLM
  // the V models (glm-4.5v, glm-4.6v, glm-5v…) see pictures; checked before the plain names below
  { test: /^glm-[0-9.]+v/i, meta: { contextWindow: 64 * K, maxOutput: 16 * K, supportsTools: true, supportsVision: true, reasoning: true } },
  { test: /^glm-5\.3-flash/i, meta: { contextWindow: 200 * K, maxOutput: 32 * K, supportsTools: true, reasoning: true, inputPrice: 0.1, outputPrice: 0.4 } },
  { test: /^glm-5/i, meta: { contextWindow: 200 * K, maxOutput: 32 * K, supportsTools: true, reasoning: true, inputPrice: 0.6, outputPrice: 2.2 } },
  { test: /^glm-4\.7/i, meta: { contextWindow: 200 * K, maxOutput: 16 * K, supportsTools: true, reasoning: true, inputPrice: 0.6, outputPrice: 2.2 } },
  { test: /^glm-4\.6/i, meta: { contextWindow: 200 * K, maxOutput: 16 * K, supportsTools: true, reasoning: true, inputPrice: 0.6, outputPrice: 2.2 } },
  { test: /^glm-4\.5v/i, meta: { contextWindow: 64 * K, maxOutput: 16 * K, supportsTools: true, supportsVision: true, reasoning: true } },
  { test: /^glm-4\.5-air/i, meta: { contextWindow: 128 * K, maxOutput: 16 * K, supportsTools: true, reasoning: true, inputPrice: 0.2, outputPrice: 1.1 } },
  { test: /^glm-4\.5/i, meta: { contextWindow: 128 * K, maxOutput: 16 * K, supportsTools: true, reasoning: true, inputPrice: 0.6, outputPrice: 2.2 } },
  { test: /^glm-4v/i, meta: { contextWindow: 8 * K, supportsVision: true } },
  // Anthropic
  { test: /^claude-(fable|mythos)/i, meta: { contextWindow: 1000 * K, maxOutput: 64 * K, supportsTools: true, supportsVision: true, reasoning: true } },
  { test: /^claude-opus-5/i, meta: { contextWindow: 1000 * K, maxOutput: 64 * K, supportsTools: true, supportsVision: true, reasoning: true, inputPrice: 5, outputPrice: 25 } },
  { test: /^claude-sonnet-5/i, meta: { contextWindow: 1000 * K, maxOutput: 64 * K, supportsTools: true, supportsVision: true, reasoning: true, inputPrice: 3, outputPrice: 15 } },
  { test: /^claude-opus-4/i, meta: { contextWindow: 200 * K, maxOutput: 32 * K, supportsTools: true, supportsVision: true, reasoning: true, inputPrice: 15, outputPrice: 75 } },
  { test: /^claude-sonnet-4/i, meta: { contextWindow: 200 * K, maxOutput: 64 * K, supportsTools: true, supportsVision: true, reasoning: true, inputPrice: 3, outputPrice: 15 } },
  { test: /^claude-haiku-4/i, meta: { contextWindow: 200 * K, maxOutput: 64 * K, supportsTools: true, supportsVision: true, reasoning: true, inputPrice: 1, outputPrice: 5 } },
  { test: /^claude/i, meta: { contextWindow: 200 * K, maxOutput: 8 * K, supportsTools: true, supportsVision: true } },
  // OpenAI
  { test: /^gpt-5/i, meta: { contextWindow: 400 * K, maxOutput: 128 * K, supportsTools: true, supportsVision: true, reasoning: true, inputPrice: 1.25, outputPrice: 10 } },
  { test: /^gpt-4\.1/i, meta: { contextWindow: 1000 * K, maxOutput: 32 * K, supportsTools: true, supportsVision: true, inputPrice: 2, outputPrice: 8 } },
  { test: /^gpt-4o-mini/i, meta: { contextWindow: 128 * K, maxOutput: 16 * K, supportsTools: true, supportsVision: true, inputPrice: 0.15, outputPrice: 0.6 } },
  { test: /^gpt-4o/i, meta: { contextWindow: 128 * K, maxOutput: 16 * K, supportsTools: true, supportsVision: true, inputPrice: 2.5, outputPrice: 10 } },
  { test: /^o[134]/i, meta: { contextWindow: 200 * K, maxOutput: 100 * K, supportsTools: true, supportsVision: true, reasoning: true } },
  // Google
  { test: /^gemini-3/i, meta: { contextWindow: 1000 * K, maxOutput: 64 * K, supportsTools: true, supportsVision: true, reasoning: true } },
  { test: /^gemini-2\.5-pro/i, meta: { contextWindow: 1000 * K, maxOutput: 64 * K, supportsTools: true, supportsVision: true, reasoning: true, inputPrice: 1.25, outputPrice: 10 } },
  { test: /^gemini-2\.5-flash/i, meta: { contextWindow: 1000 * K, maxOutput: 64 * K, supportsTools: true, supportsVision: true, reasoning: true, inputPrice: 0.3, outputPrice: 2.5 } },
  { test: /^gemini/i, meta: { contextWindow: 1000 * K, maxOutput: 8 * K, supportsTools: true, supportsVision: true } },
  // DeepSeek
  { test: /^deepseek-reasoner|^deepseek-r1/i, meta: { contextWindow: 128 * K, maxOutput: 64 * K, supportsTools: true, reasoning: true, inputPrice: 0.55, outputPrice: 2.19 } },
  { test: /^deepseek/i, meta: { contextWindow: 128 * K, maxOutput: 8 * K, supportsTools: true, inputPrice: 0.27, outputPrice: 1.1 } },
  // xAI / Mistral / Qwen / Llama / Kimi
  { test: /^grok/i, meta: { contextWindow: 256 * K, maxOutput: 32 * K, supportsTools: true, supportsVision: true, reasoning: true } },
  { test: /^(mistral|codestral|devstral|magistral)/i, meta: { contextWindow: 128 * K, maxOutput: 32 * K, supportsTools: true } },
  { test: /qwen3|qwen-?3/i, meta: { contextWindow: 128 * K, maxOutput: 32 * K, supportsTools: true, reasoning: true } },
  { test: /qwen.*vl/i, meta: { contextWindow: 128 * K, supportsTools: true, supportsVision: true } },
  { test: /qwen/i, meta: { contextWindow: 128 * K, maxOutput: 8 * K, supportsTools: true } },
  { test: /llama-?4|llama4/i, meta: { contextWindow: 1000 * K, supportsTools: true, supportsVision: true } },
  { test: /llama/i, meta: { contextWindow: 128 * K, supportsTools: true } },
  { test: /kimi/i, meta: { contextWindow: 256 * K, maxOutput: 32 * K, supportsTools: true, reasoning: true } },
  { test: /minimax/i, meta: { contextWindow: 1000 * K, supportsTools: true } },
  // Generic hints
  { test: /vision|-vl|llava|pixtral/i, meta: { supportsVision: true } },
  { test: /embed|whisper|tts|dall-e|image|moderation|rerank/i, meta: { supportsTools: false, contextWindow: null } }
]

export const DEFAULT_META: ModelMeta = {
  contextWindow: 128 * K,
  maxOutput: 8 * K,
  supportsTools: true,
  supportsVision: false,
  reasoning: false,
  inputPrice: null,
  outputPrice: null
}

export function knownMeta(modelId: string): ModelMeta {
  const out: ModelMeta = { ...DEFAULT_META }
  // Later rules fill in only what earlier (more specific) rules left default.
  const touched = new Set<keyof ModelMeta>()
  for (const r of RULES) {
    if (!r.test.test(modelId)) continue
    for (const [k, v] of Object.entries(r.meta) as Array<[keyof ModelMeta, ModelMeta[keyof ModelMeta]]>) {
      if (touched.has(k)) continue
      ;(out as unknown as Record<string, unknown>)[k] = v
      touched.add(k)
    }
  }
  return out
}

/** Does this model id look like something you can chat with? */
export function isChatModel(modelId: string): boolean {
  return !/embed|whisper|tts|dall-e|moderation|rerank|^text-|audio|realtime|transcribe/i.test(modelId)
}
