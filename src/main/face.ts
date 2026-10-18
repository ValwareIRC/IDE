// The face shown during a call: a VRM avatar. The one that comes with Prism sits beside
// the program (build/face in a checkout); a .vrm of your own can be chosen in Settings.
// It is read a piece at a time because the phone fetches it through the paired
// connection, once, and keeps it.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { FaceInfo } from '@shared/ipc'

const BUILT_IN = 'prism-face.vrm'
const PART = 512 * 1024

function builtIn(): string | null {
  const places = [join(process.resourcesPath, 'face', BUILT_IN), join(app.getAppPath(), 'build', 'face', BUILT_IN), join(app.getAppPath(), '..', 'build', 'face', BUILT_IN), join(process.cwd(), 'build', 'face', BUILT_IN)]
  return places.find((p) => existsSync(p)) ?? null
}

/** Your own face if one is set and still there, otherwise the one that comes with Prism. */
function faceFile(own: string): { path: string; own: boolean } | null {
  if (own && existsSync(own)) return { path: own, own: true }
  const b = builtIn()
  return b ? { path: b, own: false } : null
}

export function faceInfo(own: string): FaceInfo | null {
  const f = faceFile(own)
  if (!f) return null
  const s = statSync(f.path)
  // changes whenever the file does, so a phone keeping a copy knows when to fetch again
  const id = createHash('sha1').update(`${f.path}|${s.size}|${s.mtimeMs}`).digest('hex').slice(0, 16)
  return { id, name: basename(f.path), size: s.size, own: f.own }
}

export async function facePart(own: string, offset: number): Promise<{ data: string; size: number; next: number }> {
  const f = faceFile(own)
  if (!f) throw new Error('There is no face to show.')
  const h = await open(f.path, 'r')
  try {
    const size = (await h.stat()).size
    const at = Math.max(0, Math.min(Number(offset) || 0, size))
    const buf = Buffer.alloc(Math.min(PART, size - at))
    const { bytesRead } = await h.read(buf, 0, buf.length, at)
    return { data: buf.subarray(0, bytesRead).toString('base64'), size, next: at + bytesRead }
  } finally {
    await h.close()
  }
}
