import { placeOf } from '@shared/place'
import { readLedger, record, LEDGER } from '../../decisions/ledger'
import { err, num, str, type AgentTool } from './types'

/**
 * The agent's side of the decisions ledger. Answers picked from a question's options are
 * kept by Prism; an answer given in words is recorded here by the agent, which is the
 * one reading the reply and so knows whether it answers anything. Also for a decision
 * reached another way, with the deciding factors, so whoever reviews the work later can
 * see why it went the way it did.
 */
export const decisionRecordTool: AgentTool = {
  spec: {
    name: 'decision_record',
    description:
      "Write an important decision into the project's decisions ledger (" + LEDGER + "), which the user and later agents look back at. Answers picked from the question tool's options are kept by themselves. Whenever the user's message answers a question you asked in words in your previous reply, record it here first (kind answered): your question as you asked it, their answer in short with their own wording kept, and their reasons in why if they gave any. If you asked several, record each one they answered; if their message is about something else, record nothing. Also use it (kind decided) for a decision settled another way, or one you made yourself where the user left it to you, with the deciding factors. Only real decisions (what to build, which approach, what to leave out), not routine steps.",
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['answered', 'decided'], description: 'answered: the user answered a question you asked in words. decided: settled some other way' },
        question: { type: 'string', description: 'The question, as you asked it, or what was being decided' },
        answer: { type: 'string', description: 'What the user answered, or what was decided' },
        why: { type: 'string', description: 'The reasons or deciding factors, if any' },
        by: { type: 'string', enum: ['user', 'agent'], description: 'For decided: who decided it' }
      },
      required: ['question', 'answer']
    }
  },
  primaryArg: null,
  readOnly: true,
  risk: () => null,
  summary: (a) => `record a decision: ${str(a, 'question')}`,
  async execute(args, ctx) {
    if (placeOf(ctx.workspace.root).kind === 'ssh') return err('The ledger is only kept for projects on this computer.')
    const question = str(args, 'question').trim()
    const answer = str(args, 'answer').trim()
    if (!question || !answer) return err('Give the question and what was decided.')
    const why = str(args, 'why').trim() || undefined
    const d =
      str(args, 'kind') === 'answered'
        ? record(ctx.workspace.root, { kind: 'words', question, answer, why, session: sessionOf(ctx.sessionId) })
        : record(ctx.workspace.root, { kind: 'recorded', question, answer, why, by: str(args, 'by') === 'agent' ? 'agent' : 'user', session: sessionOf(ctx.sessionId) })
    return { content: `Recorded in the decisions ledger (${d.id}).`, isError: false }
  }
}

export const decisionsLookTool: AgentTool = {
  spec: {
    name: 'decisions_look',
    description: "Read the project's decisions ledger: the questions the user has answered and the decisions recorded, newest first. Look here before asking something that may already have been decided, and when reviewing another agent's work against what the user chose.",
    parameters: { type: 'object', properties: { search: { type: 'string', description: 'Words to look for' }, limit: { type: 'number' } } }
  },
  primaryArg: null,
  readOnly: true,
  risk: () => null,
  summary: (a) => (str(a, 'search') ? `look for decisions about ${str(a, 'search')}` : 'read the decisions ledger'),
  async execute(args, ctx) {
    if (placeOf(ctx.workspace.root).kind === 'ssh') return err('The ledger is only kept for projects on this computer.')
    const words = str(args, 'search').toLowerCase().split(/\s+/).filter(Boolean)
    const all = readLedger(ctx.workspace.root).reverse()
    const hits = words.length ? all.filter((d) => words.every((w) => `${d.question} ${d.answer} ${d.why ?? ''} ${d.options?.join(' ') ?? ''}`.toLowerCase().includes(w))) : all
    if (!hits.length) return { content: all.length ? 'Nothing in the ledger matches.' : 'The ledger is empty.', isError: false }
    const lines = hits.slice(0, Math.max(1, num(args, 'limit', 30))).map((d) =>
      [`- ${new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')} ${d.question}`, d.options?.length ? `  offered: ${d.options.join(' | ')}` : '', `  answer: ${d.answer}`, d.why ? `  why: ${d.why}` : '', d.kind === 'recorded' ? `  (recorded, decided by ${d.by ?? 'user'})` : '', d.changed ? `  NO LONGER STANDS: the user changed their mind${d.changed.note ? `: ${d.changed.note}` : ''}` : ''].filter(Boolean).join('\n'))
    return { content: `${hits.length} of ${all.length} decisions:\n${lines.join('\n')}`, isError: false }
  }
}

/** Set by the host: the conversation's title, so the ledger can say where a decision was made. */
let titleOf: (sessionId: string) => string | undefined = () => undefined
export function setDecisionTitles(fn: (sessionId: string) => string | undefined): void {
  titleOf = fn
}
export function sessionOf(id: string): { id: string; title: string } {
  return { id, title: titleOf(id) ?? '' }
}
