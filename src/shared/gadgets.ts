/** Gadget types shared by main and renderer. See core/gadgets for the runtime. */

export interface GadgetToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface GadgetManifest {
  id: string
  name: string
  description: string
  icon?: string
  version?: string
  /** UI entry file, default index.html. */
  ui?: string
  /** Backend entry (ES module), e.g. backend.mjs. */
  backend?: string
  /** npm packages the backend needs; installed into the gadget folder before it starts. */
  dependencies?: Record<string, string>
  /** One line for the agent's instructions: when to reach for this gadget (the ones that come with Prism use it). */
  agent?: string
  /**
   * What the user is shown the first time they open it, before it is turned on: what it
   * is, how it helps, and an everyday example. The ones that come with Prism have one.
   */
  intro?: { tagline: string; what: string; helps: string[]; example: string; icon?: string; colour?: string }
  /**
   * How this gadget appears as a widget on a phone's home screen. The picture is of
   * the gadget itself; the actions become real buttons beneath it, because a home
   * screen widget cannot run a web page's own buttons.
   */
  widget?: {
    /** Shown above the picture; the gadget's name if left out. */
    title?: string
    /** How tall the picture should be drawn, in the widget's own width. 0.6 is a wide, shallow strip. */
    ratio?: number
    /** Up to three; more are ignored because there is no room. */
    actions?: Array<{
      /** Short: it is a button on a phone. */
      label: string
      /** A handler the backend exposes, called with no arguments unless args are given. */
      call: string
      args?: Record<string, unknown>
    }>
  }
  /** Declared for the user's information; the backend is real Node and the user approves it. */
  permissions?: {
    shell?: boolean
    network?: boolean
    workspace?: 'none' | 'read' | 'write'
  }
}

/** builtin: comes with Prism (resources/gadgets), read-only; a project or global gadget with the same id takes its place. */
export type GadgetScope = 'project' | 'global' | 'builtin'

export type GadgetState = 'stopped' | 'installing' | 'starting' | 'running' | 'error'

export interface GadgetInfo extends GadgetManifest {
  scope: GadgetScope
  /** A copy of one that comes with Prism, which takes its place: removing the copy brings the original back. */
  overrides?: boolean
  /** Turned on in this project (or one of the user's own, which are always on). */
  on?: boolean
  dir: string
  hasBackend: boolean
  state: GadgetState
  error: string | null
  tools: GadgetToolSpec[]
  /** Handler names the backend exposes to the UI and to gadget_call. */
  handlers: string[]
}

export interface GadgetFiles {
  [relPath: string]: string
}

export const GADGET_ID_RE = /^[a-z][a-z0-9-]{1,40}$/
