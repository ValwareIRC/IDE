// Which conversations someone is on a voice call with, so the agent can be told: its
// words are being read aloud, and its face can be seen. The window or phone holding the
// call says so when it starts, every half minute while it lasts, and when it ends; one
// that goes quiet (a phone app swiped away mid-call) stops counting after two minutes.

const STALE_MS = 120_000

const calls = new Map<string, { at: number; face: boolean }>()

export function setCall(sessionId: string, on: boolean, face: boolean): void {
  if (on) calls.set(sessionId, { at: Date.now(), face })
  else calls.delete(sessionId)
}

/** The call on this conversation, if there is one. face: the user can see the agent's face. */
export function callOf(sessionId: string): { face: boolean } | null {
  const c = calls.get(sessionId)
  if (!c) return null
  if (Date.now() - c.at > STALE_MS) {
    calls.delete(sessionId)
    return null
  }
  return { face: c.face }
}

/** What the agent is told while a call is on. */
export function callNote(sessionId: string): string {
  const c = callOf(sessionId)
  if (!c) return ''
  return [
    '# On a call',
    'The user is on a voice call with you right now. What they say reaches you as text made from their speech, so expect the odd misheard word, and everything you write is read aloud to them as well as shown.',
    c.face
      ? 'They can see your face while you talk. The gesture tool makes it wave, nod, shake its head, smile or laugh. Use it when you want to, the way a person would when it fits what you are saying; nothing needs one.'
      : 'They have the face turned off, so gestures would not be seen.'
  ].join('\n')
}
