// How a voice looks to the call's microphone check, next to the things that are not a
// voice: hiss (a muted headset mic with its gain turned right up), a click, silence.
// The check is the call's own (lib/call.ts): a 512-point analyser at 48 kHz, smoothing
// 0.8, read every 80 ms; loudness from the waveform's peak, and "flatness" from the
// spectrum between 250 and 4000 Hz - near 1 for hiss, low for a voice, whose energy sits
// in the harmonics of its pitch.
//   node voice.cjs file.wav ...      (also runs the made-up hiss, click and silence)
const fs = require('fs')

function readWav(path) {
  const b = fs.readFileSync(path)
  let at = 12, rate = 24000, bits = 16, channels = 1, data = null, format = 1
  while (at < b.length) {
    const id = b.toString('ascii', at, at + 4), len = b.readUInt32LE(at + 4)
    if (id === 'fmt ') { format = b.readUInt16LE(at + 8); channels = b.readUInt16LE(at + 10); rate = b.readUInt32LE(at + 12); bits = b.readUInt16LE(at + 22) }
    if (id === 'data') data = b.subarray(at + 8, at + 8 + len)
    at += 8 + len + (len % 2)
  }
  const n = data.length / (bits / 8) / channels
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * channels * (bits / 8)
    out[i] = format === 3 ? data.readFloatLE(o) : bits === 16 ? data.readInt16LE(o) / 32768 : data.readInt32LE(o) / 2147483648
  }
  return { rate, samples: out }
}

function to48k({ rate, samples }) {
  if (rate === 48000) return samples
  const k = 48000 / rate, out = new Float32Array(Math.floor(samples.length * k))
  for (let i = 0; i < out.length; i++) { const x = i / k, i0 = Math.floor(x), f = x - i0; out[i] = (samples[i0] ?? 0) * (1 - f) + (samples[i0 + 1] ?? 0) * f }
  return out
}

function fftMag(frame) {
  const N = frame.length, re = Float64Array.from(frame), im = new Float64Array(N)
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] } }
  for (let len = 2; len <= N; len <<= 1) {
    const a = (-2 * Math.PI) / len
    for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(a * k), wi = Math.sin(a * k), xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi, xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr
      re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi
    }
  }
  const mag = new Float64Array(N / 2)
  for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / N
  return mag
}

/** Every 80 ms: [level, flatness], as the call's check sees them. */
function analyse(s) {
  const N = 512, binHz = 48000 / N, tau = 0.8
  const win = Float64Array.from({ length: N }, (_, i) => 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N))
  const k0 = Math.round(250 / binHz), k1 = Math.round(4000 / binHz)
  let smooth = new Float64Array(N / 2)
  const rows = []
  // the analyser smooths across every block the audio passes through, not just the ones read
  for (let t = 0; t + N < s.length; t += N) {
    const frame = Float64Array.from({ length: N }, (_, i) => s[t + i] * win[i])
    const mag = fftMag(frame)
    smooth = smooth.map((v, k) => tau * v + (1 - tau) * mag[k])
    if (Math.floor(t / (0.08 * 48000)) === Math.floor((t + N) / (0.08 * 48000))) continue
    let peak = 0
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(s[t + i]) * 128)
    let logSum = 0, sum = 0
    for (let k = k0; k <= k1; k++) {
      const p = Math.max(smooth[k] * smooth[k], 1e-20)
      logSum += Math.log(p)
      sum += p
    }
    const n = k1 - k0 + 1
    rows.push([Math.min(1, peak / 64), Math.exp(logSum / n) / (sum / n)])
  }
  return rows
}

function report(name, s) {
  const rows = analyse(s).filter(([lvl]) => lvl > 0.12)
  const f = rows.map((r) => r[1]).sort((a, b) => a - b)
  const q = (p) => (f.length ? f[Math.floor(p * (f.length - 1))] : NaN)
  console.log(`${name.padEnd(16)} loud ticks ${String(rows.length).padStart(3)}   flatness p10 ${q(0.1).toFixed(3)}  p50 ${q(0.5).toFixed(3)}  p90 ${q(0.9).toFixed(3)}`)
}

// made-up non-voices, at loudness that passes the call's 0.12 bar
const secs = (n) => new Float32Array(Math.floor(48000 * n))
let seed = 1
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
const hiss = secs(2).map(() => rnd() * 0.12)
let b0 = 0, b1 = 0, b2 = 0
const pink = secs(2).map(() => { const w = rnd(); b0 = 0.997 * b0 + 0.029591 * w; b1 = 0.985 * b1 + 0.032534 * w; b2 = 0.95 * b2 + 0.048056 * w; return (b0 + b1 + b2 + w * 0.1848) * 0.35 })
const click = secs(2).map((_, i) => (i < 240 ? (i % 2 ? 0.9 : -0.9) * (1 - i / 240) : rnd() * 0.004))
const hum = secs(2).map((_, i) => 0.15 * Math.sin((2 * Math.PI * 50 * i) / 48000) + 0.05 * Math.sin((2 * Math.PI * 150 * i) / 48000) + rnd() * 0.01)

for (const f of process.argv.slice(2)) report(f.split(/[\\/]/).pop(), to48k(readWav(f)))
report('hiss', hiss)
report('pink hiss', pink)
report('click', click)
report('mains hum', hum)
