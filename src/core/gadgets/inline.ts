// One gadget page, whole. A window loads a gadget's files over prism-gadget://, an
// address that only exists inside Prism; the phone app is an ordinary page and has
// no way to reach it. So the page is folded into one piece of HTML — stylesheets
// become <style>, scripts become <script>, pictures and fonts become data:
// addresses — and shown in the same sandboxed frame as on a window.
//
// A script that imports other files by name is the one thing this cannot follow:
// its imports are resolved by the browser, after the folding is done. Gadgets are
// single pages and do not do that today.
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { GADGET_KIT_CSS, GADGET_KIT_JS } from './kit'
import { GADGET_BASE_CSS, GADGET_SDK_JS } from './sdk'

/** Finds a file inside the gadget's own folder, or null if it is not there. */
export type ResolveFile = (rel: string) => string | null

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

const TEXT = new Set(['.css', '.js', '.mjs', '.json', '.txt'])

type Got = { text: string; mime: string } | { bytes: Buffer; mime: string }

/** Already an address of its own, so it is left alone. */
function external(url: string): boolean {
  return !url || /^(data:|blob:|https?:|\/\/|#|mailto:|javascript:)/i.test(url)
}

async function contents(url: string, find: ResolveFile): Promise<Got | null> {
  const clean = url.trim().split('#')[0]!.split('?')[0]!
  if (external(clean)) return null
  if (clean === 'prism-gadget://_sdk/prism.js') return { text: GADGET_SDK_JS, mime: 'text/javascript' }
  if (clean === 'prism-gadget://_sdk/base.css') return { text: GADGET_BASE_CSS, mime: 'text/css' }
  if (clean === 'prism-gadget://_sdk/kit.css') return { text: GADGET_KIT_CSS, mime: 'text/css' }
  if (clean === 'prism-gadget://_sdk/kit.js') return { text: GADGET_KIT_JS, mime: 'text/javascript' }
  const rel = clean.startsWith('prism-gadget://') ? clean.replace(/^prism-gadget:\/\/[^/]*\/?/, '') : clean.replace(/^\.?\//, '')
  if (!rel || rel.startsWith('..')) return null
  const abs = find(rel)
  if (!abs) return null
  const ext = extname(abs).toLowerCase()
  const mime = MIME[ext] ?? (TEXT.has(ext) ? 'text/plain' : 'application/octet-stream')
  if (TEXT.has(ext)) return { text: await readFile(abs, 'utf8'), mime: ext === '.css' ? 'text/css' : ext === '.json' ? 'application/json' : 'text/javascript' }
  return { bytes: await readFile(abs), mime }
}

function asData(got: Got): string {
  return 'bytes' in got ? `data:${got.mime};base64,${got.bytes.toString('base64')}` : `data:${got.mime};base64,${Buffer.from(got.text, 'utf8').toString('base64')}`
}

/** String.replace with an async replacement. */
async function replaceAsync(input: string, re: RegExp, make: (m: RegExpExecArray) => Promise<string>): Promise<string> {
  const jobs: Array<{ at: number; len: number; text: Promise<string> }> = []
  for (const m of input.matchAll(re)) jobs.push({ at: m.index, len: m[0].length, text: make(m as RegExpExecArray) })
  if (!jobs.length) return input
  const done = await Promise.all(jobs.map((j) => j.text))
  let out = ''
  let from = 0
  jobs.forEach((j, i) => {
    out += input.slice(from, j.at) + done[i]
    from = j.at + j.len
  })
  return out + input.slice(from)
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null
}

/** Pictures and fonts a stylesheet asks for come along with it. */
async function inlineCss(css: string, find: ResolveFile): Promise<string> {
  return replaceAsync(css, /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, async (m) => {
    const got = await contents(m[2]!, find)
    return got ? `url("${asData(got)}")` : m[0]
  })
}

/** The gadget's page with every file it loads folded in. */
export async function inlinePage(html: string, find: ResolveFile): Promise<string> {
  let out = await replaceAsync(html, /<link\b[^>]*>/gi, async (m) => {
    const tag = m[0]
    if (!/rel\s*=\s*['"]?stylesheet/i.test(tag)) return tag
    const href = attr(tag, 'href')
    const got = href ? await contents(href, find) : null
    if (!got || !('text' in got)) return tag
    return `<style>${await inlineCss(got.text, find)}</style>`
  })

  out = await replaceAsync(out, /<script\b([^>]*)>\s*<\/script>/gi, async (m) => {
    const src = attr(m[0], 'src')
    const got = src ? await contents(src, find) : null
    if (!got || !('text' in got)) return m[0]
    const module = /\btype\s*=\s*['"]?module/i.test(m[1] ?? '') ? ' type="module"' : ''
    // a closing tag inside the code would end the script early
    return `<script${module}>${got.text.replace(/<\/script/gi, '<\\/script')}</script>`
  })

  // whatever is left that points at a file: pictures, fonts, sounds
  out = await replaceAsync(out, /\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi, async (m) => {
    const url = m[3] ?? m[4] ?? ''
    if (external(url)) return m[0]
    const got = await contents(url, find)
    return got ? `${m[1]}="${asData(got)}"` : m[0]
  })

  return out
}
