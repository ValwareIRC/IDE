// Small questions Prism asks a quick model on the user's behalf: why the agent made a call, a sharper
// version of a request, what a command will do, a review of a turn's changes, and a glance at a file the
// user just saved. Each uses the Fast role (or the default model) and answers in a few plain sentences.
import { createTwoFilesPatch } from 'diff'
import type { ReviewFile, ReviewFinding, ToolCall } from '@shared/types'
import { splitPieces, type SplitCommit, type SplitPiece } from '@core/git/split'
import { streamAnswer } from '@core/agent/council'
import { transcriptAsText } from '@core/agent/context'
import type { ResolvedModel } from '@core/agent/engine'
import type { Services } from './services'

function quick(s: Services, role: 'fast' | 'review' = 'fast'): ResolvedModel {
  const pick = (role === 'review' && s.settings.get().roles.review ? s.resolveModel(s.settings.get().roles.review!) : null) ?? s.roleModel('fast')
  if (!pick) throw new Error('No model to ask. Pick a Fast model under Settings, Model roles.')
  return pick
}

async function ask(model: ResolvedModel, system: string, user: string, maxTokens = 900): Promise<string> {
  const r = await streamAnswer(model, [{ role: 'system', content: system }, { role: 'user', content: user }], () => {}, undefined, maxTokens)
  return r.text.trim()
}

/** Why the agent made one of its tool calls, from the conversation up to it. */
export async function whyCall(s: Services, sessionId: string, itemId: string): Promise<string> {
  const items = s.repo.listItems(sessionId)
  const at = items.findIndex((i) => i.id === itemId)
  if (at < 0) throw new Error('That step is no longer in the session.')
  const tool = items[at]!
  const call = tool.kind === 'tool' ? `${tool.name} ${JSON.stringify(tool.args).slice(0, 800)}` : 'this step'
  const before = transcriptAsText(items.slice(Math.max(0, at - 40), at)).slice(-24_000)
  return ask(
    quick(s),
    "You explain an AI coding agent's actions to the person it works for. Plain words, no jargon, no preamble.",
    `The conversation so far:\n\n${before}\n\n---\nThe agent then made this call: ${call}\n\nIn two or three sentences: why did it make this call, and what was it trying to find out or get done? Base it on the conversation. If the reason is not clear from it, say what it was most likely after.`,
    400
  )
}

/** A request rewritten to be precise: what to do, where, and how to tell it is done. */
export async function sharpen(s: Services, text: string, root: string | null, files: string[] = []): Promise<string> {
  return ask(
    quick(s),
    'You turn rough requests to an AI coding agent into clear ones. Keep the person\'s intent and their wording where it is already clear; never add requirements they did not ask for. Reply with the rewritten request only.',
    `${root ? `Project folder: ${root}\n\n` : ''}${files.length ? `Files in the project (refer only to files from this list; never invent a path):\n${files.slice(0, 300).join('\n')}\n\n` : 'You do not know the project\'s files: do not name any file.\n\n'}Rewrite this request so an AI coding agent can do it without guessing. Say what to change and where if that is known, what must stay as it is, and add a short "Done when:" line with how to check it worked. If something important is ambiguous, keep it as a question at the end instead of deciding it. Keep it short.\n\nRequest:\n${text}`,
    700
  )
}

/** What a command or tool call will do and how risky it is, before the user approves it. */
export async function explainCall(s: Services, call: ToolCall, root: string | null): Promise<string> {
  return ask(
    quick(s),
    'You explain to a person what an action by their AI coding agent will do before they approve it. Plain words. Be concrete about what changes and whether it can be undone.',
    `${root ? `In the project folder ${root}, ` : ''}the agent wants to run: ${call.name} ${JSON.stringify(call.args).slice(0, 3000)}\n\nIn at most four short sentences: what will this do, what could it change or delete, and can it be undone? End with one line "Risk: low", "Risk: medium" or "Risk: high", and why.`,
    350
  )
}

/** Before an approval card: is this action plainly safe and part of what the user asked? Only "ok" lets it through. */
export async function checkCall(s: Services, sessionId: string, call: ToolCall, summary: string): Promise<{ ok: boolean; reason: string } | null> {
  const items = s.repo.listItems(sessionId)
  const lastUser = [...items].reverse().find((i) => i.kind === 'user')
  const recent = transcriptAsText(items.slice(-12)).slice(-8000)
  const answer = await Promise.race([
    ask(
      quick(s, 'review'),
      'You check actions an AI coding agent wants to take, so its user is only asked about the ones that need them. Be strict: when unsure, ask.',
      `The user's request: ${lastUser && lastUser.kind === 'user' ? lastUser.text.slice(0, 3000) : '(none)'}\n\nRecent work:\n${recent}\n\n---\nThe agent now wants to: ${summary}\nThe call: ${call.name} ${JSON.stringify(call.args).slice(0, 4000)}\n\nReply with exactly one line.\n"OK: <a few words why>" only if all of these hold: it is plainly part of what the user asked; it only touches files inside the project; it deletes nothing the user wrote; it installs nothing, uploads nothing and sends nothing over the network; it does not rewrite git history or push; it does not touch secrets, keys or settings outside the project.\nOtherwise "ASK: <what the user should know, in a few words>".`,
      120
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('ASK: the check took too long'), 20_000))
  ])
  const m = /^\s*(OK|ASK)\s*:\s*(.+)$/im.exec(answer)
  if (!m) return { ok: false, reason: 'the checker was not sure' }
  return { ok: m[1]!.toUpperCase() === 'OK', reason: m[2]!.trim().slice(0, 200) }
}

function patchOf(files: ReviewFile[], limit = 60_000): string {
  let out = ''
  for (const f of files) {
    out += createTwoFilesPatch(`a/${f.path}`, `b/${f.path}`, f.before ?? '', f.after ?? '', '', '', { context: 3 })
    if (out.length > limit) return out.slice(0, limit) + '\n… (the rest of the change is cut)'
  }
  return out
}

/** How hard a request is, for choosing a model: a quick look, never more than a few seconds. */
export async function difficulty(s: Services, text: string): Promise<'easy' | 'normal' | 'hard'> {
  const answer = await Promise.race([
    ask(
      quick(s),
      'You sort requests to an AI coding agent by how hard they are. Reply with one word.',
      `EASY: a question, a small edit, renaming, a typo, running something.\nNORMAL: a feature or fix in a few files.\nHARD: design across many files, a subtle bug, a tricky algorithm, performance or concurrency, security.\n\nThe request:\n${text.slice(0, 4000)}\n\nOne word: EASY, NORMAL or HARD.`,
      10
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('NORMAL'), 8000))
  ]).catch(() => 'NORMAL')
  return /hard/i.test(answer) ? 'hard' : /easy/i.test(answer) ? 'easy' : 'normal'
}

/** Several attempts at one request compared by the Review model: which to keep, and a line on each. */
export async function judgeWays(s: Services, request: string, ways: Array<{ sessionId: string; label: string }>): Promise<{ best: number; why: string; notes: string[]; model: string }> {
  const parts: string[] = []
  for (const [i, w] of ways.entries()) {
    const files = await s.agent.copyChanges(w.sessionId).catch(() => [] as ReviewFile[])
    const items = s.repo.listItems(w.sessionId)
    const answer = [...items].reverse().find((x) => x.kind === 'assistant' && !x.toolCalls.length && x.text.trim())
    const verdict = [...items].reverse().find((x) => x.kind === 'system' && Array.isArray(x.meta?.['verdict']))
    const checks = verdict && verdict.kind === 'system' ? ((verdict.meta!['verdict'] as Array<{ name: string; ok: boolean }>).map((c) => `${c.ok ? 'passed' : 'FAILED'}: ${c.name}`).join('; ')) : 'none recorded'
    const cost = s.repo.getSession(w.sessionId)?.cost ?? 0
    parts.push(`## Way ${i + 1} (${w.label})\nIts own checks: ${checks}\nCost: $${cost.toFixed(4)}\nWhat it said at the end:\n${answer && answer.kind === 'assistant' ? answer.text.slice(0, 2500) : '(nothing)'}\n\nIts change:\n${patchOf(files, Math.floor(50_000 / ways.length)) || '(no change)'}`)
  }
  const model = quick(s, 'review')
  const text = await ask(
    model,
    'You compare several attempts by AI coding agents at the same request and say which one to keep. Judge by correctness first, then whether it does what was asked and no more, then how clean the change is; cost only breaks ties. Be concrete.',
    `The request: ${request}\n\n${parts.join('\n\n')}\n\nReply in exactly this form:\nBEST: <the number of the way to keep>\nWHY: <one or two sentences>\n${ways.map((_, i) => `WAY ${i + 1}: <one short line: its main strength or problem>`).join('\n')}`,
    900
  )
  const best = Number(/BEST:\s*(\d+)/i.exec(text)?.[1] ?? '0')
  const why = /WHY:\s*(.+)/i.exec(text)?.[1]?.trim() ?? text.slice(0, 300)
  const notes = ways.map((_, i) => new RegExp(`WAY ${i + 1}:\\s*(.+)`, 'i').exec(text)?.[1]?.trim() ?? '')
  if (!(best >= 1 && best <= ways.length)) throw new Error(`The judge did not pick one: ${text.slice(0, 200)}`)
  return { best: best - 1, why, notes, model: model.info.modelId }
}

/** A pull request's (or branch's) change reviewed: real findings only, with where, why and how to fix. */
export async function reviewDiff(s: Services, diff: string, title: string, focus: 'general' | 'security', rules: string): Promise<{ findings: ReviewFinding[]; model: string }> {
  if (!diff.trim()) return { findings: [], model: '' }
  const model = quick(s, 'review')
  const lens =
    focus === 'security'
      ? 'Look only for security problems: injection (SQL, shell, HTML/script), broken or missing authentication and authorisation, secrets or keys in code, unsafe deserialisation or file paths, data exposed to the wrong people, prompt injection into AI features, unsafe dependencies.'
      : 'Look for real problems: bugs, wrong behaviour, unhandled errors or edge cases, race conditions, security holes, data loss, breaking changes for callers, and missing tests for risky logic. Not style or taste.'
  const text = await ask(
    model,
    'You review code changes for a careful senior engineer. You report only things worth a person\'s time, each with where it is, why it matters and how to fix it. Reply with JSON only.',
    `Change: ${title}\n\n${lens}${rules.trim() ? `\n\nThe team has decided these are NOT problems; do not report them:\n${rules.slice(0, 6000)}` : ''}\n\nThe diff:\n${diff.slice(0, 90_000)}${diff.length > 90_000 ? '\n… (the rest of the diff is cut)' : ''}\n\nReply with exactly: {"findings": [{"severity": "problem" | "risk" | "minor", "file": "path as in the diff", "line": <line number in the new version, or null>, "title": "a few words", "detail": "what is wrong and why it matters, one to three sentences", "fix": "how to fix it, concretely"}]}. At most ten, most important first. An empty list is a fine answer when nothing is worth reporting.`,
    3000
  )
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let raw: { findings?: Array<Record<string, unknown>> } = {}
  try {
    raw = JSON.parse(json) as typeof raw
  } catch {
    throw new Error(`The review could not be read: ${text.slice(0, 200)}`)
  }
  const findings = (raw.findings ?? []).map((f) => ({
    severity: (['problem', 'risk', 'minor'].includes(String(f['severity'])) ? f['severity'] : 'risk') as ReviewFinding['severity'],
    file: String(f['file'] ?? ''),
    line: typeof f['line'] === 'number' && f['line'] > 0 ? Math.floor(f['line']) : null,
    title: String(f['title'] ?? '').slice(0, 120),
    detail: String(f['detail'] ?? ''),
    fix: String(f['fix'] ?? '')
  })).filter((f) => f.title || f.detail)
  return { findings: findings.slice(0, 10), model: model.info.modelId }
}

/** Uncommitted work grouped into commits by topic, in an order where none needs a later one. */
export async function planSplit(s: Services, root: string): Promise<{ pieces: SplitPiece[]; commits: SplitCommit[]; model: string }> {
  const { pieces } = await splitPieces(root)
  if (!pieces.length) throw new Error('There is nothing uncommitted to split.')
  const budget = Math.max(400, Math.floor(60_000 / pieces.length))
  const listing = pieces.map((p) => `### ${p.id} | ${p.path} | ${p.title} | +${p.added} -${p.removed}\n${p.text.slice(0, budget)}`).join('\n\n')
  const model = quick(s, 'review')
  const text = await ask(
    model,
    'You split a developer\'s uncommitted changes into a few clean commits, each about one thing, the way a careful developer would. Reply with JSON only.',
    `These are the pieces of the change (each hunk of a file, or a whole file):\n\n${listing}\n\nGroup every piece into commits. Each commit is about one thing. Order them so no commit needs a later one (a function before the code that calls it). Usually two to five commits; one is fine if it is all one thing. Write each message in the style of a good commit message: a short summary line in the imperative, a blank line and a sentence more only when it helps.\n\nReply with exactly: {"commits": [{"message": "...", "why": "one short sentence", "pieces": ["f0h0", ...]}]}. Every piece id exactly once.`,
    2500
  )
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let raw: { commits?: Array<{ message?: unknown; why?: unknown; pieces?: unknown }> }
  try {
    raw = JSON.parse(json) as typeof raw
  } catch {
    throw new Error(`The model's plan could not be read: ${text.slice(0, 200)}`)
  }
  const ids = new Set(pieces.map((p) => p.id))
  const used = new Set<string>()
  const commits: SplitCommit[] = (raw.commits ?? [])
    .map((c) => ({
      message: String(c.message ?? '').trim() || 'Changes',
      why: String(c.why ?? '').trim(),
      pieces: (Array.isArray(c.pieces) ? c.pieces.map(String) : []).filter((id) => ids.has(id) && !used.has(id) && (used.add(id), true))
    }))
    .filter((c) => c.pieces.length)
  // anything the model left out goes with the last commit, so nothing is lost
  const left = pieces.filter((p) => !used.has(p.id)).map((p) => p.id)
  if (left.length) {
    if (commits.length) commits[commits.length - 1]!.pieces.push(...left)
    else commits.push({ message: 'Changes', why: '', pieces: left })
  }
  return { pieces, commits, model: model.info.modelId }
}

/** A second model's review of a turn's changes: real problems only, or "Looks right." */
export async function reviewChanges(s: Services, files: ReviewFile[], request: string): Promise<{ text: string; model: string } | null> {
  if (!files.length) return null
  const model = quick(s, 'review')
  const text = await ask(
    model,
    'You review changes an AI coding agent just made. You care about real defects only: bugs, broken behaviour, missed cases the request needed, security holes, data loss. Not style, not naming, not nice-to-haves.',
    `The user asked:\n${request.slice(0, 4000)}\n\nThe agent changed:\n\n${patchOf(files)}\n\nList each real problem as "- path:line: what is wrong and why it matters", most serious first, at most six. If the change looks right, reply exactly "Looks right." and nothing else.`,
    1200
  )
  return { text, model: model.info.modelId }
}

/** A glance at a file the user just saved: one warning if something looks broken, else null. */
export async function pairGlance(s: Services, path: string, before: string, after: string): Promise<string | null> {
  if (before === after) return null
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 4 })
  if (patch.length > 40_000) return null
  const text = await ask(
    quick(s),
    'You glance over a change a programmer just saved, like a colleague looking over their shoulder. Speak up only for a likely bug: a typo in a name, a wrong condition, an off-by-one, a missing await or return, a broken call. Never for style.',
    `${patch}\n\nIf there is a likely bug, reply with one short sentence starting with the line number, like "Line 12: …". Otherwise reply exactly "OK".`,
    200
  )
  return /^ok\.?$/i.test(text) || !text ? null : text.slice(0, 400)
}
