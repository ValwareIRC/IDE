// Speech to text for the message box, three ways (Settings, Conversation, Voice input):
// - local: a Whisper model run inside Prism. Its files come from Hugging Face once, through prism://hf/…,
//   and are kept in userData/hf, so after the first use nothing leaves the computer.
// - provider: the recording goes to an OpenAI-compatible /audio/transcriptions on one of the user's providers.
// - windows: Windows' own dictation (Win+H) types into the focused box.
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { net } from 'electron'
import type { Endpoint } from '@shared/types'
import { normalizeBase } from '@core/providers/openai'

const HF = 'https://huggingface.co/'
const SAFE = /^[\w.-]+\/[\w.-]+\/resolve\/[\w.-]+\/[\w./-]+$/

/** prism://hf/<org>/<model>/resolve/<revision>/<file>: the kept copy, or Hugging Face's while keeping it. */
export async function serveModelFile(userData: string, rel: string, req: Request): Promise<Response> {
  if (!SAFE.test(rel) || rel.includes('..')) return new Response('forbidden', { status: 403 })
  const root = join(userData, 'hf')
  const file = normalize(join(root, rel))
  if (!file.startsWith(root + sep)) return new Response('forbidden', { status: 403 })
  const cors = { 'Access-Control-Allow-Origin': '*' }
  // "does it exist, and how big is it": answered without downloading the file
  if (req.headers.get('range') === 'bytes=0-0' || req.method === 'HEAD') {
    let size: number | null = existsSync(file) ? statSync(file).size : null
    if (size === null) {
      const head = await net.fetch(HF + rel, { method: 'HEAD', redirect: 'follow' })
      if (!head.ok) return new Response(null, { status: head.status, headers: cors })
      const n = Number(head.headers.get('x-linked-size') ?? head.headers.get('content-length'))
      size = Number.isFinite(n) && n > 0 ? n : 0
    }
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(1), { status: req.method === 'HEAD' ? 200 : 206, headers: { ...cors, 'Content-Length': req.method === 'HEAD' ? String(size) : '1', 'Content-Range': `bytes 0-0/${size}`, 'Content-Type': 'application/octet-stream' } })
  }
  if (existsSync(file)) {
    const r = await net.fetch(`file:///${file.replace(/\\/g, '/')}`)
    const headers = new Headers(r.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Content-Length', String(statSync(file).size))
    return new Response(req.method === 'HEAD' ? null : r.body, { status: 200, headers })
  }
  const up = await net.fetch(HF + rel, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', redirect: 'follow' })
  const headers = new Headers({ ...cors, 'Content-Type': up.headers.get('content-type') ?? 'application/octet-stream' })
  const len = up.headers.get('content-length')
  if (len) headers.set('Content-Length', len)
  if (!up.ok || !up.body) return new Response(up.body, { status: up.status, headers })
  // already being kept by another request: this one only passes it through
  if (keeping.has(file)) return new Response(up.body, { status: 200, headers })
  // one copy to the page as it arrives, one to disk; the file only takes its name once complete
  const [toPage, toDisk] = up.body.tee()
  mkdirSync(dirname(file), { recursive: true })
  const part = `${file}.part`
  keeping.add(file)
  const out = createWriteStream(part)
  Readable.fromWeb(toDisk as unknown as import('node:stream/web').ReadableStream).pipe(out)
  out.on('finish', () => {
    keeping.delete(file)
    try {
      if (!len || statSync(part).size === Number(len)) renameSync(part, file)
      else rmSync(part, { force: true })
    } catch {
      /* kept next time */
    }
  })
  out.on('error', () => {
    keeping.delete(file)
    rmSync(part, { force: true })
  })
  return new Response(toPage, { status: 200, headers })
}

const keeping = new Set<string>()

/** Speech models kept on disk (org/name), with their size. */
export function keptModels(userData: string): Array<{ repo: string; bytes: number }> {
  const root = join(userData, 'hf')
  if (!existsSync(root)) return []
  const size = (p: string): number => (statSync(p).isDirectory() ? readdirSync(p).reduce((a, f) => a + size(join(p, f)), 0) : statSync(p).size)
  const out: Array<{ repo: string; bytes: number }> = []
  for (const org of readdirSync(root)) for (const name of readdirSync(join(root, org))) out.push({ repo: `${org}/${name}`, bytes: size(join(root, org, name)) })
  return out
}

export function forgetModel(userData: string, repo: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Not a model name.')
  rmSync(join(userData, 'hf', ...repo.split('/')), { recursive: true, force: true })
}

/** Send a recording to an OpenAI-compatible transcription endpoint. */
export async function transcribeWithProvider(ep: Endpoint, key: string | null, model: string, audio: Uint8Array, mime: string, language: string): Promise<string> {
  let url = normalizeBase(ep.baseUrl) + '/audio/transcriptions'
  const headers: Record<string, string> = { ...ep.extraHeaders }
  if (key) {
    if (ep.auth.kind === 'bearer') headers['Authorization'] = `Bearer ${key}`
    else if (ep.auth.kind === 'header' && ep.auth.name) headers[ep.auth.name] = key
    else if (ep.auth.kind === 'query' && ep.auth.name) url += `?${encodeURIComponent(ep.auth.name)}=${encodeURIComponent(key)}`
  }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), mime.includes('wav') ? 'speech.wav' : 'speech.webm')
  form.append('model', model)
  form.append('response_format', 'json')
  if (language) form.append('language', language)
  const r = await fetch(url, { method: 'POST', headers, body: form })
  const text = await r.text()
  if (!r.ok) throw new Error(`${ep.name} said ${r.status}: ${text.slice(0, 300)}`)
  try {
    const j = JSON.parse(text) as { text?: string }
    return (j.text ?? '').trim()
  } catch {
    return text.trim()
  }
}

/** Open Windows' dictation (Win+H); it types into whatever box has the focus. */
export function startWindowsDictation(): Promise<void> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows dictation is only on Windows.'))
  const script =
    "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, System.UIntPtr e);';" +
    '[W.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero);[W.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero);[W.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero);[W.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)'
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not open Windows dictation (exit ${code}).`))))
  })
}
