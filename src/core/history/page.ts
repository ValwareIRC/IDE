// A conversation as a page anyone can read: one HTML file that opens in any browser,
// with no Prism needed, for sending to someone. The session itself travels inside it
// too, so a person who does have Prism can open the same file there and carry on, with
// their own model and their own account.
//
// The model's private thinking is left out of both: it was never part of the
// conversation the user saw.
import type { SessionFile } from './portable'
import type { TranscriptItem } from '@shared/types'

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** Enough Markdown for a conversation: code, headings, lists, quotes, emphasis and links. */
export function markdown(md: string): string {
  const out: string[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const inline = (t: string): string =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
  let i = 0
  while (i < lines.length) {
    const l = lines[i]!
    if (/^```/.test(l)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!)
      i++
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const hd = /^(#{1,4})\s+(.*)$/.exec(l)
    if (hd) {
      const n = Math.min(4, hd[1]!.length + 2)
      out.push(`<h${n}>${inline(hd[2]!)}</h${n}>`)
      i++
      continue
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) items.push(`<li>${inline(lines[i++]!.replace(/^\s*([-*+]|\d+\.)\s+/, ''))}</li>`)
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^>\s?/.test(l)) {
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ''))
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`)
      continue
    }
    if (/^\|.*\|\s*$/.test(l)) {
      const rows: string[][] = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i++]!.trim().slice(1, -1).split('|').map((c) => c.trim())
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells)
      }
      out.push(`<table>${rows.map((r, n) => `<tr>${r.map((c) => (n === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`).join('')}</table>`)
      continue
    }
    if (!l.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,4}\s|>|\s*([-*+]|\d+\.)\s|\|)/.test(lines[i]!)) para.push(lines[i++]!)
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
}

function toolLine(it: Extract<TranscriptItem, { kind: 'tool' }>): string {
  const a = it.args ?? {}
  const first = ['command', 'path', 'url', 'query', 'pattern', 'description'].map((k) => a[k]).find((v) => typeof v === 'string') as string | undefined
  return `${it.name.replace(/^mcp__\w+__/, '')}${first ? `: ${first.split('\n')[0]!.slice(0, 140)}` : ''}`
}

/** The session file without what should not travel: the model's private thinking. */
export function shareable(file: SessionFile): SessionFile {
  return {
    ...file,
    items: file.items.map((it) => (it.kind === 'assistant' ? { ...it, reasoning: null, reasoningSignature: null, blocks: null } : it))
  }
}

export function sessionPage(raw: SessionFile, opts: { tools?: boolean } = {}): string {
  const file = shareable(raw)
  const pics = file.pictures ?? {}
  const pic = (name: string): string => {
    const b64 = pics[name.split(/[\\/]/).pop() ?? '']
    if (!b64) return ''
    const ext = (name.split('.').pop() ?? 'png').toLowerCase()
    return `<img src="data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64}" alt="">`
  }
  const parts: string[] = []
  let steps: string[] = []
  const flush = (): void => {
    if (steps.length && opts.tools !== false) parts.push(`<details class="steps"><summary>${steps.length} step${steps.length === 1 ? '' : 's'}</summary>${steps.join('')}</details>`)
    steps = []
  }
  for (const it of file.items) {
    if (it.kind === 'user') {
      flush()
      const imgs = it.attachments.filter((a) => a.mime.startsWith('image/')).map((a) => pic(a.path)).join('')
      parts.push(`<section class="you"><div class="who">You</div>${markdown(it.text)}${imgs ? `<div class="pics">${imgs}</div>` : ''}</section>`)
    } else if (it.kind === 'assistant') {
      if (!it.text.trim() || it.agent) continue
      flush()
      parts.push(`<section class="ai"><div class="who">${esc(it.model?.modelId ? `Prism (${it.model.modelId})` : 'Prism')}</div>${markdown(it.text)}</section>`)
    } else if (it.kind === 'tool') {
      const detail = it.content ? `<pre>${esc(it.content.length > 3000 ? `${it.content.slice(0, 3000)}\n…` : it.content)}</pre>` : ''
      steps.push(`<details class="step${it.isError ? ' err' : ''}"><summary>${esc(toolLine(it))}</summary>${detail}</details>`)
    } else if (it.kind === 'system' && it.subkind === 'compaction') {
      flush()
      parts.push(`<section class="note"><div class="who">Summary of the earlier conversation</div>${markdown(it.text)}</section>`)
    }
  }
  flush()
  const when = new Date(file.exportedAt).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })
  // the session itself, for another Prism; "<" is escaped so nothing in it can end the script early
  const data = JSON.stringify(file).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(file.session.title)}</title>
<style>
  :root { --cream: #fdf8f3; --ink: #33293a; --soft: #6d5d6a; --you: #fbe3ea; --line: #ead9e0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--cream); color: var(--ink); font: 16px/1.6 'Segoe UI', system-ui, sans-serif; }
  header { padding: 40px 20px 20px; max-width: 820px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.2; }
  header p { margin: 0; color: var(--soft); font-size: 14px; }
  main { max-width: 820px; margin: 0 auto; padding: 0 20px 60px; display: flex; flex-direction: column; gap: 14px; }
  section { border-radius: 14px; padding: 12px 16px; }
  section.you { background: var(--you); margin-left: 12%; }
  section.ai { background: #fff; border: 1px solid var(--line); }
  section.note { background: #f3eef6; font-size: 14px; }
  .who { font-size: 12px; font-weight: 600; color: var(--soft); margin-bottom: 4px; }
  section p { margin: 6px 0; }
  pre { background: #2b2430; color: #f3eaf1; padding: 10px 12px; border-radius: 8px; overflow-x: auto; font-size: 14px; line-height: 1.45; }
  code { font-family: Consolas, 'Cascadia Mono', monospace; font-size: .92em; }
  p code, li code { background: #f1e6ec; padding: 1px 5px; border-radius: 4px; }
  table { border-collapse: collapse; margin: 8px 0; font-size: 14px; }
  th, td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
  blockquote { margin: 6px 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--soft); }
  .pics img { max-width: 100%; border-radius: 8px; margin-top: 8px; }
  details.steps { font-size: 13px; color: var(--soft); margin: -4px 0 0 4px; }
  details.steps > summary { cursor: pointer; }
  details.step { margin: 4px 0 4px 14px; }
  details.step > summary { cursor: pointer; font-family: Consolas, monospace; font-size: 13px; }
  details.step.err > summary { color: #b0405e; }
  details.step pre { font-size: 13.5px; max-height: 320px; }
  footer { max-width: 820px; margin: 0 auto; padding: 0 20px 40px; color: var(--soft); font-size: 13px; }
  a { color: var(--ink); }
</style>
</head>
<body>
<header>
  <h1>${esc(file.session.title)}</h1>
  <p>A conversation with Prism${file.project ? ` about ${esc(file.project)}` : ''}, shared on ${esc(when)}.</p>
</header>
<main>
${parts.join('\n')}
</main>
<footer>Have Prism? Open this file in it (Open a session file…) to carry the conversation on with your own model.</footer>
<script type="application/json" id="prism-session">${data}</script>
</body>
</html>
`
}

/** The session inside a shared page, for opening it in Prism. */
export function sessionFromPage(html: string): SessionFile | null {
  const m = /<script type="application\/json" id="prism-session">([\s\S]*?)<\/script>/.exec(html)
  if (!m) return null
  try {
    return JSON.parse(m[1]!) as SessionFile
  } catch {
    return null
  }
}
