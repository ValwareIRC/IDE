# Using Prism

## First run

1. **Open a folder.** Click the folder name in the title bar, or press Ctrl+O. The agent only ever works inside this folder.
2. **Connect a provider.** Settings → Providers. Pick a preset (Z.ai, Anthropic, OpenAI, Ollama…), paste the key, and Prism probes it and lists its models. Star the ones you use.
3. **Pick a model in the composer** at the bottom of the Agent panel, or set roles in Settings → Model roles (lead, fast, ghost text, vision).
4. Type what you want. Enter sends. Shift+Enter is a newline.

## Talking to the agent

- `@` followed by a path inserts a file mention with autocomplete. The file's contents reach the model.
- `/` at the start lists commands: `/explain`, `/review`, `/test`, `/commit`, `/init`, `/compact`. Put your own in `.prism/commands/<name>.md`.
- Paste or drop images into the composer. Vision-capable models see them.
- The **plan** under the header is the agent's own task list. It updates as it works.
- **Ask first / Auto-edit / Full auto** control what runs without approval. "Always allow" on an approval card adds a rule you can edit in Settings → Permissions.
- Every tool call is a row you can expand. Edits show a diff with a revert button. Commands stream their output live.
- **Checkpoints** (the history icon) snapshot every file the agent touched in a turn. Restore brings them back.
- **Compact** (the shrink icon) summarises the conversation to free context. Prism also does this automatically when the context fills up.
- Esc stops the agent.
- **Follow** (the eye icon in the agent header) opens files in the editor as the agent edits them and lights up the changed lines. Turn it off if you'd rather keep your own tabs.
- The **agent** tab in the Terminal panel mirrors every command the agent runs, with its output and exit code, live.
- **Rewind** (hover any of your messages) restores every file touched from that message on and removes the later conversation. Your message comes back into the composer so you can rephrase.
- Type while the agent is busy and press Enter to **queue** the message; it goes out the moment the run ends.
- The strip under the session title shows context use, steps, tokens, tokens per second, cost, elapsed time, and a **files** chip listing every file changed this turn with diff and revert buttons.
- Prism notifies you when a run finishes or needs you while the window is in the background.
- The agent can `web_search` and `web_fetch`. If your lead model is text-only, images you attach are described by the model in the Vision role (or any vision-capable model you have) before the lead sees them.
- Images that tools return (a Blender viewport screenshot, a file the agent reads) show up inline in the transcript. Click to enlarge.
- **Several agents at once:** in the Sessions sidebar, the "open in its own panel" icon pins a session to a new panel. The main Agent panel keeps following whichever session you select, so two or three sessions can run side by side on the same project.
- **Fallback model** (Settings → Model roles): when the lead keeps stalling or erroring, the run continues on the fallback model and says so in the transcript.
- The brain icon in the composer toggles reasoning for models that support it.

## Claude, through Claude Code

If Claude Code is installed on this computer and you are signed in to it, Prism can use it directly: no API key, the same login the terminal and the VS Code extension use.

- Open the model list under the message box. Claude's models are at the bottom, under **Claude Agent** (Default, Opus, Fable, Sonnet, Haiku, whatever your plan offers). Pick one and the session becomes a Claude session. You can switch a session back to another model at any time; whichever model answers next is given a written summary of what it missed.
- Everything looks the same as with any other model: replies stream in, each thing Claude does is a row, edits show a diff you can undo, and Rewind works.
- The four modes mean the same thing. **Ask first** shows an approval card for edits and for commands Claude Code does not consider harmless. **Always allow** is remembered by Claude Code, in its own settings, so it also applies in the terminal.
- **Plan first** opens Claude's plan in the plan panel. Approve it and Claude carries on in the same turn, in the mode you choose.
- When Claude asks you something, the question appears as a card with the choices as buttons.
- Claude Code's own commands work when typed: `/compact`, `/context`, and your own skills. They appear in the `/` list while the session is a Claude session.
- Claude uses what Claude Code already knows: its CLAUDE.md files, its memory, its MCP servers. It can also build and drive Prism's gadgets, run the project checks into the Problems panel, and show you files.
- **Settings → Claude Agent** shows whether Claude Code was found, which plan you are on and which models it offers. "Check again" asks Claude Code afresh (no message is sent). If you keep Claude Code somewhere unusual, put its location there.
- On a Claude plan the session cost stays at zero; usage counts against your plan's limits instead. Prism tells you once when you are close to a limit and when it resets.

**How big a conversation is** shows beside its title (for example 480k). Every step the model takes sends the whole conversation, so a big one uses your plan or credit fast, even with caching. Past 200k (Settings, Agent, *Warn when a conversation gets big*; 0 turns it off) a note above the message box offers *Summarise it* or *New session*. Models with a 1M window only summarise themselves near 1M, so keep an eye on this with those.

**Carry on a Claude Code conversation** (Agent menu): a list of the conversations you had with Claude Code in a terminal or in VS Code, newest first, with a filter. Pick one and it comes into the open project with everything that was said and done, and Claude carries on exactly where it stopped, remembering all of it (it resumes Claude Code's own record, not a summary). Close the conversation in the other place first, or the two copies go their own ways. Long conversations come in fine; very long tool results are shortened in Prism's copy (Claude still has them in full), and pictures from tool results are not copied.

Tool servers you set up under Settings → MCP servers are offered to Claude sessions too, not only to Prism's own models. Prism hands them over as the session starts, so nothing is written to Claude Code's config and nothing can overwrite it; a server already set up in Claude Code itself is left alone rather than appearing twice. Add one in Settings and it reaches your next message.

**Effort** sits next to the model when a Claude model offers a choice (Opus, Sonnet, Fable and Default do; Haiku does not, so the picker is not shown). It decides how much thinking Claude puts into each message: *Claude decides* leaves it to the model, or pick low, medium, high, very high or the most. Higher is slower and costs more of your plan. The choice belongs to the conversation, so different conversations can work at different depths.

Not available in a Claude session: removing single results in the "What the model is holding" panel (Claude Code keeps its own copy of the conversation; use `/compact`), and asking Claude Agent for a second opinion or putting it in a comparison (those need a provider with a key).

If you ever share Prism with someone else: this feature uses whatever Claude Code is on their computer with their own login. Anthropic does not allow an app to hand out one person's Claude login to others.

## What you're looking at goes with your message

When you have a file open in the editor, the message box shows a strip just above it: **Going with your message:** and a chip naming the file. Select some code and the chip says which lines. Then "fix this" means something.

- With code selected, those exact lines travel with your message.
- With nothing selected, only the file's **name** goes — not what's in it. The agent reads the file itself if it needs to.
- The **×** takes it off this message. It stays off until you select something else.
- Clicking the chip shows you that file, at that line, so you can check what it means.
- Close the tab and the chip goes with it. It can never offer you a file you no longer have open.
- A very long selection is shortened, and the agent is told to read the file for the rest.

Settings → Agent → **Send what I'm looking at** controls it: selected code and file name (the default), only selected code, or nothing.

## Prism on your phone (Android)

`Prism-phone-<version>.apk` in `dist` is the phone app: the whole of Prism, working on your computer. It is an ordinary sideloaded app, so Android will ask you to allow installing it.

On the computer, **Settings → Helpers & extras → Prism phone app**. Switch it on, then **Pair a phone**: it shows a QR code, a short code, and the addresses your phone can reach this computer at. The code is good for ten minutes and for one phone.

On the phone, open Prism and either scan the code or tap **Type it in instead** and enter the code and the address. After that it reconnects by itself; the computer remembers the phone under **Settings**, where you can forget it again.

- **At home** it reaches the computer over your network. Nothing leaves it.
- **Away from home** it needs either the router opening (**Open a port on my router**, which needs UPnP switched on in the router) or a relay you run yourself. A relay only passes sealed messages along and cannot read them.
- Everything between phone and computer is encrypted end to end, and only a paired phone can connect.
- Things that need the computer's own screen — file dialogs, opening something on the desktop, the Browser panel, gadgets — say so rather than pretending.

### Reaching your computer from anywhere

At home the phone finds your computer on your own network. Away from it, you need one of two things.

**A relay.** A small program on a machine that is always reachable; your computer keeps a connection to it and
your phone connects to the same place. The relay only passes sealed messages along — it cannot read them, keeps
nothing, and logs nothing but "a computer arrived". `relay/` in this repo is one, with a README. Put its
address in **Settings → Helpers & extras → Prism phone app → Relay**, and it travels in the pairing code, so
the phone picks it up by itself.

**Or your router.** **Open a port on my router** asks the router to let the phone in directly, with no relay at
all. It needs UPnP (or NAT-PMP) switched on in the router, and some internet providers share one address
between customers, which no router setting gets around. Prism says which it is.

The phone always tries your own network first, then the router opening, then the relay — so at home nothing
leaves the house.

## Editor extras

- Hover a warning or error and open the lightbulb: **Fix with Prism** sends the problem, with surrounding code, to the agent.
- Right-click a selection: **Ask Prism about this** or **Explain this with Prism**.
- Search (Ctrl+Shift+F) has a replace mode: the arrows icon reveals the replacement field, with "All" for every file or the per-file button. Regex mode supports `$1` groups.
- The **to agent** button in a terminal tab hands the last screen of output to the agent.
- Drag a file from the explorer into the composer to mention it.

## Editing

The editor is Monaco. **Inline chat** (Ctrl+I or Ctrl+K): select some code (or put the cursor on an empty line to write new code), describe the change, and the result appears as a diff under the prompt. Nothing in the file changes yet. Type again to refine it ("shorter", "handle null"); "undo last" steps back a version. Enter on an empty prompt, or **Accept**, puts it in the file; Esc discards it; Ctrl+Z undoes an accepted change. Ghost-text completions appear when a model is set in the Ghost text role; Tab accepts. Right-click → "Ask Prism about this selection" drops the code into the composer.

### Changing things across the whole project

- **Rename everywhere** (F2 with the cursor on a name, or right-click). Type the new name and Prism shows every file that would change, line by line. Accept or reject each piece, then **Apply**. Nothing is written before that, and **Undo** on the finished panel puts everything back.
- **Find everywhere this is used** (Shift+F12, or right-click). The **Uses** panel lists each place, grouped by file; click one to go there. The Rename button on that panel renames what you looked up.
- **Renaming or moving a file** in the explorer: if other files import it, Prism shows the import lines it would rewrite first. Apply moves the file and updates them together.
- In JavaScript and TypeScript these go **by meaning**: a different thing that happens to have the same name is left alone, and imports are followed. In other languages they match the **whole word as text**; the panel says so, and you reject the pieces that are something else.
- The agent has the same abilities (`rename_symbol`, `find_references`, and moving a file fixes its imports). In Ask first mode its rename arrives as a change set for you to review.
- Unsaved files are saved first, because the project is read from disk.

### Getting around a file

- The bar above the editor shows where you are: folder › file › class › function. Click a name to jump there.
- **Outline** (Ctrl+Shift+U, the tree icon in the left rail) lists the functions, classes and headings of the current file and follows your cursor.
- One click on a file in the explorer *looks* at it: the tab title is italic and the next look reuses the same tab. Double-click the file or the tab, or start typing, to keep it.
- Right-click a tab: **Pin tab** keeps it first and safe from "close others"; **Open a second view beside** (Ctrl+) shows the same file twice, edits appear in both.
- In a markdown file, the book icon in the bar opens the rendered page beside the source. It updates as you type and scrolls with the editor; double-click a paragraph in the page to jump to it in the source.
- **Zen mode** (Ctrl+Alt+Z, or View → Zen mode) hides the side bars and gives the panel you are in the whole window.

## Finding, speaking, branching (0.18)

**Finding things**
- **Ctrl+F in a conversation** finds words or "a phrase". Narrow it to your messages, answers, steps, thinking, or checks and news, or to errors only. Enter goes to the next match and opens the step it is in.
- **Search conversations** (Agent menu, Ctrl+Alt+F) searches every conversation in the project, filtered by where, errors only, which file it changed, when, how it ended (proven or not) and model. Click a result to open that conversation at that point.
- Right-click in the editor, **Conversations that changed this file**.
- The editor shows a thin bar beside the lines the agent wrote, one colour per conversation. Hover a line for which request wrote it and why; click the bar to open that conversation at that request. (View menu or Settings, Editor, to turn it off.)

**Speaking instead of typing**
The microphone in the message box (Ctrl+Alt+V). Settings, Conversation, Voice input chooses how speech becomes text: Whisper inside Prism (downloads once, then offline), a provider's speech-to-text, or Windows dictation.

**Branching and side chats**
- Right-click one of your messages, **Branch from here**: a new session with everything before it, and that message ready to change. On an answer: a new session that carries on from it. The original stays as it is.
- `/side` or `/btw` followed by a question: a side chat opens beside the conversation with all of it, answers there, and **Bring it back** puts its answer in the conversation's message box.
- Type `@` and part of a conversation's name to point at an earlier conversation: what was said there comes with your message.
- Queued messages: click one to change it, the arrow sends it earlier. Right-click a conversation, **Pin to the top**.

**Debugging and reviewing**
- `/debug` (or Agent, Debug a problem): the agent guesses at causes, adds temporary logging marked "prism-debug", asks you to make the problem happen (a card with Done), reads what was logged, fixes the cause, then removes every marked line.
- **Pull requests** (Agent menu): review the current branch before pushing, or a GitHub pull request; Review or Security review. Each finding: Fix in Prism, Post to GitHub (needs a token, kept encrypted), or Not a problem (kept in .prism/review-rules.md, so later reviews learn).
- **Split…** in Source control: your uncommitted changes, down to single hunks, grouped into a few commits with messages, in an order where none needs a later one. Edit messages, move pieces, then make them. Your files stay as they are.
- **Which is best?** in Tried several ways: the Review model compares the attempts and says which to keep.

**Approvals and the page**
- Settings, Permissions, **Let a quick checker approve the obvious ones**: before you are asked, a quick model looks at the action; plainly safe and part of your request goes ahead (the step says why), anything else comes to you with its concern. Risky actions always come to you.
- In the Browser panel, the pen **marks up the page**: click several things to number them, write what should change for each, try styles live, then Send to the agent with a picture of the numbered page.

**From elsewhere**
- Settings, Helpers & extras, **Control from your phone**: a page on your home network. Pair a phone with the code (or the QR code); it lists your sessions, approves, answers, sends messages or steers, and stops runs.
- Automations, **Triggers**: a web address on this computer that starts an automation (whatever is sent comes with it), or GitHub events (a pull request opened, @prism in a comment, a failed CI run), checked every 3 minutes with your GitHub token.
- Model roles, routing: **Otherwise, by how hard it looks**: on Auto, easy requests go to the Fast model and hard ones to the Strong model.

## How the conversation is laid out

Settings, Conversation (or View, Conversation) chooses how each request shows its work:
- **Margin rail** (the default): the answer on the left; beside each paragraph, in a narrow margin, the steps that back it up (the files it changed beside the sentence that names them, the test run beside "tests pass"). In a narrow panel the margin shrinks to icons. Hover a paragraph to light up its steps; click a step to open it under the paragraph.
- **Step strip**: each request is one card, its steps as chips along the top and the answer underneath.
- **Folded**: you watch the steps while it works; when it finishes they fold into one line ("Worked 19s · read 2 files · changed 2 files +73 −0 · ran 1") above the answer.
- **Tidy list**: every step in order, all in the same plain style, then the answer.
- **Answer only**: just the answer; "Show the steps" opens them.
- **Classic**: every step as it happened, each in its own style.

Opening a step shows what it did (the change, the file, the command's output), the agent's thinking just before it, and a **why?** button.

The switches under the layouts:
- **Spacing**: Compact, Comfortable or Roomy.
- **Times on messages**: when you sent each message and when each answer arrived, with how long the request took ("15:00 · took 1m 8s"). Hover a time for the full date.
- **The agent's thinking**: under every step, only when you open a step, or never. While it works, its thinking follows the newest words.
- **Linked words**: file names, commands and "tests pass" in an answer are underlined; hover to see the step behind them, click to open it.
- **What needs you goes under the answer**: guesses to check ("That's wrong"), the proof, and the reviewer's opinion, gathered under the answer instead of among the steps.
- **Don't repeat in the answer**: the agent is asked not to paste code it just changed or list its guesses again.
- **Work pane** (View, Conversation, Work pane): every step of one request, opened, in a panel of its own. Click a request in the conversation to show it there; the arrows go to the one before or after.

The conversation follows the newest work while you are at the bottom. Scroll up and it stays where you are; **Latest** takes you back and follows again. Opening a step never moves the view.

## Working with the agent, 0.16

**While it works**
- **Tell it something mid-run.** Type while the agent is working and press Enter: it reads your message before its next step, without being stopped. (Queue keeps a message for when it has finished.) Your message shows in the conversation, marked "sent while it was working".
- **It notices when it is going round in circles.** Making the same failing call again and again, or getting the same error back, earns it a nudge to step back. If it carries on and you have picked a **Strong** model (Settings, Model roles), that model takes over the rest of the request; otherwise Prism stops it and says why.
- **Budgets.** The wallet button in the session header sets the most one request may cost or take. The agent is told, gets a warning near the end, and is paused when it runs out.
- **Assumptions you can correct.** When the agent guesses instead of asking, it writes the guess down; each shows as a yellow card with **That's wrong**. Your correction reaches it at once, even mid-run.
- **Why did it do that?** Hover any step and press **why?**: a quick model explains what the agent was after.
- **What does this do?** On an approval card, this gives a plain-English account of the action, what it could change, whether it can be undone, and its risk.

**Proof and review**
- **Done when.** Before finishing, the agent says which commands prove its work (the tests, a type check, a small script). When it says it is done, Prism runs them: a green "Proven" card when they pass; if one fails it is sent back to fix the cause, up to the "Fix-ups after a failing check" limit.
- **Review every turn** (Settings, Helpers & extras): after a turn changes code, the Review model (or the Fast one) reads the change and lists real problems, or says it looks right.
- **Pair mode** (same place): when you save a file, a quick model glances at your change and, only if it sees a likely bug, says so in the status bar. Click it to hand it to the agent.

**Before you send**
- **Sharpen** (the wand under the message box) rewrites your request so it says exactly what to do, where, and how to tell it is done. Use it or keep yours.
- **What it will cost.** Next to Send, an estimate for the request, from how much the conversation holds, how many steps requests in this session usually take, and the model's prices.
- **Try it several ways** (the split button): the same request run at once by two to four models, Claude Agent's included (each with its own extra instruction if you like), each in its own copy of the project. The **Tried several ways** panel shows them side by side: what each changed, whether its checks passed, what it cost, what it said. **Use this one** brings that one into your project and throws the others away. Needs a git project with at least one commit.
- **Recipes.** Right-click any of your messages and **Save as a recipe**; pick it later from Ctrl+Shift+P. Write {{blanks}} where something changes each time: the first is selected for you to type over, and Tab moves to the next. Manage them under Settings, Helpers & extras.

**Everything at once**
- **Mission control** (View menu): every session in the project, what each is doing this moment, what it waits on, what it cost; answer approvals and stop sessions right there.
- **Task board** (View menu): write down jobs, choose how many run at a time, press Run, and go to bed. Each task gets its own session (and, if you tick it, its own copy of the project), runs in Full auto by default because nobody is there to approve, proves its work where it can, and ends with a report. The top of the board sums it up: done, proven, did not finish, files changed. Bring a copy's work in with one button.
- **Quick question** (Ctrl+Shift+A): ask about the code in an overlay. A read-only agent looks and answers; no session is created. **Continue in a session** carries it over when you want to act on it.

**Talking to Prism**
- The agent can change Prism's own settings and open panels for you ("turn on word wrap and open the task board"). It cannot touch permissions, providers, keys, model roles, MCP servers or shortcuts.
- In Ctrl+Shift+P, anything that is not a command name ("turn off the minimap") offers **Ask Prism to do this**.
- **/undo** followed by what to take back ("/undo the part where it renamed the API") makes the agent find just those edits in this session's history and put them back, keeping everything else.
- Diagrams: when a flow or structure is easier to see than to read, the agent draws a diagram right in the conversation.

## Settings worth knowing

Everything below is in **Settings** (Ctrl+,).

- **Agent:** how long one command may run, how often a failed model call is tried again, how many times it fixes a failing end-of-turn check, the largest team, whether new sessions name themselves, whether Enter or Ctrl+Enter sends, and the wake-ups in a row.
- **Helpers & extras:** each thing Prism does around the agent on its own, with an off switch: learning from your corrections, spec checks, before and after page pictures, the "While you were away" summary (and after how many minutes away), the agent map in the explorer, desktop notifications, reviewing every turn, pair mode, and your recipes.
- **Model roles** has two more: **Strong** (takes over when the agent is stuck) and **Review** (reviews each turn).
- **Editor & terminal:** font size, line height, joined symbols, tabs or spaces, word wrap, showing spaces, line numbers (or counted from the cursor), the minimap, keeping the current function in view, coloured brackets, the cursor, smooth scrolling, saving by itself (when you stop typing, or when you leave the editor), tidying on save, ghost text, and offering the same change elsewhere. The terminal has its own font (or the theme's code font), size, line height, scroll-back length, cursor shape and blink, copy when you select, and whether terminals follow a project switch.
- **Files:** folders Prism skips everywhere (node_modules, build output and so on): not searched, not listed for the agent, not watched. They still show in the explorer, greyed out. Add or remove any; *Start over* brings back the usual list.

**Fonts.** Besides the fonts on your computer, Prism comes with Inter, Nunito, Space Grotesk, JetBrains Mono and **Fixedsys Excelsior** (the old Windows system font, redrawn). Fixedsys is a pixel font and looks sharpest at size 16 (or 32); choosing it for the terminal sets 16 for you.

## Where to find things

Some panels open by themselves when they have something to show; all of them can be opened from the menus too.

- **View menu:** the project dashboard, the Browser, the Scratchpad, Problems, History (the commit graph), the **project spec** (SPEC.md), **Tours** (guided walks through the code), **While you were away** (what the agents did in the last hour), Usage and cost, and Settings.
- **Agent menu:** new sessions, Automations, Compare models, What the model is holding, **Time machine** (step through what this session did), **What could break** (the effect of the latest changes on the rest of the code), and Review this turn's changes.
- The project dashboard also has buttons for the spec, tours, the scratchpad and the browser. Ctrl+Shift+P finds anything by name.

## Working in the background

The agent does not have to sit and wait for slow things. It can start them, end its turn, and be woken when there is news. When that happens a card appears in the conversation saying what came in (a command finished, a timer went off, a helper reported back, another session replied), and the agent carries on from there. If Prism is not in front, you also get a desktop notification.

- **Long commands.** A build, a test run, a deploy or a server runs in the background. When it finishes, the agent is told how it went (the exit code and the last lines) and acts on it.
- **Watching a command.** The agent can ask to be told when a particular line appears in a running command's output: an error in a dev server's log, "compiled successfully", a test failing.
- **Timers.** "Check the deploy again in 10 minutes", "look at CI at 14:30", "every morning at 9, summarise new issues". Timers survive closing Prism; one that came due while Prism was closed goes off when it next starts.
- **Helpers that work alongside.** The agent can start helpers and keep going while they work; each one's report arrives when it is done. It can send a working helper a message to steer it, pick a finished helper back up with everything it already knew, or stop it.
- **Helpers in their own copy.** A helper can work in a separate copy of the project, so its edits cannot collide with the agent's or another helper's. Its changes come into your project only when the agent brings them in, and they can be undone like any edit.
- **Teams.** For bigger jobs the agent can run helpers in stages: for example three reviewers at once, then checkers who go over their findings, then someone to write it up.
- **Sessions talking to each other.** A session can send a message to another session in the same project (to hand over work or ask what it found). The other session picks it up, and its answer comes back.

**The "Waiting on" bar** above the message box lists everything a session is waiting for: commands still running, helpers still working, timers with when they go off. The × next to each one stops or cancels it.

**It does not run away with itself.** After 10 wake-ups in a row without you writing anything, the agent stops and waits for you; the news is still written into the conversation. Change the number under **Settings → Agent → Wake-ups in a row** (0 means it is never woken). Wake-ups follow the session's permission mode, so in *Ask first* anything it wants to do still asks you. A session in a project that is not open is not woken; its news waits in the conversation.

## What the agent remembers

Besides the project notes in PRISM.md, the agent keeps memories between sessions: one small note each, with a name and a one-line description. Some are about you and apply in every project (how you like to work, corrections you gave it and why); others are about one project (decisions, where things are, gotchas). Every new session sees the list and reads a memory in full when it matters. It saves them itself, or when you say "remember…", and fixes or forgets ones that turn out to be wrong.

**Settings → Agent** lists everything it remembers, and a click shows a memory in full. The bin deletes one. Project memories are files in `.prism/memory` in the project, so you can read, edit or commit them like anything else.

## PDFs and notebooks

The agent can read PDFs (it gets the text, page by page, and can ask for particular pages of a long one) and Jupyter notebooks (cells, numbered, with their outputs, including pictures when its model can see). It changes a notebook one cell at a time (replace, add before or after, delete), keeping the rest of the file exactly as Jupyter wrote it; a changed code cell loses its old output, since that no longer matches.

## A session in its own copy

For work you want kept away from your files until it is finished. In the Sessions side view, the branch icon next to **+** (or Agent → New session in its own copy) starts a session that works on its own branch in a separate folder. Your project's files do not change while it works, so you can keep editing, or run several such sessions at once.

The agent panel shows a strip for these sessions:

- **See changes**: everything the copy changed compared with where it started, file by file.
- **Bring into my project**: merges the copy's work into the branch your project is on. If you and the copy changed the same lines, the files appear under Source control → Conflicts to settle.
- **Bin**: deletes the copy and its branch. The session then works in your project folder like any other.

It needs a git repository with at least one commit. The copy starts from your last commit, so uncommitted changes are not in it, and things that are not committed (installed packages, build output) may need installing there; Prism tells the agent this.

## Git

The **Source control** side view (Ctrl+Shift+G):

- **Branch pill** at the top: click to switch branch or make a new one. The **Branches** list below takes a double-click to switch and a right-click to merge or delete.
- **Arrows**: down gets the latest from the server (the number is how many commits are waiting), up sends yours, the circular arrows check the server, the clock opens History.
- **Set aside** (the box icon next to Changes) parks your uncommitted changes with an optional note; they appear in a "Set aside" list where you can bring them back or throw them away. (Git calls this a stash.)
- **Conflicts**: when a merge stops because both sides changed the same lines, the files are listed in red. Click one to open the resolver: for each place, **Keep this** (yours), **Keep this** (theirs) or **Keep both**, then **Save**. **Settle with Prism** hands them to the agent. **Abandon** in the amber banner cancels the whole merge.

**History** (View → History, or the clock): every branch as a graph. Click a commit for its changed files; click a file for its before/after. *Branch from here* starts a branch at that commit; *Explain* asks Prism what the commit did.

**Who changed this line**: the person icon in the bar above the editor shows, in front of each line, who last changed it, when, and the commit message. Hover for the full details.

## Automations

Agent → Automations… opens the panel. Everything here belongs to the project and is kept in `.prism/automations.json`.

- **Hooks** run a command around Prism's work:
  - *After Prism edits a file*: format or lint it. `{file}` in the command is the file.
  - *When a turn ends* (only if the turn changed files): run the tests. With "send the output back" on, a failure goes straight back to Prism to fix, at most twice in a row.
  - *Before Prism uses a tool*: a command that fails stops the tool, and what it printed is the reason Prism is given. `{tool}` is the tool's name; the call is passed as JSON on standard input.
  - *After Prism uses a tool*: for logging and the like.
- **Watchers** send Prism a message when files *you* change match a pattern (Prism's own edits never trigger them). Each watcher has its own session and its own permission mode.
- **Schedules** send Prism a message every so often (`30m`, `2h`, `daily 09:00`) while Prism is open.
- **Running in the background** lists commands Prism left running (dev servers and the like), with a stop button.
- **What happened** is the log of every hook, watcher and schedule run, with its output.

Watchers and schedules run with the mode you give them. *Plan first* and *Ask first* are safe to leave unattended; *Full auto* means it acts by itself.

## More than one model

- **Second opinion.** Under any answer, click *second opinion* and pick another model. It reads the conversation (including what the tools returned) and reviews that answer. The review appears as a violet card; **Send to Prism** hands it to the agent to act on. The agent does not see the review unless you send it.
- **Compare models** (Agent → Compare models…). Choose up to six models, ask one question, and the answers stream in side by side with time and cost. "include …" sends the current conversation along. **Continue with this one** adds that question and answer to the conversation and switches the session to that model.
- **Routing** (Settings → Model roles → Routing). Rules such as "when the message has a picture use X", "when it is short use the fast model", "when it mentions *architecture, design* use the big one". Turn it on, then pick **Auto** in the model list under the message box: the first rule that fits chooses the model for each message; if none fits, the lead model answers.

## What the model is holding

Click the context percentage (in the agent panel's strip or at the bottom right), or Agent → What the model is holding. The **Context** panel shows how the model's room is shared out for the current session and gives you the levers:

- **The bar and its legend**: standing instructions, tool descriptions, project notes, pinned files, session instructions, the summary of older turns, the conversation, and tool results. Hover a legend entry to see what it is.
- **Biggest things in the conversation**: the items taking the most room. The bin on a tool result takes it out of the conversation (Prism can run the tool again if it needs it).
- **Pinned files**: files sent in full, always current, on every turn of this session. Pin by typing a name, with "open file", or by right-clicking a file or a tab → *Pin for the agent*.
- **Instructions for this session**: extra rules for this conversation only.
- **Project notes**: `PRISM.md`, read at the start of every session. Type in "Remember…" to add a line, or just tell Prism "remember that…".
- **Compact** replaces the older turns with a summary when room runs low (it also happens by itself).

## Plan first

Pick **Plan first** in the mode menu under the message box (or Agent → Permission mode). In this mode Prism can only read and search. It investigates, asks you about real decisions, and then shows a **plan**: the goal, what it found, the files it will touch, the steps, and how it will check the result.

In the plan panel you can:

- **Edit** the plan directly (the Read / Edit switch at the top),
- **Ask for changes**: type what should be different and Prism revises the plan and shows it again,
- **Approve and start**: choose how freely the work may run (Ask first, Edit freely, Full auto) and Prism carries out the plan as the next turn,
- **Discard** it.

Approved plans are kept in the project under `.prism/plans/`.

## Reviewing changes

There are two ways to keep control of what gets written.

**Before it is written.** Ask Prism to "show me the changes first" (in *Ask first* mode it does this by itself for changes that span several files). A **Review** panel opens with every file and every piece of the change. Click *accepted* on a piece to reject it, or on a file's chip to reject the whole file; type a note if you want Prism to do something differently; then **Write all** / **Write N of M**, or **Reject all**. Only what you accepted is written, in one go, and Prism is told exactly what you turned down and why.

**After it is written.** When a turn has changed files, the "N files" chip in the agent panel opens the list; **Review changes** shows them piece by piece with **Undo this**, **Undo file** and **Undo everything**. (Agent → Review this turn's changes does the same.) Rewind still exists for undoing a whole turn including the conversation.

## Problems

**Problems** (Ctrl+Shift+M, or the two counters at the bottom left) lists everything known to be wrong in the project:

- what the editor underlines in open files, and
- what the project's own checks report. Prism finds them from the project's files (TypeScript, ESLint, tests, Cargo, Go, Ruff, mypy, pytest, CMake) and shows each as a button; press it to run that check. **Check all** runs the type and lint checks; tests run from their own button.

Click a problem to jump to it. The wrench on a row hands that one problem to the agent; **Fix all with Prism** hands over the whole list. The scroll icon on a check shows what it printed. "check on change" re-runs the checks that already ran, shortly after files change.

Your own checks go in `.prism/checks.json`:

```json
[{ "label": "Shader lint", "command": "glslangValidator shaders/*.frag" }]
```

The agent has the same checks as a tool, so it verifies its own work the way the project does, and what it finds shows up in this panel too.

## Previews

Images, 3D models, HTML, markdown and PDFs open as previews. The agent can call `show` to open one for you. Previews reload when the file changes on disk.

## Folders that are not on this computer (WSL and SSH)

**File → Open a remote folder (WSL or SSH)…** (also in the folder menu in the title bar). The title bar then shows where the project is, for example "WSL: Ubuntu" or "SSH: me@server".

**WSL (Linux on this computer).** Pick your Linux system, then choose the folder. Files are read straight out of WSL, and everything that runs a command runs *inside* WSL: git, the terminal (it opens as a Linux shell in the project folder), the project's checks, hooks, and the agent's commands. Everything else in Prism works as usual. Changes made from inside WSL are noticed within a few seconds rather than instantly.

**SSH (another computer).** Type the computer (`me@server`, or a name from your SSH config; add `:2222` for another port) and the folder there. Prism signs in the way `ssh` does in a terminal, with your SSH key. It cannot type a password: if `ssh me@server` works in a terminal without asking for one, it works here.
- Works on that computer: the explorer, opening and saving files, search, git, the terminal, the agent (reading, editing, running commands), undo and rewind, previews of pictures and pages.
- Not there yet for SSH folders: the scratchpad, gadgets saved in the project, rename-everywhere and import fixing, project checks in the Problems panel, a session in its own copy, and Claude Agent (Claude Code runs on this computer). Each of these says so when you try it.
- Every action is a small round trip to the other computer, so things take a moment longer than on your own disk. Changes made there by something other than Prism show up when you refresh the explorer.
- Search uses ripgrep on the other computer if it is installed, and plain grep otherwise.

## The project dashboard

**View → Project dashboard** is the project's home page (a brand-new layout starts on it).

- **Recent sessions**: click one to carry on with it.
- **Changed files**: what is different from the last commit; click to open a file.
- **Checks and tests**: the project's type checker, linter and tests, each with its last result and a button to run it.
- **Notes left in the code**: every TODO, FIXME and HACK, with a button to hand the list to the agent.
- **Dependencies**: how many packages the project uses; *Look for newer versions* asks the package registry which ones have updates (a few seconds, needs the internet).
- **The repository**: commits, people, files, lines of code and the languages they are in.
- **Use over two weeks**: what this project's sessions used each day, as cost or as tokens.

## The scratchpad (trying code)

**View → Scratchpad** is a notebook for trying things against your project without making files for them.

- Each **cell** is a few lines of JavaScript, TypeScript or Python (pick with the buttons at the top of the cell). Ctrl+Enter runs it; Shift+Enter runs it and moves to the next cell.
- Cells **remember**: what one cell defines (a variable, a function, an import) is there for the cells you run after it. *Start afresh* forgets everything and stops whatever is running.
- It runs **against the project**: `import { add } from './src/calc.js'` finds your file, and a file you have changed is read again the next time you import it. Python uses the project's own `.venv` when there is one.
- The **last line's value** is shown under the cell: a list of records becomes a table, other data is shown as formatted text, a picture is shown as a picture. Anything printed appears as it happens, and errors show the line of the cell they happened on.
- For more: `show.table(rows)`, `show.image(fileOrBytes)`, `show.html(text)` in JavaScript; in Python, charts drawn with matplotlib and tables from pandas appear by themselves.
- The paper-plane button hands a cell and its result to the agent. The agent can also run snippets itself (`run_snippet`), in a session of its own that does not disturb yours.
- The notebook is saved in the project as `.prism/scratch.json`. Results are not saved.

## The browser (seeing your page)

**View → Browser** opens a real web page inside Prism, next to your code.

- **Getting a page into it.** Type an address (`localhost:5173`), or the name of an HTML file in the project (`index.html`; right-click an HTML file in the explorer → *Open in the browser* does the same). **Start server** runs your project's dev script (`npm run dev` or whichever the project uses) in a terminal called "dev server" and opens the address it prints; **Stop server** ends it. **Serve this folder** is for plain HTML projects with no dev server.
- **It reloads for you** when a file changes, for pages Prism serves itself. Dev servers refresh their own pages, so it stays off for those; the circular-arrows button switches it either way.
- **Pick something** (the pointer button): move over the page, click a part of it, and that element goes into the message box: what it is, its HTML, its main styles and a picture of it. Then say what you want changed. Esc cancels.
- **Show the agent** (the camera) puts a picture of the whole page in the message box.
- **Console** (the terminal-shaped button, with a red count when there are errors) lists what the page printed. *Fix with Prism* hands the warnings and errors to the agent.
- The bug button opens the page's developer tools; the last button opens the page in your usual browser.
- **The agent can use it too**: it can open a page, look at a picture of it with its console errors, and click or read things in it. So after changing a web page it can check the result instead of guessing. A model that cannot see pictures gets the page described by your Vision model.
- The page stays as it is when you switch to another tab and back.

## Themes

**Settings → Appearance** is where Prism's look lives. (Ctrl+P and typing "theme" also lists every theme by name.)

- **Pick one.** There are 54 themes, in five groups:
  - *Prism, dark* and *Prism, light*: the original Aurora to Synthwave, Phosphor (an old green screen), Graphite, High contrast, Cream and Sakura.
  - *VS Code and GitHub*: Dark Modern, Dark+, Light Modern, GitHub Dark, Dark Dimmed and Light, with their exact colours, flat like the real thing.
  - *Editor favourites*: One Dark, Monokai, Solarized (dark and light), Tokyo Night, Catppuccin (Mocha and Latte), Gruvbox, Night Owl, Rosé Pine (and Dawn), Ayu Light and Kanagawa.
  - *Like the AI apps*: Clay and Clay night (like Claude), Charcoal (ChatGPT), Caret (Cursor), Indigo (Linear), Pitch (Vercel), Twilight (Gemini), Lagoon (Perplexity) and Spotlight (Raycast).

  One click applies a theme everywhere: the panels, the code editor, the terminal, code in the conversation, and your gadgets. The new theme spreads across the window from where you clicked.
- **Ask for one.** Tell the agent what you want ("make Prism look like a sunset over the sea", "switch to Tokyo Night", "a bit rounder and less glowy") and it designs the theme and switches to it. It checks that text stays easy to read and says if anything is hard to see. What it makes is saved with your own themes, so you can change it further here.
- **Change anything.** Under "Make it yours", every part of the theme can be changed, and you see it happen as you drag. The first change to a built-in theme makes your own copy ("My Aurora"); the original is never altered.
  - *Quick colours*: dark or light, a background, and two accents. Every other colour is worked out from these three, so start here.
  - *Surfaces and text*, *Accents and signals*, *Code colours*, *Terminal colours*: every single colour, each with a picker and a box for typing a colour code.
  - *Fonts and size*: the interface font and the code font (three come with Prism, and every font installed on your computer is listed), and the size of the whole window.
  - *Shape*: corners from square to very round, how strong borders are, small headings in capitals or plain, and spacing.
  - *Light and background*: glow, how see-through the panels are, the blur behind them, and what sits behind everything: aurora, colour pools, a floor grid, stars, screen lines, nothing, or **a picture of your own**, with sliders for how washed-out and how blurred it is.
- **Keep and share.** Your themes are listed at the top of the page. *Duplicate* starts a new one from the current one, *Start over* returns a copy to how its original looks, *Save as a file* writes the theme (with its picture) to a file, and *Open a theme file* adds one someone gave you. Once you have more than one theme of your own, *Save all as a pack* puts all of them into a single file; opening a pack adds every theme in it.

**Effects.** Themes with glow have a slowly drifting backdrop, lit edges on panels, a glowing underline on the open tab, cards that catch the light under the pointer, and a ring of light that runs round the message box while the agent works. Flat themes (the VS Code and GitHub ones, Graphite) keep none of this. Turning off **Motion** (Settings → Appearance) stops everything that moves, and so does Windows' "Animation effects" setting.

## Seeing what the agent did, and undoing part of it

Prism records every change the agent makes to every file: what it was before, what it is after, which of your messages it was for, and which step made it. Shell commands are included: before the agent runs a command, Prism notes the state of the project, so anything the command changed (a code generator, a migration, an `rm`) can be undone like an ordinary edit.

- **Time machine** (the clock button at the top of the agent panel). Drag the slider through the session step by step. Each step shows your request, what the agent did, a command's output, and the files at that moment; pick a file to see what that step changed, or *Then vs now* to compare it with today. *Go back to here* puts every file the session touched back the way it was right after that step (what is there now is kept as a checkpoint, so that can be undone too).
- **Why is this line here?** Hover any line the agent wrote, in any editor. A card says which request it was for, the agent's reason just before it wrote it, the model and when, with links to the conversation, the time machine, and *Undo that request*. It finds the line by its text, so it still works after the code has moved.
- **Undo just one request.** Under each of your messages, *undo just this* (also in the message's right-click menu, the time machine and the hover card) takes out only what that request changed and keeps everything done since, even in the same files. You see it as a change set first; places where later work touched the same lines are marked for you to settle.

## Before you trust a change

- **The page, before and after.** When the Browser panel shows a page and a turn changes web files (HTML, CSS, scripts, Vue, Svelte…), Prism draws the page before the turn and after it, in a hidden window, and puts both in the conversation. Drag across to compare, see them side by side, or switch on *Mark what changed* to see every changed pixel in pink.
- **What could break.** In *Changed this turn* (the files chip above the conversation) and in the review panel, *What could break* lists every function, class and value that changed or went away, every place in the project that uses them, the files that depend on the changed ones, and the tests that reach the change. *Run the affected tests* runs only those, in a terminal. *Ask the agent to check* sends it the list. The agent has the same check as a tool (check_impact) and uses it on its own.

## The spec

Write what the project should do in plain English in **SPEC.md** (Ctrl+P, "spec", or the Spec button on the project page; *Start a spec* gives you a template). One heading per feature or rule.

- After every turn in which the agent changes code, your quick model compares the changes with the spec's sections. If something no longer matches, the conversation says which section and how, with *Update the spec* (the code is right), *Fix the code* (the spec is right) and *It is fine*.
- When **you** edit the spec, Prism notices and offers *Make the code match*. The agent plans the changes first (in a session called Spec) for you to approve, then makes them; after that the spec counts as matched again.
- The Spec panel shows every section: matching, out of step (with why), or changed by you and not built yet.

## Fleets, and helpers on your other models

**Settings → Fleets** keeps teams of helpers. Each member has a name, a model (GLM, for example), its own instructions ("You are a security reviewer…") and whether it may change files. A fleet can also have one last helper that reads every report and writes a single answer. Ask either agent to "run the reviewers fleet on this" and every member works on it at once.

Claude can use them too: **Settings → Claude Agent → Let Claude start helpers and fleets**. Claude then gets `prism_helper` (one helper on any model from any provider, Claude included) and `fleet_run`. Each helper uses its own model's account: a GLM helper your Z.ai credit, a Claude helper your Claude plan. Its report comes back to whoever asked. Each helper's work shows as a conversation of its own under the one that started it.

## Vibecoding Safety Biteback

**Settings → Agent → Vibecoding Safety Biteback (this project).** For a project where you don't know the ground well yet. The agent stops being an order taker and works like a fair colleague:

- **It insists on what has to come first.** Polishing something that doesn't run yet, adding a feature while a bug is open, hiding a symptom before anyone knows the cause, shipping something nobody has seen work: it says what has to come first and why, as a card with **Do that first** and **Do mine anyway**. Your choice goes into the Decisions ledger.
- **You can still choose your way**, and it's the agent's call how unreasonable that is. Usually it goes ahead without raising it again. If you later complain about the result, it points to the record.
- **It can refuse** to continue in a direction if you're being unreasonable: abuse aimed at it rather than at a result, blaming it for your own overrides, or a direction that keeps reversing so nothing gets finished. It quotes what it's about and says what would let it carry on.
- **It can end the conversation** if a refusal is ignored. It leaves a handover (what's done, what's half done, what it would do next) and the conversation takes no more messages. You can start a new one straight away.
- **Anger at its own mistakes never counts.** That's feedback, and it fixes the mistake.

Every insistence, override, refusal and ending is in the Decisions ledger, so the record is there for both of you.

## Prism learns from your corrections

- **Skills that write themselves.** When you correct the agent about how things are done ("no, we use arrow functions here"), Prism keeps a note. The second time the same habit comes up, it offers to save it as a skill, with the words that should bring it up already chosen. *Keep as a skill* for this project or for all of them, or *Not now*.
- **Rules.** When you forbid something ("never run npm install yourself"), Prism offers to make it a rule. You can also write rules yourself under Settings, **Skills, tools & rules**: type the rule in your own words, Prism shows exactly what it will stop (files or folders, commands), and you save it for this project or all of them. A rule is checked before **every** step the agent takes, whatever the model: a step that breaks one is refused, and if a shell command changes a protected file anyway, Prism puts the file back at once. Rules are also in the agent's instructions, so it does not try in the first place.

## When something used to work

Type **/bisect** and say what broke ("/bisect the total on the invoice page is one pound too high"). The agent writes a small script that checks it, makes sure it fails now, and Prism tests older versions of the project in a separate copy (your files and branch never move) until it finds the commit where it broke. You get the commit, what it changed, and a proposed fix; nothing is changed until you say so.

## Upgrading packages

On the project page, *Look for newer versions* lists what is out of date. Each package has an **Upgrade** button, and *Upgrade the safe ones* does every package that has a newer version without a change of major version, together. The work happens in a copy of the project: the agent reads the release notes between your version and the new one, checks how this project uses what changed, upgrades, fixes what broke, runs the checks and reports per package. Nothing reaches your files until you bring the copy in.

## The same change elsewhere

When you save a file, Prism looks at what you just changed and searches the project for other places that need the same change: the same lines elsewhere (re-indented to fit), the same small change inside a line (an argument added to a call, a renamed field), or, when neither finds anything, the lines that use the same names, judged by your quick model. If it finds any, the status bar shows *The same change in N other places*; click it to review them as one change set.

## Lessons

A lesson plays Prism for you: a pointer glides to each thing and clicks it, the way you would. The screen dims around what the step is about, and its caption sits right beside it, so you read where you look.

- **Step by step** (on unless you turn it off): after each step it waits for **Next**, or the → key.
- **Back** (or ←) goes to the step before; the lesson's files are put back as they were, so nothing is typed twice.
- **Listen along** reads each caption aloud as well, in Prism's voice. The words stay on screen either way.
- Touch anything and it stops where it is; space pauses and carries on, and the speed slider slows the acting down or hurries it up (real work, like a command running, is never hurried).

**Help → Lessons…** (or "Lessons" in the command palette) lists them: the project's own (kept in `.prism/lessons`, so they travel with it), your own (shown in every project), and 17 that come with Prism, each on one thing: finding your way around, the tree, Search, changing and saving a file, the terminal, asking the agent, how freely it works, picking a model, conversations, the keyboard, gadgets, decisions, git, usage, settings, the phone app and making your own lesson. They work in any project: what they open and type into is their own `prism-lesson/` folder, removed when they end, and they never send a message to the agent.

**Record a lesson** by doing it. Press **Record a new lesson** and use Prism as normal; the recording bar counts the steps it has caught:

- **Every click**, wherever it lands: menus and their items, right-click menus, Settings pages and switches, the pickers under the message box, buttons in panels. Clicks go through as normal while recording, so a menu opens and your next click inside it is caught too. When played, the lesson finds each thing again (by its name, its words, its tooltip or the row it sits in) and clicks it; if it cannot find one, it stops there and says what it was looking for.
- What things *do*, where that is clearer than where they were clicked: opening a view in the side bar, folders and files in the tree, typing in Search and opening a result, gadgets, commands typed in the terminal, messages to the agent (it waits for the answer when played).
- Typing into a file is caught when you save. When played, it is typed into the lesson's own copy of the file, never into your work, and only added lines play back.
- **Point at something (F8)**: the next thing you click is lit up when the lesson plays, instead of being pressed. F8 works inside an open menu without closing it; Esc cancels.
- **Point at the selection** lights up what you have selected in the open file, dimming the rest.
- Type a caption in the bar before doing something and it goes with that step; **Caption on its own** adds one to read before the next thing happens. Captions can also be written afterwards, in the editor.

**Stop** opens the lesson editor: give it a title, change any caption, slow a step down or speed it up, move steps, remove them, play from any step, and save it to the project or to your own lessons. **Edit** in the list opens a saved one the same way.

## Tours

Ask *show me how saving works* with **/tour** (or the Tours panel: Ctrl+P, "tours"). The agent follows the real path through the code and saves a tour in the project (`.prism/tours`). *Play* walks you through it: the editor jumps to each line and marks it, and a card in the lower left explains that step, with Back and Next (Alt+← and Alt+→). Steps are found by the text of their line, so a tour keeps working after the code moves.

## The agent's map

The radar button at the top of the explorer turns on the map: each file and folder shows how much the session read it (blue) and changed it (warm), and the file the agent is on right now glows, so you can watch it move through the project. Hover a file for the counts. Pick another session and the map shows where that one went.

## While you were away

When you come back to Prism after ten minutes or more (also after closing it), a small banner says what happened meanwhile: sessions that finished, ones waiting for your answer, ones that stopped with a problem, files changed, automations run. *Catch up* opens a summary, and *Walk me through the changes* steps through every changed file in the order it changed, as it was when you left and as it is now.

## Sessions as files

Agent menu, *Save this session as a file*: one `.prism-session` file with the conversation, its pinned files, instructions and skills, every change it made, and its pictures. *Open a session file* brings it into the open project, on any computer, and offers its file changes as a change set to apply. The time machine and undo by request work on it too. (A Claude Agent session continues from its transcript: Claude Code's own copy of the conversation stays on the computer it came from.)

## Repairs

When one of your own tools fails while the agent uses it, or a gadget's backend fails, Prism starts fixing it in a session called **Repairs**: the agent reads the error and the code and fixes it. A fixed tool waits for your OK (Settings, Skills, tools & rules); a gadget fix asks before it is written. Tools that do not even load have a *Fix it* button there. Turn this off under Settings, Agent, *Repair my tools and gadgets*.

## Teaching Prism: skills, your own tools, MCP servers

Three ways to make the agent better at *your* work. All three are under **Settings**.

### Skills (Settings → Skills & tools)

A skill is a page of instructions: how releases are done here, how tests are written, what a good commit message looks like. The point is that it is **not** in every conversation. It joins when it is needed and stays out of the way otherwise.

- **New skill** asks for a name and where it should work: *This project* (the file goes in the project's `.prism/skills/`, so it travels with the project) or *All my projects*.
- The file opens right there. At the top is a short header:

  ```
  ---
  name: release-notes
  description: How release notes are written in this project
  when: release notes, changelog, version bump
  ---
  ```

  Under it, write the instructions in plain words.
- **`when`** is the important line. If a message you send contains one of those words or phrases, the skill joins the conversation and a line in the conversation says so ("Using the skill …"). It then stays for the rest of that session.
- The agent also sees the names and one-line descriptions of all your skills, and can fetch one itself when it sees the need.
- `always: true` instead of `when` puts a skill in every session.
- The **context panel** (the gauge in the agent panel) has a Skills box: it shows which are in use in this session and how much room each takes, with a cross to drop one and a plus to add one by hand.
- One skill comes with Prism: it teaches the agent how to write skills and tools, so you can just say "make a skill for how we name branches".

Skills work the same in Claude Agent sessions.

### Your own tools (same page)

A tool gives the agent a new ability: look something up in your issue tracker, run your deploy check, count things your way. It is one small TypeScript file.

- **New tool** creates a working example and opens it. The file describes the tool (name, what it does, what it needs to be told) and has a `run` function.
- Inside `run`, everything the tool can do is on the `prism` object: read, write, list and search **this project's files**; run a command; fetch a web address; write a log line. The editor completes these as you type.
- A tool runs shut off from the rest of the computer. It cannot open files outside the project. It can run commands only if its file lists `uses: ['shell']`, and reach the internet only with `uses: ['network']`. The page shows these as labels on each tool, so you can see at a glance what each one is able to do.
- Files a tool writes can be undone by rewinding the conversation, like the agent's own edits.
- **Tools wait for your OK.** A tool you make or save on this page is ready at once. A tool file that arrives any other way (the agent wrote it, it came with a project you downloaded, you edited it in another editor) shows up here marked as waiting, and the agent cannot use it until you press **Look** and then **Allow**. If the file changes later, it waits again. This is deliberate: otherwise the agent could write itself a tool that runs commands without asking.
- If a file has a mistake, the page says what is wrong instead of offering the tool.
- A tool cannot use `import`. It is plain TypeScript plus the `prism` object.

The shut-off is a strong fence, not a safe: treat a tool from someone else the way you would treat their code, and read it before you allow it.

### MCP servers (Settings → MCP servers)

MCP servers are ready-made tool collections other people have written. The page has a list, **Ready to add**: Playwright and Chrome DevTools (drive a real browser), Context7 (current library documentation), Fetch, Files in another folder, Git, Memory, Sequential thinking, Time, SQLite, GitHub and Blender.

- **Add** adds the server and connects it. The first start downloads it, which can take a minute.
- Some ask for something first (a folder, a database file, a GitHub token). A token is kept encrypted, not in the settings file.
- Each needs a small program to start it: Node.js, uv, or Docker. If yours is missing the card says which, with a button that opens its download page. Cards for servers you already have say "Added".
- **Add your own server** is still there for anything not in the list.

## Pictures, sound and 3D models

Opening one of these from the explorer shows it in a viewer made for it.

**Pictures**
- Scroll to zoom (it zooms where the pointer is), drag to move, double-click to switch between fitting the panel and actual size. Zoomed in far, you see the single pixels.
- The strip at the bottom reads the pixel under the pointer: its colour as a code, its red/green/blue/transparency, and where it is. Alt+click copies the colour code.
- **Background**: checks (to see transparency), dark or light.
- **Compare**: with the last commit (what the picture looked like before your changes), or with any other picture in the project. Three ways to look: a line you drag across, side by side, or only what differs (painted pink over a faded copy).

**Sound**
- The waveform shows the whole sound; the part already played is coloured. Click anywhere on it to jump there. Space plays and pauses. There are buttons for repeat, speed and volume.

**3D models** (glb, gltf, obj, fbx, stl, ply)
- Top left: how many parts, triangles and points the model has, and its size.
- **measure**: click two points on the model to get the distance between them.
- **materials**: lists what the model is made of, with colour, roughness, metalness and the pictures each material uses. Click one to see only the parts made of it; click again to see everything.
- **Animations**: if the model has any, a bar appears to play, pause, drag through time, pick the animation and change speed.
- **turntable GIF** saves a GIF of the model turning once around, next to the file.
- **show the agent** puts a picture of the current view into the message box.

## Terminals when you switch project

When you open another project, terminals that are sitting idle in the old one close, and a fresh terminal opens in the new one. A terminal with something still running (a dev server, a build) is left alone; its tab gets the old project's name, so you know where it belongs, and you close it when you are done.

## Layout

Drag tabs to split, tab, float or move them anywhere. The layout is remembered. "Reset window layout" in the command palette restores the default.

## The search box (Ctrl+P)

One box finds everything. What you type first decides what it looks for:

| Start with | Finds | Shortcut that opens it this way |
| --- | --- | --- |
| nothing | Files in the project (open files first) | Ctrl+P |
| `>` | Commands, recently used first | Ctrl+Shift+P |
| `@` | Functions, classes and headings in the current file | Ctrl+Shift+O |
| `:` | A line number (`:42` or `:42:7`) | Ctrl+G |
| `#` | Agent sessions | Ctrl+Shift+J |

You don't have to type exact words: `swmod` finds "Switch model". Ctrl+Alt+M switches the model for the current session.

## Keyboard shortcuts

**Settings → Keyboard** lists every command. Click a shortcut and press the keys you want; the cross removes a shortcut, the arrow puts the original back. If the keys were already used by another command, they move to the new one and Prism tells you which command lost them. F1 shows the current list. Gadgets have their own guide: [gadgets.md](gadgets.md).

## Where things live

- Settings: `%APPDATA%\prism\settings.json`
- Sessions, models, usage ledger: `%APPDATA%\prism\prism.sqlite`
- Gadgets for every project: `%APPDATA%\prism\gadgets\` (project gadgets live in the project's `.prism/gadgets/`)
- File history (what the agent changed, step by step): in `prism.sqlite`, table file_versions
- Rules: the project's `.prism/rules.json`, and `%APPDATA%\prism\rules.json` for every project; tours in `.prism/tours/`; the spec in `SPEC.md`
- Skills and tools for every project: `%APPDATA%\prism\skills\` and `%APPDATA%\prism\tools\` (a project's own live in its `.prism/skills/` and `.prism/tools/`)
- API keys and MCP server tokens: `%APPDATA%\prism\vault.json`, encrypted with Windows DPAPI
