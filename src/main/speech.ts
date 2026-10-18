// The computer's own voice.
//
// Electron hands the page no voices at all — speechSynthesis.getVoices() is empty on
// every desktop, whatever Windows has installed — so a window that wants to say
// something out loud has to be given the sound. Windows has had a speech engine built
// in for twenty years; this asks it for a recording rather than asking it to make a
// noise, which means the window can play it, stop it, and watch how loud it is.
//
// Starting PowerShell and loading the speech assembly takes the better part of a
// second, which is unbearable before every sentence of a call. So one process is kept
// running and fed lines: after the first, a sentence comes back in well under a tenth
// of a second.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface InstalledVoice {
  name: string
  culture: string
  gender: string
}

/** Reads a line, speaks it into memory, writes the recording back. */
const LOOP = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:PRISM_VOICE) { try { $s.SelectVoice($env:PRISM_VOICE) } catch {} }
if ($env:PRISM_RATE) { try { $s.Rate = [int]$env:PRISM_RATE } catch {} }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  try {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $ms = New-Object System.IO.MemoryStream
    $s.SetOutputToWaveStream($ms)
    $s.Speak($text)
    $s.SetOutputToNull()
    [Console]::Out.WriteLine('ok ' + [Convert]::ToBase64String($ms.ToArray()))
    $ms.Dispose()
  } catch {
    [Console]::Out.WriteLine('no ' + ($_.Exception.Message -replace "\\r|\\n", ' '))
  }
  [Console]::Out.Flush()
}
`

interface Waiting {
  resolve: (wav: Uint8Array) => void
  reject: (e: Error) => void
}

let proc: ChildProcessWithoutNullStreams | null = null
let usingVoice = ''
let usingRate = 0
let pending: Waiting[] = []
let line = ''

function stop(why?: string): void {
  const had = pending
  pending = []
  line = ''
  const p = proc
  proc = null
  if (p) { try { p.kill() } catch { /* already gone */ } }
  for (const w of had) w.reject(new Error(why ?? 'the voice stopped'))
}

function start(voice: string, rate: number): ChildProcessWithoutNullStreams {
  // The script goes in as an argument, not on stdin: "-Command -" reads the whole of
  // stdin as the script before running any of it, so a script fed that way can never
  // then read anything. Encoded like this it also never has to survive being quoted.
  const encoded = Buffer.from(LOOP, 'utf16le').toString('base64')
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, PRISM_VOICE: voice, PRISM_RATE: String(rate) },
    windowsHide: true
  }) as ChildProcessWithoutNullStreams

  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (chunk: string) => {
    line += chunk
    let at = line.indexOf('\n')
    while (at >= 0) {
      const one = line.slice(0, at).trim()
      line = line.slice(at + 1)
      const w = pending.shift()
      if (w) {
        if (one.startsWith('ok ')) w.resolve(Buffer.from(one.slice(3), 'base64'))
        else if (one.startsWith('no ')) w.reject(new Error(one.slice(3)))
        else w.reject(new Error('the voice said something unexpected'))
      }
      at = line.indexOf('\n')
    }
  })
  // PowerShell writes its own formatting chatter to stderr; none of it is ours
  p.stderr.resume()
  p.on('exit', () => { if (proc === p) stop('the voice stopped unexpectedly') })
  p.on('error', (e) => { if (proc === p) stop(e.message) })
  return p
}

/**
 * Speaks, and gives back a WAV. The window plays it, which is what lets it be stopped
 * the instant you talk over it and lets the meter move to the real sound.
 */
export async function speakToWav(text: string, voice = '', rate = 1): Promise<Uint8Array> {
  const words = text.trim()
  if (!words) return new Uint8Array(0)
  if (process.platform !== 'win32') throw new Error('this computer has no built-in voice')
  if (!proc || voice !== usingVoice || rate !== usingRate) {
    stop()
    usingVoice = voice
    usingRate = rate
    proc = start(voice, rate)
  }
  const p = proc
  return new Promise<Uint8Array>((resolve, reject) => {
    // a sentence that never comes back must not leave the call waiting for ever
    const giveUp = setTimeout(() => {
      const at = pending.indexOf(waiting)
      if (at >= 0) pending.splice(at, 1)
      reject(new Error('the voice took too long'))
    }, 20000)
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

/** The voices this computer has, best one first. */
export async function installedVoices(): Promise<InstalledVoice[]> {
  if (process.platform !== 'win32') return []
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Speech; " +
      "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
      "ForEach-Object { $i = $_.VoiceInfo; \"$($i.Name)`t$($i.Culture)`t$($i.Gender)\" }"
    ], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (c) => { out += c })
    p.on('error', () => resolve([]))
    p.on('close', () => {
      const all = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, culture, gender] = l.split('\t')
        return { name: name ?? '', culture: culture ?? '', gender: gender ?? '' }
      }).filter((v) => v.name)
      // the one that matches where the user is reads their words least oddly
      const here = (Intl.DateTimeFormat().resolvedOptions().locale || 'en-GB').slice(0, 2)
      all.sort((a, b) => Number(b.culture.startsWith(here)) - Number(a.culture.startsWith(here)))
      resolve(all)
    })
  })
}

/** Lets go of the speech process when the app is closing. */
export function disposeSpeech(): void {
  stop('the app is closing')
}
