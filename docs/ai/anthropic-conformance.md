# Claude and Anthropic's terms

What Prism does to stay within Anthropic's rules, and why. Checked against Anthropic's
documentation on 2026-10-08 (the claude-api skill's model-migration guide, and the Agent
SDK overview at code.claude.com/docs/en/agent-sdk/overview). Change any of it only
against Anthropic's current documentation, never from memory.

## Thinking

- **What comes back is a summary, never the raw reasoning.** On every current Claude
  model the API returns a summary written for display (`display: "summarized"`), or an
  empty block (`"omitted"`, the default from Opus 4.7). The raw chain of thought is never
  sent. Prism shows the summary and labels it "thinking summary" (`thoughtIsSummary` in
  `renderer/src/state/app.ts`); other providers' reasoning text keeps the word "thought".
- **Never ask a model to write out its internal reasoning** in its answer. Anthropic's
  safety checks decline that (`stop_details.category: "reasoning_extraction"`), and it is
  not a fallback-retryable decline. Asking for a short explanation of an answer, or a
  summary of what was done, is fine - that is what the "why did it do that?" button does,
  from the visible conversation only.
- Claude Code sessions (`core/claude`) show what Claude Code receives; Claude Code is
  Anthropic's own harness and keeps these rules itself.

## Prism's own agent on Anthropic's API (`core/providers/anthropic.ts`)

- **Request shape per model** (`shapeOf`): adaptive thinking from the 4.6 models on, a
  token budget before them (a budget is a 400 from Opus 4.7). Opus 5.5 and Fable always
  think: "off" means not asking to see it. Sonnet 5.5 turns thinking off with
  `between_tools` (no other field beside it); Opus 5 and Sonnet 5 with `disabled`.
  Temperature is a 400 on Opus 4.7+, Sonnet 5+ and Fable, so it is only sent where
  accepted and never with thinking on. Non-Claude models behind an Anthropic-style
  endpoint (GLM) keep the request they always had.
- **Replies go back exactly as they came.** Every block - thinking (even empty), text,
  tool calls, in order - is kept on the transcript item (`AssistantItem.blocks`) and sent
  back unchanged while the turn is running. Changing a thinking block is refused.
- **History a thinking block depends on is never edited.** A thinking block is valid
  only while everything before it (system prompt, tools, earlier messages) is unchanged.
  Prism rebuilds its system prompt each turn, so thinking from earlier turns is left out,
  oldest first - removing a leading run of thinking blocks is explicitly allowed. On
  Anthropic's own API, `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`
  (beta `thinking-binding-controls-2026-08-01`) is a safety net; elsewhere, a refused
  block gets the documented recovery: send the history once more with no thinking.
- **A decline** (`stop_reason: "refusal"`) throws away what was written, runs none of its
  tool calls, and tells the user in plain words. On Anthropic's own API the newest models
  are sent `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) so a
  recommended model can take over; when one does, the transcript says so and names it.

## Claude Agent sessions and logins

- The Agent SDK pages carry a one-line note: *"Unless previously approved, Anthropic does
  not allow third party developers to offer claude.ai login or rate limits for their
  products, including agents built on the Claude Agent SDK."* The full rule is on Claude
  Code's legal and compliance page (code.claude.com/docs/en/legal-and-compliance, read
  2026-10-18), and it is narrower: developers may not build Claude.ai login into their own
  apps, route requests through plan credentials *on their users' behalf*, or collect,
  store or intermediate Claude credentials. It explicitly does not prevent *"an end user
  from signing in to the unmodified Claude Code binary with their own Claude
  subscription, including where a platform hosts Claude Code"*.
- That is what Prism's Claude Agent does, so it may be shared, as long as it keeps the
  conditions under "Can customers offer Claude Code in their products?": it runs the
  person's own unmodified Claude Code; it never removes or restricts Claude Code's sign-in
  methods; each person signs in through Anthropic's own flow, in Claude Code; Prism never
  sees, stores or passes on a credential; and usage is billed to that person, never paid
  for or resold by Prism. Running Claude Code in a product means agreeing to the
  Commercial Terms of Service. A sign-in screen of Prism's own, a shared plan, or anything
  that touches `.credentials.json` would break this.
- An earlier version of these notes said the opposite (API keys only once shared): that
  came from reading the one-line note alone, from memory, and was wrong.
- Branding: the option is "Claude Agent" (`CLAUDE_ENDPOINT_NAME`), which Anthropic lists
  as preferred. Prism must not label its own agent "Claude Code" or look like Claude Code;
  saying that a session runs the Claude Code installed on the computer is a plain fact
  and fine.
- The Agent SDK is used under Anthropic's Commercial Terms of Service.

## One-off answers from a Claude Agent model (`core/providers/claudecode.ts`)

Since 0.24.12 a Claude Agent model can take the Fast, Vision and Review roles, second
opinions and model comparisons: requests that want one answer and no tools. They go
through the same Claude Code login, on the same computer, for the same user, so the
login rule above covers them unchanged. Each is a single turn (`maxTurns: 1`) with Claude
Code's own tools off (`tools: []`), no settings, CLAUDE.md or MCP servers read
(`settingSources: []`, `strictMcpConfig`), and nothing kept in its history
(`persistSession: false`) - options checked against the installed SDK (0.3.287,
sdk.d.ts) on 2026-10-18. A request with tools is refused, so Fallback and Strong (which
take over Prism's own agent) and ghost text (which asks on every pause in typing and
would use the plan up) stay off Claude.
