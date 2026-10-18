// Noticing when a gadget would help. A gadget is only ever built because someone
// thought to ask for one, which means most of the ones worth having never exist. So
// after a turn that did something with an ongoing or repeatable shape — a build, a
// test run, a process being watched, numbers that move — a quick model call asks
// whether a small panel would serve both the user and the agent better than another
// wall of output, and if so, Prism offers to build it.
//
// What is turned down is remembered, by kind rather than by wording, so the same
// suggestion cannot come back in a different shirt.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GadgetIdea } from '@shared/types'
import { ask, firstJson } from '../agent/ask'
import type { ResolvedModel } from '../agent/engine'

/** Turned down for a while rather than for ever: this long. */
const LATER_MS = 14 * 24 * 60 * 60 * 1000

interface Memory {
  /** Never offer this kind here again. */
  never: string[]
  /** Offered and put off, with when. */
  later: Array<{ kind: string; at: number }>
  /** Built, so there is one already. */
  built: Array<{ kind: string; at: number }>
}

/** What the turn did, as far as this needs to know. */
export interface TurnShape {
  /** Tool names used, in order, repeats included. */
  tools: string[]
  /** Shell commands run, shortened. */
  commands: string[]
  /** What the agent said at the end. */
  said: string
  /** Gadgets this project already has: id and what it is for. */
  existing: Array<{ id: string; description: string }>
}

const EMPTY: Memory = { never: [], later: [], built: [] }

export class GadgetScout {
  /** Offered this run, so one session cannot ask twice about the same thing. */
  private thisRun = new Set<string>()

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private file(root: string): string {
    return join(this.dir, `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`)
  }

  private load(root: string): Memory {
    try {
      const m = JSON.parse(readFileSync(this.file(root), 'utf8')) as Partial<Memory>
      return { never: m.never ?? [], later: m.later ?? [], built: m.built ?? [] }
    } catch {
      return { ...EMPTY }
    }
  }

  private save(root: string, m: Memory): void {
    try {
      writeFileSync(this.file(root), JSON.stringify({ never: m.never.slice(-60), later: m.later.slice(-60), built: m.built.slice(-60) }, null, 2), 'utf8')
    } catch {
      /* forgetting a refusal is a small harm; crashing a turn over it is worse */
    }
  }

  /** Kinds not to raise here: refused for ever, put off recently, or already built. */
  silenced(root: string): string[] {
    return this.quiet(root)
  }

  /** Noted as offered, so the same thing is not raised twice in one run. */
  raised(kind: string): void {
    this.thisRun.add(kind)
  }

  private quiet(root: string): string[] {
    const m = this.load(root)
    const now = Date.now()
    return [...m.never, ...m.later.filter((l) => now - l.at < LATER_MS).map((l) => l.kind), ...m.built.map((b) => b.kind), ...this.thisRun]
  }

  /**
   * Is there a gadget worth offering after this turn? Null nearly always, which is the
   * point: an offer that comes too easily is noise, and noise gets switched off.
   */
  async consider(root: string, model: ResolvedModel, turn: TurnShape): Promise<GadgetIdea | null> {
    // nothing happened that could repeat
    if (!turn.tools.length) return null
    const quiet = this.quiet(root)
    const { text } = await ask(
      model,
      `You watch a coding agent work and notice when a small live panel — a "gadget" — would serve the user better than more text.

A gadget is a little web page inside the editor with its own backend, which both the user and the agent can use: it can run a command and show the result, watch a process, chart numbers as they change, or offer buttons the agent can press through a tool. It is worth suggesting when the work has an ongoing or repeatable shape that both of them would get at more easily through a panel than through scrollback.

Say no unless it is a real fit. In particular say no when:
- the work was a one-off that will not repeat
- the output is read once and thrown away
- a gadget would only restate what the transcript already says plainly
- the project already has a gadget for it, or the kind is in the list to leave alone

If it is a fit, name its kind as a short slug describing the sort of gadget, not this particular one: "test-results", "build-watch", "bundle-size", "log-tail". Keep the title short and plain, say in one sentence what it would show and do, and in one sentence why it earns its place.

Reply with JSON only: {"gadget":true|false,"kind":"","title":"","what":"","why":""}`,
      [
        `Gadgets this project already has:\n${turn.existing.map((g) => `- ${g.id}: ${g.description}`).join('\n') || '(none)'}`,
        `Kinds to leave alone (refused, put off, or already built):\n${quiet.join(', ') || '(none)'}`,
        `Tools the agent just used:\n${turn.tools.slice(0, 60).join(', ')}`,
        `Commands it ran:\n${turn.commands.slice(0, 20).join('\n') || '(none)'}`,
        `What it said at the end:\n${turn.said.slice(0, 1200)}`
      ].join('\n\n'),
      400
    )
    const r = firstJson<{ gadget?: boolean; kind?: string; title?: string; what?: string; why?: string }>(text)
    if (!r?.gadget || !r.kind?.trim() || !r.title?.trim()) return null
    const kind = r.kind.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    if (!kind || quiet.includes(kind)) return null
    this.thisRun.add(kind)
    return { id: randomUUID().slice(0, 8), kind, title: r.title.trim().slice(0, 70), what: (r.what ?? '').trim().slice(0, 300), why: (r.why ?? '').trim().slice(0, 300) }
  }

  /** What the user said to an offer. */
  decide(root: string, kind: string, answer: 'build' | 'later' | 'never'): void {
    const m = this.load(root)
    m.never = m.never.filter((k) => k !== kind)
    m.later = m.later.filter((l) => l.kind !== kind)
    if (answer === 'never') m.never.push(kind)
    if (answer === 'later') m.later.push({ kind, at: Date.now() })
    if (answer === 'build') m.built.push({ kind, at: Date.now() })
    this.save(root, m)
  }

  /** What has been turned down here, for Settings to show and undo. */
  refused(root: string): string[] {
    return this.load(root).never
  }

  allow(root: string, kind: string): void {
    const m = this.load(root)
    m.never = m.never.filter((k) => k !== kind)
    this.save(root, m)
    this.thisRun.delete(kind)
  }
}
