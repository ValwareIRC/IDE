import { callOf } from '../calls'
import { err, str, type AgentTool } from './types'

export const GESTURES = ['wave', 'nod', 'shake', 'smile', 'laugh'] as const
type Gesture = (typeof GESTURES)[number]

const DONE: Record<Gesture, string> = { wave: 'waved', nod: 'nodded', shake: 'shook its head', smile: 'smiled', laugh: 'laughed' }

/**
 * The agent's face in a call moves when the agent wants it to. Nothing calls this on
 * the agent's behalf: a wave is the agent's to give, not a greeting the app performs.
 */
export const gestureTool: AgentTool = {
  spec: {
    name: 'gesture',
    description:
      'Move your face while the user is on a voice call with you: wave, nod, shake your head, smile or laugh. It shows in the order of what you say, so a wave after "hi" comes after "hi". Prism tells you when a call is on and whether your face can be seen. Use it whenever you want to, the way a person would; nothing needs one.',
    parameters: { type: 'object', properties: { gesture: { type: 'string', enum: [...GESTURES] } }, required: ['gesture'] }
  },
  primaryArg: 'gesture',
  readOnly: true,
  risk: () => null,
  summary: (a) => str(a, 'gesture'),
  async execute(args, ctx) {
    const g = str(args, 'gesture') as Gesture
    if (!GESTURES.includes(g)) return err(`Say one of: ${GESTURES.join(', ')}.`)
    const call = callOf(ctx.sessionId)
    if (!call) return { content: 'Nobody saw it: the user is not on a call with you right now.', isError: false, meta: { gesture: g } }
    if (!call.face) return { content: 'Nobody saw it: the user has the face turned off.', isError: false, meta: { gesture: g } }
    return { content: `Your face ${DONE[g]}.`, isError: false, meta: { gesture: g } }
  }
}
