// The face in a call, as the app uses it: which file, fetched how, and what it reacts to.
// The drawing itself is faceEngine.ts, loaded only when a call has a face, so the
// three.js avatar code costs nothing to anyone who never calls.
//
// The file comes from the computer (main/face.ts) a piece at a time — the same way on
// the desktop and through the paired connection on the phone — and is kept in the
// page's own storage, so the phone fetches it once and not on every call.
import { create } from 'zustand'
import type { FaceInfo } from '@shared/ipc'
import { prism } from './ipc'
import { useCall } from './call'
import { speechBeat } from './speech'
import type { FaceInputs, FaceView } from './faceEngine'

interface FaceState {
  /** off: no call. loading: fetching or reading the file. failed: why says what went wrong. */
  state: 'off' | 'loading' | 'ready' | 'failed'
  why: string
  /** How much of the file has arrived, while it is being fetched. */
  progress: number
  /** The large tile rather than the small circle. A phone call starts large, as phone calls do. */
  big: boolean
}

export const useFace = create<FaceState>(() => ({ state: 'off', why: '', progress: 0, big: !!window.__prismMobile }))

const inputs: FaceInputs = {
  stage: () => useCall.getState().stage,
  mic: () => useCall.getState().level,
  speech: () => speechBeat
}

let view: FaceView | null = null
let loading: Promise<FaceView | null> | null = null
/** Bumped when a call ends, so a face still loading for the old call is thrown away. */
let generation = 0

/** The face for this call: loaded once, and kept until the call ends. */
export function faceView(): Promise<FaceView | null> {
  if (view) return Promise.resolve(view)
  if (loading) return loading
  const mine = generation
  useFace.setState({ state: 'loading', why: '', progress: 0 })
  loading = (async () => {
    try {
      const info = await prism.face.info()
      if (!info) throw new Error('There is no face to show.')
      const bytes = await faceBytes(info)
      const { FaceView } = await import('./faceEngine')
      const made = await FaceView.create(bytes, inputs)
      if (mine !== generation) {
        made.dispose()
        return null
      }
      view = made
      useFace.setState({ state: 'ready' })
      return made
    } catch (e) {
      if (mine === generation) useFace.setState({ state: 'failed', why: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) })
      return null
    } finally {
      loading = null
    }
  })()
  return loading
}

/** The agent moved its face (the gesture tool), in its turn among what it is saying. */
export function faceGesture(gesture: string): void {
  view?.gesture(gesture)
}

/** The call is over: the face, its drawing surface and its memory all go. */
export function dropFace(): void {
  generation++
  view?.dispose()
  view = null
  useFace.setState({ state: 'off', progress: 0, big: !!window.__prismMobile })
}

/** The file's bytes: from the page's own storage if this face has been fetched before. */
async function faceBytes(info: FaceInfo): Promise<ArrayBuffer> {
  const kept = await stored(info.id).catch(() => null)
  if (kept) return kept
  const parts: Uint8Array[] = []
  let at = 0
  let size = info.size
  while (at < size) {
    const part = await prism.face.part(at)
    const bytes = Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0))
    if (!bytes.length) break
    parts.push(bytes)
    at = part.next
    size = part.size
    useFace.setState({ progress: size ? at / size : 1 })
  }
  const all = new Uint8Array(at)
  let o = 0
  for (const p of parts) {
    all.set(p, o)
    o += p.length
  }
  void keep(info.id, all.buffer).catch(() => {})
  return all.buffer
}

// ---- the page's own storage: one face kept, by the id that changes when the face does

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('prism-face', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('faces')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function stored(id: string): Promise<ArrayBuffer | null> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = d.transaction('faces').objectStore('faces').get(id)
    req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function keep(id: string, bytes: ArrayBuffer): Promise<void> {
  const d = await db()
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction('faces', 'readwrite')
    const faces = tx.objectStore('faces')
    // only the face in use is kept: an older one is just space
    faces.clear()
    faces.put(bytes, id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
