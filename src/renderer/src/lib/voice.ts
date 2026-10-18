// The microphone button: record, then turn the speech into text with the engine chosen in Settings
// (Whisper inside Prism, a provider's speech-to-text, or Windows' own dictation).
import { create } from 'zustand'
import { prism } from './ipc'
import { useApp } from '@/state/app'
import type { Settings } from '@shared/types'

export type VoiceSettings = Settings['voice']
export const VOICE_DEFAULT: VoiceSettings = { engine: 'local', localModel: 'base', endpointId: '', model: 'whisper-1', language: '' }
export const LOCAL_MODELS: Array<{ id: VoiceSettings['localModel']; repo: string; label: string; size: string }> = [
  { id: 'tiny', repo: 'onnx-community/whisper-tiny', label: 'Tiny', size: 'about 120 MB to download, fastest' },
  { id: 'base', repo: 'onnx-community/whisper-base', label: 'Base', size: 'about 210 MB to download, good for most' },
  { id: 'small', repo: 'onnx-community/whisper-small', label: 'Small', size: 'about 590 MB to download, most accurate' }
]

export const voiceSettings = (): VoiceSettings => ({ ...VOICE_DEFAULT, ...useApp.getState().settings?.voice })

interface VoiceState {
  state: 'idle' | 'recording' | 'working'
  level: number
  startedAt: number
  /** What it is doing while working ("Downloading the speech model: 40%"). */
  note: string
}
export const useVoice = create<VoiceState>(() => ({ state: 'idle', level: 0, startedAt: 0, note: '' }))

let worker: Worker | null = null
let seq = 0
const getWorker = (): Worker => (worker ??= new Worker(new URL('../voice/whisper.worker.ts', import.meta.url), { type: 'module' }))

/**
 * Throw the worker away so the next go builds a fresh one. A worker that has died
 * sends nothing at all — no error, no answer — and the one kept here would be used
 * again and again, each time waiting for a reply that cannot come.
 */
function dropWorker(): void {
  try {
    worker?.terminate()
  } catch {
    /* already gone */
  }
  worker = null
}

/** Longer than this and something is wrong, whatever it is. */
const LOCAL_PATIENCE_MS = 60_000

function runLocal(audio: Float32Array, model: string, language: string): Promise<string> {
  const id = ++seq
  const w = getWorker()
  const files = new Map<string, { loaded: number; total: number }>()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      w.removeEventListener('message', on)
      w.removeEventListener('error', died)
      w.removeEventListener('messageerror', died)
      fn()
    }
    // the worker falling over sends no message of any kind, so it has to be watched for
    const died = (): void => finish(() => {
      dropWorker()
      reject(new Error('The speech model stopped working. It will start again on the next try.'))
    })
    const timer = setTimeout(() => finish(() => {
      dropWorker()
      reject(new Error('The speech model took too long and was stopped. Try again.'))
    }), LOCAL_PATIENCE_MS)
    const on = (e: MessageEvent): void => {
      const m = e.data as { type: string; id: number; [k: string]: unknown }
      if (m.id !== id) return
      if (m.type === 'loading') useVoice.setState({ note: `Getting the speech model ready (on the ${String(m['device'])})…` })
      else if (m.type === 'progress') {
        files.set(String(m['file']), { loaded: Number(m['loaded']), total: Number(m['total']) })
        const all = [...files.values()]
        const total = all.reduce((a, f) => a + f.total, 0)
        const done = all.reduce((a, f) => a + f.loaded, 0)
        if (total > 2_000_000) useVoice.setState({ note: `Downloading the speech model, once: ${Math.round((done / total) * 100)}% of ${Math.round(total / 1e6)} MB` })
      } else if (m.type === 'done') {
        finish(() => resolve(String(m['text'])))
      } else if (m.type === 'error') {
        finish(() => reject(new Error(String(m['message']))))
      }
    }
    w.addEventListener('message', on)
    w.addEventListener('error', died)
    w.addEventListener('messageerror', died)
    w.postMessage({ type: 'run', id, model, audio, language }, [audio.buffer])
  })
}

let rec: { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; ctx: AudioContext; timer: number } | null = null

/** Start recording; `stop` ends it and resolves with the text. */
export async function startRecording(): Promise<void> {
  if (rec) return
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  // a live level for the button
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  ctx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  const timer = window.setInterval(() => {
    analyser.getByteTimeDomainData(buf)
    let peak = 0
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
    useVoice.setState({ level: Math.min(1, peak / 64) })
  }, 80)
  recorder.start(250)
  rec = { recorder, stream, chunks, ctx, timer }
  useVoice.setState({ state: 'recording', startedAt: Date.now(), level: 0, note: '' })
}

export function cancelRecording(): void {
  if (!rec) return
  const r = rec
  rec = null
  r.recorder.onstop = null
  if (r.recorder.state !== 'inactive') r.recorder.stop()
  cleanup(r)
  useVoice.setState({ state: 'idle', level: 0, note: '' })
}

function cleanup(r: NonNullable<typeof rec>): void {
  clearInterval(r.timer)
  r.stream.getTracks().forEach((t) => t.stop())
  void r.ctx.close()
}

export async function stopRecording(): Promise<string> {
  if (!rec) return ''
  const r = rec
  rec = null
  const blob = await new Promise<Blob>((resolve) => {
    r.recorder.onstop = () => resolve(new Blob(r.chunks, { type: 'audio/webm' }))
    r.recorder.stop()
  })
  cleanup(r)
  return transcribe(blob)
}

/** A recording (any format the page can decode) to text, with the engine in Settings. */
export async function transcribe(blob: Blob): Promise<string> {
  useVoice.setState({ state: 'working', level: 0, note: 'Turning your speech into text…' })
  try {
    const v = voiceSettings()
    if (v.engine === 'provider') {
      if (!v.endpointId) throw new Error('Pick a provider for speech in Settings, Conversation, Voice input.')
      return await prism.voice.transcribe(v.endpointId, v.model || 'whisper-1', new Uint8Array(await blob.arrayBuffer()), blob.type || 'audio/webm', v.language)
    }
    // The phone holds no speech model: the computer it is connected to does this,
    // with the model already on it.
    if (window.__prismMobile) {
      useVoice.setState({ note: 'The computer is turning it into text…' })
      return await prism.voice.onComputer(new Uint8Array(await blob.arrayBuffer()), blob.type || 'audio/webm', v.localModel, v.language)
    }
    return await localText(blob, v.localModel, v.language)
  } finally {
    useVoice.setState({ state: 'idle', note: '' })
  }
}

/** A recording to words, here, with the speech model kept on this computer. */
async function localText(blob: Blob, localModel: string, language: string): Promise<string> {
  // Whisper wants 16 kHz, one channel
  const ctx = new AudioContext({ sampleRate: 16_000 })
  const audio = await ctx.decodeAudioData(await blob.arrayBuffer())
  void ctx.close()
  const pcm = new Float32Array(audio.getChannelData(0))
  const repo = LOCAL_MODELS.find((m) => m.id === localModel)?.repo ?? LOCAL_MODELS[1]!.repo
  return runLocal(pcm, repo, language)
}

/**
 * This window answers for the phone: the phone has no speech model, so it sends
 * its recording here and this computer says what was in it. Only a window on the
 * computer offers this; the phone never answers its own request.
 */
export function serveSpeechForPhone(): () => void {
  return prism.voice.onDoLocal((job) => {
    void (async () => {
      try {
        const text = await localText(new Blob([job.audio as BlobPart], { type: job.mime || 'audio/webm' }), job.model, job.language)
        await prism.voice.localDone(job.id, text, null)
      } catch (e) {
        await prism.voice.localDone(job.id, null, e instanceof Error ? e.message : String(e))
      }
    })()
  })
}

/** Windows' own dictation types into the focused box. */
export function windowsDictation(): Promise<void> {
  return prism.voice.dictate()
}
