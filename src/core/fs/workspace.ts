import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, open } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { FileContent, FsChange, FsEntry } from '@shared/types'
import { isIgnoredDir, jail, relPosix } from './paths'

const MAX_READ = 2 * 1024 * 1024
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.avif', '.heic',
  '.glb', '.gltf', '.fbx', '.obj', '.stl', '.blend', '.usdz', '.3ds', '.dae',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.webm', '.mov', '.mkv',
  '.zip', '.gz', '.7z', '.rar', '.tar', '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm',
  '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.psd', '.ai', '.sqlite', '.db', '.uasset', '.umap', '.pak'
])

export function looksBinary(buf: Buffer, ext: string): boolean {
  if (BINARY_EXT.has(ext.toLowerCase())) return true
  const n = Math.min(buf.length, 8000)
  let suspicious = 0
  for (let i = 0; i < n; i++) {
    const c = buf[i]!
    if (c === 0) return true
    if (c < 7 || (c > 13 && c < 32)) suspicious++
  }
  return n > 0 && suspicious / n > 0.1
}

export class Workspace {
  readonly root: string
  private watcher: FSWatcher | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private seen: Map<string, string> | null = null
  private closed = false
  private pending = new Map<string, FsChange>()
  private flushTimer: NodeJS.Timeout | null = null
  protected listeners = new Set<(changes: FsChange[]) => void>()

  constructor(root: string) {
    this.root = root
  }

  abs(p: string): string {
    return jail(this.root, p)
  }

  rel(abs: string): string {
    return relPosix(this.root, abs)
  }

  async list(path: string): Promise<FsEntry[]> {
    const dir = this.abs(path)
    const entries = await readdir(dir, { withFileTypes: true })
    const out: FsEntry[] = []
    for (const e of entries) {
      if (e.name === '.git' && e.isDirectory()) continue
      const abs = join(dir, e.name)
      const rel = this.rel(abs)
      if (e.isDirectory()) {
        out.push({ name: e.name, path: rel, kind: 'dir', size: null, mtime: null })
      } else if (e.isFile()) {
        let size: number | null = null
        let mtime: number | null = null
        try {
          const s = await stat(abs)
          size = s.size
          mtime = s.mtimeMs
        } catch {
          /* unreadable */
        }
        out.push({ name: e.name, path: rel, kind: 'file', size, mtime })
      } else if (e.isSymbolicLink()) {
        out.push({ name: e.name, path: rel, kind: 'symlink', size: null, mtime: null })
      }
    }
    out.sort((a, b) => {
      const ad = a.kind === 'dir' ? 0 : 1
      const bd = b.kind === 'dir' ? 0 : 1
      return ad - bd || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    })
    return out
  }

  async read(path: string): Promise<FileContent> {
    const abs = this.abs(path)
    const s = await stat(abs)
    const ext = extname(abs)
    if (BINARY_EXT.has(ext.toLowerCase())) {
      return { path, content: '', size: s.size, truncated: false, binary: true, mtime: s.mtimeMs }
    }
    const truncated = s.size > MAX_READ
    let buf: Buffer
    if (truncated) {
      const fh = await open(abs, 'r')
      try {
        buf = Buffer.alloc(MAX_READ)
        await fh.read(buf, 0, MAX_READ, 0)
      } finally {
        await fh.close()
      }
    } else {
      buf = await readFile(abs)
    }
    const binary = looksBinary(buf, ext)
    return { path, content: binary ? '' : buf.toString('utf8'), size: s.size, truncated, binary, mtime: s.mtimeMs }
  }

  async readRaw(path: string): Promise<Buffer> {
    return readFile(this.abs(path))
  }

  async write(path: string, content: string): Promise<void> {
    const abs = this.abs(path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    this.touched(path)
  }

  /** Where the system cannot watch the folder, Prism's own changes are announced directly. */
  protected touched(...paths: string[]): void {
    if (this.watcher || !this.listeners.size) return
    for (const p of paths) this.queue({ type: 'update', path: p.split('\\').join('/').replace(/^\.\//, '') })
  }

  async writeRaw(path: string, data: Buffer): Promise<void> {
    const abs = this.abs(path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, data)
    this.touched(path)
  }

  async create(path: string, kind: 'file' | 'dir'): Promise<void> {
    const abs = this.abs(path)
    if (kind === 'dir') {
      await mkdir(abs, { recursive: true })
    } else {
      await mkdir(dirname(abs), { recursive: true })
      const fh = await open(abs, 'wx')
      await fh.close()
    }
    this.touched(path)
  }

  async rename(from: string, to: string): Promise<void> {
    const a = this.abs(from)
    const b = this.abs(to)
    await mkdir(dirname(b), { recursive: true })
    await rename(a, b)
    this.touched(from, to)
  }

  async delete(path: string): Promise<void> {
    const abs = this.abs(path)
    if (abs === this.root) throw new Error('Refusing to delete the workspace root')
    await rm(abs, { recursive: true, force: true })
    this.touched(path)
  }

  /** Models often prefix paths with the folder name ("demo/src/x.js"); accept that when the plain path exists. */
  async lenient(path: string): Promise<string> {
    const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
    if (await this.exists(p)) return p
    const prefix = this.name + '/'
    if (p.startsWith(prefix) && (await this.exists(p.slice(prefix.length)))) return p.slice(prefix.length)
    return p
  }

  /** Whether a path is a file, a folder, or not there. */
  async kind(path: string): Promise<'file' | 'dir' | null> {
    try {
      return (await stat(this.abs(path))).isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.abs(path))
      return true
    } catch {
      return false
    }
  }

  /** Walk every non-ignored file (for quick-open and the project map). */
  async walk(limit = 50_000): Promise<string[]> {
    const out: string[] = []
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= limit || depth > 32) return
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (out.length >= limit) return
        if (e.isDirectory()) {
          if (isIgnoredDir(e.name) || e.name.startsWith('.')) continue
          await visit(join(dir, e.name), depth + 1)
        } else if (e.isFile()) {
          out.push(this.rel(join(dir, e.name)))
        }
      }
    }
    await visit(this.root, 0)
    return out
  }

  // ---------------------------------------------------------------- watching

  onChange(cb: (changes: FsChange[]) => void): () => void {
    this.listeners.add(cb)
    this.ensureWatcher()
    return () => this.listeners.delete(cb)
  }

  protected ensureWatcher(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, (_ev, filename) => {
        if (!filename) return
        const rel = String(filename).split('\\').join('/')
        const top = rel.split('/')[0] ?? ''
        if (isIgnoredDir(top) || top === '.git') return
        this.queue({ type: 'update', path: rel })
      })
      this.watcher.on('error', () => {
        this.watcher = null
        this.poll()
      })
    } catch {
      // a WSL folder (and some network drives) cannot be watched
      this.watcher = null
      this.poll()
    }
  }

  /** Looks for changes itself: compares every file's size and time with the last look. Slower folders are looked at less often. */
  protected poll(): void {
    if (this.pollTimer || this.closed) return
    const look = async (): Promise<void> => {
      this.pollTimer = null
      if (this.closed || !this.listeners.size) return
      const started = Date.now()
      const now = new Map<string, string>()
      try {
        for (const f of await this.walk(6000)) {
          try {
            const s = await stat(join(this.root, f))
            now.set(f, `${s.size}:${Math.floor(s.mtimeMs)}`)
          } catch {
            /* went away between the listing and the look */
          }
        }
        if (this.seen) {
          for (const [f, sig] of now) if (this.seen.get(f) !== sig) this.queue({ type: 'update', path: f })
          for (const f of this.seen.keys()) if (!now.has(f)) this.queue({ type: 'update', path: f })
        }
        this.seen = now
      } catch {
        /* try again next time */
      }
      const took = Date.now() - started
      this.pollTimer = setTimeout(() => void look(), Math.max(3500, took * 8))
    }
    this.pollTimer = setTimeout(() => void look(), 1500)
  }

  protected queue(c: FsChange): void {
    this.pending.set(c.path, c)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const batch = [...this.pending.values()]
      this.pending.clear()
      void this.classify(batch).then((changes) => {
        for (const l of this.listeners) l(changes)
      })
    }, 120)
  }

  protected async classify(batch: FsChange[]): Promise<FsChange[]> {
    const out: FsChange[] = []
    for (const c of batch) {
      try {
        await stat(join(this.root, c.path))
        out.push({ type: 'update', path: c.path })
      } catch {
        out.push({ type: 'delete', path: c.path })
      }
    }
    return out
  }

  close(): void {
    this.closed = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.watcher?.close()
    this.watcher = null
    this.listeners.clear()
  }

  get name(): string {
    return basename(this.root)
  }
}
