import type { AdapterId, AuthConfig } from '@shared/types'

export interface ProviderPreset {
  id: string
  label: string
  adapter: AdapterId
  baseUrl: string
  auth: AuthConfig
  blurb: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'zai-coding', label: 'Z.ai coding plan', adapter: 'openai-compat', baseUrl: 'https://api.z.ai/api/coding/paas/v4', auth: { kind: 'bearer' }, blurb: 'GLM, coding plan' },
  { id: 'zai', label: 'Z.ai', adapter: 'openai-compat', baseUrl: 'https://api.z.ai/api/paas/v4', auth: { kind: 'bearer' }, blurb: 'GLM, pay as you go' },
  { id: 'anthropic', label: 'Anthropic', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: { kind: 'header', name: 'x-api-key' }, blurb: 'Claude, with caching' },
  { id: 'openai', label: 'OpenAI', adapter: 'openai-compat', baseUrl: 'https://api.openai.com/v1', auth: { kind: 'bearer' }, blurb: 'GPT family' },
  { id: 'gemini', label: 'Gemini', adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', auth: { kind: 'header', name: 'x-goog-api-key' }, blurb: 'Google AI Studio' },
  { id: 'openrouter', label: 'OpenRouter', adapter: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', auth: { kind: 'bearer' }, blurb: 'Hundreds of models' },
  { id: 'deepseek', label: 'DeepSeek', adapter: 'openai-compat', baseUrl: 'https://api.deepseek.com/v1', auth: { kind: 'bearer' }, blurb: 'V3 / R1' },
  { id: 'groq', label: 'Groq', adapter: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1', auth: { kind: 'bearer' }, blurb: 'Very fast' },
  { id: 'mistral', label: 'Mistral', adapter: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1', auth: { kind: 'bearer' }, blurb: 'Codestral, Devstral' },
  { id: 'xai', label: 'xAI', adapter: 'openai-compat', baseUrl: 'https://api.x.ai/v1', auth: { kind: 'bearer' }, blurb: 'Grok' },
  { id: 'moonshot', label: 'Moonshot', adapter: 'openai-compat', baseUrl: 'https://api.moonshot.ai/v1', auth: { kind: 'bearer' }, blurb: 'Kimi' },
  { id: 'ollama', label: 'Ollama', adapter: 'openai-compat', baseUrl: 'http://localhost:11434/v1', auth: { kind: 'none' }, blurb: 'Local, no key' },
  { id: 'lmstudio', label: 'LM Studio', adapter: 'openai-compat', baseUrl: 'http://localhost:1234/v1', auth: { kind: 'none' }, blurb: 'Local, no key' },
  { id: 'vllm', label: 'vLLM', adapter: 'openai-compat', baseUrl: 'http://localhost:8000/v1', auth: { kind: 'none' }, blurb: 'Local server' },
  { id: 'llamacpp', label: 'llama.cpp', adapter: 'openai-compat', baseUrl: 'http://localhost:8080/v1', auth: { kind: 'none' }, blurb: 'Local server' }
]
