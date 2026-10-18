// Checks Prism's Anthropic connection against the request and reply shapes in
// Anthropic's documentation, with no network: fetch is replaced by replies built here.
//   esbuild scripts/anthropic-test/check.ts --bundle --platform=node --outfile=scripts/anthropic-test/check.js && node scripts/anthropic-test/check.js
import { anthropicAdapter, requestFor, shapeOf } from '../../src/core/providers/anthropic'
import type { ChatRequest, ChatResult, Message } from '../../src/core/providers/types'

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++
  else {
    failed++
    console.log(`FAIL ${name}${detail === undefined ? '' : `\n     ${JSON.stringify(detail)}`}`)
  }
}

const anthropicApi = { id: 'a', name: 'Anthropic', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: { kind: 'header', name: 'x-api-key' }, extraHeaders: {} } as never
const proxy = { id: 'p', name: 'Proxy', adapter: 'anthropic', baseUrl: 'https://example.com/anthropic', auth: { kind: 'bearer' }, extraHeaders: {} } as never

// ---- what each model accepts
const shapes: Array<[string, Partial<ReturnType<typeof shapeOf>>]> = [
  ['claude-opus-5-5', { claude: true, thinking: 'adaptive', off: 'omit', alwaysThinks: true, askSummary: true, sampling: false, fallbacks: true }],
  ['anthropic.claude-opus-5-5', { claude: true, alwaysThinks: true, sampling: false }],
  ['claude-opus-5', { thinking: 'adaptive', off: 'disabled', alwaysThinks: false, sampling: false, fallbacks: true }],
  ['claude-opus-4-8', { thinking: 'adaptive', off: 'omit', askSummary: true, sampling: false, fallbacks: false }],
  ['claude-opus-4-7', { thinking: 'adaptive', off: 'omit', sampling: false }],
  ['claude-opus-4-6', { thinking: 'adaptive', askSummary: false, sampling: true }],
  ['claude-opus-4-5-20251101', { thinking: 'budget', sampling: true }],
  ['claude-sonnet-5-5', { thinking: 'adaptive', off: 'between_tools', sampling: false, fallbacks: true }],
  ['claude-sonnet-5', { thinking: 'adaptive', off: 'disabled', sampling: false, fallbacks: false }],
  ['claude-sonnet-4-6', { thinking: 'adaptive', sampling: true }],
  ['claude-sonnet-4-5', { thinking: 'budget', sampling: true }],
  ['claude-haiku-4-5', { thinking: 'budget', sampling: true }],
  ['claude-3-7-sonnet-20250219', { claude: true, thinking: 'budget', sampling: true }],
  ['claude-fable-5-1', { thinking: 'adaptive', alwaysThinks: true, sampling: false, fallbacks: true }],
  ['claude-fable-5', { alwaysThinks: true, sampling: false, fallbacks: false }],
  ['claude-mythos-5-1', { alwaysThinks: true, sampling: false, fallbacks: false }],
  ['claude-opus-6', { thinking: 'adaptive', sampling: false }],
  ['glm-4.6', { claude: false, thinking: 'budget', sampling: true, fallbacks: false }]
]
for (const [model, want] of shapes) {
  const got = shapeOf(model)
  for (const [k, v] of Object.entries(want)) check(`shape ${model}.${k}`, (got as Record<string, unknown>)[k] === v, { want: v, got: (got as Record<string, unknown>)[k] })
}

// ---- request bodies
const req = (model: string, o: Partial<ChatRequest> = {}): ChatRequest => ({ model, messages: [{ role: 'user', content: 'hi' }], cache: false, ...o })
{
  const { body, betas } = requestFor(anthropicApi, req('claude-opus-5-5', { reasoning: true, temperature: 0.4 }))
  const t = body['thinking'] as Record<string, unknown>
  check('opus 5.5 on: adaptive', t?.['type'] === 'adaptive', t)
  check('opus 5.5 on: summary asked for', t?.['display'] === 'summarized', t)
  check('opus 5.5 on: bound, drop', (t?.['block_binding'] as Record<string, unknown>)?.['prefix_mismatch_behavior'] === 'drop_block', t)
  check('opus 5.5: no temperature', !('temperature' in body), body)
  check('opus 5.5: fallbacks default', body['fallbacks'] === 'default', body['fallbacks'])
  check('opus 5.5: betas', betas.includes('thinking-binding-controls-2026-08-01') && betas.includes('server-side-fallback-2026-07-01'), betas)
  check('opus 5.5: no budget', !('budget_tokens' in (t ?? {})), t)
}
{
  const { body } = requestFor(anthropicApi, req('claude-opus-5-5', { reasoning: false }))
  const t = body['thinking'] as Record<string, unknown>
  check('opus 5.5 off: never disabled', t?.['type'] === 'adaptive' && !('display' in t), t)
}
{
  const { body, betas } = requestFor(proxy, req('claude-opus-5-5', { reasoning: true }))
  const t = body['thinking'] as Record<string, unknown>
  check('proxy: no binding', !('block_binding' in (t ?? {})), t)
  check('proxy: no fallbacks', !('fallbacks' in body), body)
  check('proxy: no betas', betas.length === 0, betas)
}
{
  const { body, betas } = requestFor(anthropicApi, req('claude-sonnet-5-5', { reasoning: false, temperature: 0.2 }))
  check('sonnet 5.5 off: between_tools, nothing else', JSON.stringify(body['thinking']) === '{"type":"between_tools"}', body['thinking'])
  check('sonnet 5.5 off: no fallbacks with between_tools', !('fallbacks' in body), body)
  check('sonnet 5.5: no temperature', !('temperature' in body), body)
  check('sonnet 5.5 off: no binding beta', !betas.includes('thinking-binding-controls-2026-08-01'), betas)
}
{
  const { body } = requestFor(anthropicApi, req('claude-opus-5', { reasoning: false }))
  check('opus 5 off: disabled', JSON.stringify(body['thinking']) === '{"type":"disabled"}', body['thinking'])
}
{
  const { body } = requestFor(anthropicApi, req('claude-opus-4-8', { reasoning: false, temperature: 0.5 }))
  check('opus 4.8 off: no thinking field', !('thinking' in body), body)
  check('opus 4.8: no temperature', !('temperature' in body), body)
}
{
  const { body } = requestFor(anthropicApi, req('claude-opus-4-6', { reasoning: false, temperature: 0.3 }))
  check('opus 4.6 off: temperature kept', body['temperature'] === 0.3, body)
  const on = requestFor(anthropicApi, req('claude-opus-4-6', { reasoning: true, temperature: 0.3 })).body
  check('opus 4.6 on: adaptive, default display', JSON.stringify((on['thinking'] as Record<string, unknown>)['type']) === '"adaptive"' && !('display' in (on['thinking'] as object)), on['thinking'])
  check('opus 4.6 on: no temperature with thinking', !('temperature' in on), on)
}
{
  const { body } = requestFor(anthropicApi, req('claude-haiku-4-5', { reasoning: true, maxTokens: 16000 }))
  const t = body['thinking'] as Record<string, unknown>
  check('haiku 4.5 on: budget', t?.['type'] === 'enabled' && Number(t?.['budget_tokens']) >= 1024 && Number(t?.['budget_tokens']) < 16000, t)
}
{
  // GLM behind an Anthropic-style endpoint: exactly what it always had
  const on = requestFor(proxy, req('glm-4.6', { reasoning: true, maxTokens: 16000 })).body
  check('glm on: budget as before', JSON.stringify(on['thinking']) === JSON.stringify({ type: 'enabled', budget_tokens: 9600 }), on['thinking'])
  const off = requestFor(proxy, req('glm-4.6', { reasoning: false, temperature: 0.7 })).body
  check('glm off: temperature as before', off['temperature'] === 0.7 && !('thinking' in off), off)
}

// ---- what is sent back
const T1 = { type: 'thinking', thinking: 'Earlier summary.', signature: 'sig-1' }
const T2 = { type: 'thinking', thinking: '', signature: 'sig-2' }
const T3 = { type: 'thinking', thinking: 'Progress note.', signature: 'sig-3' }
const history: Message[] = [
  { role: 'system', content: 'You are Prism.' },
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer', reasoning: 'Earlier summary.', blocks: [T1, { type: 'text', text: 'first answer' }] },
  { role: 'user', content: 'second question' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'tu_1', name: 'read_file', args: { path: 'a.ts' } }], blocks: [T2, T3, { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } }] },
  { role: 'tool', callId: 'tu_1', name: 'read_file', content: 'file text', isError: false }
]
{
  const { body } = requestFor(anthropicApi, req('claude-opus-5-5', { messages: history, reasoning: true }))
  const msgs = body['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>
  const earlier = msgs[1]!
  check('earlier turn: no thinking sent back', earlier.role === 'assistant' && !earlier.content.some((b) => b['type'] === 'thinking'), earlier)
  check('earlier turn: its text kept', earlier.content.some((b) => b['type'] === 'text' && b['text'] === 'first answer'), earlier)
  const current = msgs[3]!
  check('current turn: blocks exactly as they came', JSON.stringify(current.content) === JSON.stringify([T2, T3, { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } }]), current.content)
  check('current turn: empty thinking block kept', current.content[0]?.['thinking'] === '' && current.content[0]?.['signature'] === 'sig-2', current.content[0])
  check('tool result follows', msgs[4]?.content[0]?.['type'] === 'tool_result', msgs[4])
  const strip = requestFor(anthropicApi, req('claude-opus-5-5', { messages: history, reasoning: true }), true).body
  const all = (strip['messages'] as Array<{ content: Array<Record<string, unknown>> }>).flatMap((m) => m.content)
  check('retry without thinking: none left', !all.some((b) => b['type'] === 'thinking' || b['type'] === 'redacted_thinking'), all)
  check('retry without thinking: tool call kept', all.some((b) => b['type'] === 'tool_use' && b['id'] === 'tu_1'), all)
}
{
  // GLM: every turn's thinking goes back, as before
  const glmHistory: Message[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1', reasoning: 'r1', reasoningSignature: 's1' },
    { role: 'user', content: 'q2' }
  ]
  const { body } = requestFor(proxy, req('glm-4.6', { messages: glmHistory, reasoning: true }))
  const a = (body['messages'] as Array<{ content: Array<Record<string, unknown>> }>)[1]!
  check('glm: earlier thinking still sent', a.content[0]?.['type'] === 'thinking' && a.content[0]?.['signature'] === 's1', a)
}

// ---- reading replies
function sse(events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}
let sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
function serve(replies: Array<{ status: number; text: string }>): void {
  sent = []
  let n = 0
  ;(globalThis as { fetch: unknown }).fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    const r = replies[Math.min(n++, replies.length - 1)]!
    return new Response(r.text, { status: r.status, headers: { 'content-type': r.status === 200 ? 'text/event-stream' : 'application/json' } })
  }
}
async function run(ep: never, r: ChatRequest): Promise<ChatResult> {
  const gen = anthropicAdapter.chat(ep, 'key', r)
  let x = await gen.next()
  while (!x.done) x = await gen.next()
  return x.value
}
const start = (model: string): unknown => ({ type: 'message_start', message: { id: 'm', model, usage: { input_tokens: 10, output_tokens: 1 } } })

async function replies(): Promise<void> {
  // thinking, text, a tool call: kept exactly, in order
  serve([
    {
      status: 200,
      text: sse([
        start('claude-opus-5-5'),
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look at a.ts first.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIGA' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading it.' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'SIGB' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu_9', name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
        { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: 'th":"a.ts"}' } },
        { type: 'content_block_stop', index: 3 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
        { type: 'message_stop' }
      ])
    }
  ])
  const r = await run(anthropicApi, req('claude-opus-5-5', { reasoning: true }))
  check('reply: blocks in order, exact', JSON.stringify(r.blocks) === JSON.stringify([
    { type: 'thinking', thinking: 'Look at a.ts first.', signature: 'SIGA' },
    { type: 'text', text: 'Reading it.' },
    { type: 'thinking', thinking: '', signature: 'SIGB' },
    { type: 'tool_use', id: 'tu_9', name: 'read_file', input: { path: 'a.ts' } }
  ]), r.blocks)
  check('reply: text', r.text === 'Reading it.', r.text)
  check('reply: summary shown', r.reasoning === 'Look at a.ts first.', r.reasoning)
  check('reply: tool call', r.toolCalls.length === 1 && r.toolCalls[0]!.args['path'] === 'a.ts', r.toolCalls)
  check('reply: no stand-in', !r.servedBy, r.servedBy)
  check('request: betas header', (sent[0]!.headers['anthropic-beta'] ?? '').includes('thinking-binding-controls-2026-08-01'), sent[0]!.headers)

  // declined partway: nothing kept, nothing run
  serve([
    {
      status: 200,
      text: sse([
        start('claude-opus-5-5'),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sure, here is how to' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_x', name: 'shell', input: {} } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined.' } }, usage: { output_tokens: 5 } },
        { type: 'message_stop' }
      ])
    }
  ])
  const d = await run(anthropicApi, req('claude-opus-5-5', {}))
  check('declined: flagged', !!d.declined && d.stopReason === 'refusal', d)
  check('declined: plain reason', d.declined?.why === 'it looked like security work this model will not do', d.declined)
  check('declined: nothing kept', d.text === '' && d.toolCalls.length === 0 && !d.blocks, d)

  // handed over partway: only the text before the handover goes back
  serve([
    {
      status: 200,
      text: sse([
        start('claude-opus-5-5'),
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'S0' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Partial. ' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } },
        { type: 'content_block_stop', index: 2 },
        { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'Rest.' } },
        { type: 'content_block_stop', index: 3 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' }
      ])
    }
  ])
  const f = await run(anthropicApi, req('claude-opus-5-5', {}))
  check('handover: named', f.servedBy === 'claude-opus-5', f.servedBy)
  check('handover: only earlier text kept before it', JSON.stringify(f.blocks) === JSON.stringify([{ type: 'text', text: 'Partial. ' }, { type: 'text', text: 'Rest.' }]), f.blocks)

  // a refused thinking block: one retry with none
  serve([
    { status: 400, text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }) },
    { status: 200, text: sse([start('claude-opus-5-5'), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]) }
  ])
  const s = await run(proxy, req('claude-opus-5-5', { messages: history, reasoning: true }))
  check('refused block: retried once', sent.length === 2, sent.length)
  const second = (sent[1]?.body['messages'] as Array<{ content: Array<Record<string, unknown>> }> | undefined)?.flatMap((m) => m.content) ?? []
  check('refused block: retry has no thinking', !second.some((b) => b['type'] === 'thinking'), second)
  check('refused block: answered', s.text === 'ok', s.text)

  // GLM reply: one thinking block and its signature, as it always was
  serve([
    {
      status: 200,
      text: sse([
        start('glm-4.6'),
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'G1' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' }
      ])
    }
  ])
  const g = await run(proxy, req('glm-4.6', { reasoning: true }))
  check('glm reply: as before', g.reasoning === 'hmm' && g.reasoningSignature === 'G1' && g.text === 'hi' && !g.blocks, g)
}

replies()
  .then(() => {
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
