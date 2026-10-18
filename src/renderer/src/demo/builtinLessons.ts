// The lessons that come with Prism: how to use it to do things. Each works in any project:
// what it types into, searches for and opens are its own scratch files in prism-lesson/,
// laid down when it starts and removed when it ends. They never send a message to the
// agent or type into the message box, which may hold a conversation or a draft of yours;
// they show where things are and say what they do.
import type { Demo } from './script'

const DIR = 'prism-lesson'

export const BUILTIN_LESSONS: Array<{ id: string; demo: Demo }> = [
  {
    id: 'around',
    demo: {
      title: 'Finding your way around',
      steps: [
        { do: 'say', say: 'This is a quick tour of where things are in Prism. Touch anything at any time to stop it where it is.' },
        { do: 'rail', view: 'explorer', say: 'The strip of icons on the left opens the **side bar**. This first one is your project’s **files**.' },
        { do: 'rail', view: 'search', say: '**Search** looks through every file in the project at once.' },
        { do: 'rail', view: 'sessions', say: '**Conversations** lists everything you have talked about with the agent in this project.' },
        { do: 'rail', view: 'gadgets', say: '**Gadgets** are small apps that live inside Prism: monitors, control panels, viewers.' },
        { do: 'point', at: 'titlebar:search', say: 'The box at the top jumps to any file by name. Press **Ctrl+P** to get there from anywhere.' },
        { do: 'open', what: 'agent', say: 'The **agent** lives in its own panel. **Ctrl+L** brings it up.' },
        { do: 'point', at: 'agent:input', say: 'This is where you tell it what you want, in your own words.' },
        { do: 'point', at: 'status:usage', say: 'The bar along the bottom shows which model is working, and how much it has used. Click it for the full picture.' },
        { do: 'say', say: 'That is the lay of the land. Help, **Lessons…** has more, each on one thing.' }
      ]
    }
  },
  {
    id: 'tree',
    demo: {
      title: 'Opening a file from the tree',
      stage: [{ path: `${DIR}/notes.md`, content: '# Notes\n\nThis file was made by the lesson, and it goes away when the lesson ends.\n\nThe tree shows every file in your project.\n' }],
      steps: [
        { do: 'rail', view: 'explorer', say: 'The **file tree** shows everything in your project, folder by folder.' },
        { do: 'tree.expand', path: DIR, say: 'A folder opens with one click. This one was made by the lesson.' },
        { do: 'tree.open', path: `${DIR}/notes.md`, say: 'A file opens with a click too. One click only *looks*: the tab is reused by the next file you look at. **Double-click** to keep it open.' },
        { do: 'spotlight', file: `${DIR}/notes.md`, anchor: 'The tree shows every file in your project.', say: 'Now it is open in the editor, ready to read or change.' },
        { do: 'spotlight.off' },
        { do: 'say', say: 'Right-click anything in the tree for more: new file, rename, delete, copy its path.' }
      ]
    }
  },
  {
    id: 'search',
    demo: {
      title: 'Finding anything with Search',
      stage: [
        {
          path: `${DIR}/shop.js`,
          content: `// Made by the lesson; it goes away when the lesson ends.\nconst basket = []\n\nfunction addToBasket(item) {\n  basket.push(item)\n  return basket.length\n}\n\naddToBasket('apples')\n`
        }
      ],
      steps: [
        { do: 'say', say: 'When you know a word but not which file it is in, **Search** finds it.' },
        { do: 'rail', view: 'search', say: 'Search is the magnifying glass on the left.' },
        { do: 'search.type', query: 'addToBasket', say: 'Type what you are looking for. It searches as you type, in every file.' },
        { do: 'search.open', file: `${DIR}/shop.js`, say: 'Each file it was found in is listed, with every line underneath. Clicking a line opens the file right there.' },
        { do: 'spotlight', file: `${DIR}/shop.js`, anchor: 'function addToBasket(item) {', through: '}', select: 'addToBasket', say: 'And there it is.' },
        { do: 'spotlight.off' },
        { do: 'say', say: 'The buttons beside the search box match case, whole words or patterns. The last one opens **Replace**, to change it in every file at once.' }
      ]
    }
  },
  {
    id: 'edit',
    demo: {
      title: 'Changing a file and saving it',
      stage: [{ path: `${DIR}/greeting.js`, content: `// Made by the lesson; it goes away when the lesson ends.\nfunction greet(name) {\n  return 'Hello, ' + name\n}\n` }],
      steps: [
        { do: 'rail', view: 'explorer' },
        { do: 'tree.expand', path: DIR },
        { do: 'tree.open', path: `${DIR}/greeting.js`, say: 'Open the file you want to change.' },
        { do: 'type', file: `${DIR}/greeting.js`, after: '}', text: "\nconsole.log(greet('Sam'))", say: 'Click where you want to write and type. Prism adds the matching brackets and quotes for you.' },
        { do: 'save', file: `${DIR}/greeting.js`, say: '**Ctrl+S** saves. Until then the change is only on screen, and the tab shows a dot.' },
        { do: 'say', say: '**Ctrl+Z** undoes, as many times as you like. When the agent changes files, its changes can be taken back too: each turn of the conversation can be rewound.' }
      ]
    }
  },
  {
    id: 'terminal',
    demo: {
      title: 'Running a command in the terminal',
      steps: [
        { do: 'say', say: 'The **terminal** is where commands run: building, testing, installing.' },
        { do: 'open', what: 'terminal', say: 'It opens at the bottom. **Ctrl+`** brings it up from anywhere.' },
        { do: 'terminal', command: 'echo Hello from your first command', say: 'Type a command and press Enter.' },
        { do: 'await.output', match: 'Hello from your first command', say: 'What it prints appears straight away.' },
        { do: 'say', say: 'The **+** beside the tabs opens another terminal. **To agent** sends what is on screen to the agent, handy when something fails and you want help with it.' }
      ]
    }
  },
  {
    id: 'ask',
    demo: {
      title: 'Asking the agent to do something',
      steps: [
        { do: 'open', what: 'agent', say: 'The agent reads your project, changes files and runs commands, when you ask.' },
        { do: 'point', at: 'agent:input', say: 'Write what you want here. The best requests say **what** to do, **where**, and **how you will know it is done**.' },
        { do: 'say', say: 'For example: *“The Save button in settings does nothing. Make it save, and check by changing the theme and reopening Settings.”*' },
        { do: 'point', at: 'agent:attach', say: 'A picture helps a lot: a screenshot of what is wrong, or a sketch of what you want. You can also paste one straight in.' },
        { do: 'point', at: 'agent:sharpen', say: 'Not sure how to put it? Write it roughly, then press **Sharpen** and it is rewritten to say exactly what to do.' },
        { do: 'say', say: 'Press **Enter** to send. While it works you can keep typing: what you write steers it before its next step. **Esc** stops it.' }
      ]
    }
  },
  {
    id: 'modes',
    demo: {
      title: 'Choosing how freely the agent works',
      steps: [
        { do: 'open', what: 'agent' },
        { do: 'point', at: 'agent:mode', say: 'This decides how much the agent may do without asking you first.' },
        { do: 'say', say: '**Plan first**: it only reads, then shows you a plan to approve. Good for anything big.' },
        { do: 'say', say: '**Ask first**: it asks before every edit and every command. You see everything before it happens.' },
        { do: 'say', say: '**Edit freely**: edits go ahead, commands still ask.' },
        { do: 'say', say: '**Full auto**: everything goes ahead, except what your own rules block. Best when you trust the task and want to walk away.' },
        { do: 'say', say: 'When it asks, you can allow it once, or always for that kind of thing. You can change the mode in the middle of a task.' }
      ]
    }
  },
  {
    id: 'models',
    demo: {
      title: 'Picking a model',
      steps: [
        { do: 'open', what: 'agent' },
        { do: 'point', at: 'agent:model', say: 'This picks the **model** that answers: GLM, Claude, or anything else you have set up.' },
        { do: 'open', what: 'settings', section: 'models', say: 'New providers are added in **Settings, Providers**: paste in a key, and their models appear in the list.' },
        { do: 'point', at: 'settings:claude', say: '**Claude Agent** uses the Claude Code already signed in on this computer, with no key needed.' },
        { do: 'point', at: 'settings:roles', say: '**Model roles** give different jobs to different models: a quick one for titles, one that can see pictures, a stronger one to take over when the work goes round in circles.' }
      ]
    }
  },
  {
    id: 'sessions',
    demo: {
      title: 'Conversations: new ones, old ones, and safe copies',
      steps: [
        { do: 'rail', view: 'sessions', say: 'Every conversation with the agent is kept, per project, newest at the top.' },
        { do: 'point', at: 'sessions:new', say: 'Start a **new conversation** for each new piece of work. A fresh one is quicker and costs less than a very long one.' },
        { do: 'point', at: 'sessions:copy', say: 'This one starts a conversation in **its own copy** of the project. The agent works on a separate branch, and your files stay untouched until you bring its work in.' },
        { do: 'say', say: 'A dot beside a conversation shows it working; an amber one means it is waiting for you. Right-click one to rename, pin or delete it.' }
      ]
    }
  },
  {
    id: 'palette',
    demo: {
      title: 'Doing anything from the keyboard',
      steps: [
        { do: 'say', say: 'Almost everything in Prism can be found by typing its name.' },
        { do: 'open', what: 'palette', say: 'This is the **command palette**. **Ctrl+Shift+P** opens it. Start typing and it narrows down.' },
        { do: 'close', what: 'palette' },
        { do: 'point', at: 'titlebar:search', say: '**Ctrl+P** is the same box for files: type part of a name and press Enter.' },
        { do: 'say', say: 'Every shortcut is listed under Help, **Keyboard shortcuts**, and can be changed in Settings.' }
      ]
    }
  },
  {
    id: 'gadgets',
    demo: {
      title: 'Gadgets: small apps inside Prism',
      steps: [
        { do: 'say', say: 'A **gadget** is a small app that lives in a panel: a monitor, a control panel, a viewer. Some come with Prism, and the agent can build new ones for you.' },
        { do: 'rail', view: 'gadgets', say: 'They are listed here.' },
        { do: 'gadget.open', id: 'system-pulse', say: 'Opening one that comes with Prism the first time shows what it is for. Nothing runs until you press **Turn it on**, and that is for this project only.' },
        { do: 'say', say: 'To get a new one, just ask the agent: *“make me a gadget that shows my build and lets me restart it”*.' }
      ]
    }
  },
  {
    id: 'decisions',
    demo: {
      title: 'Keeping track of what you decided',
      steps: [
        { do: 'say', say: 'When the agent asks you something and you answer, that answer matters later. Prism keeps them.' },
        { do: 'rail', view: 'gadgets' },
        { do: 'gadget.open', id: 'decisions', say: 'The **Decisions** gadget lists every question and your answer, with the reasons, newest first, and you can search it. The first time you open it, it explains itself; turn it on to see the list.' },
        { do: 'say', say: 'Changed your mind? Mark an answer as changed: it is crossed out but kept, so the story stays. Agents read this too, so they stop asking what you already settled.' }
      ]
    }
  },
  {
    id: 'git',
    demo: {
      title: 'Seeing what changed',
      steps: [
        { do: 'rail', view: 'git', say: 'If your project uses **git**, this lists every file that has changed since your last commit.' },
        { do: 'say', say: 'Click a file to see exactly what changed, side by side. Write a message and commit from here, or ask the agent to do it.' },
        { do: 'say', say: 'Each agent conversation also remembers what it changed, so you can see one task’s changes on their own and take back part of them.' }
      ]
    }
  },
  {
    id: 'usage',
    demo: {
      title: 'Watching how much you have used',
      steps: [
        { do: 'point', at: 'status:usage', say: 'The bottom bar shows the model at work in this conversation.' },
        { do: 'open', what: 'usage', say: 'Click it for **Usage**: your Claude plan’s limits and when they reset, what used them, and what each provider cost.' },
        { do: 'say', say: 'A long conversation costs more with every step, because the whole of it is sent each time. When it gets big, Prism offers to summarise it or start fresh.' }
      ]
    }
  },
  {
    id: 'settings',
    demo: {
      title: 'Settings that shape how the agent works',
      steps: [
        { do: 'open', what: 'settings', section: 'agent', say: 'In **Settings, Agent** you can turn on **Vibecoding Safety Biteback** for a project: the agent insists that what has to come first comes first, and tells you why.' },
        { do: 'point', at: 'settings:permissions', say: '**Permissions** decide what always asks and what is never allowed, whatever the mode.' },
        { do: 'point', at: 'settings:extend', say: '**Skills, tools and rules** teach the agent: instructions it reads when they matter, small tools of your own, and rules Prism enforces.' },
        { do: 'point', at: 'settings:fleets', say: '**Fleets** are teams of helpers on different models that work on one task at once.' },
        { do: 'point', at: 'settings:appearance', say: 'And **Appearance** has the themes, fonts and colours.' }
      ]
    }
  },
  {
    id: 'phone',
    demo: {
      title: 'Using Prism from your phone',
      steps: [
        { do: 'say', say: 'Prism has a phone app: the same conversations, from anywhere, working on this computer.' },
        { do: 'open', what: 'settings', section: 'assist', say: 'Turn it on in **Settings, Helpers & extras**, then **Pair a phone**: scan the code it shows with the app.' },
        { do: 'say', say: 'Everything between the two is encrypted. The phone tells you when an answer is ready or the agent is waiting for you, and you can reply from the notification.' }
      ]
    }
  },
  {
    id: 'lessons',
    demo: {
      title: 'Making your own lesson',
      steps: [
        { do: 'say', say: 'A lesson like this one can be made by doing it.' },
        { do: 'open', what: 'lessons', say: 'Help, **Lessons…** lists them all: the project’s own, yours, and the ones that come with Prism.' },
        { do: 'point', at: 'lessons:record', say: 'Press **Record a new lesson**, then use Prism as normal. A bar counts each thing you do; type a caption into it before a step and it goes with that step.' },
        { do: 'close', what: 'lessons' },
        { do: 'say', say: 'Press **Stop** and the lesson opens in an editor: give it a title, change captions, slow parts down, then save it to the project or to your own lessons.' }
      ]
    }
  }
]
