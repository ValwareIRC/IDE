// What a demo is made of.
//
// Every entry is one thing a person does, named after the thing on screen they
// do it to rather than the code underneath: "put this in the Search box", not
// "run a search". `say` is the caption shown while it happens, and `pace`
// stretches or shrinks that one entry relative to the speed you chose.

import type { Target } from './locate'

interface Common {
  /** The caption, shown for at least as long as it takes to read. */
  say?: string
  /** 0.5 = take twice as long as usual here, 2 = half as long. Multiplies your speed. */
  pace?: number
}

export type DemoStep = Common &
  (
    | { do: 'say' }
    /** Click an icon in the activity rail. */
    | { do: 'rail'; view: 'explorer' | 'search' | 'outline' | 'git' | 'sessions' | 'gadgets' }
    | { do: 'tree.expand'; path: string }
    | { do: 'tree.open'; path: string }
    /** Type into the Search box, letter by letter, and let the search run. */
    | { do: 'search.type'; query: string }
    /** Open a result; by file if given, else the nth. */
    | { do: 'search.open'; file?: string; index?: number }
    /** Light up a line (or a range of them) and dim the rest of the file. */
    | { do: 'spotlight'; file: string; anchor: string; through?: string; select?: string }
    /** Stop dimming. */
    | { do: 'spotlight.off' }
    /** Type text into a file after the line whose text is `after`; `after: ''` is the very top. `line` says which, when that line appears more than once. */
    | { do: 'type'; file: string; after: string; text: string; line?: number }
    /** Save the file, as Ctrl+S does. Typing alone leaves it on screen only. */
    | { do: 'save'; file: string }
    /** Type a command into a real terminal and press enter. */
    | { do: 'terminal'; command: string }
    /** Wait until the terminal has printed something matching this. */
    | { do: 'await.output'; match: string; timeout?: number }
    /** Open a gadget's panel from the gadgets list, as clicking it does. */
    | { do: 'gadget.open'; id: string }
    /** Press something inside the open gadget's panel. */
    | { do: 'gadget.press'; gadget: string; find: string; nth?: number }
    /** Type a message to the agent and send it. */
    | { do: 'agent.ask'; text: string }
    /** Wait until the agent has finished answering. */
    | { do: 'agent.wait'; timeout?: number }
    /** Glide to something on screen and light it up, without pressing it: by its lesson name (`at`), or as recorded (`target`). */
    | { do: 'point'; at?: string; target?: Target }
    /** Press something on screen, as recorded: a menu, a menu item, a switch, a button. */
    | { do: 'click'; target: Target; right?: boolean }
    /** Rest the pointer on something, as a submenu needs before its items can be pressed. */
    | { do: 'hover'; target: Target }
    /** Type into a box (a new file's name, a setting), and press Enter if `enter`. */
    | { do: 'fill'; target: Target; text: string; enter?: boolean }
    /** Open a part of Prism, as its menu entry or button does; Settings at a page if `section` is given. */
    | { do: 'open'; what: 'settings' | 'palette' | 'terminal' | 'browser' | 'usage' | 'lessons' | 'agent'; section?: string }
    /** Close what `open` opened, where closing it is not an ordinary click. */
    | { do: 'close'; what: 'palette' | 'lessons' }
  )

export interface Demo {
  title: string
  /**
   * The demo's own scratch files: written when it starts, deleted when it ends.
   * A demo types here, never into work of yours.
   */
  stage?: Array<{ path: string; content: string }>
  steps: DemoStep[]
}
