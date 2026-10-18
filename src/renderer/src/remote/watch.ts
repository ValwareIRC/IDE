// The phone's background watcher: the page an Android service keeps open on its own,
// with nothing on screen, so Prism can still say "finished" or "needs you" when the
// app has been swiped away or the phone has been locked for an hour.
//
// It is the app's own connection, run a second time — the same pairing and the same
// encrypted channel — in a web view that belongs to the service rather than to the
// app's window (android/.../WatchService.java). The app's window dies when it is closed;
// this does not. Everything it has to say goes out through PrismWatchHost, which turns
// it into an Android notification, but only when Prism is not the app in front.
import { finishedNotice } from '@/lib/finished'
import { makeApi } from '@shared/api'
import type { PrismApi } from '@shared/ipc'
import type { AgentEvent } from '@shared/types'
import { connect, savedPairing, type ConnState } from './connection'

interface Host {
  /** A notification. The service decides whether the app is in front and stays quiet if so. */
  say(title: string, body: string): void
  /** What the permanent notification says about the connection. */
  status(text: string): void
  /**
   * A question, with its answers as buttons on the notification and a reply box for
   * anything else. A tap is sent back through __prismAnswer below.
   */
  ask(title: string, body: string, sessionId: string, questionId: string, optionsJson: string): void
  /** The question was answered somewhere else: its notification goes. */
  done(questionId: string): void
  /**
   * A finished run: the answer as text, a reply box to answer it from the notification,
   * and the last picture it made, if any, as {"mime":...,"data":base64}.
   */
  finished(title: string, body: string, sessionId: string, imageJson: string): void
  /** A file the run handed over, with a Save button that fetches it to the phone. */
  file(sessionId: string, itemId: string, name: string, size: number): void
  /** A run started or ended: an ongoing "working on it" notification with a Stop button. */
  work(sessionId: string, title: string, on: boolean): void
  /** Something wants approval: Allow and Deny buttons on the notification. */
  approve(title: string, body: string, sessionId: string, approvalId: string): void
  /** One piece of a file being fetched (called by this page, answered below); `first` truncates what was there. */
  filePart(name: string, data: string, first: boolean): void
  /** The whole file has been written to the phone. */
  fileSaved(name: string): void
  /** The file could not be fetched. */
  fileFailed(name: string, why: string): void
}

function host(): Partial<Host> {
  return (window as unknown as { PrismWatchHost?: Partial<Host> }).PrismWatchHost ?? {}
}

/** Whether this page is the watcher rather than the app. */
export function isWatcher(): boolean {
  return new URLSearchParams(window.location.search).has('watch')
}

/** How often a quiet connection is asked whether it is still there. */
const HEARTBEAT_MS = 120_000
/** How long to wait before starting again when the computer could not be reached at all. */
const RETRY_FIRST_MS = 60_000

const say = (title: string, body: string): void => host().say?.(title, body.slice(0, 300))

/** Set once the connection is up: the buttons and reply boxes on notifications come back to it. */
let apiRef: PrismApi | null = null

/** Each conversation's latest answer, for the snippet when its run finishes. */
const lastSaid = new Map<string, string>()
/** The last picture a conversation's tools produced, to show when its run finishes. */
const lastImage = new Map<string, string>()
/** The last file a conversation's run handed over, to offer as a Save button. */
const lastFile = new Map<string, { itemId: string; name: string; size: number }>()

/** A file the run handed over that is a picture, small enough to show in the notification itself. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i
const IMAGE_MAX = 15 * 1024 * 1024

/** The last picture, shrunk to what a notification can carry: a megabyte screenshot would not. */
async function picture(src: { stored: string } | { sessionId: string; itemId: string; name: string } | undefined): Promise<string> {
  if (!src || !apiRef) return ''
  try {
    let blob: Blob
    if ('stored' in src) {
      const a = await apiRef.host.asset(`prism://attach/${src.stored}`)
      if (!a || !a.data?.length) return ''
      blob = new Blob([a.data as BlobPart], { type: a.mime || 'image/png' })
    } else {
      // a picture handed over as a file (attach_file): fetched the way Save to phone fetches it
      const pieces: BlobPart[] = []
      let at = 0
      for (let i = 0; i < 40; i++) {
        const part = await apiRef.files.part(src.sessionId, src.itemId, at)
        if (!part.data) break
        pieces.push(Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)))
        at = part.next
        if (at >= part.size) break
      }
      blob = new Blob(pieces, { type: IMAGE_FILE.exec(src.name)?.[1] === 'png' ? 'image/png' : 'image/jpeg' })
    }
    const bmp = await createImageBitmap(blob)
    const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bmp.width * scale))
    canvas.height = Math.max(1, Math.round(bmp.height * scale))
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    return JSON.stringify({ mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.8).slice(23) })
  } catch {
    return ''
  }
}

function onEvent(id: string, title: () => string, ev: AgentEvent): void {
  switch (ev.type) {
    case 'run-start':
      host().work?.(id, title(), true)
      break
    case 'item':
      if (ev.item.kind === 'assistant' && !ev.item.agent && ev.item.text.trim()) lastSaid.set(id, ev.item.text)
      if (ev.item.kind === 'tool' && !ev.item.agent && !ev.item.isError) {
        const images = ev.item.meta?.['images']
        if (Array.isArray(images) && images.length) lastImage.set(id, String(images[images.length - 1]))
        const a = ev.item.meta?.['attach'] as { name?: unknown; size?: unknown } | undefined
        if (a && typeof a.name === 'string') lastFile.set(id, { itemId: ev.item.id, name: a.name, size: Number(a.size) || 0 })
      }
      break
    case 'run-end': {
      host().work?.(id, '', false)
      // what it said, or the question it ended on, rather than only that it finished
      if (ev.reason === 'completed') {
        const n = finishedNotice(title(), lastSaid.get(id))
        const image = lastImage.get(id)
        lastImage.delete(id)
        const file = lastFile.get(id)
        lastFile.delete(id)
        // a picture handed over is what the run was for: it is the one shown, ahead of any screenshot
        const shown = file && IMAGE_FILE.test(file.name) && file.size <= IMAGE_MAX ? { sessionId: id, itemId: file.itemId, name: file.name } : image ? { stored: image } : undefined
        if (host().finished) void picture(shown).then((json) => host().finished?.(n.title, n.body, id, json))
        else say(n.title, n.body)
        if (file && host().file) host().file!(id, file.itemId, file.name, file.size)
      }
      else if (ev.reason === 'error') say('Prism stopped with a problem', title() + (ev.error ? ': ' + ev.error : ''))
      // stopped on purpose is not news to the person who stopped it
      break
    }
    case 'approval': {
      const h = host()
      if (h.approve) h.approve('Prism needs your approval', ev.request.summary, id, ev.request.approvalId)
      else say('Prism needs your approval', ev.request.summary)
      break
    }
    case 'approval-resolved':
      // answered here, in the app, or somewhere else: its notification goes
      host().done?.(ev.approvalId)
      break
    case 'question': {
      const h = host()
      // several answers at once cannot be buttons; that kind opens the app
      if (h.ask && !ev.request.multi) h.ask('Prism has a question', ev.request.question.slice(0, 300), id, ev.request.questionId, JSON.stringify(ev.request.options.map((o) => o.label)))
      else say('Prism has a question', ev.request.question)
      break
    }
    case 'question-resolved':
      host().done?.(ev.questionId)
      break
    case 'plan':
      say('Prism has a plan for you', ev.request.title)
      break
    case 'review':
      say('Prism proposes a change', ev.request.title)
      break
  }
}

export async function startWatching(): Promise<void> {
  const p = savedPairing()
  if (!p) {
    host().status?.('Not paired with a computer yet')
    return
  }
  // The connection coming and going is not news: the phone's notification stays as it
  // is rather than flicking between "Connecting" and "Connected" every few minutes.
  const onState = (_s: ConnState): void => {}

  let check: (() => Promise<void>) | null = null
  let transport
  try {
    transport = await connect(p, onState, (c) => { check = c.check }, { keepTrying: true })
  } catch {
    // the computer is off, or the phone has no signal: start again in a minute, for ever
    setTimeout(() => void startWatching(), RETRY_FIRST_MS)
    return
  }
  const api = makeApi(transport)
  apiRef = api
  // an answer tapped on a notification
  ;(window as unknown as { __prismAnswer?: (s: string, q: string, a: string) => void }).__prismAnswer = (sessionId, questionId, answer) =>
    void api.agent.answer(sessionId, questionId, answer).catch(() => say('Prism did not get that answer', 'Open the app and answer it there.'))
  // a reply typed on a finished run's notification: it is the next message to that conversation
  ;(window as unknown as { __prismSend?: (s: string, t: string) => void }).__prismSend = (sessionId, text) =>
    void api.agent.send(sessionId, text, undefined).catch(() => say('Prism did not get that message', 'Open the app and send it there.'))
  // the Stop button on the "working" notification
  ;(window as unknown as { __prismStop?: (s: string) => void }).__prismStop = (sessionId) =>
    void api.agent.abort(sessionId).catch(() => say('Prism could not be stopped from here', 'Open the app and stop it there.'))
  // Allow or Deny on an approval's notification
  ;(window as unknown as { __prismApprove?: (s: string, a: string, d: string) => void }).__prismApprove = (sessionId, approvalId, decision) =>
    void api.agent.approve(sessionId, approvalId, decision as 'once' | 'deny').catch(() => say('Prism did not get that decision', 'Open the app and decide it there.'))
  // Save on a file's notification: fetch it a piece at a time and hand each piece to Android
  ;(window as unknown as { __prismFetchFile?: (s: string, i: string, n: string) => void }).__prismFetchFile = (sessionId, itemId, name) => {
    const h = host()
    void (async () => {
      try {
        let at = 0
        for (;;) {
          const part = await api.files.part(sessionId, itemId, at)
          h.filePart?.(name, part.data, at === 0)
          at = part.next
          if (!part.data || at >= part.size) break
        }
        h.fileSaved?.(name)
      } catch (e) {
        h.fileFailed?.(name, e instanceof Error ? e.message : 'It could not be fetched.')
      }
    })()
  }

  // every conversation, not just the one last open: each is listened to by name
  const titles = new Map<string, string>()
  const offs = new Map<string, () => void>()
  const follow = (list: Array<{ id: string; title: string }>): void => {
    for (const s of list) {
      titles.set(s.id, s.title)
      if (offs.has(s.id)) continue
      offs.set(s.id, api.agent.onEvent(s.id, (ev) => onEvent(s.id, () => titles.get(s.id) ?? 'A conversation', ev)))
    }
  }
  follow(await api.sessions.list().catch(() => []))
  api.sessions.onChanged((list) => follow(list))
  // after a gap the list may have changed while nobody was listening
  transport.on('remote:reconnected', () => void api.sessions.list().then(follow).catch(() => {}))

  // anything Prism itself wants to say: a timer, a background job finishing
  api.agent.onNotice((n) => say('Prism: ' + n.title, n.body))

  // A connection with nothing happening on it can be dropped somewhere along the way
  // without anyone at either end being told. Asking a small question now and then
  // finds that out, and keeps a quiet connection from being thought dead.
  setInterval(() => void check?.(), HEARTBEAT_MS)
}

/**
 * Asks Android to start the background service (android/.../WatchService.java). Done
 * by the app once it has connected, because Android only lets an app start a service
 * like this while it is on screen. Returns whether it is running, so the app can leave
 * notifications to it rather than both sending one.
 */
export async function startBackgroundWatcher(): Promise<boolean> {
  try {
    const { registerPlugin } = await import('@capacitor/core')
    const watch = registerPlugin<{ start(): Promise<void> }>('Watch')
    await watch.start()
    ;(window as unknown as { __prismWatching?: boolean }).__prismWatching = true
    return true
  } catch {
    return false
  }
}
