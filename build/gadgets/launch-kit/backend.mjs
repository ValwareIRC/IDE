// The launch kit: what a thing needs once it works, to reach people. The words for a
// store listing (checked against each store's limits), screenshots at the sizes the
// stores ask for (with a caption and a background if wanted), the release video, and
// a web page for it. Everything is kept in the project's launch/ folder, so it can be
// looked at, changed by hand or by the agent, and committed.
//
// Nothing here publishes anything. Putting the page or the listing online is a separate
// step the user takes, because a publish cannot be taken back.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIR = 'launch'
let api = null

const here = (...p) => join(api.root, DIR, ...p)

/** What the stores allow, so the listing is checked as it is written. */
const STORES = {
  play: { name: 'Google Play', title: 30, short: 80, long: 4000, whatsNew: 500 },
  microsoft: { name: 'Microsoft Store', title: 256, short: 1000, long: 10000, whatsNew: 1500 },
  steam: { name: 'Steam', title: 200, short: 300, long: 8000, whatsNew: 8000 },
  itch: { name: 'itch.io', title: 100, short: 200, long: 20000, whatsNew: 20000 }
}

/** Sizes the stores ask for. width x height in CSS pixels, drawn at scale. */
const SIZES = {
  phone: { name: 'Phone (1080 x 1920)', width: 360, height: 640, scale: 3 },
  phoneTall: { name: 'Tall phone (1080 x 2400)', width: 360, height: 800, scale: 3 },
  tablet: { name: 'Tablet (1600 x 2560)', width: 800, height: 1280, scale: 2 },
  desktop: { name: 'Desktop (1920 x 1080)', width: 1920, height: 1080, scale: 1 },
  feature: { name: 'Play feature graphic (1024 x 500)', width: 1024, height: 500, scale: 1 },
  icon: { name: 'Icon (512 x 512)', width: 512, height: 512, scale: 1 },
  social: { name: 'Social card (1200 x 630)', width: 1200, height: 630, scale: 1 }
}

function listing() {
  try {
    return JSON.parse(readFileSync(here('listing.json'), 'utf8'))
  } catch {
    return { name: api.root ? basename(api.root) : '', short: '', long: '', whatsNew: '', keywords: '', website: '', contact: '', colour: '#f6c7d4' }
  }
}

function saveListing(l) {
  mkdirSync(here(), { recursive: true })
  writeFileSync(here('listing.json'), JSON.stringify(l, null, 2) + '\n')
  return l
}

function checks(l) {
  const out = {}
  for (const [id, s] of Object.entries(STORES)) {
    const over = []
    if ((l.name ?? '').length > s.title) over.push(`the name is ${(l.name ?? '').length} of ${s.title}`)
    if ((l.short ?? '').length > s.short) over.push(`the short description is ${(l.short ?? '').length} of ${s.short}`)
    if ((l.long ?? '').length > s.long) over.push(`the full description is ${(l.long ?? '').length} of ${s.long}`)
    if ((l.whatsNew ?? '').length > s.whatsNew) over.push(`what is new is ${(l.whatsNew ?? '').length} of ${s.whatsNew}`)
    out[id] = { name: s.name, over }
  }
  return out
}

function shots() {
  const dir = here('screenshots')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
    .map((n) => ({ name: n, path: join(dir, n), at: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => a.at - b.at)
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/** A screenshot at a store's size: a page drawn directly, or a picture set on a coloured background with a caption. */
async function shoot({ url, path, size = 'phone', caption = '', name, background }) {
  const s = SIZES[size] ?? SIZES.phone
  mkdirSync(here('screenshots'), { recursive: true })
  const l = listing()
  let target = url
  if (path || caption) {
    // framed: the page (or picture) sits inside a frame drawn by a small page of our own
    let inner = ''
    if (path) {
      const abs = isAbsolute(path) ? path : join(api.root, path)
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(abs).toLowerCase()] ?? 'image/png'
      inner = `<img src="data:${mime};base64,${readFileSync(abs).toString('base64')}">`
    } else if (url) {
      const shot = await api.capture(url, { width: Math.round(s.width * 0.86), height: Math.round(s.height * (caption ? 0.74 : 0.86)), scale: s.scale, waitMs: 900 })
      inner = `<img src="data:${shot.mime};base64,${shot.base64}">`
    }
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:${s.width}px;height:${s.height}px;overflow:hidden}
      body{background:${esc(background || l.colour || '#f6c7d4')};font-family:'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(s.height * 0.035)}px}
      h1{margin:0 ${Math.round(s.width * 0.07)}px;font-size:${Math.round(Math.min(s.width, s.height) * 0.075)}px;line-height:1.15;text-align:center;color:#3a2e39;font-weight:650}
      .shot{max-width:86%;max-height:${caption ? 74 : 86}%;display:flex}
      .shot img{max-width:100%;max-height:100%;object-fit:contain;border-radius:${Math.round(Math.min(s.width, s.height) * 0.04)}px;box-shadow:0 12px 40px rgba(60,30,50,.22)}
    </style></head><body>${caption ? `<h1>${esc(caption)}</h1>` : ''}<div class="shot">${inner}</div></body></html>`
    const file = here('screenshots', '.frame.html')
    writeFileSync(file, page)
    target = pathToFileURL(file).toString()
  }
  if (!target) throw new Error('Give a page (url) or a picture (path) to make the screenshot from.')
  const out = await api.capture(target, { width: s.width, height: s.height, scale: s.scale, waitMs: path || caption ? 300 : 900 })
  try {
    unlinkSync(here('screenshots', '.frame.html'))
  } catch {
    /* was not framed */
  }
  const file = `${(name || caption || size).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shot'}-${size}.png`
  writeFileSync(here('screenshots', file), Buffer.from(out.base64, 'base64'))
  api.emit('changed', null)
  return { path: here('screenshots', file), name: file, size: `${s.width * s.scale} x ${s.height * s.scale}` }
}

/** A single page for the product: name, what it is, the screenshots, what is new, where to get it. */
function site() {
  const l = listing()
  const pics = shots().filter((p) => !/feature|icon|social/.test(p.name))
  mkdirSync(here('site'), { recursive: true })
  const imgs = pics.map((p) => {
    const ext = extname(p.name).toLowerCase()
    return `<img src="data:image/${ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext.slice(1)};base64,${readFileSync(p.path).toString('base64')}" alt="${esc(p.name.replace(/-[a-z]+\.\w+$/, '').replace(/-/g, ' '))}">`
  })
  const paras = String(l.long ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/^[-*] /m.test(p) ? `<ul>${p.split('\n').map((x) => `<li>${esc(x.replace(/^[-*]\s*/, ''))}</li>`).join('')}</ul>` : `<p>${esc(p)}</p>`))
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(l.name)}</title>
<meta name="description" content="${esc(l.short)}">
<meta property="og:title" content="${esc(l.name)}">
<meta property="og:description" content="${esc(l.short)}">
<style>
  :root { --cream: #fdf8f3; --ink: #3a2e39; --soft: #6d5d6a; --accent: ${esc(l.colour || '#f6c7d4')}; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--cream); color: var(--ink); font-family: 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; font-size: 18px; line-height: 1.6; }
  header { padding: 72px 24px 40px; text-align: center; background: linear-gradient(180deg, var(--accent), var(--cream)); }
  h1 { font-size: clamp(36px, 7vw, 64px); margin: 0 0 12px; line-height: 1.05; }
  header p { font-size: 21px; color: var(--soft); max-width: 640px; margin: 0 auto 28px; }
  .get { display: inline-block; padding: 14px 28px; border-radius: 999px; background: var(--ink); color: var(--cream); text-decoration: none; font-weight: 600; }
  main { max-width: 900px; margin: 0 auto; padding: 24px; }
  .shots { display: flex; gap: 20px; overflow-x: auto; padding: 8px 4px 24px; scroll-snap-type: x mandatory; }
  .shots img { height: 460px; border-radius: 22px; box-shadow: 0 14px 40px rgba(60, 30, 50, .18); scroll-snap-align: center; }
  section { margin: 32px 0; }
  h2 { font-size: 26px; margin: 0 0 12px; }
  footer { text-align: center; color: var(--soft); padding: 40px 24px 60px; font-size: 15px; }
  a { color: var(--ink); }
</style>
</head>
<body>
<header>
  <h1>${esc(l.name)}</h1>
  <p>${esc(l.short)}</p>
  ${l.website ? `<a class="get" href="${esc(l.website)}">Get it</a>` : ''}
</header>
<main>
  ${imgs.length ? `<div class="shots">${imgs.join('\n')}</div>` : ''}
  ${paras.length ? `<section>${paras.join('\n')}</section>` : ''}
  ${l.whatsNew ? `<section><h2>What is new</h2><p>${esc(l.whatsNew)}</p></section>` : ''}
</main>
<footer>${l.contact ? `Questions? <a href="mailto:${esc(l.contact)}">${esc(l.contact)}</a>` : ''}</footer>
</body>
</html>
`
  writeFileSync(here('site', 'index.html'), html)
  api.emit('changed', null)
  return here('site', 'index.html')
}

function videos() {
  const dir = here('video')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => /\.(mp4|webm|mov|gif)$/i.test(n))
    .map((n) => ({ name: n, path: join(dir, n), size: statSync(join(dir, n)).size }))
}

function overview() {
  if (!api.root) return { project: null }
  const l = listing()
  return { project: api.root, listing: l, checks: checks(l), stores: STORES, sizes: Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, v.name])), shots: shots().map(({ name, path }) => ({ name, path })), site: existsSync(here('site', 'index.html')) ? here('site', 'index.html') : null, videos: videos() }
}

export default {
  async start(a) {
    api = a
  },
  handlers: {
    overview: () => overview(),
    saveListing: (a) => {
      saveListing({ ...listing(), ...a.listing })
      return overview()
    },
    shoot: (a) => shoot(a),
    picture: (a) => {
      const p = shots().find((s) => s.name === a.name)
      return p ? { mime: p.name.endsWith('.png') ? 'image/png' : 'image/jpeg', base64: readFileSync(p.path).toString('base64') } : null
    },
    removeShot: (a) => {
      const p = shots().find((s) => s.name === a.name)
      if (p) unlinkSync(p.path)
      return overview()
    },
    site: () => site(),
    preview: async (a) => {
      await api.ui.openPreview(a.path)
      return true
    },
    attach: async (a) => {
      await api.ui.attach(a.path, a.note ?? '')
      return true
    },
    askAgent: async (a) => {
      await api.agent.send(String(a.text))
      return true
    }
  },
  tools: [
    {
      name: 'launch_status',
      description: "The project's launch kit (launch/): the store listing and whether it fits each store's limits, the screenshots made so far, the web page, and the release video.",
      parameters: { type: 'object', properties: {} },
      async execute() {
        const o = overview()
        if (!o.project) return 'No project is open.'
        const l = o.listing
        const over = Object.values(o.checks).filter((c) => c.over.length).map((c) => `${c.name}: ${c.over.join(', ')}`)
        return [`Listing (launch/listing.json): ${l.name || '(no name)'}; short: ${l.short ? `${l.short.length} characters` : 'missing'}; full: ${l.long ? `${l.long.length} characters` : 'missing'}; what is new: ${l.whatsNew ? 'written' : 'missing'}.`, over.length ? `Too long for: ${over.join('; ')}.` : 'It fits every store.', `Screenshots: ${o.shots.map((s) => s.name).join(', ') || 'none'}.`, `Web page: ${o.site ?? 'not made'}.`, `Video: ${o.videos.map((v) => v.name).join(', ') || 'none in launch/video'}.`].join('\n')
      }
    },
    {
      name: 'launch_listing',
      description: "Write the store listing (launch/listing.json): name, short description, full description (paragraphs; lines starting with - are a list), what is new, keywords, website, contact, and a background colour for screenshots and the page. Give only what changes. The result says if anything is too long for a store (Google Play's short description is 80 characters, its name 30).",
      parameters: { type: 'object', properties: { name: { type: 'string' }, short: { type: 'string' }, long: { type: 'string' }, whatsNew: { type: 'string' }, keywords: { type: 'string' }, website: { type: 'string' }, contact: { type: 'string' }, colour: { type: 'string' } } },
      async execute(a) {
        const l = saveListing({ ...listing(), ...a })
        api.emit('changed', null)
        const over = Object.values(checks(l)).filter((c) => c.over.length)
        return over.length ? `Saved, but too long for ${over.map((c) => `${c.name} (${c.over.join(', ')})`).join('; ')}.` : 'Saved. It fits every store.'
      }
    },
    {
      name: 'launch_screenshot',
      description: `Make a store screenshot at an exact size from a page (url: an address or an HTML file in the project) or a picture (path), optionally framed with a caption on the listing's background colour. Sizes: ${Object.entries(SIZES).map(([k, v]) => `${k} = ${v.name}`).join('; ')}. Saved in launch/screenshots.`,
      parameters: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string' }, size: { type: 'string', enum: Object.keys(SIZES) }, caption: { type: 'string', description: 'A few words over the picture' }, name: { type: 'string' } } },
      async execute(a) {
        const r = await shoot(a)
        api.ui.show().catch(() => {})
        const pic = readFileSync(r.path).toString('base64')
        return { content: `Made ${r.name} (${r.size}) in launch/screenshots.`, images: [{ mime: 'image/png', base64: pic }] }
      }
    },
    {
      name: 'launch_site',
      description: 'Write launch/site/index.html: one page for the product from the listing and the screenshots, in a warm cream-and-pastel look, ready to be checked and polished. It is not put online.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return `Wrote ${site()}. Look at it with browser_open, and check it with check_accessibility.`
      }
    }
  ]
}
