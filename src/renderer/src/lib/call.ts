// A voice call with the agent: you talk, it listens until you stop, it answers out
// loud, and you can talk over it. Everything said is also written in the
// conversation, which stays on screen the whole time — the call is a bar, not a
// takeover.
//
// The round trip is the one the microphone button already uses (your voice →
// Whisper → the agent → its reply → a voice), so there is a pause between you
// finishing and it answering. That is the shape of it, not a fault.
import { create } from 'zustand'
import { useSessions } from '@/state/sessions'
import { prism } from './ipc'
import { toastError } from '@/state/ui'
import { transcribe } from './voice'
import { makeSound, playSound, speak, stopSpeaking } from './speech'

interface CallState {
  /** The session being talked to, or null when there is no call. */
  on: string | null
  /** listening: waiting for you. heard: you are talking. working: it is thinking. speaking: it is talking. */
  stage: 'listening' | 'heard' | 'working' | 'speaking'
  /** Microphone loudness, 0 to 1, for the bar. */
  level: number
  /** The last thing it said out loud, so the bar can show it as well as say it. */
  said: string
  muted: boolean
}

export const useCall = create<CallState>(() => ({ on: null, stage: 'listening', level: 0, said: '', muted: false }))

/** Quiet for this long after you have spoken means you have finished. */
const SILENCE_MS = 1200
/** Below this is silence. */
const SPEAKING_LEVEL = 0.12
/**
 * Its own voice reaches the microphone while it talks - on the phone above all, where
 * Android speaks outside the page and the echo cancelling cannot take it out. So talking
 * over it has to be clearly you: louder than its echo, held for a moment.
 */
const OVER_LEVEL = window.__prismMobile ? 0.45 : 0.28
const OVER_MS = window.__prismMobile ? 700 : 450
/**
 * A voice, rather than hiss or a click: how flat the sound's spectrum is between 250 and
 * 4000 Hz. A voice puts its energy in the harmonics of its pitch and measures well under
 * this (0.04 to 0.38); hiss - a headset's own mute button cutting the microphone, with
 * the automatic volume turning the silence right up - measures 0.4 to 0.95. Measured
 * with scripts/call-test/voice.cjs. Whisper given hiss writes sentences nobody said.
 */
const VOICE_FLATNESS = 0.3
/** At least this much actual voice in a stretch (in 80 ms checks) before it is sent at all. */
const MIN_VOICED = 3
/** After it stops, its voice carries on in the room (and the phone's speaker) a little longer. */
const TAIL_MS = window.__prismMobile ? 900 : 600
/** Shorter than this was a cough, not a sentence. */
const MIN_SPEECH_MS = 400

let live: {
  stream: MediaStream
  ctx: AudioContext
  recorder: MediaRecorder
  chunks: Blob[]
  timer: number
  /** When the current run of speech began, or 0 while quiet. */
  since: number
  /** When it last went quiet after speech, or 0. */
  quietFrom: number
  /** A stretch of speech is already on its way to being words. */
  busy: boolean
  /** When a loud stretch over its own voice began, or 0, and when it was last loud. */
  overFrom: number
  overLast: number
  /** How much of the current stretch, and of a stretch over its voice, was actually a voice. */
  voiced: number
  overVoiced: number
  /** Until when what the microphone hears is still its own voice dying away. */
  quietUntil: number
  /** Start a clean recording once its voice has died away. */
  afterVoice: boolean
} | null = null

/** The microphone was muted by the device rather than the mute button. */
let deviceMuted = false

/** What it has said out loud lately, to tell its own voice coming back from you. */
const recentlySaid: Array<{ text: string; at: number }> = []

const wordsOf = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** Most of what was heard is words it has just said: its own voice, picked up again. */
function ownVoice(heard: string): boolean {
  const h = wordsOf(heard)
  const said = new Set(wordsOf(recentlySaid.filter((x) => Date.now() - x.at < 45_000).map((x) => x.text).join(' ')))
  if (h.length < 3 || !said.size) return false
  return h.filter((w) => said.has(w)).length / h.length >= 0.8
}

/**
 * What the speech-to-text writes when it hears silence, hum, or the tail of a voice:
 * never someone talking. A lone "you" is the classic one.
 */
const NOTHING_SAID = new Set(['you', 'thanks for watching', 'thank you for watching', 'please subscribe', 'blank audio', 'silence', 'music'])
function nothingSaid(heard: string): boolean {
  const n = wordsOf(heard.replace(/'/g, '')).join(' ')
  return !n || NOTHING_SAID.has(n)
}


/**
 * Starts a fresh recording on the open microphone. Each one is a whole file.
 *
 * The one already running has to be ended first, and told to stop reporting before it
 * is: two recorders on one microphone both put their pieces in the same list, and the
 * mixture of two streams is not a sound file at all. That is what made the second thing
 * said in a call come back as something nothing could decode — the agent answering
 * started a recording without ending the one that was already going.
 */
function listen(r: NonNullable<typeof live>): void {
  const old = r.recorder
  if (old) {
    old.ondataavailable = null
    old.onstop = null
    if (old.state !== 'inactive') old.stop()
  }
  r.chunks.length = 0
  const rec = new MediaRecorder(r.stream, { mimeType: 'audio/webm;codecs=opus' })
  rec.ondataavailable = (e) => e.data.size && r.chunks.push(e.data)
  rec.start(250)
  r.recorder = rec
}

/** A soft blip, so a step the agent takes is heard without being read out. */
export function blip(): void {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.2)
    osc.onended = () => void ctx.close()
  } catch {
    /* no sound is not worth an error */
  }
}

export async function startCall(sessionId: string): Promise<void> {
  if (live) return
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  // The device muting the microphone (a headset switch, the system's own mute) counts as
  // the mute button, and its unmuting undoes only a mute it caused.
  const mic = stream.getAudioTracks()[0]
  if (mic) {
    mic.onmute = () => {
      if (!live || useCall.getState().muted) return
      deviceMuted = true
      setMuted(true)
    }
    mic.onunmute = () => {
      if (!live || !deviceMuted) return
      deviceMuted = false
      setMuted(false)
    }
  }
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  ctx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  const spectrum = new Float32Array(analyser.frequencyBinCount)
  const binHz = ctx.sampleRate / analyser.fftSize
  const lo = Math.round(250 / binHz)
  const hi = Math.round(4000 / binHz)
  /** The sound right now is a voice, not hiss or a click (see VOICE_FLATNESS). */
  const isVoice = (): boolean => {
    analyser.getFloatFrequencyData(spectrum)
    let logSum = 0
    let sum = 0
    for (let k = lo; k <= hi; k++) {
      const db = spectrum[k] ?? -200
      const power = Number.isFinite(db) ? Math.pow(10, db / 10) : 1e-20
      logSum += Math.log(Math.max(power, 1e-20))
      sum += power
    }
    const n = hi - lo + 1
    return sum > 0 && Math.exp(logSum / n) / (sum / n) < VOICE_FLATNESS
  }
  const chunks: Blob[] = []

  const timer = window.setInterval(() => {
    if (!live) return
    analyser.getByteTimeDomainData(buf)
    let peak = 0
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
    const level = Math.min(1, peak / 64)
    useCall.setState({ level })
    if (useCall.getState().muted) return
    const loud = level > SPEAKING_LEVEL
    const stage = useCall.getState().stage
    const now = Date.now()

    if (stage === 'speaking') {
      live.quietUntil = now + TAIL_MS
      live.afterVoice = true
      if (level > OVER_LEVEL) {
        // possibly you: record from here, so your first words are in it and its voice before them is not
        if (!live.overFrom) {
          live.overFrom = now
          live.overVoiced = 0
          if (!live.busy) listen(live)
        }
        live.overLast = now
        if (isVoice()) live.overVoiced++
      } else if (live.overFrom && now - live.overLast > 250) {
        // speech dips between syllables; a longer gap means it was not you after all
        live.overFrom = 0
      }
      // and it has to be a voice, not hiss
      if (!live.overFrom || now - live.overFrom < OVER_MS || live.overVoiced < 2) return
      // Talking over it stops it talking, and drops everything it still meant to say,
      // not just the sentence in its mouth - otherwise it carries on as if you hadn't.
      stopSpeaking()
      dropWhatIsWaiting()
      useCall.setState({ stage: 'heard' })
      live.since = live.overFrom
      live.voiced = live.overVoiced
      live.overFrom = 0
      live.quietFrom = 0
      live.quietUntil = 0
      live.afterVoice = false
      return
    }
    // one stretch at a time, but it keeps listening while the agent works
    if (live.busy) return
    // its own voice still dying away in the room is not you; once it has, start a clean recording
    if (!live.since && now < live.quietUntil) return
    if (live.afterVoice && !live.since) {
      live.afterVoice = false
      listen(live)
    }

    // Hiss counts as quiet: a headset's mute button pressed mid-sentence leaves the
    // microphone hissing, and that is you having stopped, not you still talking.
    const voice = loud && isVoice()
    if (voice) {
      if (!live.since) {
        live.since = now
        live.voiced = 0
      }
      live.voiced++
      live.quietFrom = 0
      if (stage !== 'heard') useCall.setState({ stage: 'heard' })
      return
    }
    // Quiet, or not a voice (a breath, an s, hiss). A stretch of speech ends after this
    // has lasted a moment; if it was a real stretch of voice, it is sent.
    if (!live.since) return
    if (!live.quietFrom) live.quietFrom = Date.now()
    if (Date.now() - live.quietFrom < SILENCE_MS) return
    const spoke = live.quietFrom - live.since
    live.since = 0
    live.quietFrom = 0
    // too short, or too little of it was a voice: never sent, so Whisper is never given hiss
    if (spoke < MIN_SPEECH_MS || live.voiced < MIN_VOICED) {
      useCall.setState({ stage: 'listening' })
      return
    }
    void turn(sessionId)
  }, 80)

  live = { stream, ctx, recorder: null as unknown as MediaRecorder, chunks, timer, since: 0, quietFrom: 0, busy: false, overFrom: 0, overLast: 0, voiced: 0, overVoiced: 0, quietUntil: 0, afterVoice: false }
  listen(live)
  useCall.setState({ on: sessionId, stage: 'listening', level: 0, said: '', muted: false })
}

/** One go: what you just said, sent, answered, and spoken back. */
async function turn(sessionId: string): Promise<void> {
  if (!live || live.busy) return
  const r = live
  r.busy = true
  // you have said something new, so anything it was still queued up to say about the
  // last thing is out of date
  dropWhatIsWaiting()
  useCall.setState({ stage: 'working' })
  // A recording has its header in the first piece and nothing but continuation
  // after, so a slice out of the middle is not a sound file at all. Each stretch
  // of speech is its own recording, ended properly and started again at once so
  // nothing is missed while this one is being read.
  const blob = await new Promise<Blob>((resolve) => {
    r.recorder.onstop = () => resolve(new Blob(r.chunks, { type: 'audio/webm' }))
    if (r.recorder.state === 'inactive') resolve(new Blob(r.chunks, { type: 'audio/webm' }))
    else r.recorder.stop()
  })
  if (live === r && !useCall.getState().muted) listen(r)
  try {
    const text = (await transcribe(blob)).trim()
    // its own voice coming back, or the speech-to-text hearing only silence: not something you said
    if (text && !nothingSaid(text) && !ownVoice(text)) {
      const s = useSessions.getState()
      // Speaking while it works steers it, exactly as typing then would. Sending it
      // as a new message is refused while a turn is running, which is what ended
      // the call the moment you said a second thing.
      if (s.live[sessionId]?.running) {
        const took = await prism.agent.steer(sessionId, text).catch(() => false)
        if (!took) s.enqueue(text, sessionId)
      } else await s.send(text, {}, sessionId)
    }
  } catch (e) {
    toastError(e, 'The call could not send that')
    // on a call a toast is nothing: it has to be heard, or it looks like it is just
    // going round and round
    await sayOutLoud('Sorry, I did not catch that.').catch(() => {})
  } finally {
    if (live) live.busy = false
    if (useCall.getState().stage === 'working') useCall.setState({ stage: 'listening' })
  }
}

/**
 * Things waiting to be said, in the order they were said.
 *
 * One turn can produce several of them — a sentence, a tool, another sentence — and
 * they arrive faster than they can be spoken. Starting a voice stops whatever is
 * already talking, so without somewhere to wait they talk over each other and only
 * the last one is ever heard.
 */
type Waiting = { say: string } | { blip: true } | { gesture: string }
const toSay: Waiting[] = []
let talking = false

/**
 * The next line, already being made while the current one is still playing.
 *
 * The good voice takes about a second a sentence and makes sound four times faster
 * than it plays, so starting the next one early means only the very first sentence of
 * an answer ever waits. The plain voice is fast enough not to care either way.
 */
let ahead: { text: string; sound: Promise<Uint8Array> } | null = null

/** Forgets whatever is still waiting: you have interrupted, or the call has ended. */
function dropWhatIsWaiting(): void {
  toSay.length = 0
  // a sound already being made is let go of; nothing is waiting on it now
  ahead?.sound.catch(() => {})
  ahead = null
}

/** The agent said something: speak it, after anything already waiting. */
export async function sayOutLoud(text: string): Promise<void> {
  if (!useCall.getState().on || !text.trim()) return
  return enqueue({ say: text })
}

/**
 * The agent reached for a tool. On a call this is a blip rather than a sentence, and
 * it waits its turn like everything else — it belongs after whatever it said just
 * before reaching, not on top of it.
 */
export function blipInCall(): void {
  if (!useCall.getState().on) return blip()
  void enqueue({ blip: true })
}

/**
 * The agent moved its face. It waits its turn too, so a wave the agent gives after
 * saying hello comes after the hello, and does not hold up what comes next.
 */
export function gestureInCall(gesture: string): void {
  if (!useCall.getState().on) return
  void enqueue({ gesture })
}

async function enqueue(item: Waiting): Promise<void> {
  toSay.push(item)
  if (talking) return
  talking = true
  try {
    while (toSay.length && useCall.getState().on) {
      const next = toSay.shift()
      if (!next) break
      if ('blip' in next) {
        blip()
        await new Promise((r) => setTimeout(r, 220))
        continue
      }
      if ('gesture' in next) {
        void import('./face').then((m) => m.faceGesture(next.gesture))
        continue
      }
      // Its own voice is not something you said, so the recording starts again here —
      // as a whole new recording. Emptying the pieces of the one already running
      // would throw away its header and leave the next thing you say unreadable.
      if (live && !live.busy && !useCall.getState().muted) listen(live)
      useCall.setState({ stage: 'speaking', said: next.say })
      recentlySaid.push({ text: next.say, at: Date.now() })
      while (recentlySaid.length > 40) recentlySaid.shift()
      try {
        if (window.__prismMobile) {
          // the phone's own voice makes the sound as it speaks; there is nothing to get ready
          await speak(next.say)
        } else {
          const sound = ahead && ahead.text === next.say ? ahead.sound : makeSound(next.say)
          ahead = null
          const after = toSay.find((x) => 'say' in x)
          if (after && 'say' in after) ahead = { text: after.say, sound: makeSound(after.say) }
          await playSound(await sound)
        }
      } catch {
        /* a voice that will not speak should not end the call */
      }
    }
  } finally {
    talking = false
    if (useCall.getState().on && useCall.getState().stage === 'speaking') useCall.setState({ stage: 'listening' })
  }
}

/**
 * Muted means nothing heard reaches the agent. The microphone used to go on recording
 * underneath, and the next thing you said was sent with everything from the muted
 * stretch in front of it - whoever you were talking to, the television - which came
 * back as strange things you had never said to it.
 */
export function setMuted(muted: boolean): void {
  useCall.setState({ muted })
  const r = live
  if (muted) {
    stopSpeaking()
    dropWhatIsWaiting()
    if (r) {
      // A recording already on its way to being words is left to finish: it is from
      // before you muted. Otherwise what was being recorded is thrown away.
      if (!r.busy) hush(r)
      r.since = 0
      r.quietFrom = 0
      r.overFrom = 0
      r.afterVoice = false
    }
    if (useCall.getState().stage === 'heard') useCall.setState({ stage: 'listening' })
  } else if (r && !r.busy) {
    // a clean recording from the moment you unmute; the click of unmuting is not you
    listen(r)
    r.quietUntil = Date.now() + 300
  }
}

/** Stops recording and throws away what was recorded. */
function hush(r: NonNullable<typeof live>): void {
  const rec = r.recorder
  if (rec) {
    rec.ondataavailable = null
    rec.onstop = null
    if (rec.state !== 'inactive') rec.stop()
  }
  r.chunks.length = 0
}

export function endCall(): void {
  stopSpeaking()
  dropWhatIsWaiting()
  deviceMuted = false
  const r = live
  live = null
  if (r) {
    clearInterval(r.timer)
    if (r.recorder.state !== 'inactive') r.recorder.stop()
    r.stream.getTracks().forEach((t) => t.stop())
    void r.ctx.close()
  }
  useCall.setState({ on: null, stage: 'listening', level: 0, said: '', muted: false })
}
