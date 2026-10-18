// Testing on a real phone over Wi-Fi: pairing with Android's wireless debugging, then
// installing the app, seeing the screen, touching and typing, and reading the app's
// own log. Everything goes through adb, Android's own tool for this.
//
// The rule: Prism touches the phone only when its owner has asked, each time. The
// agent's tools say so, the panel shows everything the agent did, and the panel has
// a switch that turns the agent's access off altogether.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

let api = null
let adbPath = null
let chosen = null
let logProc = null
let logLines = []
let logMode = 'app'
const activity = []
let emitTimer = null

// ---------------------------------------------------------------- adb itself

function findAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const homes = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), join(homedir(), 'Library', 'Android', 'sdk'), join(homedir(), 'Android', 'Sdk')].filter(Boolean)
  for (const h of homes) {
    const p = join(h, 'platform-tools', exe)
    if (existsSync(p)) return p
  }
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const p = join(dir, exe)
    if (dir && existsSync(p)) return p
  }
  return null
}

function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PRISM_GADGET
  return env
}

/** One adb command to completion. binary: the output as bytes (a screenshot). */
function adb(args, { timeout = 30_000, binary = false, device = true } = {}) {
  if (!adbPath) adbPath = findAdb()
  if (!adbPath) return Promise.reject(new Error('The Android tools (adb) are not installed on this computer.'))
  const full = device && chosen ? ['-s', chosen, ...args] : args
  return new Promise((res) => {
    execFile(adbPath, full, { timeout, windowsHide: true, env: cleanEnv(), encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout, err: String(stderr ?? '') + (err && !stdout?.length ? ` ${err.message}` : '') })
    })
  })
}

const text = (r) => `${r.out ?? ''}${r.err ?? ''}`.trim()

// ---------------------------------------------------------------- devices

async function devices() {
  const r = await adb(['devices', '-l'], { device: false, timeout: 15_000 })
  if (r.code !== 0) throw new Error(text(r) || 'adb did not answer.')
  return String(r.out)
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/)
      const kv = Object.fromEntries(rest.map((x) => x.split(':')).filter((x) => x.length === 2))
      return { serial, state, model: (kv.model ?? '').replace(/_/g, ' '), wireless: /:\d+$|_adb-tls-connect/.test(serial) }
    })
}

async function pick() {
  const list = await devices()
  const ready = list.filter((d) => d.state === 'device')
  if (chosen && ready.some((d) => d.serial === chosen)) return chosen
  // the same phone can appear twice (by its address and by its name): either will do
  chosen = ready[0]?.serial ?? null
  return chosen
}

async function need() {
  if (!(await pick())) {
    await reconnect().catch(() => {})
    if (!(await pick())) throw new Error('No phone is connected. Open Wireless debugging on the phone, then pair or reconnect in the Phone panel.')
  }
  return chosen
}

/** Services Android announces on the network while wireless debugging is on. */
async function announced() {
  const r = await adb(['mdns', 'services'], { device: false, timeout: 10_000 })
  return String(r.out ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 3 && /_adb-tls-(pairing|connect)\._tcp/.test(p[1]))
    .map((p) => ({ name: p[0], kind: p[1].includes('pairing') ? 'pairing' : 'connect', address: p[2] }))
}

async function reconnect() {
  const found = (await announced()).filter((s) => s.kind === 'connect')
  const out = []
  for (const s of found) {
    const r = await adb(['connect', s.address], { device: false, timeout: 10_000 })
    out.push(text(r))
  }
  return out.join('\n') || 'Nothing announced itself. Is wireless debugging on, on the same Wi-Fi?'
}

async function pair(code, address) {
  code = String(code ?? '').replace(/\D/g, '')
  if (code.length !== 6) throw new Error('The pairing code is the six numbers the phone shows.')
  let where = String(address ?? '').trim()
  if (!where) {
    // the phone announces the pairing address while its pairing screen is open
    for (let i = 0; i < 6 && !where; i++) {
      where = (await announced()).find((s) => s.kind === 'pairing')?.address ?? ''
      if (!where) await new Promise((r) => setTimeout(r, 1000))
    }
    if (!where) throw new Error('The phone could not be found. Type the address it shows under the code (like 192.168.1.20:37099).')
  }
  const r = await adb(['pair', where, code], { device: false, timeout: 30_000 })
  const said = text(r)
  if (!/Successfully paired/i.test(said)) throw new Error(said || 'Pairing failed.')
  note('you', 'paired with the phone')
  await new Promise((r2) => setTimeout(r2, 1500))
  await reconnect().catch(() => {})
  return said
}

async function info() {
  const serial = await need()
  const [model, release, battery, size] = await Promise.all([
    adb(['shell', 'getprop', 'ro.product.model']),
    adb(['shell', 'getprop', 'ro.build.version.release']),
    adb(['shell', 'dumpsys', 'battery']),
    adb(['shell', 'wm', 'size'])
  ])
  const level = String(battery.out).match(/level:\s*(\d+)/)?.[1]
  const m = String(size.out).match(/(\d+)x(\d+)/g)
  const [w, h] = (m?.[m.length - 1] ?? '0x0').split('x').map(Number)
  return { serial, model: String(model.out).trim(), android: String(release.out).trim(), battery: level ? Number(level) : null, width: w, height: h }
}

// ---------------------------------------------------------------- the app under test

/** The project's Android app id, from its build files. */
function appIdOf(root) {
  if (!root) return null
  for (const f of ['android/app/build.gradle', 'app/build.gradle', 'android/app/build.gradle.kts', 'app/build.gradle.kts']) {
    try {
      const m = readFileSync(join(root, f), 'utf8').match(/applicationId\s*=?\s*["']([\w.]+)["']/)
      if (m) return m[1]
    } catch {
      /* not this one */
    }
  }
  for (const f of ['capacitor.config.json', 'capacitor.config.ts']) {
    try {
      const m = readFileSync(join(root, f), 'utf8').match(/appId["']?\s*:\s*["']([\w.]+)["']/)
      if (m) return m[1]
    } catch {
      /* not this one */
    }
  }
  return null
}

async function appId() {
  return (await api.state.get(`app:${api.root}`, null)) ?? appIdOf(api.root)
}

/** APK files this project has built, newest first. */
function apks() {
  const root = api.root
  if (!root) return []
  const out = []
  const walk = (dir, depth) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        if (depth < 5 && !/^(node_modules|\.git|intermediates|tmp|\.gradle)$/.test(n)) walk(p, depth + 1)
      } else if (/\.apk$/i.test(n)) out.push({ path: p, name: n, size: s.size, at: s.mtimeMs })
    }
  }
  for (const d of ['android/app/build/outputs/apk', 'app/build/outputs/apk', 'dist', 'build']) walk(join(root, d), 0)
  // Prism's own phone app is built into the main copy's dist folder
  if (/prism-work$/i.test(root)) walk(join(root, '..', 'prism', 'dist'), 0)
  return out.sort((a, b) => b.at - a.at).slice(0, 10)
}

async function install(path, by) {
  await need()
  const apk = path ? (isAbsolute(path) ? path : join(api.root, path)) : apks()[0]?.path
  if (!apk || !existsSync(apk)) throw new Error(path ? `${path} is not there.` : 'No APK was found in this project. Build one first, or give its path.')
  note(by, `installed ${basename(apk)}`)
  const r = await adb(['install', '-r', apk], { timeout: 240_000 })
  const said = text(r)
  if (!/Success/i.test(said)) throw new Error(said || 'The install failed.')
  return `Installed ${basename(apk)}.`
}

async function openApp(by) {
  const id = await appId()
  if (!id) throw new Error("This project's app id is not known. Set it in the Phone panel.")
  await need()
  note(by, `opened ${id}`)
  const r = await adb(['shell', 'monkey', '-p', id, '-c', 'android.intent.category.LAUNCHER', '1'])
  if (/No activities found|monkey aborted/i.test(text(r))) throw new Error(`${id} is not installed on the phone.`)
  return `Opened ${id}.`
}

async function closeApp(by) {
  const id = await appId()
  if (!id) throw new Error("This project's app id is not known.")
  await need()
  note(by, `closed ${id}`)
  await adb(['shell', 'am', 'force-stop', id])
  return `Closed ${id}.`
}

// ---------------------------------------------------------------- screen and touch

async function screenshot() {
  await need()
  const r = await adb(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20_000 })
  const buf = r.out
  if (!buf || buf.length < 100 || buf[0] !== 0x89) throw new Error(text({ err: r.err }) || 'The phone did not send a picture (is the screen on?).')
  return buf
}

/** What is on screen, as words and places, from Android's own description of the screen. */
async function elements() {
  const r = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 20_000 })
  const xml = String(r.out ?? '')
  const out = []
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
    const label = (a.text || a['content-desc'] || '').trim()
    const b = a.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    if (!b) continue
    const [x1, y1, x2, y2] = b.slice(1).map(Number)
    const clickable = a.clickable === 'true' || a['long-clickable'] === 'true' || a.checkable === 'true' || a.focusable === 'true' && /Edit|Button/.test(a.class ?? '')
    if (!label && !clickable) continue
    out.push({ label: label.replace(/&#10;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), kind: (a.class ?? '').split('.').pop(), clickable, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), w: x2 - x1, h: y2 - y1 })
  }
  return out
}

/**
 * What on the phone's screen shuts people out: things that can be tapped but have no
 * name for TalkBack (Android's screen reader), and things smaller than the 48dp Android
 * asks for. Text size and contrast need the picture, so they are left to looking.
 */
async function accessibility() {
  await need()
  const [dump, dens] = await Promise.all([adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 20_000 }), adb(['shell', 'wm', 'density'])])
  const dpi = Number(String(dens.out).match(/(\d+)\s*$/m)?.[1] ?? 420)
  const min = Math.round((48 * dpi) / 160)
  const unnamed = []
  const small = []
  for (const m of String(dump.out ?? '').matchAll(/<node ([^>]*?)\/?>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
    if (a.clickable !== 'true' && a['long-clickable'] !== 'true' && a.checkable !== 'true') continue
    const b = a.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    if (!b) continue
    const [x1, y1, x2, y2] = b.slice(1).map(Number)
    const where = { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
    const kind = (a.class ?? '').split('.').pop()
    const label = (a.text || a['content-desc'] || '').trim()
    // a container whose children carry the words is named by them; only bare ones count
    if (!label && !/Layout|View$/.test(kind ?? '')) unnamed.push({ kind, ...where, id: a['resource-id'] ?? '' })
    if (x2 - x1 < min || y2 - y1 < min) small.push({ label: label || kind, ...where, size: `${x2 - x1}x${y2 - y1}px` })
  }
  const lines = [`Checked what can be tapped on screen (the phone draws ${dpi} dots per inch, so 48dp is ${min}px).`]
  lines.push(unnamed.length ? `${unnamed.length} thing(s) TalkBack cannot name (give each a contentDescription, or aria-label in a web page):\n${unnamed.slice(0, 20).map((u) => `- ${u.kind}${u.id ? ` ${u.id}` : ''} at ${u.x},${u.y}`).join('\n')}` : 'Everything that can be tapped has a name for TalkBack.')
  lines.push(small.length ? `${small.length} thing(s) smaller than 48dp to tap:\n${small.slice(0, 20).map((s) => `- "${s.label}" ${s.size} at ${s.x},${s.y}`).join('\n')}` : 'Everything that can be tapped is at least 48dp.')
  lines.push('Text size, contrast and whether it works without sound need the picture: look with phone_screen.')
  return lines.join('\n')
}

function escapeText(s) {
  // adb's input text: spaces become %s, and the shell's own characters are escaped
  return String(s).replace(/[\\'"`$&|;<>()*~!?#[\]{}]/g, (c) => `\\${c}`).replace(/ /g, '%s')
}

const KEYS = { back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', recent: 'KEYCODE_APP_SWITCH', enter: 'KEYCODE_ENTER', delete: 'KEYCODE_DEL', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', power: 'KEYCODE_POWER', wake: 'KEYCODE_WAKEUP', tab: 'KEYCODE_TAB' }

async function act(a, by) {
  await need()
  if (a.tapText) {
    const want = String(a.tapText).toLowerCase()
    const els = await elements()
    const hit = els.find((e) => e.label.toLowerCase() === want) ?? els.find((e) => e.label.toLowerCase().includes(want))
    if (!hit) throw new Error(`Nothing on the screen says "${a.tapText}". On screen: ${els.filter((e) => e.label).slice(0, 25).map((e) => `"${e.label}"`).join(', ') || 'no words'}`)
    note(by, `tapped "${hit.label}"`)
    await adb(['shell', 'input', 'tap', String(hit.x), String(hit.y)])
    return `Tapped "${hit.label}" at ${hit.x},${hit.y}.`
  }
  if (a.tap) {
    const { x, y } = a.tap
    note(by, `tapped at ${Math.round(x)},${Math.round(y)}`)
    await adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))])
    return `Tapped at ${Math.round(x)},${Math.round(y)}.`
  }
  if (a.longPress) {
    const { x, y } = a.longPress
    note(by, `held at ${Math.round(x)},${Math.round(y)}`)
    await adb(['shell', 'input', 'swipe', String(Math.round(x)), String(Math.round(y)), String(Math.round(x)), String(Math.round(y)), '800'])
    return 'Held.'
  }
  if (typeof a.type === 'string') {
    note(by, `typed "${a.type.slice(0, 40)}"`)
    const parts = a.type.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) await adb(['shell', 'input', 'text', escapeText(parts[i])])
      if (i < parts.length - 1) await adb(['shell', 'input', 'keyevent', 'KEYCODE_ENTER'])
    }
    return 'Typed.'
  }
  if (a.key) {
    const code = KEYS[String(a.key).toLowerCase()] ?? String(a.key)
    note(by, `pressed ${String(a.key).toLowerCase()}`)
    await adb(['shell', 'input', 'keyevent', code])
    return `Pressed ${a.key}.`
  }
  if (a.swipe) {
    let { from, to, ms } = typeof a.swipe === 'object' ? a.swipe : {}
    if (typeof a.swipe === 'string') {
      const i = await info()
      const cx = i.width / 2
      const cy = i.height / 2
      const d = { up: [cx, cy * 1.5, cx, cy * 0.5], down: [cx, cy * 0.5, cx, cy * 1.5], left: [i.width * 0.85, cy, i.width * 0.15, cy], right: [i.width * 0.15, cy, i.width * 0.85, cy] }[a.swipe]
      if (!d) throw new Error('A swipe is up, down, left or right, or from and to points.')
      from = { x: d[0], y: d[1] }
      to = { x: d[2], y: d[3] }
    }
    note(by, `swiped ${typeof a.swipe === 'string' ? a.swipe : ''}`.trim())
    await adb(['shell', 'input', 'swipe', String(Math.round(from.x)), String(Math.round(from.y)), String(Math.round(to.x)), String(Math.round(to.y)), String(ms ?? 300)])
    return 'Swiped.'
  }
  throw new Error('Say what to do: tapText, tap, longPress, type, key or swipe.')
}

// ---------------------------------------------------------------- the log

async function startLog(mode = logMode) {
  stopLog()
  logMode = mode
  logLines = []
  await need()
  const args = ['-s', chosen, 'logcat', '-v', 'time', '-T', '200']
  if (mode === 'app') {
    const id = await appId()
    const pid = id ? String((await adb(['shell', 'pidof', id])).out ?? '').trim().split(/\s+/)[0] : ''
    if (!pid) {
      logLines.push(`(${id ?? 'The app'} is not running. Open it and press "Follow" again.)`)
      emitLog()
      return
    }
    args.push(`--pid=${pid}`)
  } else if (mode === 'errors') args.push('*:E')
  logProc = spawn(adbPath, args, { windowsHide: true, env: cleanEnv() })
  let carry = ''
  const take = (d) => {
    const parts = (carry + d).split(/\r?\n/)
    carry = parts.pop() ?? ''
    for (const p of parts) if (p.trim()) logLines.push(p)
    if (logLines.length > 1500) logLines.splice(0, logLines.length - 1500)
    emitLog()
  }
  logProc.stdout.setEncoding('utf8')
  logProc.stdout.on('data', take)
  logProc.stderr.on('data', (d) => take(String(d)))
  logProc.on('close', () => {
    logProc = null
    emitLog()
  })
}

function stopLog() {
  if (logProc?.pid) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(logProc.pid), '/T', '/F'], { windowsHide: true })
    else logProc.kill()
  }
  logProc = null
}

function emitLog() {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    api.emit('log', { following: !!logProc, mode: logMode, lines: logLines.slice(-400) })
  }, 300)
}

async function recentLog({ lines = 200, errors = false, app = true } = {}) {
  await need()
  const args = ['logcat', '-d', '-v', 'time', '-t', String(Math.min(2000, lines))]
  if (app) {
    const id = await appId()
    const pid = id ? String((await adb(['shell', 'pidof', id])).out ?? '').trim().split(/\s+/)[0] : ''
    if (pid) args.push(`--pid=${pid}`)
    else if (id) return `${id} is not running, so it has no log right now.`
  }
  if (errors) args.push('*:E')
  const r = await adb(args, { timeout: 20_000 })
  return String(r.out ?? '').trim() || '(nothing)'
}

// ---------------------------------------------------------------- what happened

function note(by, what) {
  activity.unshift({ at: Date.now(), by, what })
  activity.splice(80)
  api.emit('activity', activity.slice(0, 40))
}

async function agentAllowed() {
  if ((await api.state.get('agentOff', false)) === true) throw new Error('The user has turned off Prism\'s use of the phone in the Phone panel.')
}

async function overview() {
  const tools = !!(adbPath ?? (adbPath = findAdb()))
  if (!tools) return { tools: false }
  let list = []
  let error = null
  try {
    list = await devices()
    await pick()
  } catch (e) {
    error = String(e?.message ?? e)
  }
  let device = null
  if (chosen) device = await info().catch(() => null)
  return {
    tools: true,
    adb: adbPath,
    devices: list,
    device,
    error,
    appId: await appId(),
    apks: apks().map((a) => ({ ...a, at: a.at })),
    agentOff: (await api.state.get('agentOff', false)) === true,
    activity: activity.slice(0, 40),
    log: { following: !!logProc, mode: logMode, lines: logLines.slice(-400) }
  }
}

const RULE = 'Only when the user has asked, in this conversation, for something to be tried or checked on their phone; never on your own initiative.'

export default {
  async start(a) {
    api = a
    adbPath = findAdb()
  },
  async stop() {
    stopLog()
  },
  handlers: {
    overview,
    pair: (a) => pair(a.code, a.address),
    reconnect: () => reconnect(),
    disconnect: async () => {
      stopLog()
      const r = await adb(['disconnect'], { device: false })
      chosen = null
      return text(r)
    },
    choose: async (a) => {
      chosen = String(a.serial)
      return overview()
    },
    screen: async () => {
      const buf = await screenshot()
      return { mime: 'image/png', base64: buf.toString('base64') }
    },
    elements: () => elements(),
    act: (a) => act(a, 'you'),
    install: (a) => install(a.path, 'you'),
    openApp: () => openApp('you'),
    closeApp: () => closeApp('you'),
    setApp: async (a) => {
      await api.state.set(`app:${api.root}`, String(a.id ?? '').trim() || null)
      return appId()
    },
    follow: (a) => startLog(a.mode ?? logMode),
    unfollow: () => {
      stopLog()
      emitLog()
      return true
    },
    clearLog: () => {
      logLines = []
      emitLog()
      return true
    },
    setAgentOff: async (a) => {
      await api.state.set('agentOff', !!a.off)
      return true
    },
    sendLog: async (a) => {
      const lines = logLines.slice(-(a.lines ?? 80)).join('\n')
      await api.agent.send(`Here is the phone app's log (last lines):\n\n\`\`\`\n${lines}\n\`\`\`\n\n${a.ask ?? 'What is going on here?'}`)
      return true
    },
    installTools: async () => {
      const r = await api.shell('winget install --id Google.PlatformTools -e --accept-source-agreements --accept-package-agreements', { timeoutMs: 600_000 })
      adbPath = findAdb()
      return { ok: !!adbPath, output: (r.stdout + r.stderr).slice(-2000) }
    }
  },
  tools: [
    {
      name: 'phone_status',
      description: `Whether the user's phone is connected for testing (over Wi-Fi), which phone, its screen size, the app id of this project's Android app, and the APKs this project has built. ${RULE}`,
      parameters: { type: 'object', properties: {} },
      async execute() {
        const o = await overview()
        if (!o.tools) return 'The Android tools (adb) are not installed. The Phone panel can install them.'
        const lines = [o.device ? `Connected: ${o.device.model}, Android ${o.device.android}, screen ${o.device.width}x${o.device.height}${o.device.battery != null ? `, battery ${o.device.battery}%` : ''}.` : 'No phone is connected. Ask the user to open Wireless debugging on the phone and use the Phone panel to pair or reconnect.']
        lines.push(`App: ${o.appId ?? 'unknown (set it in the Phone panel)'}.`)
        if (o.apks.length) lines.push(`APKs built here, newest first:\n${o.apks.map((a) => `- ${a.path} (${(a.size / 1048576).toFixed(1)} MB, ${new Date(a.at).toLocaleString()})`).join('\n')}`)
        if (o.agentOff) lines.push('The user has turned off Prism\'s use of the phone.')
        return lines.join('\n')
      }
    },
    {
      name: 'phone_install',
      description: `Install an APK on the user's phone (the newest one this project built, unless a path is given), and optionally open the app. ${RULE}`,
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'The APK; default the newest built here' }, open: { type: 'boolean', description: 'Open the app afterwards' } } },
      async execute(a) {
        await agentAllowed()
        api.ui.show().catch(() => {})
        const r = await install(a.path, 'Prism')
        return a.open ? `${r} ${await openApp('Prism')}` : r
      }
    },
    {
      name: 'phone_screen',
      description: `See the phone's screen: a picture, plus the words and buttons on it with their positions (for phone_do). ${RULE}`,
      parameters: { type: 'object', properties: {} },
      async execute() {
        await agentAllowed()
        note('Prism', 'looked at the screen')
        const [buf, els] = await Promise.all([screenshot(), elements().catch(() => [])])
        api.emit('shot', { mime: 'image/png', base64: buf.toString('base64') })
        const listing = els.length ? els.slice(0, 80).map((e) => `- ${e.label ? `"${e.label}"` : `(${e.kind})`}${e.clickable ? ' [can tap]' : ''} at ${e.x},${e.y}`).join('\n') : '(Android did not describe the screen; use the picture.)'
        return { content: `On screen:\n${listing}`, images: [{ mime: 'image/png', base64: buf.toString('base64') }] }
      }
    },
    {
      name: 'phone_do',
      description: `Touch, type or press on the phone. Give one of: tapText (tap what says these words), tap {x,y}, longPress {x,y}, type (text into the focused field; \\n presses enter), key ("back", "home", "recent", "enter", "delete", "wake"), swipe ("up", "down", "left", "right", or {from:{x,y}, to:{x,y}, ms}), or app: "open" | "close". Positions are in the phone's own pixels, as phone_screen gives them. ${RULE}`,
      parameters: {
        type: 'object',
        properties: {
          tapText: { type: 'string' },
          tap: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
          longPress: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
          type: { type: 'string' },
          key: { type: 'string' },
          swipe: { description: 'up | down | left | right, or { from, to, ms }' },
          app: { type: 'string', enum: ['open', 'close'] }
        }
      },
      async execute(a) {
        await agentAllowed()
        if (a.app === 'open') return openApp('Prism')
        if (a.app === 'close') return closeApp('Prism')
        return act(a, 'Prism')
      }
    },
    {
      name: 'phone_accessibility',
      description: `Check what is on the phone's screen for people using TalkBack or with shaky hands: things that can be tapped but have no name, and things smaller than 48dp. ${RULE}`,
      parameters: { type: 'object', properties: {} },
      async execute() {
        await agentAllowed()
        note('Prism', 'checked the screen for accessibility')
        return accessibility()
      }
    },
    {
      name: 'phone_logs',
      description: `Read the phone's log: by default the last lines from this project's app (its console messages and crashes are there). ${RULE}`,
      parameters: { type: 'object', properties: { lines: { type: 'number', description: 'How many, default 200' }, errors: { type: 'boolean', description: 'Errors only' }, everything: { type: 'boolean', description: 'The whole phone, not just the app' } } },
      async execute(a) {
        await agentAllowed()
        note('Prism', 'read the log')
        return recentLog({ lines: a.lines ?? 200, errors: !!a.errors, app: !a.everything })
      }
    }
  ]
}
