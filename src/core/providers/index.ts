import type { AdapterId } from '@shared/types'
import { anthropicAdapter } from './anthropic'
import { claudeCodeAdapter } from './claudecode'
import { geminiAdapter } from './gemini'
import { openaiAdapter } from './openai'
import type { ProviderAdapter } from './types'

const ADAPTERS: Record<AdapterId, ProviderAdapter> = {
  'openai-compat': openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  'claude-code': claudeCodeAdapter
}

export function getAdapter(id: string): ProviderAdapter {
  const a = ADAPTERS[id as AdapterId]
  if (!a) throw new Error(`Unknown provider adapter '${id}'`)
  return a
}

export interface ProviderPreset {
  id: string
  label: string
  adapter: AdapterId
  baseUrl: string
  auth: { kind: 'none' | 'bearer' | 'header' | 'query'; name?: string }
  local: boolean
  blurb: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'zai-coding', label: 'Z.ai (coding plan)', adapter: 'openai-compat', baseUrl: 'https://api.z.ai/api/coding/paas/v4', auth: { kind: 'bearer' }, local: false, blurb: 'GLM models on the coding plan' },
  { id: 'zai', label: 'Z.ai', adapter: 'openai-compat', baseUrl: 'https://api.z.ai/api/paas/v4', auth: { kind: 'bearer' }, local: false, blurb: 'GLM models (international)' },
  { id: 'bigmodel', label: 'BigModel', adapter: 'openai-compat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', auth: { kind: 'bearer' }, local: false, blurb: 'GLM · Zhipu (CN)' },
  { id: 'anthropic', label: 'Anthropic', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: { kind: 'header', name: 'x-api-key' }, local: false, blurb: 'Claude, native API with caching' },
  { id: 'openai', label: 'OpenAI', adapter: 'openai-compat', baseUrl: 'https://api.openai.com/v1', auth: { kind: 'bearer' }, local: false, blurb: 'GPT family' },
  { id: 'gemini', label: 'Gemini', adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', auth: { kind: 'header', name: 'x-goog-api-key' }, local: false, blurb: 'Google AI Studio' },
  { id: 'openrouter', label: 'OpenRouter', adapter: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', auth: { kind: 'bearer' }, local: false, blurb: 'Hundreds of models, one key' },
  { id: 'deepseek', label: 'DeepSeek', adapter: 'openai-compat', baseUrl: 'https://api.deepseek.com/v1', auth: { kind: 'bearer' }, local: false, blurb: 'V3 / R1' },
  { id: 'groq', label: 'Groq', adapter: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1', auth: { kind: 'bearer' }, local: false, blurb: 'Very fast inference' },
  { id: 'mistral', label: 'Mistral', adapter: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1', auth: { kind: 'bearer' }, local: false, blurb: 'Mistral, Codestral, Devstral' },
  { id: 'xai', label: 'xAI', adapter: 'openai-compat', baseUrl: 'https://api.x.ai/v1', auth: { kind: 'bearer' }, local: false, blurb: 'Grok' },
  { id: 'together', label: 'Together', adapter: 'openai-compat', baseUrl: 'https://api.together.xyz/v1', auth: { kind: 'bearer' }, local: false, blurb: 'Open models, hosted' },
  { id: 'moonshot', label: 'Moonshot', adapter: 'openai-compat', baseUrl: 'https://api.moonshot.ai/v1', auth: { kind: 'bearer' }, local: false, blurb: 'Kimi' },
  { id: 'ollama', label: 'Ollama', adapter: 'openai-compat', baseUrl: 'http://localhost:11434/v1', auth: { kind: 'none' }, local: true, blurb: 'Local, no key' },
  { id: 'lmstudio', label: 'LM Studio', adapter: 'openai-compat', baseUrl: 'http://localhost:1234/v1', auth: { kind: 'none' }, local: true, blurb: 'Local, no key' },
  { id: 'vllm', label: 'vLLM', adapter: 'openai-compat', baseUrl: 'http://localhost:8000/v1', auth: { kind: 'none' }, local: true, blurb: 'Local server' },
  { id: 'llamacpp', label: 'llama.cpp', adapter: 'openai-compat', baseUrl: 'http://localhost:8080/v1', auth: { kind: 'none' }, local: true, blurb: 'Local server' },
  { id: 'litellm', label: 'LiteLLM', adapter: 'openai-compat', baseUrl: 'http://localhost:4000/v1', auth: { kind: 'bearer' }, local: true, blurb: 'Local gateway' }
]

export * from './types'
export { StallError } from './sse'
