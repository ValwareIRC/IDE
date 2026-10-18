// What a notification says when a run finishes: a snippet of the answer, not just
// "finished" and the conversation's name. When the answer ends by asking something, the
// notification is that question - a question written in a reply is as much a question as
// one on a card, and it is the part that needs you.

/** Markdown down to the words a person reads. */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The last thing asked, if the answer ends on a question. */
function lastQuestion(text: string): string | null {
  const paras = text.split(/\n\s*\n/).map(plain).filter(Boolean)
  const last = paras[paras.length - 1]
  if (!last || !last.endsWith('?')) return null
  const sentences = last.match(/[^.!?]+[.!?]+/g) ?? [last]
  const q = sentences[sentences.length - 1]!.trim()
  // a very short question leans on the sentence before it
  return q.length < 40 && sentences.length > 1 ? (sentences[sentences.length - 2]!.trim() + ' ' + q) : q
}

/** Title and body for a finished run, from the session's name and the answer's text. */
export function finishedNotice(session: string, answer: string | null | undefined): { title: string; body: string } {
  const text = (answer ?? '').trim()
  const asked = text ? lastQuestion(text) : null
  if (asked) return { title: 'Prism has a question', body: asked.slice(0, 300) }
  const said = plain(text)
  if (!said) return { title: 'Prism finished', body: session }
  return { title: session ? `Prism finished: ${session}` : 'Prism finished', body: said.length > 300 ? said.slice(0, 299) + '…' : said }
}
