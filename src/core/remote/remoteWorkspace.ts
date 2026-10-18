// A workspace on another computer, reached over SSH. It has the same face as a
// local Workspace, so the explorer, the editor, the agent's file tools and
// checkpoints work unchanged; underneath, every operation is one small command
// run on the other side through the system's ssh client (GNU find, stat, cat…).
//
// Each operation opens its own connection, which costs a fraction of a second.
// That is fine for opening files and for the agent, and keeps this free of any
// SSH library; a kept-open connection would be the next step if it feels slow.
// Nothing watches the remote folder: Prism's own changes are announced directly.
import { posix } from 'node:path'
import type { FileContent, FsEntry } from '@shared/types'
import { placeOf, remotePath } from '@shared/place'
import { Workspace, looksBinary } from '../fs/workspace'
import { isIgnoredDir } from '../fs/paths'
import { collect, sq, sshArgs } from './command'

const MAX_READ = 2 * 1024 * 1024

export class RemoteWorkspace extends Workspace {
  private host: string
  private base: string

  constructor(root: string) {
    super(root)
    const place = placeOf(root)
    if (place.kind !== 'ssh') throw new Error('Not an SSH folder.')
    this.host = place.host
    this.base = remotePath(root).replace(/(.)\/$/, '$1')
  }

  /** The path on the other computer, refusing anything outside the folder. */
  private there(p: string): string {
    const raw = (typeof p === 'string' && p.trim() ? p.trim() : '.').split('\\').join('/')
    const full = posix.normalize(raw.startsWith('/') ? raw : posix.join(this.base, raw)).replace(/(.)\/$/, '$1')
    if (full !== this.base && !full.startsWith(this.base === '/' ? '/' : `${this.base}/`)) throw new Error(`Path is outside the workspace: ${p}`)
    return full
  }

  /** In the same form as the root (ssh://host/path), so it can be handed on as a working directory. */
  override abs(p: string): string {
    return `ssh://${this.host}${this.there(p)}`
  }

  override rel(abs: string): string {
    const r = posix.relative(this.base, remotePath(abs))
    return r === '' ? '.' : r
  }

  override get name(): string {
    return posix.basename(this.base) || this.host
  }

  /** Run a script on the other side. A connection that fails says so in plain words. */
  private async run(script: string, stdin?: string | Buffer, timeoutMs = 30_000): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    const r = await collect({ file: 'ssh', args: [...sshArgs(this.host), '--', script] }, timeoutMs, stdin)
    if (r.code === 255 || r.code === 127) {
      const why = r.stderr.trim().split('\n').pop() ?? ''
      throw new Error(r.code === 127 ? 'The ssh program was not found on this computer.' : `Could not reach ${this.host}${why ? `: ${why}` : '.'}`)
    }
    return r
  }

  private async must(script: string, what: string, stdin?: string | Buffer): Promise<Buffer> {
    const r = await this.run(script, stdin)
    if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim().split('\n').pop() || `it failed (${r.code})`}`)
    return r.stdout
  }

  /** Check that the folder is there before anything is built on it. */
  async connect(): Promise<void> {
    const r = await this.run(`test -d ${sq(this.base)}`, undefined, 25_000)
    if (r.code !== 0) throw new Error(`${this.base} is not a folder on ${this.host}.`)
  }

  override async list(path: string): Promise<FsEntry[]> {
    const dir = this.there(path)
    const out = (await this.must(`cd -- ${sq(dir)} && find . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n'`, `Could not list ${path}`)).toString('utf8')
    const entries: FsEntry[] = []
    for (const line of out.split('\n')) {
      const [type, size, mtime, ...rest] = line.split('\t')
      const name = rest.join('\t')
      if (!name || (name === '.git' && type === 'd')) continue
      const rel = this.rel(`ssh://${this.host}${posix.join(dir, name)}`)
      if (type === 'd') entries.push({ name, path: rel, kind: 'dir', size: null, mtime: null })
      else if (type === 'f') entries.push({ name, path: rel, kind: 'file', size: Number(size) || 0, mtime: Math.round(Number(mtime) * 1000) || null })
      else if (type === 'l') entries.push({ name, path: rel, kind: 'symlink', size: null, mtime: null })
    }
    entries.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
    return entries
  }

  override async kind(path: string): Promise<'file' | 'dir' | null> {
    const p = sq(this.there(path))
    const r = await this.run(`if [ -d ${p} ]; then echo d; elif [ -e ${p} ]; then echo f; fi`)
    const t = r.stdout.toString('utf8').trim()
    return t === 'd' ? 'dir' : t === 'f' ? 'file' : null
  }

  override async read(path: string): Promise<FileContent> {
    const p = sq(this.there(path))
    // one trip: the file's size and time on the first line, then its beginning
    const r = await this.run(`[ -f ${p} ] || { echo "${path} is not a file" >&2; exit 2; }; stat -c '%s %Y' -- ${p} && head -c ${MAX_READ} -- ${p}`)
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `Could not read ${path}`)
    const nl = r.stdout.indexOf(10)
    const [size, mtime] = r.stdout.subarray(0, nl).toString('utf8').split(' ').map(Number)
    const buf = r.stdout.subarray(nl + 1)
    const binary = looksBinary(buf, posix.extname(path))
    return { path, content: binary ? '' : buf.toString('utf8'), size: size ?? buf.length, truncated: (size ?? 0) > MAX_READ, binary, mtime: (mtime ?? 0) * 1000 }
  }

  override async readRaw(path: string): Promise<Buffer> {
    return this.must(`cat -- ${sq(this.there(path))}`, `Could not read ${path}`)
  }

  override async write(path: string, content: string): Promise<void> {
    await this.writeRaw(path, Buffer.from(content, 'utf8'))
  }

  override async writeRaw(path: string, data: Buffer): Promise<void> {
    const p = this.there(path)
    await this.must(`mkdir -p -- ${sq(posix.dirname(p))} && cat > ${sq(p)}`, `Could not write ${path}`, data)
    this.touched(path)
  }

  override async create(path: string, kind: 'file' | 'dir'): Promise<void> {
    const p = this.there(path)
    if (kind === 'dir') await this.must(`mkdir -p -- ${sq(p)}`, `Could not create ${path}`)
    else await this.must(`mkdir -p -- ${sq(posix.dirname(p))} && { [ ! -e ${sq(p)} ] || { echo "${path} already exists" >&2; exit 2; }; } && : > ${sq(p)}`, `Could not create ${path}`)
    this.touched(path)
  }

  override async rename(from: string, to: string): Promise<void> {
    const a = this.there(from)
    const b = this.there(to)
    await this.must(`mkdir -p -- ${sq(posix.dirname(b))} && mv -- ${sq(a)} ${sq(b)}`, `Could not move ${from}`)
    this.touched(from, to)
  }

  override async delete(path: string): Promise<void> {
    const p = this.there(path)
    if (p === this.base) throw new Error('Refusing to delete the workspace root')
    await this.must(`rm -rf -- ${sq(p)}`, `Could not delete ${path}`)
    this.touched(path)
  }

  override async exists(path: string): Promise<boolean> {
    try {
      return (await this.run(`test -e ${sq(this.there(path))}`)).code === 0
    } catch {
      return false
    }
  }

  /** Every file worth offering: what git tracks or would track, else everything outside the usual build folders. */
  override async walk(limit = 50_000): Promise<string[]> {
    const skip = ['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__', 'target'].map((d) => `-not -path '*/${d}/*'`).join(' ')
    const r = await this.run(`cd -- ${sq(this.base)} && { git ls-files -co --exclude-standard 2>/dev/null || find . -type f ${skip} -printf '%P\\n'; } | head -n ${limit}`, undefined, 45_000)
    return r.stdout
      .toString('utf8')
      .split('\n')
      .filter((f) => f && !f.split('/').some((part) => isIgnoredDir(part)))
  }

  // nothing can watch a folder on another computer; touched() announces what Prism itself changes
  protected override ensureWatcher(): void {}

  protected override async classify(batch: Array<{ type: 'update' | 'delete'; path: string }>): Promise<Array<{ type: 'update' | 'delete'; path: string }>> {
    return batch
  }
}
