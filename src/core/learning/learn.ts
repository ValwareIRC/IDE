// Learning from corrections. When a message looks like the user correcting the
// agent, a quick model call decides what it is: a habit ("we write tests with
// vitest"), a prohibition ("never push"), or neither. Habits are kept as
// candidates and counted; the second time the same habit comes up, Prism offers
// to save it as a skill with trigger words already chosen. Prohibitions are
// offered as rules straight away.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LearnOffer } from '@shared/types'
import { ask, firstJson } from '../agent/ask'
import type { ResolvedModel } from '../agent/engine'

/** Words that usually mean the user is correcting the agent; only these messages are looked at more closely. */
const CORRECTING = /\b(no[,.!]|nope|don'?t|do not|never|always|stop|instead|i told you|i said|again|wrong|not like that|should(?:n'?t| not)? have|we use|we don'?t|please use|use .+ not|prefer|from now on)\b/i

interface Candidate {
  id: string
  title: string
  instruction: string
  when: string[]
  examples: string[]
  count: number
  offered: boolean
}

export class Learner {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private file(root: string): string {
    return join(this.dir, `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`)
  }

  private load(root: string): Candidate[] {
    try {
      return (JSON.parse(readFileSync(this.file(root), 'utf8')) as { candidates?: Candidate[] }).candidates ?? []
    } catch {
      return []
    }
  }

  private save(root: string, list: Candidate[]): void {
    writeFileSync(this.file(root), JSON.stringify({ candidates: list.slice(-60) }, null, 2), 'utf8')
  }

  /** Look at a message sent after the agent answered. Returns something to offer, or null. */
  async consider(root: string, model: ResolvedModel, previousAnswer: string, message: string, ruleTexts: string[]): Promise<LearnOffer | null> {
    if (!CORRECTING.test(message) || message.length > 2000) return null
    const list = this.load(root)
    const known = list.map((c) => `${c.id}: ${c.title} (${c.instruction})`).join('\n') || '(none)'
    const { text } = await ask(
      model,
      `You watch a user working with a coding agent and notice when they correct it in a way that will matter again. Classify the user's latest message:
- "habit": a lasting preference about how work should be done in this project (style, tools, conventions, process). Not a one-off fix to this task.
- "rule": a lasting prohibition on touching certain files or running certain commands ("never edit X", "don't run Y", "never push").
- "none": anything else, including one-off corrections, bug reports, and preferences only about the current task.
For a habit, give a short title, the instruction written as guidance for the agent (imperative, one or two sentences, general rather than about this one case), 3-6 trigger words or short phrases a future message about this kind of work would contain, and the id of an existing habit it is the same as, if any.
For a rule, give it as one sentence starting with Never.
Reply with JSON only: {"kind":"habit"|"rule"|"none","title":"","instruction":"","when":[""],"same_as":"<id or null>","rule":""}`,
      `Habits already noticed:\n${known}\n\nRules already in force:\n${ruleTexts.join('\n') || '(none)'}\n\nThe agent's previous answer (shortened):\n${previousAnswer.slice(0, 1500)}\n\nThe user's message:\n${message}`,
      500
    )
    const r = firstJson<{ kind?: string; title?: string; instruction?: string; when?: unknown; same_as?: string | null; rule?: string }>(text)
    if (!r) return null
    if (r.kind === 'rule' && r.rule?.trim()) {
      if (ruleTexts.some((t) => t.toLowerCase() === r.rule!.trim().toLowerCase())) return null
      return { kind: 'rule', id: randomUUID(), sentence: r.rule.trim().slice(0, 200) }
    }
    if (r.kind !== 'habit' || !r.instruction?.trim()) return null
    let c = r.same_as ? list.find((x) => x.id === r.same_as) : undefined
    if (!c) {
      c = { id: randomUUID().slice(0, 8), title: String(r.title || r.instruction).slice(0, 60), instruction: r.instruction.trim().slice(0, 600), when: [], examples: [], count: 0, offered: false }
      list.push(c)
    }
    c.count++
    c.examples = [...c.examples, message.slice(0, 300)].slice(-4)
    const words = Array.isArray(r.when) ? r.when.map((w) => String(w).toLowerCase().trim()).filter(Boolean) : []
    c.when = [...new Set([...c.when, ...words])].slice(0, 8)
    const offer = c.count >= 2 && !c.offered
    if (offer) c.offered = true
    this.save(root, list)
    return offer ? { kind: 'skill', id: c.id, title: c.title, instruction: c.instruction, when: c.when, examples: c.examples } : null
  }

  /** Turned down: do not offer this one again. */
  dismiss(root: string, id: string): void {
    const list = this.load(root)
    const c = list.find((x) => x.id === id)
    if (c) c.offered = true
    this.save(root, list)
  }
}

/** The skill file for an accepted habit. */
export function skillFromHabit(o: Extract<LearnOffer, { kind: 'skill' }>): { name: string; text: string } {
  const name = o.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'habit'
  return {
    name,
    text: `---\nname: ${name}\ndescription: ${o.title}\nwhen: ${o.when.join(', ')}\n---\n\n# ${o.title}\n\n${o.instruction}\n\nWhat was said when this came up:\n${o.examples.map((e) => `- "${e.replace(/\s+/g, ' ').trim()}"`).join('\n')}\n`
  }
}
