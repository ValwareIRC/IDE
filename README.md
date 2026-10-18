# Prism

An agentic IDE for any model. A real editor, a real terminal, and an agent that reads, edits and runs your project, with the things it makes shown to you as it makes them.

- **Any model.** Claude, GLM, GPT, Gemini, DeepSeek, Mistral, local models through Ollama or LM Studio, anything with an OpenAI-compatible API. Each conversation can use a different one, and rules can pick the model for each message.
- **Claude Agent.** If you have Claude Code installed and signed in, Prism can run your conversations on it: its tools, its memory, your plan. Prism never sees or keeps your Claude sign-in; it uses the Claude Code you set up yourself.
- **A real agent.** Precise edits, project-wide search, a terminal with background jobs, the web, a plan you watch it tick off, helpers that work alongside it (on any model, or as saved fleets), checkpoints you can rewind, MCP servers, skills and your own tools.
- **A real IDE.** Monaco editor with completions and inline edit, terminals, source control with side-by-side diffs, dockable panels you can split, tab and float.
- **It shows you its work.** Pages open in a built-in browser the agent can look at and click through; pictures, 3D models, PDFs and HTML open as live previews; an accessibility check tells you what would shut people out of a page.
- **Gadgets.** Small apps inside Prism, with a panel and their own backend: monitors, control panels, viewers. Some come with it (releases, deploys, dependencies and safety, your graphics card, profiling, a decisions ledger and more), and the agent builds new ones when you ask.
- **Lessons.** Prism can play a lesson that drives the real interface, with a pointer and a spotlight on each step, step by step, read aloud if you like. Seventeen come with it, and you can record your own by doing the thing.
- **On your phone.** An Android app pairs with your computer and carries on the same conversations, end to end encrypted, with notifications you can answer.
- **Holds you to the mark, if you want.** Vibecoding Safety Biteback, per project, makes the agent insist that what has to come first comes first, and explain why.

## Install

**Windows.** `corepack pnpm dist` builds `dist/Prism-Setup-<version>.exe`, a normal installer. Your settings, conversations and keys live in `%APPDATA%\Prism` and survive upgrades.

**Linux.** Run the same command on Linux (or in WSL) for `dist/Prism-<version>.AppImage` and a `.tar.gz`. Run `corepack pnpm rebuild:pty` first: the terminal library is compiled for Electron there (needs gcc, make and python3).

**The phone app.** `scripts/apk.ps1` builds the Android app (needs a Java 21 in `JAVA_HOME`). Pair it under Settings, Helpers & extras. At home it reaches your computer over your own network; away from home it needs a port opened on your router or a relay you run yourself (`relay/`), which only passes sealed messages along.

## Develop

```powershell
corepack pnpm install
corepack pnpm dev        # development, hot reload
corepack pnpm typecheck
corepack pnpm build      # production bundles into out/
```

Requires Node 22+. If the window never appears and the log mentions `setName`, the shell has `ELECTRON_RUN_AS_NODE=1` set (VS Code terminals do this): clear it first.

The build scripts write to `dist/`. If you keep builds somewhere else, put `$PrismDist` (and `$PrismJavaHome` for the phone app) in `scripts/local.ps1`, which git ignores.

```
src/
  shared/     types and the contract between the window and the main process
  core/       the engine: providers, agent loop, tools, permissions, store, files, git, terminals, MCP
  main/       Electron's main process: windows, services, the agent host, requests from the window
  preload/    the bridge the window talks through
  renderer/   the interface: shell, panels, state, styles, lessons
build/gadgets the gadgets that come with Prism
relay/        the optional relay for the phone app
```

`docs/human/using-prism.md` is the guide to using it, `docs/human/gadgets.md` the guide to gadgets, and `docs/ai/` notes for anyone (or any agent) working on the code, including how Prism keeps to Anthropic's terms.

## Keys

| Keys | Action |
| --- | --- |
| Ctrl P | Go to file |
| Ctrl Shift P | Command palette |
| Ctrl L | Agent panel |
| Ctrl Shift L | New conversation |
| Ctrl ` | Terminal |
| Ctrl K (in the editor) | Edit the selection with the model |
| Ctrl , | Settings |

Every shortcut can be changed under Settings, Keyboard.

## Licence

MIT © Valerie Liu (Valware)
