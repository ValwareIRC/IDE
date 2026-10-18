// Domain types shared by main, preload and renderer. No runtime code here.
import type { Theme } from './theme'

// ---------------------------------------------------------------- providers

/** claude-code: Claude Agent models, for one-off answers through the Claude Code on this computer (providers/claudecode.ts). */
export type AdapterId = 'openai-compat' | 'anthropic' | 'gemini' | 'claude-code'

export type AuthKind = 'none' | 'bearer' | 'header' | 'query'

export interface AuthConfig {
  kind: AuthKind
  /** Header or query-parameter name for 'header' / 'query'. */
  name?: string
}

export interface Endpoint {
  id: string
  name: string
  adapter: AdapterId
  baseUrl: string
  auth: AuthConfig
  extraHeaders: Record<string, string>
  enabled: boolean
  createdAt: number
  probedAt: number | null
  probeLatencyMs: number | null
  probeError: string | null
  hasKey: boolean
}

export interface EndpointInput {
  id?: string
  name: string
  adapter: AdapterId
  baseUrl: string
  auth: AuthConfig
  extraHeaders?: Record<string, string>
  /** Write-only. Empty on edit keeps the stored key. */
  apiKey?: string
}

export interface ModelRef {
  endpointId: string
  modelId: string
}

export interface ModelMeta {
  contextWindow: number | null
  maxOutput: number | null
  supportsTools: boolean
  supportsVision: boolean
  reasoning: boolean
  /** USD per million tokens. */
  inputPrice: number | null
  outputPrice: number | null
}

export interface ModelInfo extends ModelMeta {
  /** `${endpointId}::${modelId}` */
  key: string
  endpointId: string
  endpointName: string
  adapter: AdapterId
  modelId: string
  /** Name to show instead of the id (Claude Agent models). */
  label?: string
  /** One line about the model, shown under its name. */
  note?: string
  /** Effort levels this model takes; absent when it has none to choose from. */
  efforts?: Effort[]
  favorite: boolean
}

export interface ProbeResult {
  ok: boolean
  latencyMs: number
  models: string[]
  error?: string
}

export interface ModelRoles {
  lead: ModelRef | null
  fast: ModelRef | null
  completion: ModelRef | null
  vision: ModelRef | null
  /** Used for the rest of a run when the lead model keeps failing. */
  fallback: ModelRef | null
  /** Takes over the rest of a turn when the agent is going round in circles. */
  strong?: ModelRef | null
  /** Reviews each turn's changes when automatic review is on. */
  review?: ModelRef | null
}

// ---------------------------------------------------------------- settings

/** 'plan': the agent may only read, and must present a plan for approval before any work starts. */
export type PermissionMode = 'ask' | 'auto-edit' | 'auto' | 'plan'

export interface PermissionRule {
  /** Tool name, e.g. "shell", "write_file", "mcp:blender:*". */
  tool: string
  /** Glob-ish pattern matched against the tool's primary argument (command, path). */
  pattern?: string
}

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  /** Names of environment variables whose values (tokens, passwords) are kept in the encrypted vault instead of here. */
  secrets?: string[]
  enabled: boolean
}

export interface RoutingRule {
  /** image: the message has a picture. plan: the session is in Plan first. short/long: by length (value = characters). keyword: value = comma-separated words. */
  when: 'image' | 'plan' | 'short' | 'long' | 'keyword'
  value?: string
  model: ModelRef | null
}

/** Progress of one model in a side-by-side comparison. key = endpointId::modelId, as modelKey() builds it. */
export type CompareEvent =
  | { type: 'delta'; key: string; text: string }
  | { type: 'done'; key: string; text: string; ms: number; inputTokens: number; outputTokens: number; cost: number }
  | { type: 'error'; key: string; message: string }

export type ConversationLayout = 'classic' | 'tidy' | 'folded' | 'strip' | 'rail' | 'answer'

/** One member of a fleet: a helper agent with its own model and instructions. */
export interface FleetMember {
  name: string
  model: ModelRef
  /** Who it is and how it works: put before its task. */
  persona: string
  /** May write files and run commands; otherwise it can only read and search. */
  canEdit: boolean
}

/** A saved team of helpers that works on one task in parallel, optionally with one more that combines their reports. */
export interface Fleet {
  name: string
  description: string
  members: FleetMember[]
  /** A last helper that reads every report and writes one answer; null hands back the reports as they are. */
  combine: { model: ModelRef; persona: string } | null
}

export interface Settings {
  roles: ModelRoles
  permissions: {
    mode: PermissionMode
    allow: PermissionRule[]
    deny: PermissionRule[]
    /** Before asking the user, a quick model looks at the action: plainly safe and part of the request goes ahead; anything else still asks. Never for high-risk actions. */
    checker: boolean
  }
  agent: {
    maxSteps: number
    compactAt: number
    reasoning: boolean
    temperature: number | null
    parallelTools: boolean
    /** When one of the user's own tools or gadgets fails, have the agent fix it in the background (the fix still waits for the user). */
    selfRepair: boolean
    /** How many times in a row the agent may be woken by news (a finished job, a timer, a helper) before it waits for the user. */
    wakeLimit: number
    /** Longest a shell command may run before it is stopped, in seconds (background commands are not limited). */
    shellTimeoutSec: number
    /** How many times a failed model call is tried again before giving up or switching to the fallback model. */
    retries: number
    /** How many times in a row a failing turn-end hook may send the agent back to fix it. */
    hookFixes: number
    /** Most helpers one team may have. */
    maxTeam: number
    /** Name new sessions from their first message. */
    autoTitle: boolean
    /** Which key sends a message; the other one adds a new line. */
    sendKey: 'enter' | 'ctrl-enter'
    /** Offer the file open in the editor, and anything selected in it, alongside the message. */
    editorContext: 'selection-and-file' | 'selection' | 'off'
    /** Warn when a conversation gets bigger than this many thousand tokens (every step sends all of it); 0 never warns. */
    sizeWarnK: number
  }
  editor: {
    fontSize: number
    tabSize: number
    /** Indent with spaces (true) or tab characters. */
    insertSpaces: boolean
    wordWrap: boolean
    minimap: boolean
    ghostText: boolean
    ghostTextDelayMs: number
    formatOnSave: boolean
    /** Save by itself: never, a moment after typing stops, or when the editor loses focus. */
    autoSave: 'off' | 'delay' | 'focus'
    autoSaveDelayMs: number
    fontLigatures: boolean
    lineHeight: number
    lineNumbers: 'on' | 'relative' | 'off'
    stickyScroll: boolean
    bracketColours: boolean
    renderWhitespace: 'none' | 'selection' | 'boundary' | 'all'
    cursorBlinking: 'smooth' | 'blink' | 'phase' | 'solid'
    smoothScrolling: boolean
    /** After a save, offer the same change in the other places that need it. */
    nextEdit: boolean
    /** A bar in the margin beside the lines the agent wrote. */
    agentLines: boolean
  }
  terminal: {
    shell: string | null
    fontSize: number
    /** The terminal's font; empty uses the theme's code font. */
    fontFamily: string
    /** Space from one line to the next, as a multiple of the font size. */
    lineHeight: number
    scrollback: number
    cursorStyle: 'bar' | 'block' | 'underline'
    cursorBlink: boolean
    /** Selecting text copies it. */
    copyOnSelect: boolean
    /** On a project switch, close idle terminals from the old project and open one in the new. */
    followProject: boolean
  }
  /** Prism's own extras around the agent, each of which can be turned off. */
  assist: {
    /** Offer a skill or rule when you correct the agent the same way more than once. */
    learn: boolean
    /** After a turn changes files, check whether the project spec still matches. */
    specChecks: boolean
    /** Before and after pictures of the page in the Browser panel when a turn changes web files. */
    pagePictures: boolean
    /** Offer a summary of what happened when you come back after this many minutes (0 = never). */
    catchUpAfterMin: number
    /** Colour the files the agent read and changed in the explorer. */
    agentMap: boolean
    /** Desktop notifications when Prism is in the background (finished, needs approval, news). */
    notifications: boolean
    /** After a turn changes code, have the Review (or Fast) model look for real problems. */
    autoReview: boolean
    /** Offer to build a gadget when a turn's work would be better seen in a panel. */
    gadgetIdeas: boolean
    /** When you save a file, have the Fast model glance at the change and speak up only about a likely bug. */
    pair: boolean
  }
  files: {
    /** Folder names Prism skips: not searched, not listed for the agent, not watched. Shown greyed out in the explorer. */
    hidden: string[]
  }
  /** Requests the user saved to reuse; {{blanks}} are filled in before sending. */
  recipes: Array<{ id: string; name: string; text: string }>
  appearance: {
    /** The active theme's id. Empty = not chosen yet (the old accent setting decides). */
    theme: string
    /** The user's own themes, each stored whole. */
    themes: Theme[]
    /** The active theme's backdrop colour, so the window can open in it before the page has loaded. */
    bg: string
    accent: string
    motion: boolean
    density: 'comfortable' | 'compact'
    glow: boolean
  }
  /** How the agent's conversation is laid out. */
  conversation: {
    /** classic: every step as it happened; tidy: one plain list; folded: the steps fold into a line when done; strip: chips above the answer; rail: steps in the margin beside the sentences they back up; answer: just the answer. */
    layout: ConversationLayout
    spacing: 'compact' | 'comfortable' | 'roomy'
    /** Words in the answer (files, commands, "tests pass") show the step behind them on hover. */
    linkedWords: boolean
    /** Assumptions, proof and the reviewer's opinion gathered under the answer. */
    needsUnder: boolean
    /** Tell the agent not to paste code it changed or repeat its assumptions in the answer. */
    noRepeat: boolean
    /** The agent's thinking: always under the step, only when a step is opened, or never. */
    thinking: 'always' | 'opened' | 'never'
    /** When each message was sent, and how long each request took. */
    times: boolean
    /**
     * How many of the latest requests are drawn. The rest are a click away. A long
     * conversation drawn whole makes the whole panel slow, typing included, because
     * every request on the page takes part in every redraw.
     */
    drawn: number
  }
  /** The Prism phone app: paired devices reach this Prism directly (port) or through a relay (its address). */
  remote: { enabled: boolean; port: number; relay: string; /** Ask the home router to open the port (UPnP / NAT-PMP). */ upnp: boolean }
  /** Control from your phone: a page on the home network, paired with a code. */
  phone: { enabled: boolean; port: number }
  /** Speaking instead of typing in the message box. */
  voice: {
    /** local: Whisper inside Prism; provider: a provider's speech-to-text; windows: Windows' own dictation (Win+H). */
    engine: 'local' | 'provider' | 'windows'
    localModel: 'tiny' | 'base' | 'small'
    /** The provider for 'provider', and its speech model's name. */
    endpointId: string
    model: string
    /** A language code ("en", "fr"); empty works it out. */
    language: string
  }
  /** The voice Prism speaks with, which is not the same thing as how it hears you. */
  speech: {
    /** windows: the computer's own, instant but plain. kokoro: a far better voice from a model on disk, about a second a sentence. */
    engine: 'windows' | 'kokoro'
    /** Which Windows voice; empty picks the one that matches where you are. */
    windowsVoice: string
    /** A folder holding a Kokoro install (.venv and models/). Empty looks in the usual places. */
    kokoroPath: string
    /** Which Kokoro voice, e.g. bf_emma. */
    kokoroVoice: string
  }
  /** The face shown during a call. path: a .vrm of your own; empty is the one that comes with Prism. */
  face: { enabled: boolean; path: string }
  /** Claude Code on this computer, used for "Claude Agent" sessions. path null = find it. */
  /** helpers: Claude may start helpers and fleets on Prism's other models (GLM and the rest), through Prism. */
  claude: { enabled: boolean; path: string | null; helpers?: boolean }
  /** Saved teams of helpers, each run by name: by Prism's agent, and by Claude when claude.helpers is on. */
  fleets?: Fleet[]
  /** Pick the model per message for sessions set to "Auto". First matching rule wins; no match uses the lead model. */
  /** byDifficulty: when no rule matches, a quick model judges the request: easy goes to the Fast model, hard to the Strong one. */
  routing: { enabled: boolean; rules: RoutingRule[]; byDifficulty?: boolean }
  mcp: McpServerConfig[]
  /** Shortcut changes made by the user; key '' means "no shortcut". Defaults live in the renderer. */
  keybindings: Array<{ command: string; key: string }>
  recentWorkspaces: string[]
  onboarded: boolean
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K]
}

// ---------------------------------------------------------------- app

export type Platform = 'win32' | 'darwin' | 'linux' | 'freebsd' | 'openbsd' | 'sunos' | 'aix' | 'android' | 'haiku' | 'cygwin' | 'netbsd'

export interface AppInfo {
  version: string
  platform: Platform
  userData: string
  encryptionAvailable: boolean
  homeDir: string
}

// ---------------------------------------------------------------- workspace / fs

export type FsKind = 'file' | 'dir' | 'symlink' | 'other'

export interface FsEntry {
  name: string
  /** Workspace-relative, forward slashes. */
  path: string
  kind: FsKind
  size: number | null
  mtime: number | null
  /** True when a directory is known to have children (for lazy trees). */
  hasChildren?: boolean
}

export interface FileContent {
  path: string
  content: string
  size: number
  truncated: boolean
  binary: boolean
  mtime: number
}

export interface FsChange {
  type: 'create' | 'update' | 'delete'
  path: string
}

export interface SearchOptions {
  query: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  include?: string
  exclude?: string
  maxResults?: number
}

export interface SearchMatch {
  path: string
  line: number
  column: number
  text: string
  matchStart: number
  matchEnd: number
}

export interface SearchResult {
  matches: SearchMatch[]
  files: number
  truncated: boolean
  durationMs: number
}

// ---------------------------------------------------------------- git

export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!'

export interface GitFile {
  path: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
  oldPath?: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  files: GitFile[]
  head: { sha: string; message: string } | null
}

export interface GitLogEntry {
  sha: string
  short: string
  message: string
  author: string
  date: number
}

export interface GitOpResult {
  ok: boolean
  /** What git printed. */
  output: string
}

export interface GitBranch {
  name: string
  remote: boolean
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  sha: string
  date: number
  subject: string
}

export interface GitStash {
  /** e.g. stash@{0} */
  ref: string
  message: string
  date: number
}

export interface GitGraphCommit {
  sha: string
  parents: string[]
  author: string
  date: number
  /** Branch and tag names pointing here, as git prints them ("HEAD -> main", "origin/main", "tag: v1"). */
  refs: string[]
  subject: string
}

export interface GitCommitFile {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
  path: string
  oldPath?: string
}

export interface GitBlameLine {
  line: number
  sha: string
  author: string
  date: number
  summary: string
}

export interface GitConflict {
  path: string
  /** The file in order: text both sides agree on, and the places where they differ. */
  parts: Array<{ kind: 'text'; text: string } | { kind: 'conflict'; ours: string; theirs: string; oursLabel: string; theirsLabel: string }>
}

// ---------------------------------------------------------------- sessions & transcript

export interface Attachment {
  id: string
  name: string
  mime: string
  /** Absolute path on disk (images live in userData/attachments). */
  path: string
  size: number
  /** Filled in by the vision role when the lead model cannot see images. */
  description?: string
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface FileDiff {
  path: string
  before: string | null
  after: string | null
  additions: number
  deletions: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  latencyMs?: number
  cost?: number
}

export interface UserItem {
  kind: 'user'
  id: string
  ts: number
  /** What the user typed (shown in the transcript). */
  text: string
  /** What the model receives when a slash command expanded the text. */
  expanded?: string
  attachments: Attachment[]
}

export interface AssistantItem {
  kind: 'assistant'
  id: string
  ts: number
  text: string
  reasoning: string | null
  /** Provider signature for replaying thinking blocks (Anthropic). */
  reasoningSignature?: string | null
  /** The reply exactly as Anthropic sent it: its thinking goes back unchanged while the turn runs. */
  blocks?: Array<Record<string, unknown>> | null
  toolCalls: ToolCall[]
  model: ModelRef
  usage: Usage | null
  step: number
  /** Set when a sub-agent produced this item. */
  agent?: string
}

export interface ToolItem {
  kind: 'tool'
  id: string
  ts: number
  callId: string
  name: string
  args: Record<string, unknown>
  content: string
  isError: boolean
  durationMs: number
  diff: FileDiff | null
  /** Tool-specific structured payload for rich rendering. */
  meta: Record<string, unknown> | null
  agent?: string
}

export interface SystemItem {
  kind: 'system'
  id: string
  ts: number
  /**
   * 'opinion': another model's review of an answer (meta.model, meta.forItem); never sent to the lead model.
   * 'notice': news from Prism for the agent (a job finished, a timer went off, a helper or another session reported);
   * the model receives it as a message, marked as not coming from the user. meta.source says what sent it.
   */
  subkind: 'compaction' | 'info' | 'error' | 'checkpoint' | 'opinion' | 'visual' | 'notice'
  text: string
  meta: Record<string, unknown> | null
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | SystemItem

export type SessionStatus = 'idle' | 'running' | 'waiting'

export interface Session {
  id: string
  workspace: string
  title: string
  createdAt: number
  updatedAt: number
  model: ModelRef | null
  mode: PermissionMode
  inputTokens: number
  outputTokens: number
  cost: number
  parentId: string | null
  status: SessionStatus
  itemCount: number
}

/** A session's own copy of the project: a git worktree on its own branch. */
export interface SessionWorktree {
  /** Absolute folder of the copy. */
  path: string
  branch: string
  /** The commit the copy started from. */
  base: string
}

/** What the user added to one session's context. */
export interface SessionExtras {
  /** A side chat: the conversation it branched off to answer a passing question. */
  sideOf?: string | null
  /** Set when the session works in its own copy instead of the project folder. */
  worktree?: SessionWorktree | null
  /** Workspace-relative files sent to the model, with their current content, on every turn. */
  pins: string[]
  /** Extra instructions for this session only. */
  instructions: string
  /** Names of the skills this session has loaded; they stay for the rest of it. */
  skills?: string[]
  /** Outside tool sources (MCP servers, gadgets) brought in with load_tools; they stay for the rest of the session. */
  toolSources?: string[]
  /** Set once the session has talked to Claude Code. */
  claude?: ClaudeSessionState | null
  /** How hard Claude is asked to think in this session; null leaves it to Claude. */
  effort?: Effort | null
  /** Timers the agent set to be woken by. */
  wakeups?: Wakeup[]
  /** Helper agents this session started, by name, so they can be messaged or carried on later. */
  helpers?: HelperRecord[]
  /** Most each request may cost (dollars) or take (minutes). */
  budget?: { cost?: number | null; minutes?: number | null } | null
  /**
   * Set while the session is in the middle of something, and left in place when Prism goes down under
   * it, so the session carries on once Prism is back. Cleared when a turn ends normally or is stopped.
   * `turn`: a turn was running. `jobs`: what was running in the background. `resumes`: automatic
   * restarts in a row, so work that itself brings Prism down is not restarted for ever.
   */
  working?: { since: number; turn: boolean; jobs: string[]; resumes: number } | null
  /** Biteback: when the agent last refused to continue, and why (it may only end a conversation after one). */
  refused?: { at: number; reason: string } | null
  /** Biteback: the agent ended this conversation; it takes no more messages. */
  ended?: { at: number; reason: string; handover: string } | null
}

/** One job on the task board. */
export interface BoardTask {
  id: string
  title: string
  prompt: string
  /** Work in its own copy of the project (needs git); bring it in afterwards. */
  ownCopy: boolean
  mode: PermissionMode
  model: ModelRef | null
  status: 'todo' | 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  sessionId: string | null
  /** The agent's last words: its report. */
  summary: string
  /** Whether the checks it promised (done_when) passed. */
  verdict: 'proven' | 'not-proven' | null
  /** How many files it changed. */
  changed: number
  startedAt: number | null
  endedAt: number | null
  error: string | null
}

export interface Wakeup {
  id: string
  /** When it goes off next (ms since 1970). */
  dueAt: number
  /** Repeats: "30m", "2h", "daily at 09:00". */
  every?: string
  /** What the agent wanted to be reminded of. */
  note: string
  createdAt: number
}

export interface HelperRecord {
  name: string
  sessionId: string
  task: string
  model: ModelRef
  readOnly: boolean
  /** Its own copy of the project, when it was started isolated. */
  copy?: { path: string; branch: string; base: string } | null
  startedAt: number
}

/** Everything a session is waiting on in the background, for the header list. */
export interface BackgroundState {
  jobs: Array<{ id: string; command: string; startedAt: number; watching: string[] }>
  timers: Wakeup[]
  helpers: Array<{ name: string; task: string; running: boolean; startedAt: number; isolated: boolean }>
  /** Automatic wake-ups in a row since the user last wrote. */
  wakes: number
  wakeLimit: number
}

/** Where a "Claude Agent" session's conversation lives inside Claude Code. */
/** A conversation Claude Code had outside Prism (terminal, VS Code). */
export interface ClaudeConversation {
  id: string
  file: string
  title: string
  /** The folder it was started in. */
  cwd: string
  updatedAt: number
  bytes: number
}

export interface ClaudeSessionState {
  /** Claude Code's own id for the conversation; resumed on every turn. */
  sessionId: string
  /** The last answer Claude Code recorded. */
  lastUuid: string | null
  /** After a rewind: resume only up to this answer on the next turn. */
  resumeAt: string | null
  /** One entry per turn sent to Claude: the user item, and the last answer before it. */
  turns: Array<{ item: string; before: string | null }>
  /** Last transcript item Claude has seen; later items from other models are summarised for it. */
  synced: string | null
  /** Fingerprint of the session context (skills, rules, instructions, pinned files) Claude last received; null after it summarised the conversation. */
  given?: string | null
}

/** What Prism knows about the Claude Code installed on this computer. */
/** How hard Claude is asked to think about a turn. Only some models take it. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ClaudeStatus {
  enabled: boolean
  /** The program Prism would run; null when it is not installed. */
  path: string | null
  version: string | null
  /** Plan name ("Claude Max"), or "API key". */
  plan: string | null
  signedIn: boolean
  models: Array<{ value: string; name: string; description: string; efforts?: Effort[] }>
  commands: Array<{ name: string; description: string }>
  error: string | null
  checkedAt: number
}

/** What the model would be sent for a session right now, measured part by part (estimates). */
export interface ContextReport {
  window: number | null
  total: number
  parts: Array<{ id: string; label: string; tokens: number }>
  /** Biggest transcript items first. */
  items: Array<{ id: string; kind: TranscriptItem['kind']; label: string; tokens: number; removable: boolean }>
  notes: Array<{ path: string; tokens: number }>
  pins: Array<{ path: string; tokens: number; truncated: boolean }>
  /** Every skill the session could use; `loaded` ones are sent in full on every turn. */
  skills: Array<{ name: string; description: string; tokens: number; loaded: boolean; always: boolean }>
}

export interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'active' | 'done'
}

export type ApprovalDecision = 'once' | 'always' | 'deny'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface ApprovalRequest {
  approvalId: string
  call: ToolCall
  risk: RiskLevel
  /** One line the user reads to decide. */
  summary: string
  /** Rule that "always allow" would add. */
  rule: PermissionRule
  agent?: string
  /** Why the quick checker would not let it through by itself. */
  concern?: string
}

export interface QuestionRequest {
  questionId: string
  question: string
  options: Array<{ label: string; description: string }>
  multi: boolean
}

export interface PlanRequest {
  planId: string
  title: string
  /** Markdown. */
  plan: string
}

export interface PlanDecision {
  action: 'approve' | 'revise' | 'discard'
  /** The plan as the user left it (they may have edited it). */
  plan: string
  /** Mode to carry the plan out in, when approved. */
  mode?: PermissionMode
  feedback?: string
}

/** One file of a change set the user reviews before it is written. null = the file does not exist on that side. */
/** The phone app's side of this Prism (main/remote.ts). */
export interface RemoteDevice {
  pub: string
  name: string
  pairedAt: number
  lastSeen: number
}

/** The router opening for the phone app (main/portmap.ts). */
export interface RemoteOutside {
  state: 'off' | 'trying' | 'open' | 'failed'
  how: 'UPnP' | 'NAT-PMP' | null
  /** The address phones use from outside, e.g. ws://81.2.3.4:8793. */
  external: string | null
  error: string | null
}

export interface RemoteInfo {
  on: boolean
  hostId: string
  fingerprint: string
  name: string
  direct: string[]
  relay: { url: string; connected: boolean; error: string | null } | null
  devices: RemoteDevice[]
  connected: number
  pairing: { code: string; until: number; qr: string } | null
  outside: RemoteOutside
  error: string | null
}

/** Something a review found in a change. */
export interface ReviewFinding {
  severity: 'problem' | 'risk' | 'minor'
  file: string
  line: number | null
  title: string
  detail: string
  fix: string
}

export interface PullRequestInfo {
  number: number
  title: string
  author: string
  branch: string
  base: string
  url: string
  updatedAt: number
  draft: boolean
  headSha: string
}

/** One piece of uncommitted work, for splitting it into commits (core/git/split.ts). */
export interface SplitPiece {
  id: string
  path: string
  /** hunk: part of a changed file; file: the whole file (new, deleted, renamed, binary, or not yet tracked). */
  kind: 'hunk' | 'file'
  /** What the piece is, in a few words (the hunk's @@ line, or "new file"). */
  title: string
  added: number
  removed: number
  /** The piece's diff text. */
  text: string
}

export interface SplitCommit {
  message: string
  why: string
  pieces: string[]
}

export interface ReviewFile {
  path: string
  before: string | null
  after: string | null
}

export type ScratchLang = 'js' | 'ts' | 'python'

/** One piece of what a scratchpad cell produced. */
export type ScratchOutput =
  | { kind: 'text' | 'stderr' | 'error' | 'json'; text: string }
  | { kind: 'table'; columns: string[]; rows: Array<Array<string | number | boolean | null>>; total: number }
  | { kind: 'html'; html: string }
  | { kind: 'image'; src: string }

export type ScratchEvent = { cell: string; type: 'output'; output: ScratchOutput } | { cell: string; type: 'done'; ok: boolean; ms: number }

export interface ScratchStatus {
  /** The Node version JavaScript cells run on. */
  node: string
  /** The Python that Python cells would use; null when none was found. version is known once a cell has run. */
  python: { path: string; version: string | null } | null
}

/** One line the page in the Browser panel printed. */
export interface BrowserConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error'
  text: string
  /** The script it came from, and the line there. */
  source: string
  line: number
  ts: number
}

/** A package.json script that usually starts a dev server. */
export interface DevScript {
  name: string
  /** What the script runs. */
  script: string
  /** What to type to run it here (npm run dev, pnpm run dev…). */
  command: string
}

/** One place a name is used. */
export interface RefHit {
  path: string
  line: number
  column: number
  /** The line it is on. */
  text: string
  kind: 'definition' | 'write' | 'read'
}

/** A refactor worked out but not written: the change set to preview, and what to do after it. */
export interface RefactorPlan {
  title: string
  files: ReviewFile[]
  /** False when it was matched as text because the language is not understood by meaning. */
  byMeaning: boolean
  note: string | null
  /** A move to carry out once the accepted changes are written. */
  then?: { from: string; to: string }
}

export interface ReviewRequest {
  reviewId: string
  title: string
  files: ReviewFile[]
  agent?: string
}

export interface ReviewDecision {
  /** What to write: the final content per accepted file (null deletes it). Files left out are rejected. */
  files: Array<{ path: string; content: string | null; partial: boolean }>
  comment?: string
}

export type RunEndReason = 'completed' | 'max-steps' | 'aborted' | 'error' | 'budget' | 'stuck'

export type AgentEvent =
  | { type: 'run-start'; runId: string; model: ModelRef }
  | { type: 'step-start'; step: number; model: ModelRef; agent?: string }
  | { type: 'text-delta'; text: string; agent?: string }
  | { type: 'reasoning-delta'; text: string; agent?: string }
  | { type: 'tool-start'; call: ToolCall; agent?: string }
  | { type: 'tool-output'; callId: string; chunk: string; agent?: string }
  | { type: 'item'; item: TranscriptItem }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; approvalId: string; decision: ApprovalDecision }
  | { type: 'question'; request: QuestionRequest }
  | { type: 'question-resolved'; questionId: string }
  | { type: 'review'; request: ReviewRequest }
  | { type: 'review-resolved'; reviewId: string }
  | { type: 'plan'; request: PlanRequest }
  | { type: 'plan-resolved'; planId: string }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'status'; text: string | null; agent?: string }
  | { type: 'usage'; step: number; usage: Usage; contextTokens: number; contextWindow: number | null }
  | { type: 'subagent-start'; agent: string; task: string; model: ModelRef }
  | { type: 'subagent-end'; agent: string; ok: boolean; summary: string; durationMs: number }
  /** What the session waits on in the background changed. */
  | { type: 'background'; state: BackgroundState }
  | { type: 'compaction'; beforeTokens: number; afterTokens: number }
  /** The agent was going round in circles; what Prism did about it. */
  | { type: 'stuck'; reason: string; action: 'nudged' | 'escalated' | 'stopped'; model?: string }
  | { type: 'checkpoint'; id: string; files: string[] }
  | { type: 'file-touched'; path: string; op: 'read' | 'write' | 'edit' | 'delete'; callId?: string }
  | { type: 'run-end'; reason: RunEndReason; error?: string; durationMs: number }

export interface SendOptions {
  /** The session is on "Auto": no fixed model; routing rules choose per message. */
  auto?: boolean
  model?: ModelRef
  mode?: PermissionMode
  attachments?: Attachment[]
}

export interface Checkpoint {
  id: string
  sessionId: string
  ts: number
  label: string
  files: string[]
  /** The user item whose turn produced this checkpoint. */
  turnItemId: string | null
}

// ---------------------------------------------------------------- file history

/** One change the agent made to one file, with what it was before and after (core/history). */
export interface FileVersion {
  id: number
  sessionId: string
  /** The user message whose turn made the change. */
  turnItemId: string | null
  /** The tool call that made it. */
  callId: string | null
  path: string
  ts: number
  /** Null: the file did not exist. */
  before: string | null
  after: string | null
}

/** One tool call in a session's history, with the files it changed. */
export interface HistoryStep {
  index: number
  callId: string | null
  tool: string
  summary: string
  ts: number
  turnItemId: string | null
  /** A command's output, shortened. */
  output: string | null
  isError: boolean
  changes: Array<{ versionId: number; path: string; op: 'created' | 'changed' | 'deleted'; added: number; removed: number }>
}

export interface HistoryTimeline {
  steps: HistoryStep[]
  /** The user's requests, in order; `changed` when the request changed files. */
  turns: Array<{ id: string; text: string; ts: number; changed: boolean }>
}

/** What happened while the user was away. */
export interface CatchUp {
  since: number
  sessions: Array<{ id: string; title: string; status: Session['status']; updatedAt: number; lastText: string | null; error: string | null; steps: number }>
  runs: AutomationRun[]
  /** Every file changed since, first change first, with how it was when the user left. */
  files: Array<{ path: string; before: string | null; ts: number; sessionId: string; sessions: string[]; request: string | null }>
}

/** A guided walk through the code (.prism/tours/*.json). */
export interface CodeTour {
  title: string
  steps: Array<{
    file: string
    /** The text of the line to land on; found again by its text after the code moves. */
    anchor: string
    /** Markdown. */
    note: string
    /** Where the line was when the tour was made. */
    line: number
  }>
}

/** Something the agent must never do; checked before every tool call. */
export interface UserRule {
  id: string
  /** The rule as the user reads it. */
  text: string
  /** What it stops: writing those files, shell commands, or both. */
  block: 'files' | 'commands' | 'both'
  /** Globs relative to the project folder. */
  paths: string[]
  /** A pattern matched against shell commands. */
  command: string | null
  enabled: boolean
  scope?: 'project' | 'personal'
}

/** Something Prism noticed in the user's corrections and offers to keep. */
export type LearnOffer =
  | { kind: 'skill'; id: string; title: string; instruction: string; when: string[]; examples: string[] }
  | { kind: 'rule'; id: string; sentence: string }

/** A gadget Prism thinks is worth building, offered after a turn (core/gadgets/scout.ts). */
export interface GadgetIdea {
  id: string
  /** The sort of gadget, not this one: refusing silences the sort. */
  kind: string
  title: string
  /** What it would show and do. */
  what: string
  /** Why it earns its place. */
  why: string
}

/** One heading of the project's spec, with what Prism knows about it. */
export interface SpecSection {
  title: string
  body: string
  /** The user changed it since the code last matched the spec. */
  edited: 'added' | 'changed' | null
  /** The last check of the agent's changes against it. */
  status: 'ok' | 'drift' | null
  note: string | null
  checkedAt: number | null
}

export interface SpecState {
  path: string
  sections: SpecSection[]
  /** Sections the user removed since the code last matched. */
  removed: string[]
  /** The spec has edits the code does not follow yet. */
  pendingEdits: boolean
}

/** What a set of changes could break (core/impact). */
export interface ImpactReport {
  files: string[]
  symbols: Array<{ path: string; name: string; kind: 'function' | 'class' | 'method' | 'variable' | 'type'; change: 'added' | 'changed' | 'removed'; line: number; column: number }>
  /** Places that use something that changed or went away. */
  callers: Array<{ symbol: string; path: string; line: number; text: string; inTest: boolean }>
  /** Files that import the changed ones, directly or through others. */
  importedBy: string[]
  /** Test files that reach the changed code. */
  tests: string[]
  /** How to run only those tests, when the project's test runner is known. */
  testCommand: string | null
  /** False when uses were found by name rather than by meaning. */
  byMeaning: boolean
}

/** Where a line the agent wrote came from. */
/** Lines of a file (1-based, inclusive) that one of the agent's changes wrote. */
export interface AgentLineRun {
  from: number
  to: number
  versionId: number
  sessionId: string
  sessionTitle: string
  turnItemId: string | null
  ts: number
}

export interface LineOrigin {
  sessionId: string
  sessionTitle: string
  turnItemId: string | null
  /** What the user asked for. */
  request: string | null
  /** What the agent said just before writing it. */
  reason: string | null
  model: string | null
  ts: number
  versionId: number
}

// ---------------------------------------------------------------- terminals

export type TerminalKind = 'user' | 'agent'

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  pid: number
  kind: TerminalKind
  shell: string
}

// ---------------------------------------------------------------- completions / inline edit

export interface InlineCompletionRequest {
  path: string
  language: string
  prefix: string
  suffix: string
}

export interface InlineEditRequest {
  path: string
  language: string
  selection: string
  before: string
  after: string
  instruction: string
  /** Earlier rounds of the same inline chat, oldest first: the new instruction refines the last result. */
  history?: Array<{ instruction: string; result: string }>
}

// ---------------------------------------------------------------- mcp

export type McpState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface McpStatus extends McpServerConfig {
  state: McpState
  toolCount: number
  error: string | null
  tools: Array<{ name: string; description: string }>
}

// ---------------------------------------------------------------- skills and the user's own tools

/** A file of instructions that joins a conversation when it is relevant (.prism/skills/*.md). */
export interface SkillInfo {
  name: string
  description: string
  /** Words or phrases; a message containing one loads the skill. */
  when: string[]
  always: boolean
  /** 'builtin' skills come with Prism and cannot be edited. */
  scope: 'project' | 'personal' | 'builtin'
  /** Workspace-relative for a project skill, absolute for a personal one. */
  path: string
}

/** A tool the user wrote for the agent (.prism/tools/*.ts). */
export interface CustomToolInfo {
  /** Empty when the file could not be loaded. */
  name: string
  description: string
  file: string
  scope: 'project' | 'personal'
  uses: Array<'shell' | 'network'>
  risk: 'none' | 'low' | 'medium' | 'high'
  /** Why the file is not offered to the agent, when it is not. */
  error: string | null
  /** Set while the file waits for the user's OK: it is new, or it changed since it was allowed. */
  waiting?: 'new' | 'changed'
}

export interface ExtendState {
  skills: SkillInfo[]
  tools: CustomToolInfo[]
}

/** Which of the programs that MCP servers are started with exist on this computer. */
export interface Toolchain {
  npx: boolean
  uvx: boolean
  docker: boolean
}

// ---------------------------------------------------------------- slash commands

export interface SlashCommand {
  name: string
  description: string
  /** 'builtin' commands are handled by the app; 'custom' expand to a prompt; 'claude' belong to Claude Code and only work in Claude Agent sessions. */
  source: 'builtin' | 'custom' | 'claude'
  prompt?: string
}

// ---------------------------------------------------------------- automations

/** A command run around the agent's work. */
export interface AutomationHook {
  id: string
  name: string
  /** before-tool can stop the tool (non-zero exit). after-edit runs for a file the agent wrote. turn-end runs when a turn finishes. */
  event: 'before-tool' | 'after-tool' | 'after-edit' | 'turn-end'
  /** Tool names for the tool events, file patterns for after-edit and turn-end (comma separated, * wildcards). Empty = everything. */
  match: string
  command: string
  /** Tell the agent what the command printed (and, for turn-end, send it back to fix a failure). */
  feedback: boolean
  enabled: boolean
}

/** A prompt sent to the agent when matching files change (not for the agent's own edits). */
export interface AutomationWatcher {
  id: string
  name: string
  glob: string
  prompt: string
  mode: PermissionMode
  debounceMs: number
  enabled: boolean
}

/** A prompt sent on a timer while Prism is open: "30m", "2h" or "daily 09:00". */
export interface AutomationSchedule {
  id: string
  name: string
  every: string
  prompt: string
  mode: PermissionMode
  enabled: boolean
}

/** A prompt sent when something happens outside Prism: a call to its web address, or an event on GitHub. */
export interface AutomationTrigger {
  id: string
  name: string
  /** webhook: a call to its address on this computer; the github ones are checked every few minutes with the user's token. */
  on: 'webhook' | 'github-pr-opened' | 'github-mention' | 'github-ci-failed'
  prompt: string
  mode: PermissionMode
  enabled: boolean
}

export interface AutomationsConfig {
  hooks: AutomationHook[]
  watchers: AutomationWatcher[]
  schedules: AutomationSchedule[]
  triggers: AutomationTrigger[]
}

export interface AutomationRun {
  id: string
  kind: 'hook' | 'watcher' | 'schedule' | 'trigger'
  automationId: string
  name: string
  startedAt: number
  endedAt: number
  ok: boolean
  output: string
  detail?: string
  sessionId?: string
}

export interface AutomationsState {
  config: AutomationsConfig
  /** Newest first. */
  runs: AutomationRun[]
  error: string | null
  /** Where the config lives, relative to the project. */
  file: string
  /** Each web-address trigger's full address. */
  webhooks?: Record<string, string>
  /** Why the GitHub triggers could not look, if they could not. */
  githubError?: string | null
}

/** A command the agent left running in the background. */
export interface JobInfo {
  id: string
  command: string
  running: boolean
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  tail: string
}

// ---------------------------------------------------------------- problems

export interface Problem {
  /** Workspace-relative path with forward slashes. */
  file: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info'
  message: string
  /** Who reported it: "TypeScript", "ESLint", "Editor"… */
  source: string
  code?: string
}

export interface CheckerInfo {
  id: string
  label: string
  kind: 'types' | 'lint' | 'test' | 'custom'
  command: string
}

export interface CheckResult {
  checker: CheckerInfo
  problems: Problem[]
  output: string
  code: number
  durationMs: number
  /** Set when the checker itself could not run. */
  note?: string
}

// ---------------------------------------------------------------- project dashboard

/** What the dashboard shows about the open project. */
export interface ProjectOverview {
  name: string
  root: string
  package: { name: string | null; version: string | null; description: string | null; deps: number; devDeps: number; manager: string | null } | null
  /** Null when the folder is not a git repository. */
  git: {
    branch: string | null
    ahead: number
    behind: number
    commits: number
    contributors: number
    /** When the first commit was made, in milliseconds. */
    firstCommit: number | null
    recent: Array<{ hash: string; subject: string; author: string; date: number }>
    changed: Array<{ path: string; status: GitFileStatus }>
  } | null
  files: {
    tracked: number
    /** Lines of code: data and prose files are counted in `languages` but not here. */
    lines: number
    languages: Array<{ name: string; lines: number; files: number; data: boolean }>
  }
  todos: Array<{ tag: 'TODO' | 'FIXME' | 'HACK' | 'XXX'; path: string; line: number; text: string }>
}

export interface OutdatedReport {
  manager: string | null
  packages: Array<{ name: string; current: string; wanted: string; latest: string; dev: boolean }>
  /** Set when the list could not be made, in words for the user. */
  note: string | null
}

/** What one day of this project's sessions used. day = days since 1970 (UTC). */
export interface SpendDay {
  day: number
  inputTokens: number
  outputTokens: number
  cost: number
  requests: number
}

// ---------------------------------------------------------------- telemetry

export interface UsageSummary {
  totals: { requests: number; inputTokens: number; outputTokens: number; cost: number }
  byModel: Array<{ label: string; requests: number; inputTokens: number; outputTokens: number; cost: number }>
  last24h: { requests: number; inputTokens: number; outputTokens: number; cost: number }
}

/** One slice of where Claude usage went (Claude Code's own /usage data). */
export interface ClaudeUsageSpan {
  requests: number
  sessions: number
  /** Overlapping characteristics, so they do not add up to 100. */
  behaviors: Array<{ key: string; pct: number; count: number }>
  skills: Array<{ name: string; pct: number }>
  agents: Array<{ name: string; pct: number }>
  plugins: Array<{ name: string; pct: number }>
  mcpServers: Array<{ name: string; pct: number }>
}

/** How much of the Claude plan's limits is used, and by what. */
export interface ClaudePlanUsage {
  at: number
  /** False for an API key, or when Claude Code could not say. */
  available: boolean
  plan: string | null
  email: string | null
  organization: string | null
  windows: Array<{ key: string; label: string; used: number; resetsAt: number | null }>
  extra: { limit: number | null; used: number | null; percent: number | null; currency: string | null } | null
  behaviors: { day: ClaudeUsageSpan | null; week: ClaudeUsageSpan | null } | null
  error: string | null
}
