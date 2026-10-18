import type { A11yReport } from './a11y'
import type { ConvHit, ConvQuery } from './convSearch'
import type { Theme } from './theme'
import type {
  ClaudePlanUsage,
  AgentEvent,
  ClaudeConversation,
  AppInfo,
  ApprovalDecision,
  ApprovalRequest,
  QuestionRequest,
  ReviewRequest,
  PlanRequest,
  Attachment,
  AutomationsConfig,
  AutomationsState,
  CheckResult,
  CompareEvent,
  ContextReport,
  CheckerInfo,
  Checkpoint,
  DevScript,
  ClaudeStatus,
  Endpoint,
  EndpointInput,
  FileContent,
  FsChange,
  FsEntry,
  GitBlameLine,
  GitBranch,
  GitCommitFile,
  GitConflict,
  GitGraphCommit,
  GitOpResult,
  GitStash,
  GitLogEntry,
  GitStatus,
  InlineCompletionRequest,
  InlineEditRequest,
  JobInfo,
  McpStatus,
  ExtendState,
  FileVersion,
  ImpactReport,
  CatchUp,
  SpecState,
  UserRule,
  LearnOffer,
  HistoryTimeline,
  LineOrigin,
  SplitCommit,
  RemoteInfo,
  SplitPiece,
  ReviewFinding,
  PullRequestInfo,
  AgentLineRun,
  Toolchain,
  ModelInfo,
  ModelMeta,
  ModelRef,
  PermissionMode,
  Platform,
  PlanDecision,
  OutdatedReport,
  ProbeResult,
  ProjectOverview,
  SpendDay,
  RefHit,
  RefactorPlan,
  ScratchEvent,
  ScratchLang,
  ScratchStatus,
  ReviewDecision,
  ReviewFile,
  SearchOptions,
  SearchResult,
  SendOptions,
  SessionExtras,
  Session,
  Settings,
  SettingsPatch,
  SlashCommand,
  SystemItem,
  TerminalInfo,
  TerminalKind,
  TranscriptItem,
  UsageSummary, BackgroundState, BoardTask, ToolCall, GadgetIdea } from './types'
import type { GadgetInfo } from './gadgets'

export type GadgetUiMessage =
  | { kind: 'toast'; title: string; detail?: string }
  | { kind: 'openFile'; path: string }
  | { kind: 'openPreview'; path: string }
  | { kind: 'focusSession'; id: string }
  | { kind: 'openGadget'; id: string; title?: string }
  | { kind: 'openPanel'; panel: string; section?: string }

export type { GadgetInfo }

/** Every IPC channel in one place. Push channels carry a suffix id. */
export const CH = {
  AppInfo: 'app:info',
  AppOpenExternal: 'app:open-external',
  AppReveal: 'app:reveal',
  FileOpen: 'file:open',
  FileReveal: 'file:reveal',
  FilePart: 'file:part',
  FaceInfo: 'face:info',
  FacePart: 'face:part',
  FacePick: 'face:pick',
  WinMinimize: 'win:minimize',
  WinMaximize: 'win:maximize',
  WinClose: 'win:close',
  WinIsMaximized: 'win:is-maximized',
  WinMaximizedChanged: 'win:maximized-changed',
  WinZoom: 'win:zoom',

  SettingsGet: 'settings:get',
  SettingsUpdate: 'settings:update',
  SettingsDefaults: 'settings:defaults',
  SettingsChanged: 'settings:changed',

  EndpointList: 'endpoint:list',
  EndpointSave: 'endpoint:save',
  EndpointDelete: 'endpoint:delete',
  EndpointProbe: 'endpoint:probe',
  ModelList: 'model:list',
  ClaudeStatus: 'claude:status',
  ClaudeRefresh: 'claude:refresh',
  ClaudeChanged: 'claude:changed',
  ClaudeConversations: 'claude:conversations',
  ClaudeBringIn: 'claude:bring-in',
  ModelFavorite: 'model:favorite',
  ModelSetMeta: 'model:set-meta',

  WorkspaceOpen: 'workspace:open',
  WorkspaceSet: 'workspace:set',
  WorkspaceCurrent: 'workspace:current',
  WorkspaceWsl: 'workspace:wsl',
  WorkspaceSshHosts: 'workspace:ssh-hosts',
  WorkspaceChanged: 'workspace:changed',
  FsList: 'fs:list',
  FsRead: 'fs:read',
  FsWrite: 'fs:write',
  FsWriteBinary: 'fs:write-binary',
  FsCreate: 'fs:create',
  FsRename: 'fs:rename',
  FsDelete: 'fs:delete',
  FsChanged: 'fs:changed',
  FsAssetUrl: 'fs:asset-url',
  FsSearch: 'fs:search',
  FsQuickOpen: 'fs:quick-open',

  GitStatus: 'git:status',
  GitDiff: 'git:diff',
  GitBlob: 'git:blob',
  GitStage: 'git:stage',
  GitUnstage: 'git:unstage',
  GitCommit: 'git:commit',
  GitLog: 'git:log',
  GitDiscard: 'git:discard',
  GitOp: 'git:op',

  SessionList: 'session:list',
  SessionCreate: 'session:create',
  SessionDelete: 'session:delete',
  SessionRename: 'session:rename',
  SessionDuplicate: 'session:duplicate',
  SessionItems: 'session:items',
  SessionExtras: 'session:extras',
  SessionCreateCopy: 'session:create-copy',
  SessionCopyChanges: 'session:copy-changes',
  SessionCopyIntegrate: 'session:copy-integrate',
  SessionCopyDiscard: 'session:copy-discard',
  SessionSetExtras: 'session:set-extras',
  SessionPrune: 'session:prune',
  AgentContext: 'agent:context',
  AgentOpinion: 'agent:opinion',
  AgentCompare: 'agent:compare',
  AgentCompareStop: 'agent:compare-stop',
  AgentAdopt: 'agent:adopt',
  CompareEventPrefix: 'compare:event:',
  NotesRemember: 'notes:remember',
  SessionChanged: 'session:changed',

  AgentSend: 'agent:send',
  AgentAbort: 'agent:abort',
  AgentApprove: 'agent:approve',
  AgentAnswer: 'agent:answer',
  Biteback: 'agent:biteback',
  LessonList: 'lesson:list',
  LessonRead: 'lesson:read',
  LessonWrite: 'lesson:write',
  LessonRemove: 'lesson:remove',
  AgentReview: 'agent:review',
  AgentPlan: 'agent:plan',
  AgentSetMode: 'agent:set-mode',
  AgentSetModel: 'agent:set-model',
  /** What a session waits on in the background (jobs, timers, helpers). */
  AgentBackground: 'agent:background',
  AgentSteer: 'agent:steer',
  /** What a session is in the middle of, for a client that has just connected. */
  AgentPending: 'agent:pending',
  AgentQuickAsk: 'agent:quick-ask',
  AgentQuickStop: 'agent:quick-stop',
  AgentWhy: 'agent:why',
  AgentSharpen: 'agent:sharpen',
  AgentExplainCall: 'agent:explain-call',
  PairGlance: 'pair:glance',
  AgentBackgroundCancel: 'agent:background-cancel',
  /** main → renderer: news for a session, for a desktop notification. */
  Notice: 'agent:notice',
  MemoryList: 'memory:list',
  MemoryRemove: 'memory:remove',
  AgentCompact: 'agent:compact',
  AgentEventPrefix: 'agent:event:',
  CheckpointList: 'checkpoint:list',
  CheckpointRestore: 'checkpoint:restore',
  CheckpointRestoreFile: 'checkpoint:restore-file',
  CheckpointFile: 'checkpoint:file',
  SessionRewind: 'session:rewind',
  SlashList: 'slash:list',

  TermCreate: 'term:create',
  TermWrite: 'term:write',
  TermResize: 'term:resize',
  TermKill: 'term:kill',
  TermList: 'term:list',
  TermDataPrefix: 'term:data:',
  TermExitPrefix: 'term:exit:',
  TermCreated: 'term:created',
  /** main → renderer: terminals were closed or renamed because the project changed. */
  TermChanged: 'term:changed',
  TasksList: 'tasks:list',
  TasksSave: 'tasks:save',
  TasksRun: 'tasks:run',
  TasksStop: 'tasks:stop',
  /** main → renderer: the task board changed. */
  TasksChanged: 'tasks:changed',

  CompletionInline: 'completion:inline',
  CompletionEdit: 'completion:edit',

  McpList: 'mcp:list',
  McpConnect: 'mcp:connect',
  McpDisconnect: 'mcp:disconnect',
  McpSetSecret: 'mcp:set-secret',

  RulesList: 'rules:list',
  RulesPreview: 'rules:preview',
  RulesSave: 'rules:save',
  RulesRemove: 'rules:remove',
  LearnAccept: 'learn:accept',
  LearnDismiss: 'learn:dismiss',
  SpecState: 'spec:state',
  SpecCreate: 'spec:create',
  SpecMakeCodeMatch: 'spec:make-code-match',
  SpecResolve: 'spec:resolve',
  /** main → renderer: the spec file or what is known about it changed. */
  SpecChanged: 'spec:changed',
  NextEditSuggest: 'next-edit:suggest',
  CatchUpSince: 'catchup:since',
  SessionExport: 'session:export',
  SessionImport: 'session:import',
  SessionSharePage: 'session:share-page',
  ClaudePlanUsage: 'claude:plan-usage',
  ImpactFiles: 'impact:files',
  ImpactSession: 'impact:session',
  HistoryTimeline: 'history:timeline',
  HistoryVersion: 'history:version',
  HistoryState: 'history:state',
  HistoryWhy: 'history:why',
  WinNew: 'win:new',

  FloatOpen: 'float:open',
  FloatPin: 'float:pin',
  FloatOpacity: 'float:opacity',
  FloatClose: 'float:close',
  FloatDrag: 'float:drag',
  FloatBar: 'float:bar',
  FloatList: 'float:list',
  RemoteInfo: 'remote:info',
  RemotePair: 'remote:pair',
  RemoteForget: 'remote:forget',
  HostProjects: 'host:projects',
  AssetGet: 'asset:get',
  HistoryLines: 'history:lines',
  ConversationsSearch: 'conversations:search',
  AgentJudgeWays: 'agent:judge-ways',
  GitSplitPlan: 'git:split-plan',
  PrsList: 'prs:list',
  PhoneInfo: 'phone:info',
  PhoneForget: 'phone:forget',
  PrsReview: 'prs:review',
  PrsPost: 'prs:post',
  PrsDismiss: 'prs:dismiss',
  PrsToken: 'prs:token',
  GitSplitApply: 'git:split-apply',
  VoiceTranscribe: 'voice:transcribe',
  VoiceDictate: 'voice:dictate',
  /** Windows speaks a line and hands back the recording; the window plays it. */
  VoiceSpeak: 'voice:speak',
  /** The voices this computer has installed. */
  VoiceVoices: 'voice:voices',
  /** Is there a working better-voice install, and what does it offer? */
  VoiceKokoro: 'voice:kokoro',
  VoiceInCall: 'voice:in-call',
  VoiceKept: 'voice:kept',
  VoiceForget: 'voice:forget',
  /** The phone asks the computer to turn a recording into words. */
  VoiceOnComputer: 'voice:on-computer',
  /** The computer's own window is asked to do it (it holds the speech model). */
  VoiceDoLocal: 'voice:do-local',
  /** That window's answer. */
  VoiceLocalDone: 'voice:local-done',
  HistoryUndoRequest: 'history:undo-request',
  HistoryRestore: 'history:restore',

  ExtendList: 'extend:list',
  ExtendCreate: 'extend:create',
  ExtendRead: 'extend:read',
  ExtendWrite: 'extend:write',
  ExtendRemove: 'extend:remove',
  ExtendAllow: 'extend:allow',
  ExtendRepair: 'extend:repair',
  ExtendOpenFolder: 'extend:open-folder',
  ExtendToolchain: 'extend:toolchain',
  /** main → renderer: a skill or tool file in the project changed. */
  ExtendChanged: 'extend:changed',

  DashboardOverview: 'dashboard:overview',
  DashboardOutdated: 'dashboard:outdated',
  DashboardSpend: 'dashboard:spend',
  DashboardNotes: 'dashboard:notes',

  ScratchRun: 'scratch:run',
  ScratchStop: 'scratch:stop',
  ScratchStatus: 'scratch:status',
  /** main → renderer: output of the notebook's cells as it happens. */
  ScratchEvent: 'scratch:event',

  PreviewAttach: 'preview:attach',
  PreviewDetach: 'preview:detach',
  PreviewServe: 'preview:serve',
  PreviewBase: 'preview:base',
  PreviewResolve: 'preview:resolve',
  PreviewScripts: 'preview:scripts',
  PreviewAudit: 'preview:audit',
  PreviewHighlight: 'preview:highlight',
  PreviewFollow: 'preview:follow',
  /** main → renderer: the agent needs the Browser panel to exist / to be in front. */
  PreviewOpen: 'preview:open',
  PreviewFocus: 'preview:focus',

  RefactorRename: 'refactor:rename',
  RefactorReferences: 'refactor:references',
  RefactorMove: 'refactor:move',
  RefactorApply: 'refactor:apply',
  RefactorUndo: 'refactor:undo',

  ThemeExport: 'theme:export',
  ThemeExportAll: 'theme:export-all',
  ThemeImport: 'theme:import',
  ThemePicture: 'theme:picture',
  ThemeFonts: 'theme:fonts',

  AttachPick: 'attach:pick',
  AttachFromData: 'attach:from-data',

  ChecksList: 'checks:list',
  ChecksRun: 'checks:run',

  AutomationsGet: 'automations:get',
  AutomationsSave: 'automations:save',
  AutomationsRun: 'automations:run',
  AutomationsChanged: 'automations:changed',
  JobsList: 'jobs:list',
  JobsKill: 'jobs:kill',

  GadgetList: 'gadget:list',
  GadgetStart: 'gadget:start',
  GadgetStop: 'gadget:stop',
  GadgetReload: 'gadget:reload',
  GadgetRemove: 'gadget:remove',
  GadgetTurnOn: 'gadget:turn-on',
  GadgetCall: 'gadget:call',
  GadgetWrite: 'gadget:write',
  GadgetRead: 'gadget:read',
  GadgetPage: 'gadget:page',
  GadgetIdeaDecide: 'gadget:idea-decide',
  GadgetIdeaRefused: 'gadget:idea-refused',
  GadgetIdeaAllow: 'gadget:idea-allow',
  GadgetLog: 'gadget:log',
  GadgetOpenDir: 'gadget:open-dir',
  GadgetChanged: 'gadget:changed',
  GadgetEventPrefix: 'gadget:event:',
  GadgetLogPrefix: 'gadget:log:',
  GadgetUi: 'gadget:ui',

  UsageSummary: 'usage:summary'
} as const

export type Unsubscribe = () => void

/** The face shown in calls. own: chosen in Settings, rather than the one that comes with Prism. */
export interface FaceInfo {
  id: string
  name: string
  size: number
  own: boolean
}

/** The typed surface exposed on window.prism by the preload bridge. */
export interface PrismApi {
  platform: Platform
  /** Started with a debugging port: the stores are exposed on window for automated checks. */
  debug: boolean
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    reveal(path: string): Promise<void>
  }
  /** The face shown in calls: a VRM avatar, read a piece at a time so the phone can fetch it too. */
  face: {
    /** Which face, or null when there is none to show. id changes whenever the face does. */
    info(): Promise<FaceInfo | null>
    part(offset: number): Promise<{ data: string; size: number; next: number }>
    /** Choose a .vrm of your own (a window on the computer only). */
    pick(): Promise<FaceInfo | null>
  }
  /** Files the agent handed over with attach_file, found by the transcript item that attached them. */
  files: {
    /** Opens it with whatever the computer opens that kind of file with. */
    open(sessionId: string, itemId: string): Promise<void>
    reveal(sessionId: string, itemId: string): Promise<void>
    /** A piece of it, for the phone, which fetches it a piece at a time. */
    part(sessionId: string, itemId: string, offset: number): Promise<{ data: string; size: number; next: number }>
  }
  win: {
    minimize(): void
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizedChanged(cb: (max: boolean) => void): Unsubscribe
    /** Zoom the whole UI: +1 / -1 steps, or 0 to reset. Returns the new level. NaN only reads the current level. */
    zoom(step: number): Promise<number>
    /** Another Prism window, empty (pick a project in it), or on a project. */
    open(root?: string | null): Promise<void>
  }
  /** Tabs taken out of Prism and put on the desktop. */
  float: {
    /** Pops a tab out. Already out: the one on the desktop comes to the front. */
    open(spec: { kind: string; key: string; title: string; params: Record<string, unknown> }): Promise<void>
    /** Which tabs are out, by key. */
    list(): Promise<string[]>
    /** Only inside a floating window: keep it above other windows, or let it go behind. */
    pin(on: boolean): Promise<void>
    /** Only inside a floating window: 0.3 to 1. */
    opacity(value: number): Promise<void>
    /** Only inside a floating window: the strip at the top is showing, or has gone. */
    bar(on: boolean): Promise<void>
    /** Only inside a floating window: held down on the strip at the top, and let go. */
    drag(on: boolean): Promise<void>
    /** Only inside a floating window. */
    close(): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: SettingsPatch): Promise<Settings>
    /** Every setting as Prism starts out, for "start over". */
    defaults(): Promise<Settings>
    onChanged(cb: (s: Settings) => void): Unsubscribe
  }
  endpoints: {
    list(): Promise<Endpoint[]>
    save(input: EndpointInput): Promise<Endpoint>
    delete(id: string): Promise<void>
    probe(id: string): Promise<ProbeResult>
  }
  claude: {
    status(): Promise<ClaudeStatus>
    /** Ask Claude Code again which models and account it has. */
    refresh(): Promise<ClaudeStatus>
    onChanged(cb: (s: ClaudeStatus) => void): Unsubscribe
    /** Conversations Claude Code has had on this computer (terminal, VS Code), newest first. */
    conversations(): Promise<ClaudeConversation[]>
    /** Carry one on in this project: its transcript comes in and Claude resumes it, remembering all of it. */
    bringIn(file: string): Promise<{ sessionId: string; items: number }>
  }
  models: {
    list(): Promise<ModelInfo[]>
    favorite(key: string, on: boolean): Promise<void>
    setMeta(key: string, meta: Partial<ModelMeta>): Promise<void>
  }
  workspace: {
    /** Native folder picker (starting at `at` when given); resolves to the chosen path or null. */
    open(at?: string): Promise<string | null>
    /** Open a folder by path. An SSH folder (ssh://host/path) is checked first, so a wrong one fails here. */
    set(path: string): Promise<string>
    /** The Linux systems installed in WSL, each with its home folder as Windows sees it. */
    wsl(): Promise<Array<{ distro: string; home: string }>>
    /** Host names from the user's SSH config, as suggestions. */
    sshHosts(): Promise<string[]>
    current(): Promise<string | null>
    onChanged(cb: (path: string | null) => void): Unsubscribe
  }
  fs: {
    list(path: string): Promise<FsEntry[]>
    read(path: string): Promise<FileContent>
    write(path: string, content: string): Promise<void>
    /** Write a file that is not text (a picture, a GIF): its bytes as base64. */
    writeBinary(path: string, base64: string): Promise<void>
    create(path: string, kind: 'file' | 'dir'): Promise<void>
    rename(from: string, to: string): Promise<void>
    delete(path: string): Promise<void>
    assetUrl(path: string): Promise<string>
    search(opts: SearchOptions): Promise<SearchResult>
    quickOpen(query: string, limit?: number): Promise<string[]>
    onChanged(cb: (changes: FsChange[]) => void): Unsubscribe
  }
  git: {
    status(): Promise<GitStatus>
    diff(path: string, staged: boolean): Promise<{ before: string; after: string }>
    /** The file as it is in the last commit, as base64. Null when it was never committed. */
    blob(path: string): Promise<string | null>
    stage(paths: string[]): Promise<void>
    unstage(paths: string[]): Promise<void>
    discard(paths: string[]): Promise<void>
    commit(message: string): Promise<{ ok: boolean; output: string }>
    log(limit?: number): Promise<GitLogEntry[]>
    branches(): Promise<GitBranch[]>
    checkout(name: string): Promise<GitOpResult>
    createBranch(name: string, from?: string): Promise<GitOpResult>
    deleteBranch(name: string, force: boolean): Promise<GitOpResult>
    merge(name: string): Promise<GitOpResult>
    fetch(): Promise<GitOpResult>
    pull(): Promise<GitOpResult>
    push(): Promise<GitOpResult>
    stashList(): Promise<GitStash[]>
    stashSave(message: string): Promise<GitOpResult>
    stashApply(ref: string, drop: boolean): Promise<GitOpResult>
    stashDrop(ref: string): Promise<GitOpResult>
    graph(limit?: number): Promise<GitGraphCommit[]>
    commitFiles(sha: string): Promise<GitCommitFile[]>
    commitFileDiff(sha: string, path: string, oldPath?: string): Promise<{ before: string; after: string }>
    blame(path: string): Promise<GitBlameLine[]>
    /** What git is in the middle of: a merge, a rebase, a cherry-pick, or nothing. */
    operation(): Promise<'merge' | 'rebase' | 'cherry-pick' | null>
    abortOperation(): Promise<GitOpResult>
    conflict(path: string): Promise<GitConflict>
    resolveConflict(path: string, content: string): Promise<GitOpResult>
  }
  sessions: {
    list(): Promise<Session[]>
    create(title?: string): Promise<Session>
    delete(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    /** Copy a session and its transcript into a new session: all of it, or up to and including one item (upTo), or only what came before it (before). */
    duplicate(id: string, opts?: { upTo?: string; before?: string; title?: string; sideOf?: string }): Promise<Session>
    /** `limit`: only the last that many, oldest first. The phone asks for a tail rather than the whole transcript. */
    items(id: string, limit?: number): Promise<TranscriptItem[]>
    /** Pinned files and extra instructions of one session. */
    extras(id: string): Promise<SessionExtras>
    setExtras(id: string, patch: Partial<SessionExtras>): Promise<SessionExtras>
    /** Remove one bulky tool result from what the model is sent. */
    prune(sessionId: string, itemId: string): Promise<boolean>
    /** A new session that works in its own copy of the project, on its own branch. Needs a git repository. */
    createInCopy(title?: string): Promise<Session>
    /** What a session's copy changed, as before/after pairs. */
    copyChanges(sessionId: string): Promise<ReviewFile[]>
    /** Merge the copy's work into the project's current branch. */
    copyIntegrate(sessionId: string): Promise<GitOpResult>
    /** Delete the copy and its branch. */
    copyDiscard(sessionId: string): Promise<GitOpResult>
    onChanged(cb: (sessions: Session[]) => void): Unsubscribe
  }
  /** The task board: jobs the agent works through by itself (main/tasks.ts). */
  tasks: {
    list(): Promise<BoardTask[]>
    save(tasks: Array<Partial<BoardTask> & { title: string; prompt: string }>): Promise<BoardTask[]>
    run(ids: string[] | null, parallel: number): Promise<BoardTask[]>
    stop(): Promise<BoardTask[]>
    onChanged(cb: (tasks: BoardTask[]) => void): Unsubscribe
  }
  /** What the agent remembers between sessions (core/memory). */
  memory: {
    list(): Promise<Array<{ name: string; description: string; body: string; scope: 'project' | 'personal' }>>
    remove(name: string): Promise<boolean>
  }
  /** Lessons kept as files (core/lessons/lessons.ts): the project's and your own. */
  lessons: {
    list(): Promise<Array<{ id: string; scope: 'project' | 'personal'; title: string; steps: number; updatedAt: number }>>
    read(id: string): Promise<unknown>
    /** Saves over `id` when given, else as a new lesson. Returns its id. */
    write(scope: 'project' | 'personal', lesson: { title: string; steps: unknown[] }, id?: string | null): Promise<string>
    remove(id: string): Promise<void>
  }
  agent: {
    send(sessionId: string, text: string, opts?: SendOptions): Promise<{ runId: string }>
    abort(sessionId: string): Promise<void>
    approve(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void>
    answer(sessionId: string, questionId: string, answer: string): Promise<void>
    /** Vibecoding Safety Biteback in this project: read it (no argument), or turn it on or off. */
    biteback(on?: boolean): Promise<boolean>
    /** Answer a change set the agent proposed: what to write, and an optional note for it. */
    review(sessionId: string, reviewId: string, decision: ReviewDecision): Promise<void>
    /** Answer a presented plan: approve (with the mode to work in), send feedback, or discard. */
    plan(sessionId: string, planId: string, decision: PlanDecision): Promise<void>
    /** What the session would send to the model right now, measured part by part. */
    context(sessionId: string): Promise<ContextReport>
    /** Add a lasting note to the project's PRISM.md. Returns the line that was written. */
    remember(note: string): Promise<string>
    /** Ask another model to review the conversation up to one answer. The review is added to the transcript. */
    opinion(sessionId: string, itemId: string, model: ModelRef): Promise<SystemItem>
    /** Put one question to several models at once; listen with onCompare(runId). */
    compare(runId: string, sessionId: string | null, question: string, models: ModelRef[]): Promise<void>
    compareStop(runId: string): Promise<void>
    onCompare(runId: string, cb: (ev: CompareEvent) => void): Unsubscribe
    /** Continue a session with one of the compared answers. */
    adopt(sessionId: string, question: string, answer: string, model: ModelRef): Promise<void>
    setMode(sessionId: string, mode: PermissionMode): Promise<void>
    /** The model for the session's next message; null = Auto (the routing rules choose). */
    setModel(sessionId: string, model: ModelRef | null): Promise<void>
    background(sessionId: string): Promise<BackgroundState>
    /** Give the working agent a message before its next step; false when it cannot take one now. */
    steer(sessionId: string, text: string): Promise<boolean>
    /** Whether it is working and anything it is waiting on, for a window or phone that was not here when it was asked. */
    pending(sessionId: string): Promise<{ running: boolean; approvals: ApprovalRequest[]; questions: QuestionRequest[]; reviews: ReviewRequest[]; plans: PlanRequest[] }>
    /** A quick read-only question; returns the id of its hidden session, whose events can be followed. */
    quickAsk(text: string): Promise<string>
    quickStop(id: string): Promise<void>
    /** Why the agent made this tool call, in a few sentences. */
    why(sessionId: string, itemId: string): Promise<string>
    /** The request rewritten to be precise. */
    sharpen(text: string): Promise<string>
    /** What a call waiting for approval will do, and its risk. */
    explainCall(call: ToolCall): Promise<string>
    /** A glance at a change the user saved: a warning, or null. */
    pairGlance(path: string, before: string, after: string): Promise<string | null>
    cancelBackground(sessionId: string, kind: 'job' | 'timer' | 'helper', id: string): Promise<boolean>
    onNotice(cb: (n: { sessionId: string; title: string; body: string }) => void): Unsubscribe
    compact(sessionId: string): Promise<void>
    onEvent(sessionId: string, cb: (ev: AgentEvent) => void): Unsubscribe
    checkpoints(sessionId: string): Promise<Checkpoint[]>
    restore(checkpointId: string): Promise<string[]>
    restoreFile(checkpointId: string, path: string): Promise<boolean>
    /** A file as it was before the turn changed it. existed=false: the turn created it. */
    checkpointFile(checkpointId: string, path: string): Promise<{ existed: boolean; content: string } | null>
    /** Undo every turn from this user message on: files restored, transcript cut. Returns the message text. */
    rewind(sessionId: string, itemId: string): Promise<{ text: string; files: string[] }>
    slashCommands(): Promise<SlashCommand[]>
  }
  terminals: {
    create(opts?: { cwd?: string; kind?: TerminalKind; title?: string }): Promise<TerminalInfo>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    list(): Promise<TerminalInfo[]>
    onData(id: string, cb: (data: string) => void): Unsubscribe
    onExit(id: string, cb: (code: number) => void): Unsubscribe
    onCreated(cb: (info: TerminalInfo) => void): Unsubscribe
    onChanged(cb: () => void): Unsubscribe
  }
  completions: {
    inline(req: InlineCompletionRequest): Promise<string | null>
    edit(req: InlineEditRequest): Promise<string>
  }
  mcp: {
    list(): Promise<McpStatus[]>
    connect(id: string): Promise<McpStatus>
    disconnect(id: string): Promise<McpStatus>
    /** Keep a token or password for a server in the encrypted vault; an empty value forgets it. */
    setSecret(id: string, name: string, value: string): Promise<void>
  }
  rules: {
    list(): Promise<UserRule[]>
    /** Work out what a rule written as a sentence would stop; nothing is saved. */
    preview(sentence: string): Promise<UserRule>
    save(rule: UserRule): Promise<void>
    remove(id: string): Promise<void>
  }
  learn: {
    /** Keep what was offered: a skill file, or a rule (returned so its reach can be shown). */
    accept(offer: LearnOffer, scope: 'project' | 'personal'): Promise<{ path?: string; rule?: UserRule }>
    dismiss(offer: LearnOffer): Promise<void>
  }
  spec: {
    /** The project's spec and what is known about each section; null when there is none. */
    state(): Promise<SpecState | null>
    /** Start a SPEC.md from a template; returns its path. */
    create(): Promise<string>
    /** Send the spec's edits to the agent (in a session called "Spec", plan first); returns that session. */
    makeCodeMatch(): Promise<string>
    /** Deal with a section that drifted: change the spec, change the code (in that session), or let it be. */
    resolve(title: string, how: 'spec' | 'code' | 'ignore', sessionId: string | null): Promise<string | null>
    onChanged(cb: () => void): Unsubscribe
  }
  portable: {
    /** Save a session as one file the user chooses. False when they cancelled. */
    export(sessionId: string): Promise<boolean>
    /** Save it as one web page anyone can read, with the session inside for another Prism. The path, or null when cancelled. */
    sharePage(sessionId: string, tools: boolean): Promise<string | null>
    /** Open a session file into this project. Null when cancelled; the plan brings in its file changes. */
    import(): Promise<{ sessionId: string; plan: RefactorPlan | null } | null>
  }
  catchup: {
    /** What happened in this project since the given time. */
    since(ts: number): Promise<CatchUp>
  }
  nextEdit: {
    /** After the user saved a change: the other places that need the same change, as a change set. Null: none found. */
    suggest(path: string, before: string, after: string): Promise<RefactorPlan | null>
  }
  impact: {
    /** What these changes (not yet written, or written) could break. */
    files(files: ReviewFile[]): Promise<ImpactReport>
    /** What the session's latest changes could break. */
    session(sessionId: string): Promise<ImpactReport>
  }
  voice: {
    /** Speech to text through one of the user's providers (OpenAI-compatible /audio/transcriptions). */
    transcribe(endpointId: string, model: string, audio: Uint8Array, mime: string, language: string): Promise<string>
    /** Open Windows' dictation; it types into the focused box. */
    dictate(): Promise<void>
    /** Says a line in whichever voice is set, and hands back a WAV to play. "trouble" is set when it had to fall back to the plain voice. */
    speak(text: string): Promise<{ wav: Uint8Array; trouble: string | null }>
    /** Whether the better voice is set up, and the voices it has. */
    kokoro(path: string): Promise<{ ok: boolean; why: string; path: string; voices: string[] }>
    /** A call on this conversation started, is still on (said every half minute), or ended. face: the face is showing. */
    inCall(sessionId: string, on: boolean, face: boolean): Promise<void>
    /** The voices this computer has installed, the local one first. */
    voices(): Promise<Array<{ name: string; culture: string; gender: string }>>
    /** The speech models kept on this computer, with their size on disk. */
    kept(): Promise<Array<{ repo: string; bytes: number }>>
    /** Delete a kept speech model; it downloads again when next used. */
    forget(repo: string): Promise<void>
    /** The phone's recording, turned into words by the computer with the model it already has. */
    onComputer(audio: Uint8Array, mime: string, model: string, language: string): Promise<string>
    /** A window of the app offers to be the one that runs the speech model. */
    onDoLocal(cb: (job: { id: string; audio: Uint8Array; mime: string; model: string; language: string }) => void): Unsubscribe
    /** That window hands back what it heard, or why it could not. */
    localDone(id: string, text: string | null, error: string | null): Promise<void>
  }
  remote: {
    /** The phone app's side of this Prism: its addresses, paired devices, and a pairing code while one is open. */
    info(): Promise<RemoteInfo>
    /** Open pairing for ten minutes (a one-time code, also as a QR code). */
    pair(): Promise<RemoteInfo>
    forget(pub: string): Promise<void>
  }
  host: {
    /** Projects open in Prism (in any window) and recent ones, for a remote client to pick from. */
    projects(): Promise<Array<{ root: string; name: string; open: boolean }>>
    /** A file behind a prism:// address, for clients that cannot load those addresses themselves. */
    asset(url: string): Promise<{ mime: string; data: Uint8Array } | null>
  }
  phone: {
    /** Whether the phone page is on, its addresses, the pairing code and how many phones are paired. */
    info(): Promise<{ on: boolean; urls: string[]; code: string; paired: number; error: string | null }>
    /** Unpair every phone. */
    forget(): Promise<void>
  }
  prs: {
    /** The project's GitHub repository (if its origin is on GitHub), its open pull requests, and whether a token is kept. */
    list(): Promise<{ repo: { owner: string; repo: string } | null; pulls: PullRequestInfo[]; login: string | null; error: string | null }>
    /** Review a pull request (number) or the current branch against the main one (null). */
    review(number: number | null, focus: 'general' | 'security'): Promise<{ findings: ReviewFinding[]; model: string; title: string; headSha: string | null }>
    /** Post a finding as a comment on the pull request; returns its address. */
    post(number: number, finding: ReviewFinding, headSha: string): Promise<string>
    /** "Not a problem": kept as a rule for later reviews. */
    dismiss(finding: ReviewFinding, reason: string): Promise<void>
    /** Keep a GitHub token (encrypted), or forget it with an empty one; returns the account name. */
    token(token: string): Promise<string | null>
  }
  split: {
    /** Uncommitted work cut into pieces and grouped into commits by a model (nothing is changed yet). */
    plan(): Promise<{ pieces: SplitPiece[]; commits: SplitCommit[]; model: string }>
    /** Make the commits, in order. The files on disk are not touched. */
    apply(commits: SplitCommit[]): Promise<{ ok: boolean; made: number; output: string }>
  }
  conversations: {
    /** Search every conversation in the open project. */
    search(q: ConvQuery): Promise<{ hits: ConvHit[]; more: boolean }>
    /** Several attempts at one request, compared: which to keep (an index into ways), why, and a line on each. */
    judge(request: string, ways: Array<{ sessionId: string; label: string }>): Promise<{ best: number; why: string; notes: string[]; model: string }>
  }
  history: {
    /** Every step of a session, with the files each changed. */
    timeline(sessionId: string): Promise<HistoryTimeline>
    version(id: number): Promise<FileVersion | null>
    /** The files the session changed, as they were right after step `index` (-1: before any change). */
    state(sessionId: string, index: number, path?: string): Promise<Array<{ path: string; content: string | null }>>
    /** Which request and reasoning put this line of this file there. */
    why(path: string, line: string): Promise<LineOrigin | null>
    /** The lines of this file (as it is now) that the agent wrote. */
    lines(path: string, content: string): Promise<AgentLineRun[]>
    /** The changes that take one request back out, keeping later work; nothing is written. */
    undoRequest(sessionId: string, turnItemId: string): Promise<RefactorPlan>
    /** Put every file the session changed back as it was right after step `index`. Undoable from the session's checkpoints. */
    restore(sessionId: string, index: number): Promise<string[]>
  }
  extend: {
    /** The skills and the user's own tools available in the open project. */
    list(): Promise<ExtendState>
    /** Start a new skill or tool from a template; returns where the file is. */
    create(kind: 'skill' | 'tool', name: string, scope: 'project' | 'personal'): Promise<string>
    read(kind: 'skill' | 'tool', path: string, scope: 'project' | 'personal'): Promise<string>
    write(kind: 'skill' | 'tool', path: string, scope: 'project' | 'personal', content: string): Promise<void>
    remove(kind: 'skill' | 'tool', path: string, scope: 'project' | 'personal'): Promise<void>
    /** Let the agent use a tool file as it is now. */
    allow(path: string, scope: 'project' | 'personal'): Promise<void>
    /** Have the agent fix a tool file that does not load; returns the Repairs session. */
    repair(path: string, scope: 'project' | 'personal', error: string): Promise<string | null>
    /** Show the folder of the user's own (every-project) skills or tools. */
    openFolder(kind: 'skill' | 'tool'): Promise<void>
    toolchain(): Promise<Toolchain>
    onChanged(cb: () => void): Unsubscribe
  }
  dashboard: {
    overview(): Promise<ProjectOverview>
    /** Slow: asks the package registry which dependencies have newer versions. */
    outdated(): Promise<OutdatedReport>
    /** What this project's sessions used per day, for the last `days` days. */
    spend(days: number): Promise<SpendDay[]>
    /** Where each package's release notes are (its repository's releases), when the registry says. */
    releaseNotes(names: string[]): Promise<Record<string, string | null>>
  }
  scratch: {
    /** Run one notebook cell. Its output arrives through onEvent; this settles when the cell has finished. */
    run(cell: string, lang: ScratchLang, code: string): Promise<{ ok: boolean; ms: number }>
    /** Stop whatever runs and forget everything the cells defined. */
    stop(): Promise<void>
    status(): Promise<ScratchStatus>
    onEvent(cb: (ev: ScratchEvent) => void): Unsubscribe
  }
  preview: {
    /** The Browser panel's page exists: tell main which web contents it is, so the agent's browser tools can reach it. */
    attach(webContentsId: number): void
    detach(webContentsId: number): void
    /** Start (or reuse) the static server for the workspace folder; returns its address. */
    serve(): Promise<string>
    /** The static server's address if it is running; does not start it. */
    base(): Promise<string | null>
    /** Turn what was typed (an address, or a file in the workspace) into an address to load. */
    resolve(target: string): Promise<string>
    scripts(): Promise<DevScript[]>
    /** Accessibility problems on the page open in the Browser panel, worst first, with a picture of where they are. */
    audit(): Promise<{ report: A11yReport; image: { mime: string; base64: string } | null }>
    /** Point at elements on the open page (one problem's places). */
    highlight(selectors: string[]): Promise<boolean>
    /** Whether the user follows the agent: if not, the agent browses in a hidden page and leaves the Browser panel alone. */
    follow(on: boolean): Promise<void>
    onOpen(cb: () => void): Unsubscribe
    onFocus(cb: () => void): Unsubscribe
  }
  refactor: {
    /** Work out a rename everywhere; nothing is written. line and column are 1-based; word is the name under the cursor. */
    rename(path: string, line: number, column: number, word: string, newName: string): Promise<RefactorPlan>
    references(path: string, line: number, column: number, word: string): Promise<{ hits: RefHit[]; byMeaning: boolean }>
    /** Work out which files must change when a file or folder moves; nothing is written or moved. */
    move(from: string, to: string): Promise<RefactorPlan>
    /** Write the accepted files (as in a review), then carry out the move if there is one. */
    apply(files: ReviewDecision['files'], then?: { from: string; to: string }): Promise<{ written: string[] }>
    /** Put back what the last apply changed. Null when there is nothing to undo. */
    undo(): Promise<string[] | null>
  }
  themes: {
    /** Save a theme as a file the user chooses. False when they cancelled. */
    export(theme: Theme): Promise<boolean>
    /** Save several themes as one file (a pack). False when they cancelled. */
    exportAll(themes: Theme[]): Promise<boolean>
    /** Read a theme file or a pack the user chooses. Null when they cancelled. */
    import(): Promise<Theme[] | null>
    /** Choose a background picture; it is copied into the app's data folder. Returns its file name there. */
    pickPicture(): Promise<string | null>
    /** Names of the fonts installed on this computer. */
    fonts(): Promise<string[]>
  }
  attachments: {
    pick(): Promise<Attachment[]>
    fromData(name: string, mime: string, base64: string): Promise<Attachment>
  }
  gadgets: {
    list(): Promise<GadgetInfo[]>
    start(id: string): Promise<GadgetInfo>
    stop(id: string): Promise<GadgetInfo>
    reload(id: string): Promise<GadgetInfo>
    remove(id: string): Promise<void>
    /** Turn one that comes with Prism on (or off) in this project, after its introduction. */
    turnOn(id: string, on: boolean): Promise<GadgetInfo[]>
    call(id: string, method: string, args: Record<string, unknown>): Promise<unknown>
    write(id: string, files: Record<string, string>, scope: 'project' | 'global'): Promise<GadgetInfo>
    read(id: string): Promise<Record<string, string>>
    /** The gadget's page with everything it loads folded in, for a client with no prism-gadget:// address. */
    page(id: string): Promise<string>
    /** An offered gadget: build it, put it off, or never this kind here again. */
    decideIdea(idea: GadgetIdea, answer: 'build' | 'later' | 'never', sessionId?: string | null): Promise<void>
    /** Kinds of gadget turned down for good in this project. */
    refusedIdeas(): Promise<string[]>
    /** Let a refused kind be offered again. */
    allowIdea(kind: string): Promise<void>
    log(id: string): Promise<string[]>
    openDir(id: string): Promise<void>
    onChanged(cb: (list: GadgetInfo[]) => void): Unsubscribe
    onEvent(id: string, cb: (ev: { event: string; data: unknown }) => void): Unsubscribe
    onLog(id: string, cb: (line: string) => void): Unsubscribe
    onUi(cb: (msg: GadgetUiMessage) => void): Unsubscribe
  }
  usage: {
    summary(): Promise<UsageSummary>
    /** The Claude plan's limits and what uses them, asked of Claude Code (at most once a minute unless fresh). */
    claude(fresh?: boolean): Promise<ClaudePlanUsage>
  }
  automations: {
    get(): Promise<AutomationsState>
    save(config: AutomationsConfig): Promise<AutomationsState>
    /** Fire a watcher or a schedule now. */
    run(id: string): Promise<void>
    onChanged(cb: (s: AutomationsState) => void): Unsubscribe
    /** Commands the agent left running in the background. */
    jobs(): Promise<JobInfo[]>
    killJob(id: string): Promise<boolean>
  }
  checks: {
    /** The checkers found for the open project (type checker, linter, tests…). */
    list(): Promise<CheckerInfo[]>
    run(id: string): Promise<CheckResult>
  }
}
