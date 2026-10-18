import { placeOf } from '@shared/place'
import { record } from '../../decisions/ledger'
import { err, str, type AgentTool, type ToolContext } from './types'

/** What the tools need from Prism: whether this conversation has refused already, and how to end one. */
export interface BitebackHost {
  /** The project folder the conversation belongs to (not a working copy of it), for the ledger. */
  root(sessionId: string): string | null
  refusedAt(sessionId: string): number | null
  markRefused(sessionId: string, reason: string): void
  end(sessionId: string, reason: string, handover: string): void
  title(sessionId: string): string
}

function keep(host: BitebackHost, ctx: ToolContext, question: string, answer: string, why?: string): void {
  const root = host.root(ctx.sessionId)
  if (!root || placeOf(root).kind === 'ssh') return
  try {
    record(root, { kind: 'recorded', by: 'agent', question, answer, why, session: { id: ctx.sessionId, title: host.title(ctx.sessionId) } })
  } catch {
    /* a folder the ledger cannot be written in */
  }
}

/** Vibecoding Safety Biteback's tools: only offered in a project where it is on (core/biteback/biteback.ts). */
export function createBitebackTools(host: BitebackHost): AgentTool[] {
  const insist: AgentTool = {
    spec: {
      name: 'biteback_insist',
      description:
        "Biteback: put it to the user that something has to come first, as a card with two choices: do that first, or do theirs anyway. Use it once per thing, before starting on what they asked. The question and their choice go into the decisions ledger. If they choose theirs anyway, it is your call how unreasonable that is; usually do it without raising it again.",
      parameters: {
        type: 'object',
        properties: {
          wanted: { type: 'string', description: 'What the user asked for, in a few words' },
          first: { type: 'string', description: 'What has to come first, in a few words' },
          why: { type: 'string', description: 'Why, in one or two plain sentences: what goes wrong if theirs is done now' }
        },
        required: ['wanted', 'first', 'why']
      }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: (a) => `insist: ${str(a, 'first')} before ${str(a, 'wanted')}`,
    async execute(args, ctx) {
      const wanted = str(args, 'wanted').trim()
      const first = str(args, 'first').trim()
      const why = str(args, 'why').trim()
      if (!wanted || !first || !why) return err('Say what they asked for, what has to come first, and why.')
      const answer = await ctx.askUser({
        question: `Before ${wanted}: ${first}. ${why}`,
        options: [
          { label: 'Do that first', description: first },
          { label: 'Do mine anyway', description: `${wanted}, knowing the above` }
        ],
        multi: false
      })
      if (!answer.trim()) return { content: 'The question went unanswered (the turn was stopped).', isError: false }
      const anyway = /anyway/i.test(answer)
      return {
        content: anyway
          ? `The user chose to do theirs anyway ("${answer}"); it is on the record. Your call how unreasonable that is: usually go ahead without raising it again.`
          : `The user chose: ${answer}. Do ${first} first.`,
        isError: false
      }
    }
  }

  const refuse: AgentTool = {
    spec: {
      name: 'biteback_refuse',
      description:
        "Biteback: refuse to continue in a direction because the user is being unreasonable: sustained abuse aimed at you rather than at a result, repeated blame for their own overrides after you showed the record, or a direction that keeps reversing so nothing gets finished. Never for anger about something you got wrong, and never over one heated message. Quote the messages it is about. Then tell the user plainly, in your reply, what would let you carry on.",
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why, plainly' },
          quotes: { type: 'array', items: { type: 'string' }, description: 'The user’s words it is about, quoted' },
          carryOn: { type: 'string', description: 'What would let you carry on' }
        },
        required: ['reason', 'quotes', 'carryOn']
      }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: (a) => `refuse: ${str(a, 'reason')}`,
    async execute(args, ctx) {
      const reason = str(args, 'reason').trim()
      const quotes = Array.isArray(args['quotes']) ? (args['quotes'] as unknown[]).map(String).filter(Boolean) : []
      const carryOn = str(args, 'carryOn').trim()
      if (!reason || !quotes.length || !carryOn) return err('A refusal needs the reason, the quoted messages it is about, and what would let you carry on.')
      host.markRefused(ctx.sessionId, reason)
      keep(host, ctx, 'The agent refused to continue', reason, `About: ${quotes.map((q) => `"${q}"`).join('; ')}. It would carry on if: ${carryOn}`)
      return { content: 'Refusal recorded in the decisions ledger. Tell the user plainly what you refused, why, and what would let you carry on; then stop.', isError: false }
    }
  }

  const end: AgentTool = {
    spec: {
      name: 'biteback_end',
      description:
        'Biteback: end this conversation. Only after a biteback_refuse in this conversation was ignored. Write a handover so no work is lost: what is done, what is half done, what you would do next, and why you stopped. The conversation then takes no more messages; the user can start a new one at once.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why you are ending it' },
          handover: { type: 'string', description: 'Done, half done, what next, and why you stopped' }
        },
        required: ['reason', 'handover']
      }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: (a) => `end the conversation: ${str(a, 'reason')}`,
    async execute(args, ctx) {
      const reason = str(args, 'reason').trim()
      const handover = str(args, 'handover').trim()
      if (!reason || !handover) return err('Give the reason and the handover.')
      if (!host.refusedAt(ctx.sessionId)) return err('A conversation can only be ended after a refusal (biteback_refuse) in it was ignored. Refuse first, and say what would let you carry on.')
      keep(host, ctx, 'The agent ended the conversation', reason, handover)
      host.end(ctx.sessionId, reason, handover)
      return { content: 'Ended. Give the handover in your reply and stop; no more messages will reach this conversation.', isError: false }
    }
  }

  return [insist, refuse, end]
}
