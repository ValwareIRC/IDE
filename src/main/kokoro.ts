// A much better voice than the computer's own.
//
// Kokoro is a small speech model that runs on this machine. It sounds like a person
// rather than a satnav, and the cost is about a second a sentence instead of fifteen
// milliseconds — which the call hides, because it is already speaking one sentence
// while the next is being made.
//
// Prism does not ship it. It uses an install already on the computer: a Python with
// kokoro-onnx in it, and the two model files. The folder is set in Settings, and if
// anything is missing it says exactly which piece, because "no voice" is useless.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface KokoroWhere {
  /** The folder holding .venv and models/. */
  path: string
  /** Which voice, e.g. bf_emma. */
  voice: string
}

/** Loads the model once, then speaks a line at a time for as long as it is fed. */
const LOOP = `
import sys, base64, io, json
import soundfile as sf
from kokoro_onnx import Kokoro

model = sys.argv[1]
voices = sys.argv[2]
voice = sys.argv[3]
k = Kokoro(model, voices)
# print, never an escaped newline: this script passes through a TypeScript template
# literal on its way here, and every backslash in it has to survive two readings
print("ready", file=sys.stderr, flush=True)

# readline, not "for line in sys.stdin": iterating reads ahead in big blocks and so
# sits on the first line until enough has arrived to fill a buffer, which never happens
# when the lines come one answer at a time.
while True:
    line = sys.stdin.readline()
    if not line:
        break
    line = line.strip()
    if not line:
        continue
    try:
        text = base64.b64decode(line).decode("utf-8")
        samples, rate = k.create(text, voice=voice, speed=1.0, lang="en-gb")
        buf = io.BytesIO()
        sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
        print("ok " + base64.b64encode(buf.getvalue()).decode("ascii"), flush=True)
    except Exception as e:
        print("no " + " ".join(str(e).split()), flush=True)
`

interface Waiting {
  resolve: (wav: Uint8Array) => void
  reject: (e: Error) => void
}

let proc: ChildProcessWithoutNullStreams | null = null
let usingPath = ''
let usingVoice = ''
let pending: Waiting[] = []
let line = ''

/** Where an install usually ends up, so the setting can be left empty. */
const LIKELY = ['C:\\AI\\RadioShow', 'C:\\AI\\Kokoro', join(process.env.USERPROFILE ?? '', 'kokoro')]

/** The folder to use: the one that was set, or the first likely one that is there. */
export function whereKokoro(path: string): string {
  if (path) return path
  return LIKELY.find((p) => p && existsSync(join(p, 'models', 'kokoro-v1.0.onnx'))) ?? ''
}

/** The pieces a working install is made of, and what to say when one is missing. */
export function checkKokoro(set: string): { ok: true; path: string; python: string; model: string; voices: string } | { ok: false; why: string } {
  const path = whereKokoro(set)
  if (!path) return { ok: false, why: 'No folder set for the better voice, and none found in the usual places.' }
  if (!existsSync(path)) return { ok: false, why: 'There is no folder at ' + path + '.' }
  const python = join(path, '.venv', 'Scripts', 'python.exe')
  const model = join(path, 'models', 'kokoro-v1.0.onnx')
  const voices = join(path, 'models', 'voices-v1.0.bin')
  if (!existsSync(python)) return { ok: false, why: 'No Python in ' + join(path, '.venv') + '.' }
  if (!existsSync(model)) return { ok: false, why: 'No model file at ' + model + '.' }
  if (!existsSync(voices)) return { ok: false, why: 'No voices file at ' + voices + '.' }
  return { ok: true, path, python, model, voices }
}

function stop(why?: string): void {
  const had = pending
  pending = []
  line = ''
  const p = proc
  proc = null
  if (p) { try { p.kill() } catch { /* already gone */ } }
  for (const w of had) w.reject(new Error(why ?? 'the voice stopped'))
}

function start(where: KokoroWhere): ChildProcessWithoutNullStreams {
  const found = checkKokoro(where.path)
  if (!found.ok) throw new Error(found.why)
  const p = spawn(found.python, ['-u', '-c', LOOP, found.model, found.voices, where.voice || 'bf_emma'], {
    cwd: found.path,
    windowsHide: true
  }) as ChildProcessWithoutNullStreams

  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (chunk: string) => {
    line += chunk
    let at = line.indexOf('\n')
    while (at >= 0) {
      const one = line.slice(0, at).trim()
      line = line.slice(at + 1)
      if (one) {
        const w = pending.shift()
        if (w) {
          if (one.startsWith('ok ')) w.resolve(Buffer.from(one.slice(3), 'base64'))
          else if (one.startsWith('no ')) w.reject(new Error(one.slice(3)))
          else w.reject(new Error('the voice said something unexpected'))
        }
      }
      at = line.indexOf('\n')
    }
  })
  // the model's own loading chatter; only its dying words matter
  let lastWords = ''
  p.stderr.setEncoding('utf8')
  p.stderr.on('data', (c: string) => { lastWords = c.trim().slice(-300) })
  p.on('exit', () => { if (proc === p) stop(lastWords || 'the better voice stopped unexpectedly') })
  p.on('error', (e) => { if (proc === p) stop(e.message) })
  return p
}

/** Speaks, and gives back a WAV. */
export async function kokoroToWav(text: string, where: KokoroWhere): Promise<Uint8Array> {
  const words = text.trim()
  if (!words) return new Uint8Array(0)
  if (!proc || where.path !== usingPath || where.voice !== usingVoice) {
    stop()
    usingPath = where.path
    usingVoice = where.voice
    proc = start(where)
  }
  const p = proc
  return new Promise<Uint8Array>((resolve, reject) => {
    // the model takes a moment to load the first time, so the first line waits longer
    const giveUp = setTimeout(() => {
      const at = pending.indexOf(waiting)
      if (at >= 0) pending.splice(at, 1)
      reject(new Error('the better voice took too long'))
    }, 60000)
    const waiting: Waiting = {
      resolve: (wav) => { clearTimeout(giveUp); resolve(wav) },
      reject: (e) => { clearTimeout(giveUp); reject(e) }
    }
    pending.push(waiting)
    try {
      p.stdin.write(Buffer.from(words, 'utf8').toString('base64') + '\n')
    } catch (e) {
      waiting.reject(e as Error)
      const at = pending.indexOf(waiting)
      if (at >= 0) pending.splice(at, 1)
    }
  })
}

/** The voices a Kokoro install offers. */
export async function kokoroVoices(path: string): Promise<string[]> {
  const found = checkKokoro(path)
  if (!found.ok) return []
  return new Promise((resolve) => {
    const p = spawn(found.python, ['-c',
      'import sys;from kokoro_onnx import Kokoro;' +
      'print("\\n".join(sorted(Kokoro(sys.argv[1], sys.argv[2]).get_voices())))',
      found.model, found.voices], { cwd: found.path, windowsHide: true })
    let out = ''
    p.stdout.on('data', (c) => { out += c })
    p.on('error', () => resolve([]))
    p.on('close', () => resolve(out.split('\n').map((l) => l.trim()).filter((l) => /^[a-z]{2}_/.test(l))))
  })
}

export function disposeKokoro(): void {
  stop('the app is closing')
}
