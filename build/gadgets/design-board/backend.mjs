// The design board: sketches, screenshots and references, with the agent's versions
// beside them. It replaces the agent making throwaway pages and photographing them in
// private: what it is aiming at and what it made are on the board, where both of you
// can see them side by side, laid over each other, or with the differences lit up.
//
// The board lives in the project, in .prism/board/: the pictures, and board.json for
// what each one is. A .gitignore there keeps the pictures out of commits unless the
// user decides otherwise.
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'

const DIR = '.prism/board'
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif' }
let api = null

const boardDir = () => join(api.root, DIR)
const boardFile = () => join(boardDir(), 'board.json')

function ensure() {
  if (!api.root) throw new Error('Open a project to use its design board.')
  mkdirSync(boardDir(), { recursive: true })
  const gi = join(boardDir(), '.gitignore')
  if (!existsSync(gi)) writeFileSync(gi, '# the design board\'s pictures stay out of commits; delete this file to keep them\n*\n!board.json\n!.gitignore\n')
}

function board() {
  try {
    const j = JSON.parse(readFileSync(boardFile(), 'utf8'))
    return { items: Array.isArray(j.items) ? j.items : [] }
  } catch {
    return { items: [] }
  }
}

function save(b) {
  ensure()
  writeFileSync(boardFile(), JSON.stringify(b, null, 2) + '\n')
  api.emit('board', b)
  return b
}

function mimeOf(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function addItem(item) {
  const b = board()
  const full = { id: randomUUID().slice(0, 8), at: Date.now(), note: '', pairWith: null, ...item }
  b.items.unshift(full)
  // a pair is two-way
  if (full.pairWith) {
    const other = b.items.find((x) => x.id === full.pairWith)
    if (other) other.pairWith = full.id
    else full.pairWith = null
  }
  save(b)
  return full
}

/** A picture handed over as base64 (dropped or pasted into the panel). */
function addPicture({ name, mime, base64, title, by = 'you', kind = 'reference', pairWith = null, note = '' }) {
  ensure()
  const ext = Object.entries(MIME).find(([, m]) => m === mime)?.[0] ?? (extname(name ?? '') || '.png')
  const id = randomUUID().slice(0, 8)
  const file = `${id}${ext}`
  writeFileSync(join(boardDir(), file), Buffer.from(base64, 'base64'))
  return addItem({ id, kind, title: title || (name ? basename(name, extname(name)) : 'A picture'), file, by, pairWith, note })
}

function addFile(path, opts) {
  const abs = isAbsolute(path) ? path : join(api.root, path)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${path} is not there.`)
  if (!MIME[extname(abs).toLowerCase()]) throw new Error(`${basename(abs)} is not a picture the board can show (png, jpg, gif, webp, svg).`)
  ensure()
  const id = randomUUID().slice(0, 8)
  const file = `${id}${extname(abs).toLowerCase()}`
  copyFileSync(abs, join(boardDir(), file))
  return addItem({ id, file, title: opts.title || basename(abs, extname(abs)), ...opts, source: path })
}

/** The agent's version of something: a page drawn to a picture at the size asked. */
async function addRender({ url, width = 1280, height = 800, scale = 1, title, pairWith = null, note = '', by = 'Prism' }) {
  ensure()
  const shot = await api.capture(url, { width, height, scale, waitMs: 900 })
  const id = randomUUID().slice(0, 8)
  const file = `${id}.png`
  writeFileSync(join(boardDir(), file), Buffer.from(shot.base64, 'base64'))
  return addItem({ id, kind: 'render', title: title || basename(String(url)), file, by, pairWith, note, source: url, size: `${width}x${height}` })
}

function picture(id) {
  const it = board().items.find((x) => x.id === id)
  if (!it?.file) return null
  try {
    return { mime: mimeOf(it.file), base64: readFileSync(join(boardDir(), it.file)).toString('base64') }
  } catch {
    return null
  }
}

function update(id, patch) {
  const b = board()
  const it = b.items.find((x) => x.id === id)
  if (!it) throw new Error('That is no longer on the board.')
  for (const k of ['title', 'note', 'kind']) if (patch[k] != null) it[k] = String(patch[k])
  if ('pairWith' in patch) {
    // unpair both sides of the old pair, then pair the new two
    for (const x of b.items) if (x.pairWith === id || x.id === it.pairWith) x.pairWith = null
    it.pairWith = null
    const other = patch.pairWith ? b.items.find((x) => x.id === patch.pairWith) : null
    if (other && other.id !== id) {
      for (const x of b.items) if (x.pairWith === other.id) x.pairWith = null
      other.pairWith = id
      it.pairWith = other.id
    }
  }
  save(b)
  return it
}

function remove(id) {
  const b = board()
  const it = b.items.find((x) => x.id === id)
  if (!it) return b
  b.items = b.items.filter((x) => x.id !== id)
  for (const x of b.items) if (x.pairWith === id) x.pairWith = null
  if (it.file) {
    try {
      unlinkSync(join(boardDir(), it.file))
    } catch {
      /* already gone */
    }
  }
  return save(b)
}

function describe(it) {
  return `${it.id}: ${it.kind === 'render' ? `Prism's version` : it.kind === 'note' ? 'a note' : `${it.by === 'you' ? "the user's" : 'a'} reference`} "${it.title}"${it.pairWith ? `, paired with ${it.pairWith}` : ''}${it.note ? `. Note: ${it.note}` : ''}${it.text ? `. Says: ${it.text}` : ''}${it.source ? ` (from ${it.source})` : ''}`
}

export default {
  async start(a) {
    api = a
  },
  handlers: {
    board: () => (api.root ? board() : { items: [], noProject: true }),
    picture: (a) => picture(String(a.id)),
    addPicture: (a) => addPicture({ ...a, by: 'you' }),
    addNote: (a) => addItem({ kind: 'note', title: String(a.title ?? 'A note'), text: String(a.text ?? ''), by: 'you' }),
    update: (a) => update(String(a.id), a.patch ?? {}),
    remove: (a) => remove(String(a.id)),
    askAgent: async (a) => {
      await api.agent.send(String(a.text))
      return true
    }
  },
  tools: [
    {
      name: 'board_look',
      description:
        "See the project's design board: the user's sketches, screenshots and references, your earlier versions, and notes. With an id, that item's picture (and its pair's); without, the list and the newest pictures. Look here before building something visual the user has put on the board.",
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      async execute(a) {
        const b = board()
        if (!b.items.length) return 'The design board is empty.'
        if (a.id) {
          const it = b.items.find((x) => x.id === a.id)
          if (!it) return { content: `Nothing on the board has the id ${a.id}.`, isError: true }
          const pair = it.pairWith ? b.items.find((x) => x.id === it.pairWith) : null
          const images = [picture(it.id), pair ? picture(pair.id) : null].filter(Boolean)
          return { content: [describe(it), pair ? `Its pair: ${describe(pair)}` : ''].filter(Boolean).join('\n') + (images.length ? `\n(${images.length === 2 ? 'Pictures: this one, then its pair' : 'Its picture'} below.)` : ''), images }
        }
        const pics = b.items.filter((x) => x.file).slice(0, 4)
        return { content: `On the board, newest first:\n${b.items.map((x) => `- ${describe(x)}`).join('\n')}\n\nPictures of the newest ${pics.length}: ${pics.map((x) => x.id).join(', ')}.`, images: pics.map((x) => picture(x.id)).filter(Boolean) }
      }
    },
    {
      name: 'board_add',
      description:
        "Put something on the design board where the user sees it: your version of a design, beside the user's reference (pairWith its id), so the two can be compared side by side, laid over each other or with the differences lit up. Give url (a page address or an HTML file in the project, drawn at width x height) or path (a picture file). Use this instead of making throwaway pictures only you see.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A page to draw: an address, or an HTML file in the project' },
          path: { type: 'string', description: 'Or a picture file to put up as it is' },
          title: { type: 'string' },
          pairWith: { type: 'string', description: "The id of the reference this is your version of" },
          note: { type: 'string', description: 'What you tried, or what is still different' },
          width: { type: 'number', description: 'Default 1280; use the reference\'s own size when matching a phone screen' },
          height: { type: 'number', description: 'Default 800' },
          scale: { type: 'number', description: 'Sharpness, 1 to 3; default 1' }
        }
      },
      async execute(a) {
        let it
        if (a.url) it = await addRender({ url: String(a.url), width: a.width ?? 1280, height: a.height ?? 800, scale: a.scale ?? 1, title: a.title, pairWith: a.pairWith ?? null, note: a.note ?? '' })
        else if (a.path) it = addFile(String(a.path), { kind: 'render', title: a.title, pairWith: a.pairWith ?? null, note: a.note ?? '', by: 'Prism' })
        else return { content: 'Give a url (a page or HTML file to draw) or a path (a picture).', isError: true }
        api.ui.show().catch(() => {})
        api.emit('focus', { id: it.id })
        return { content: `Put on the board as ${it.id}${it.pairWith ? `, beside ${it.pairWith}` : ''}.`, images: [picture(it.id)].filter(Boolean) }
      }
    }
  ]
}
