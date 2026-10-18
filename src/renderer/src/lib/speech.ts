// Saying things out loud.
//
// There are three voices and the rest of the app knows about none of them: everything
// goes through speak() and stopSpeaking(). The phone uses Android's. The desktop asks
// Windows for a recording and plays it here, because Electron offers the page no
// voices of its own. Anything else falls back to whatever the browser has.
import { create } from 'zustand'
import { prism } from './ipc'

/** Code, paths and punctuation soup are for reading, not for hearing. */
export function forSpeech(markdown: string): string {
  return (
    markdown
      // fenced code: say that there is some, do not read it
      .replace(/```[\s\S]*?```/g, ' (code) ')
      .replace(/`([^`]+)`/g, '$1')
      // links: the words, not the address
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/[*_>]/g, '')
      // long paths read terribly: the file's name is enough
      .replace(/[\w./\\-]*[/\\]([\w.-]+)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * What the voice is doing right now, which the bars and the face in a call move to.
 *
 * On the desktop the sound is played here, so it is measured: how loud, and roughly
 * where its two lowest resonances sit (f1 and f2), which is what tells ah from ee from oh
 * and shapes the face's mouth. The phone speaks through Android's own voice, which the page never
 * hears; it reports each word as it starts, and the word's letters stand in for the
 * sound. The browser's voice reports words the same way.
 */
export const speechBeat = {
  at: 0,
  level: 0,
  /** sound: f1 and f2 are measured. word: only the word being spoken is known. */
  source: 'sound' as 'sound' | 'word',
  /** Where the sound's weight sits, in Hz: 200-1000 (how open the mouth is) and 1000-3200 (how spread). */
  f1: 0,
  f2: 0,
  word: '',
  wordAt: 0
}

/** A word is being spoken: what the phone and the browser's voice report instead of sound. */
function beatWord(word: string): void {
  const now = Date.now()
  speechBeat.at = now
  speechBeat.level = Math.min(1, 0.45 + word.length / 14)
  speechBeat.source = 'word'
  speechBeat.word = word
  speechBeat.wordAt = now
}

let current: SpeechSynthesisUtterance | null = null
/** Android is speaking through its own voice, which the web page cannot reach. */
let onPhone = false

/**
 * The phone's own voice. Android's web view has no voices of its own — not a
 * setting, it simply does not offer them to a page — so the app asks Android
 * directly instead.
 */
async function phoneSpeak(words: string): Promise<void> {
  const { TextToSpeech } = await import('@capacitor-community/text-to-speech')
  onPhone = true
  // Android says when each word starts, which is all the face has to go on here
  const spoken = await TextToSpeech.addListener('onRangeStart', (info) => beatWord(info.spokenWord ?? '')).catch(() => null)
  try {
    await TextToSpeech.speak({ text: words, rate: 1.1 })
  } finally {
    onPhone = false
    void spoken?.remove()
  }
}

/** The voices this device has. They often arrive a moment after being asked for. */
async function voices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === 'undefined') return []
  const now = speechSynthesis.getVoices()
  if (now.length) return now
  return new Promise((resolve) => {
    const done = (): void => resolve(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 1000)
  })
}

let toldNoVoice = false

// --------------------------------------------------------------- the computer's voice
// Electron gives the page no voices at all, so on the desktop the sound is made by
// Windows and handed back as a recording. Playing it ourselves is better than letting
// the system make the noise: it stops the instant you talk over it, and the bars in the
// call move to how loud it really is rather than to a guess from word boundaries.
let ctx: AudioContext | null = null
let playing: AudioBufferSourceNode | null = null
let watching = 0
let toldTrouble = ''

/**
 * Makes the sound for a line. Which voice that is comes from Settings and is decided
 * on the other side; all that matters here is that a recording comes back.
 */
export async function makeSound(text: string): Promise<Uint8Array> {
  const words = forSpeech(text)
  if (!words) return new Uint8Array(0)
  const { wav, trouble } = await prism.voice.speak(words)
  // it fell back to the plain voice rather than going silent; say so, once
  if (trouble && trouble !== toldTrouble) {
    toldTrouble = trouble
    const { useUi } = await import('@/state/ui')
    useUi.getState().toast('info', 'Using the plain voice', trouble)
  }
  return wav
}

/** Plays a recording, and keeps the meter fed while it plays. */
async function play(wav: Uint8Array): Promise<void> {
  if (!wav.length) return
  ctx = ctx ?? new AudioContext()
  await ctx.resume()
  const buffer = await ctx.decodeAudioData(wav.slice().buffer as ArrayBuffer)
  const source = ctx.createBufferSource()
  const level = ctx.createAnalyser()
  level.fftSize = 512
  // quick to follow the sound, or the mouth trails behind the words
  level.smoothingTimeConstant = 0.45
  source.buffer = buffer
  source.connect(level).connect(ctx.destination)

  const samples = new Uint8Array(level.fftSize)
  const spectrum = new Float32Array(level.frequencyBinCount)
  const binHz = ctx.sampleRate / level.fftSize
  /** The middle of the sound's weight between two frequencies, in Hz. */
  const centre = (from: number, to: number): number => {
    let weight = 0
    let sum = 0
    for (let k = Math.round(from / binHz); k <= Math.round(to / binHz); k++) {
      const power = Math.pow(10, (spectrum[k] ?? -200) / 10)
      weight += power
      sum += power * k * binHz
    }
    return weight ? sum / weight : 0
  }
  clearInterval(watching)
  watching = window.setInterval(() => {
    level.getByteTimeDomainData(samples)
    let peak = 0
    for (const v of samples) peak = Math.max(peak, Math.abs(v - 128))
    speechBeat.at = Date.now()
    speechBeat.level = Math.min(1, peak / 70)
    level.getFloatFrequencyData(spectrum)
    speechBeat.source = 'sound'
    speechBeat.f1 = centre(200, 1000)
    speechBeat.f2 = centre(1000, 3200)
  }, 40)

  playing = source
  await new Promise<void>((resolve) => {
    source.onended = () => resolve()
    source.start()
  })
  if (playing === source) playing = null
  clearInterval(watching)
  watching = 0
  speechBeat.level = 0
  speechBeat.f1 = speechBeat.f2 = 0
  speechBeat.word = ''
}

/** Plays a recording made earlier, which is how the better voice hides its delay. */
export async function playSound(wav: Uint8Array): Promise<void> {
  stopSpeaking()
  await play(wav)
}

/** Speaks, and resolves when it has finished or been stopped. */
export async function speak(text: string): Promise<void> {
  const words = forSpeech(text)
  if (!words) return
  if (window.__prismMobile) return phoneSpeak(words)

  stopSpeaking()

  // The desktop's own voice, which inside Electron is the only one there is.
  let why = ''
  try {
    return await play(await makeSound(words))
  } catch (e) {
    why = String((e as Error)?.message ?? e)
  }

  // Anywhere else, whatever voices the page has. Some web views have none at all,
  // which is silence with no error — worse than being told.
  if (!(await voices()).length) {
    if (!toldNoVoice) {
      toldNoVoice = true
      const { useUi } = await import('@/state/ui')
      useUi.getState().toast('info', 'This device has no voice', why || 'It can hear you and the conversation carries on; it just cannot read its answers out here.')
    }
    return
  }
  return new Promise<void>((resolve) => {
    const u = new SpeechSynthesisUtterance(words)
    u.rate = 1.05
    current = u
    const done = (): void => {
      if (current === u) current = null
      resolve()
    }
    u.onboundary = (e) => {
      // longer words land harder, which is roughly how speech sounds
      const word = words.slice(e.charIndex).split(/\s/)[0] ?? ''
      beatWord(word)
    }
    u.onend = done
    u.onerror = done
    speechSynthesis.speak(u)
  })
}

export function stopSpeaking(): void {
  current = null
  if (playing) {
    const source = playing
    playing = null
    // onended still fires, so whoever was waiting on speak() is let go
    try { source.stop() } catch { /* already finished */ }
  }
  clearInterval(watching)
  watching = 0
  speechBeat.level = 0
  speechBeat.f1 = speechBeat.f2 = 0
  speechBeat.word = ''
  if (onPhone) void import('@capacitor-community/text-to-speech').then((m) => m.TextToSpeech.stop()).catch(() => {})
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}

// ------------------------------------------------------------- reading one aloud
// The play button under an answer, for hearing it without being on a call.

/** Which answer is being read out, so its button can say Stop instead of Play. */
export const useReading = create<{ id: string | null }>(() => ({ id: null }))

/** Bumped every time reading starts or stops, so a reading that has been replaced knows to stop. */
let reading = 0

/**
 * An answer in pieces of a few sentences each.
 *
 * Handed to the good voice whole, a long answer means several seconds of silence
 * before anything is heard, because the whole thing is made before any of it plays.
 * In pieces, the first is ready almost at once and the rest are made while it plays.
 */
function pieces(text: string): string[] {
  const words = forSpeech(text)
  const sentences = words.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [words]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (cur && (cur + s).length > 280) {
      out.push(cur.trim())
      cur = ''
    }
    cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export function stopReading(): void {
  reading++
  useReading.setState({ id: null })
  stopSpeaking()
}

/** Reads an answer out, or stops it if it is the one already being read. */
export async function readAloud(id: string, text: string): Promise<void> {
  if (useReading.getState().id === id) return stopReading()
  stopReading()
  const mine = ++reading
  useReading.setState({ id })
  const still = (): boolean => mine === reading
  try {
    const parts = pieces(text)
    if (window.__prismMobile) {
      // the phone's own voice makes the sound as it speaks: nothing to get ready
      for (const p of parts) {
        if (!still()) return
        await speak(p)
      }
      return
    }
    const ready = (t: string): Promise<Uint8Array> => {
      const p = makeSound(t)
      p.catch(() => {}) // one that is never played must not complain about it
      return p
    }
    let next: Promise<Uint8Array> | null = parts.length ? ready(parts[0]!) : null
    for (let i = 0; i < parts.length; i++) {
      if (!still() || !next) return
      const sound = await next
      next = i + 1 < parts.length ? ready(parts[i + 1]!) : null
      if (!still()) return
      await playSound(sound)
    }
  } catch (e) {
    const { toastError } = await import('@/state/ui')
    toastError(e, 'Could not read that out')
  } finally {
    if (still()) useReading.setState({ id: null })
  }
}
