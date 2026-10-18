// Measures a recording the way the call does (lib/speech.ts): an analyser of 512 points at
// 48 kHz, read every 40 ms, low = 250-800 Hz and high = 1200-3500 Hz as the analyser's
// 0-255 decibel scale. Prints what the face would see, so the mouth's thresholds can be
// set from real speech rather than guessed.
//   node bands.cjs file.wav [file.wav ...]
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

/** Linear resampling to 48 kHz, as the page's audio would be. */
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

function analyse(path) {
  const s = to48k(readWav(path))
  const N = 512, binHz = 48000 / N, tau = 0.45
  const span = (a, b) => [Math.max(1, Math.round(a / binHz)), Math.round(b / binHz)]
  const [l0, l1] = span(250, 800), [h0, h1] = span(1200, 3500)
  const win = Float64Array.from({ length: N }, (_, i) => 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N))
  let smooth = new Float64Array(N / 2)
  const rows = []
  for (let t = 0; t + N < s.length; t += Math.round(0.04 * 48000)) {
    const frame = Float64Array.from({ length: N }, (_, i) => s[t + i] * win[i])
    const mag = fftMag(frame)
    smooth = smooth.map((v, k) => tau * v + (1 - tau) * mag[k])
    const byte = (k) => Math.max(0, Math.min(255, (255 * (20 * Math.log10(smooth[k] + 1e-12) + 100)) / 70))
    const mean = (a, b) => { let x = 0; for (let k = a; k <= b; k++) x += byte(k); return x / ((b - a + 1) * 255) }
    let peak = 0
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(s[t + i]) * 128)
    const cen = (a, b) => { let w = 0, x = 0; for (let k = Math.round(a / binHz); k <= Math.round(b / binHz); k++) { const p = smooth[k] * smooth[k]; w += p; x += p * k * binHz } return w ? x / w : 0 }
    rows.push({ level: Math.min(1, peak / 70), low: mean(l0, l1), high: mean(h0, h1), f1: cen(200, 1000), f2: cen(1000, 3200) })
  }
  return rows
}

for (const f of process.argv.slice(2).filter((a) => a.endsWith(".wav"))) {
  const rows = analyse(f).filter((r) => r.level > 0.12)
  const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))] ?? 0 }
  const diff = rows.map((r) => r.high - r.low)
  const ratio = rows.map((r) => r.high / (r.low + r.high + 1e-4))
  const f1 = rows.map((r) => r.f1), f2 = rows.map((r) => r.f2)
  console.log(`${f.split(/[\\/]/).pop().padEnd(9)} n ${String(rows.length).padStart(3)}  F1 p25/50/75 ${[0.25, 0.5, 0.75].map((p) => q(f1, p).toFixed(0)).join(' ')}   F2 p25/50/75 ${[0.25, 0.5, 0.75].map((p) => q(f2, p).toFixed(0)).join(' ')}   high-low p50 ${q(diff, 0.5).toFixed(3)}`)
}

// The mouth the face would make from these numbers (kept in step with faceEngine.ts).
if (process.argv.includes('--shapes')) {
  const clamp = (v) => Math.min(1, Math.max(0, v))
  for (const f of process.argv.slice(2).filter((a) => a.endsWith('.wav'))) {
    const rows = analyse(f).filter((r) => r.level > 0.12)
    const sum = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }
    for (const r of rows) {
      const jaw = clamp((r.f1 - 300) / 150), front = clamp((r.f2 - 1700) / 700)
      const ob = jaw * (1 - front), of = jaw * front, cf = (1 - jaw) * front, cb = (1 - jaw) * (1 - front)
      sum.aa += 0.4 * ob + of; sum.oh += 0.6 * ob; sum.ee += 0.6 * cf; sum.ih += 0.4 * cf; sum.ou += cb
    }
    const n = rows.length || 1
    console.log(f.split(/[\/]/).pop().padEnd(9), Object.entries(sum).map(([k, v]) => `${k} ${(v / n).toFixed(2)}`).join('  '))
  }
}
