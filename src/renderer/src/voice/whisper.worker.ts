// Whisper, run inside Prism in a worker so the window stays responsive. Model files come through
// prism://hf/… (kept on disk by the main process after the first download); the graphics card is used when
// there is one, otherwise the processor.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import mjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'

env.allowLocalModels = false
env.useBrowserCache = false
// the library only treats http(s) addresses as remote, so it is given one and each request goes to prism://hf/
const HOST = 'https://models.prism.local/'
env.remoteHost = HOST
const plainFetch = globalThis.fetch.bind(globalThis)
env.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return plainFetch(url.startsWith(HOST) ? 'prism://hf/' + url.slice(HOST.length) : input, init)
}) as typeof fetch
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { wasm, mjs }

type In = { type: 'run'; id: number; model: string; audio: Float32Array; language: string }
type Out =
  | { type: 'progress'; id: number; file: string; loaded: number; total: number }
  | { type: 'loading'; id: number; device: string }
  | { type: 'done'; id: number; text: string }
  | { type: 'error'; id: number; message: string }

let current: { model: string; pipe: Promise<AutomaticSpeechRecognitionPipeline> } | null = null
const post = (m: Out): void => (self as unknown as Worker).postMessage(m)

async function load(model: string, id: number): Promise<AutomaticSpeechRecognitionPipeline> {
  if (current?.model === model) return current.pipe
  const gpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null))
  post({ type: 'loading', id, device: gpu ? 'graphics card' : 'processor' })
  const opts = {
    device: gpu ? ('webgpu' as const) : ('wasm' as const),
    dtype: gpu ? { encoder_model: 'fp32' as const, decoder_model_merged: 'q4' as const } : ('q8' as const),
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file) post({ type: 'progress', id, file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 })
    }
  }
  const pipe = pipeline('automatic-speech-recognition', model, opts) as unknown as Promise<AutomaticSpeechRecognitionPipeline>
  current = { model, pipe }
  pipe.catch(() => {
    if (current?.pipe === pipe) current = null
  })
  return pipe
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data
  if (m.type !== 'run') return
  try {
    const pipe = await load(m.model, m.id)
    const out = (await pipe(m.audio, { ...(m.language ? { language: m.language } : {}), task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 })) as { text: string } | Array<{ text: string }>
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
    post({ type: 'done', id: m.id, text: text.trim() })
  } catch (err) {
    post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) })
  }
}
