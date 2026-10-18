// Branching a conversation: a new session from any point of an existing one, and side chats for passing
// questions that should not derail the conversation they come from.
import { prism } from './ipc'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'

/** From one of the user's messages: a new session with everything before it, and that message ready to change. From an answer: a new session that carries on from it. */
export async function branchFrom(itemId: string): Promise<void> {
  try {
    const st = useSessions.getState()
    // whichever conversation holds it (a side chat has a panel of its own)
    const sessionId = Object.keys(st.items).find((id) => st.items[id]!.some((i) => i.id === itemId))
    const item = sessionId ? st.items[sessionId]!.find((i) => i.id === itemId) : undefined
    if (!sessionId || !item) return
    const title = st.sessions.find((s) => s.id === sessionId)?.title ?? 'Session'
    const fromUser = item.kind === 'user'
    const copy = await prism.sessions.duplicate(sessionId, fromUser ? { before: itemId, title: `${title} (branch)` } : { upTo: itemId, title: `${title} (branch)` })
    await useSessions.getState().refresh()
    useLayout.getState().openAgent()
    await useSessions.getState().select(copy.id)
    if (fromUser && item.kind === 'user') useSessions.getState().hand(copy.id, item.text, item.attachments)
    useUi.getState().toast('success', 'Branched', fromUser ? 'A new session up to that message, with it in the box to change. The original is untouched.' : 'A new session that carries on from that answer. The original is untouched.')
  } catch (e) {
    toastError(e, 'Could not branch')
  }
}

/** A passing question, answered in a copy of the conversation opened beside it. */
export async function sideChat(sessionId: string, question: string): Promise<void> {
  try {
    const q = question.trim()
    if (!q) return
    const copy = await prism.sessions.duplicate(sessionId, { title: `Side: ${q.replace(/\s+/g, ' ').slice(0, 48)}`, sideOf: sessionId })
    await useSessions.getState().refresh()
    useLayout.getState().openAgentSession(copy.id, copy.title)
    await useSessions.getState().ensure(copy.id)
    await useSessions.getState().send(q, undefined, copy.id)
  } catch (e) {
    toastError(e, 'Could not start the side chat')
  }
}

/** The side chat's latest answer, put in the message box of the conversation it came from. */
export function bringBack(sideId: string, mainId: string): void {
  const st = useSessions.getState()
  const items = st.items[sideId] ?? []
  const answer = [...items].reverse().find((i) => i.kind === 'assistant' && !i.toolCalls.length && i.text.trim())
  const question = items.filter((i) => i.kind === 'user').pop()
  if (!answer || answer.kind !== 'assistant') {
    useUi.getState().toast('info', 'No answer yet', 'Bring it back once the side chat has answered.')
    return
  }
  st.hand(mainId, `From a side chat${question && question.kind === 'user' ? ` ("${question.text.slice(0, 80)}")` : ''}:\n\n${answer.text}\n\n`, [])
  useLayout.getState().openAgent()
  void st.select(mainId)
}
