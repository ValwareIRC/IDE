// The Prism API the page uses (window.prism), built on whatever carries it: Electron's IPC in a window
// (preload/index.ts), or the encrypted channel in the phone app (renderer/src/remote).
import { CH, type PrismApi, type Unsubscribe } from './ipc'

export interface Transport {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  on<T>(channel: string, cb: (payload: T) => void): Unsubscribe
  /** No answer expected (typing into a terminal). */
  send(channel: string, ...args: unknown[]): void
  platform: PrismApi['platform']
  debug: boolean
}

export function makeApi(t: Transport): PrismApi {
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => t.invoke<T>(channel, ...args)
  const on = <T>(channel: string, cb: (payload: T) => void): Unsubscribe => t.on<T>(channel, cb)
  const send = (channel: string, ...args: unknown[]): void => t.send(channel, ...args)
  return {
    platform: t.platform,
    debug: t.debug,
    app: {
      info: () => invoke(CH.AppInfo),
      openExternal: (url) => invoke(CH.AppOpenExternal, url),
      reveal: (p) => invoke(CH.AppReveal, p)
    },
    face: {
      info: () => invoke(CH.FaceInfo),
      part: (offset) => invoke(CH.FacePart, offset),
      pick: () => invoke(CH.FacePick)
    },
    files: {
      open: (sid, itemId) => invoke(CH.FileOpen, sid, itemId),
      reveal: (sid, itemId) => invoke(CH.FileReveal, sid, itemId),
      part: (sid, itemId, offset) => invoke(CH.FilePart, sid, itemId, offset)
    },
    win: {
      minimize: () => send(CH.WinMinimize),
      maximize: () => send(CH.WinMaximize),
      close: () => send(CH.WinClose),
      isMaximized: () => invoke(CH.WinIsMaximized),
      onMaximizedChanged: (cb) => on(CH.WinMaximizedChanged, cb),
      zoom: (step) => invoke(CH.WinZoom, step),
      open: (root) => invoke(CH.WinNew, root ?? null)
    },
    float: {
      open: (spec) => invoke(CH.FloatOpen, spec),
      list: () => invoke(CH.FloatList),
      pin: (on) => invoke(CH.FloatPin, on),
      opacity: (value) => invoke(CH.FloatOpacity, value),
      bar: (on) => invoke(CH.FloatBar, on),
      drag: (on) => invoke(CH.FloatDrag, on),
      close: () => invoke(CH.FloatClose)
    },
    settings: {
      get: () => invoke(CH.SettingsGet),
      update: (patch) => invoke(CH.SettingsUpdate, patch),
      defaults: () => invoke(CH.SettingsDefaults),
      onChanged: (cb) => on(CH.SettingsChanged, cb)
    },
    endpoints: {
      list: () => invoke(CH.EndpointList),
      save: (input) => invoke(CH.EndpointSave, input),
      delete: (id) => invoke(CH.EndpointDelete, id),
      probe: (id) => invoke(CH.EndpointProbe, id)
    },
    claude: {
      status: () => invoke(CH.ClaudeStatus),
      refresh: () => invoke(CH.ClaudeRefresh),
      onChanged: (cb) => on(CH.ClaudeChanged, cb),
      conversations: () => invoke(CH.ClaudeConversations),
      bringIn: (file) => invoke(CH.ClaudeBringIn, file)
    },
    models: {
      list: () => invoke(CH.ModelList),
      favorite: (key, onFlag) => invoke(CH.ModelFavorite, key, onFlag),
      setMeta: (key, meta) => invoke(CH.ModelSetMeta, key, meta)
    },
    workspace: {
      open: (at) => invoke(CH.WorkspaceOpen, at),
      set: (p) => invoke(CH.WorkspaceSet, p),
      wsl: () => invoke(CH.WorkspaceWsl),
      sshHosts: () => invoke(CH.WorkspaceSshHosts),
      current: () => invoke(CH.WorkspaceCurrent),
      onChanged: (cb) => on(CH.WorkspaceChanged, cb)
    },
    fs: {
      list: (p) => invoke(CH.FsList, p),
      read: (p) => invoke(CH.FsRead, p),
      write: (p, content) => invoke(CH.FsWrite, p, content),
      writeBinary: (p, base64) => invoke(CH.FsWriteBinary, p, base64),
      create: (p, kind) => invoke(CH.FsCreate, p, kind),
      rename: (a, b) => invoke(CH.FsRename, a, b),
      delete: (p) => invoke(CH.FsDelete, p),
      assetUrl: (p) => invoke(CH.FsAssetUrl, p),
      search: (opts) => invoke(CH.FsSearch, opts),
      quickOpen: (q, limit) => invoke(CH.FsQuickOpen, q, limit),
      onChanged: (cb) => on(CH.FsChanged, cb)
    },
    git: {
      status: () => invoke(CH.GitStatus),
      diff: (p, staged) => invoke(CH.GitDiff, p, staged),
      blob: (p) => invoke(CH.GitBlob, p),
      stage: (paths) => invoke(CH.GitStage, paths),
      unstage: (paths) => invoke(CH.GitUnstage, paths),
      discard: (paths) => invoke(CH.GitDiscard, paths),
      commit: (m) => invoke(CH.GitCommit, m),
      log: (limit) => invoke(CH.GitLog, limit),
      branches: (...args: unknown[]) => invoke(CH.GitOp, 'branches', ...args),
      checkout: (...args: unknown[]) => invoke(CH.GitOp, 'checkout', ...args),
      createBranch: (...args: unknown[]) => invoke(CH.GitOp, 'createBranch', ...args),
      deleteBranch: (...args: unknown[]) => invoke(CH.GitOp, 'deleteBranch', ...args),
      merge: (...args: unknown[]) => invoke(CH.GitOp, 'merge', ...args),
      fetch: (...args: unknown[]) => invoke(CH.GitOp, 'fetch', ...args),
      pull: (...args: unknown[]) => invoke(CH.GitOp, 'pull', ...args),
      push: (...args: unknown[]) => invoke(CH.GitOp, 'push', ...args),
      stashList: (...args: unknown[]) => invoke(CH.GitOp, 'stashList', ...args),
      stashSave: (...args: unknown[]) => invoke(CH.GitOp, 'stashSave', ...args),
      stashApply: (...args: unknown[]) => invoke(CH.GitOp, 'stashApply', ...args),
      stashDrop: (...args: unknown[]) => invoke(CH.GitOp, 'stashDrop', ...args),
      graph: (...args: unknown[]) => invoke(CH.GitOp, 'graph', ...args),
      commitFiles: (...args: unknown[]) => invoke(CH.GitOp, 'commitFiles', ...args),
      commitFileDiff: (...args: unknown[]) => invoke(CH.GitOp, 'commitFileDiff', ...args),
      blame: (...args: unknown[]) => invoke(CH.GitOp, 'blame', ...args),
      operation: (...args: unknown[]) => invoke(CH.GitOp, 'operation', ...args),
      abortOperation: (...args: unknown[]) => invoke(CH.GitOp, 'abortOperation', ...args),
      conflict: (...args: unknown[]) => invoke(CH.GitOp, 'conflict', ...args),
      resolveConflict: (...args: unknown[]) => invoke(CH.GitOp, 'resolveConflict', ...args)
    },
    sessions: {
      list: () => invoke(CH.SessionList),
      create: (title) => invoke(CH.SessionCreate, title),
      delete: (id) => invoke(CH.SessionDelete, id),
      rename: (id, title) => invoke(CH.SessionRename, id, title),
      duplicate: (id, opts) => invoke(CH.SessionDuplicate, id, opts),
      items: (id, limit) => invoke(CH.SessionItems, id, limit),
      extras: (id) => invoke(CH.SessionExtras, id),
      setExtras: (id, patch) => invoke(CH.SessionSetExtras, id, patch),
      prune: (sessionId, itemId) => invoke(CH.SessionPrune, sessionId, itemId),
      createInCopy: (title) => invoke(CH.SessionCreateCopy, title),
      copyChanges: (sessionId) => invoke(CH.SessionCopyChanges, sessionId),
      copyIntegrate: (sessionId) => invoke(CH.SessionCopyIntegrate, sessionId),
      copyDiscard: (sessionId) => invoke(CH.SessionCopyDiscard, sessionId),
      onChanged: (cb) => on(CH.SessionChanged, cb)
    },
    tasks: {
      list: () => invoke(CH.TasksList),
      save: (tasks) => invoke(CH.TasksSave, tasks),
      run: (ids, parallel) => invoke(CH.TasksRun, ids, parallel),
      stop: () => invoke(CH.TasksStop),
      onChanged: (cb) => on(CH.TasksChanged, cb)
    },
    memory: {
      list: () => invoke(CH.MemoryList),
      remove: (name) => invoke(CH.MemoryRemove, name)
    },
    lessons: {
      list: () => invoke(CH.LessonList),
      read: (id) => invoke(CH.LessonRead, id),
      write: (scope, lesson, id) => invoke(CH.LessonWrite, scope, lesson, id ?? null),
      remove: (id) => invoke(CH.LessonRemove, id)
    },
    agent: {
      send: (sessionId, text, opts) => invoke(CH.AgentSend, sessionId, text, opts),
      abort: (sessionId) => invoke(CH.AgentAbort, sessionId),
      approve: (sessionId, approvalId, decision) => invoke(CH.AgentApprove, sessionId, approvalId, decision),
      biteback: (on) => invoke(CH.Biteback, on ?? null),
      answer: (sessionId, questionId, answer) => invoke(CH.AgentAnswer, sessionId, questionId, answer),
      review: (sessionId, reviewId, decision) => invoke(CH.AgentReview, sessionId, reviewId, decision),
      plan: (sessionId, planId, decision) => invoke(CH.AgentPlan, sessionId, planId, decision),
      context: (sessionId) => invoke(CH.AgentContext, sessionId),
      remember: (note) => invoke(CH.NotesRemember, note),
      opinion: (sessionId, itemId, model) => invoke(CH.AgentOpinion, sessionId, itemId, model),
      compare: (runId, sessionId, question, models) => invoke(CH.AgentCompare, runId, sessionId, question, models),
      compareStop: (runId) => invoke(CH.AgentCompareStop, runId),
      onCompare: (runId, cb) => on(CH.CompareEventPrefix + runId, cb),
      adopt: (sessionId, question, answer, model) => invoke(CH.AgentAdopt, sessionId, question, answer, model),
      setMode: (sessionId, mode) => invoke(CH.AgentSetMode, sessionId, mode),
      setModel: (sessionId, model) => invoke(CH.AgentSetModel, sessionId, model),
      background: (sessionId) => invoke(CH.AgentBackground, sessionId),
      steer: (sessionId, text) => invoke(CH.AgentSteer, sessionId, text),
      pending: (sessionId) => invoke(CH.AgentPending, sessionId),
      quickAsk: (text) => invoke(CH.AgentQuickAsk, text),
      quickStop: (id) => invoke(CH.AgentQuickStop, id),
      why: (sessionId, itemId) => invoke(CH.AgentWhy, sessionId, itemId),
      sharpen: (text) => invoke(CH.AgentSharpen, text),
      explainCall: (call) => invoke(CH.AgentExplainCall, call),
      pairGlance: (path, before, after) => invoke(CH.PairGlance, path, before, after),
      cancelBackground: (sessionId, kind, id) => invoke(CH.AgentBackgroundCancel, sessionId, kind, id),
      onNotice: (cb) => on(CH.Notice, cb),
      compact: (sessionId) => invoke(CH.AgentCompact, sessionId),
      onEvent: (sessionId, cb) => on(CH.AgentEventPrefix + sessionId, cb),
      checkpoints: (sessionId) => invoke(CH.CheckpointList, sessionId),
      restore: (id) => invoke(CH.CheckpointRestore, id),
      restoreFile: (id, path) => invoke(CH.CheckpointRestoreFile, id, path),
      checkpointFile: (id, path) => invoke(CH.CheckpointFile, id, path),
      rewind: (sessionId, itemId) => invoke(CH.SessionRewind, sessionId, itemId),
      slashCommands: () => invoke(CH.SlashList)
    },
    terminals: {
      create: (opts) => invoke(CH.TermCreate, opts),
      write: (id, data) => send(CH.TermWrite, id, data),
      resize: (id, cols, rows) => send(CH.TermResize, id, cols, rows),
      kill: (id) => invoke(CH.TermKill, id),
      list: () => invoke(CH.TermList),
      onData: (id, cb) => on(CH.TermDataPrefix + id, cb),
      onExit: (id, cb) => on(CH.TermExitPrefix + id, cb),
      onCreated: (cb) => on(CH.TermCreated, cb),
      onChanged: (cb) => on(CH.TermChanged, cb)
    },
    completions: {
      inline: (req) => invoke(CH.CompletionInline, req),
      edit: (req) => invoke(CH.CompletionEdit, req)
    },
    mcp: {
      list: () => invoke(CH.McpList),
      connect: (id) => invoke(CH.McpConnect, id),
      disconnect: (id) => invoke(CH.McpDisconnect, id),
      setSecret: (id, name, value) => invoke(CH.McpSetSecret, id, name, value)
    },
    rules: {
      list: () => invoke(CH.RulesList),
      preview: (sentence) => invoke(CH.RulesPreview, sentence),
      save: (rule) => invoke(CH.RulesSave, rule),
      remove: (id) => invoke(CH.RulesRemove, id)
    },
    learn: {
      accept: (offer, scope) => invoke(CH.LearnAccept, offer, scope),
      dismiss: (offer) => invoke(CH.LearnDismiss, offer)
    },
    spec: {
      state: () => invoke(CH.SpecState),
      create: () => invoke(CH.SpecCreate),
      makeCodeMatch: () => invoke(CH.SpecMakeCodeMatch),
      resolve: (title, how, sessionId) => invoke(CH.SpecResolve, title, how, sessionId),
      onChanged: (cb) => on(CH.SpecChanged, cb)
    },
    catchup: {
      since: (ts) => invoke(CH.CatchUpSince, ts)
    },
    portable: {
      export: (sessionId) => invoke(CH.SessionExport, sessionId),
      sharePage: (sessionId, tools) => invoke(CH.SessionSharePage, sessionId, tools),
      import: () => invoke(CH.SessionImport)
    },
    nextEdit: {
      suggest: (path, before, after) => invoke(CH.NextEditSuggest, path, before, after)
    },
    impact: {
      files: (files) => invoke(CH.ImpactFiles, files),
      session: (sessionId) => invoke(CH.ImpactSession, sessionId)
    },
    remote: {
      info: () => invoke(CH.RemoteInfo),
      pair: () => invoke(CH.RemotePair),
      forget: (pub) => invoke(CH.RemoteForget, pub)
    },
    host: {
      projects: () => invoke(CH.HostProjects),
      asset: (url) => invoke(CH.AssetGet, url)
    },
    phone: {
      info: () => invoke(CH.PhoneInfo),
      forget: () => invoke(CH.PhoneForget)
    },
    prs: {
      list: () => invoke(CH.PrsList),
      review: (number, focus) => invoke(CH.PrsReview, number, focus),
      post: (number, finding, headSha) => invoke(CH.PrsPost, number, finding, headSha),
      dismiss: (finding, reason) => invoke(CH.PrsDismiss, finding, reason),
      token: (token) => invoke(CH.PrsToken, token)
    },
    split: {
      plan: () => invoke(CH.GitSplitPlan),
      apply: (commits) => invoke(CH.GitSplitApply, commits)
    },
    conversations: {
      search: (q) => invoke(CH.ConversationsSearch, q),
      judge: (request, ways) => invoke(CH.AgentJudgeWays, request, ways)
    },
    voice: {
      transcribe: (endpointId, model, audio, mime, language) => invoke(CH.VoiceTranscribe, endpointId, model, audio, mime, language),
      dictate: () => invoke(CH.VoiceDictate),
      speak: (text) => invoke(CH.VoiceSpeak, text),
      kokoro: (path) => invoke(CH.VoiceKokoro, path),
      inCall: (sessionId, on, face) => invoke(CH.VoiceInCall, sessionId, on, face),
      voices: () => invoke(CH.VoiceVoices),
      kept: () => invoke(CH.VoiceKept),
      forget: (repo) => invoke(CH.VoiceForget, repo),
      onComputer: (audio, mime, model, language) => invoke(CH.VoiceOnComputer, audio, mime, model, language),
      onDoLocal: (cb) => on(CH.VoiceDoLocal, cb),
      localDone: (id, text, error) => invoke(CH.VoiceLocalDone, id, text, error)
    },
    history: {
      timeline: (sessionId) => invoke(CH.HistoryTimeline, sessionId),
      version: (id) => invoke(CH.HistoryVersion, id),
      state: (sessionId, index, path) => invoke(CH.HistoryState, sessionId, index, path),
      why: (path, line) => invoke(CH.HistoryWhy, path, line),
      lines: (path, content) => invoke(CH.HistoryLines, path, content),
      undoRequest: (sessionId, turnItemId) => invoke(CH.HistoryUndoRequest, sessionId, turnItemId),
      restore: (sessionId, index) => invoke(CH.HistoryRestore, sessionId, index)
    },
    extend: {
      list: () => invoke(CH.ExtendList),
      create: (kind, name, scope) => invoke(CH.ExtendCreate, kind, name, scope),
      read: (kind, path, scope) => invoke(CH.ExtendRead, kind, path, scope),
      write: (kind, path, scope, content) => invoke(CH.ExtendWrite, kind, path, scope, content),
      remove: (kind, path, scope) => invoke(CH.ExtendRemove, kind, path, scope),
      allow: (path, scope) => invoke(CH.ExtendAllow, path, scope),
      repair: (path, scope, error) => invoke(CH.ExtendRepair, path, scope, error),
      openFolder: (kind) => invoke(CH.ExtendOpenFolder, kind),
      toolchain: () => invoke(CH.ExtendToolchain),
      onChanged: (cb) => on(CH.ExtendChanged, cb)
    },
    dashboard: {
      overview: () => invoke(CH.DashboardOverview),
      outdated: () => invoke(CH.DashboardOutdated),
      spend: (days) => invoke(CH.DashboardSpend, days),
      releaseNotes: (names) => invoke(CH.DashboardNotes, names)
    },
    scratch: {
      run: (cell, lang, code) => invoke(CH.ScratchRun, cell, lang, code),
      stop: () => invoke(CH.ScratchStop),
      status: () => invoke(CH.ScratchStatus),
      onEvent: (cb) => on(CH.ScratchEvent, cb)
    },
    preview: {
      attach: (id) => void invoke(CH.PreviewAttach, id),
      detach: (id) => void invoke(CH.PreviewDetach, id),
      serve: () => invoke(CH.PreviewServe),
      base: () => invoke(CH.PreviewBase),
      resolve: (target) => invoke(CH.PreviewResolve, target),
      scripts: () => invoke(CH.PreviewScripts),
      audit: () => invoke(CH.PreviewAudit),
      highlight: (selectors) => invoke(CH.PreviewHighlight, selectors),
      follow: (on) => invoke(CH.PreviewFollow, on),
      onOpen: (cb) => on(CH.PreviewOpen, cb),
      onFocus: (cb) => on(CH.PreviewFocus, cb)
    },
    refactor: {
      rename: (path, line, column, word, newName) => invoke(CH.RefactorRename, path, line, column, word, newName),
      references: (path, line, column, word) => invoke(CH.RefactorReferences, path, line, column, word),
      move: (from, to) => invoke(CH.RefactorMove, from, to),
      apply: (files, then) => invoke(CH.RefactorApply, files, then),
      undo: () => invoke(CH.RefactorUndo)
    },
    themes: {
      export: (theme) => invoke(CH.ThemeExport, theme),
      exportAll: (themes) => invoke(CH.ThemeExportAll, themes),
      import: () => invoke(CH.ThemeImport),
      pickPicture: () => invoke(CH.ThemePicture),
      fonts: () => invoke(CH.ThemeFonts)
    },
    attachments: {
      pick: () => invoke(CH.AttachPick),
      fromData: (name, mime, base64) => invoke(CH.AttachFromData, name, mime, base64)
    },
    usage: {
      summary: () => invoke(CH.UsageSummary),
      claude: (fresh) => invoke(CH.ClaudePlanUsage, fresh)
    },
    automations: {
      get: () => invoke(CH.AutomationsGet),
      save: (config) => invoke(CH.AutomationsSave, config),
      run: (id) => invoke(CH.AutomationsRun, id),
      onChanged: (cb) => on(CH.AutomationsChanged, cb),
      jobs: () => invoke(CH.JobsList),
      killJob: (id) => invoke(CH.JobsKill, id)
    },
    checks: {
      list: () => invoke(CH.ChecksList),
      run: (id) => invoke(CH.ChecksRun, id)
    },
    gadgets: {
      list: () => invoke(CH.GadgetList),
      start: (id) => invoke(CH.GadgetStart, id),
      stop: (id) => invoke(CH.GadgetStop, id),
      reload: (id) => invoke(CH.GadgetReload, id),
      remove: (id) => invoke(CH.GadgetRemove, id),
      turnOn: (id, on) => invoke(CH.GadgetTurnOn, id, on),
      call: (id, method, args) => invoke(CH.GadgetCall, id, method, args),
      write: (id, files, scope) => invoke(CH.GadgetWrite, id, files, scope),
      read: (id) => invoke(CH.GadgetRead, id),
      page: (id) => invoke(CH.GadgetPage, id),
      decideIdea: (idea, answer, sessionId) => invoke(CH.GadgetIdeaDecide, idea, answer, sessionId ?? null),
      refusedIdeas: () => invoke(CH.GadgetIdeaRefused),
      allowIdea: (kind) => invoke(CH.GadgetIdeaAllow, kind),
      log: (id) => invoke(CH.GadgetLog, id),
      openDir: (id) => invoke(CH.GadgetOpenDir, id),
      onChanged: (cb) => on(CH.GadgetChanged, cb),
      onEvent: (id, cb) => on(CH.GadgetEventPrefix + id, cb),
      onLog: (id, cb) => on(CH.GadgetLogPrefix + id, cb),
      onUi: (cb) => on(CH.GadgetUi, cb)
    }
  }
  }
