import type { BrowserConsoleEntry } from '@shared/types'
import { reportText, type A11yReport } from '@shared/a11y'
import { clipOutput, err, str, type AgentTool } from './types'

/** Prism's in-app browser, as the tools need it (main/preview.ts implements this). */
export interface BrowserHost {
  open(target: string): Promise<{ url: string; title: string; console: BrowserConsoleEntry[] }>
  look(): Promise<{ url: string; title: string; image: { mime: string; base64: string } | null; console: BrowserConsoleEntry[]; text: string }>
  evaluate(script: string): Promise<string>
  /** Accessibility problems on the open page, or on an address or file of its own (main/a11y.ts). */
  audit(target?: string): Promise<{ report: A11yReport; image: { mime: string; base64: string } | null }>
}

function consoleText(list: BrowserConsoleEntry[]): string {
  if (!list.length) return 'Console: no new warnings or errors.'
  return `Console (new warnings and errors):\n${list.map((l) => `[${l.level}] ${l.text}${l.source ? `  (${l.source.split('/').pop()}:${l.line})` : ''}`).join('\n')}`
}

const local = (url: string): boolean => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url) || !/^https?:\/\//i.test(url)

/** Tools that let the agent open a page in Prism's browser, see it, and poke at it. */
export function createBrowserTools(host: BrowserHost): AgentTool[] {
  const open: AgentTool = {
    spec: {
      name: 'browser_open',
      description:
        "Open a page in Prism's built-in browser: the user's Browser panel when they are following you, otherwise a page of your own that leaves their panel alone. Give a web address (for example the dev server you started, http://localhost:5173) or the path of an HTML file in the workspace (it is served over http for you). Returns the page title and any console errors from loading. Follow with browser_look to see it.",
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Address, or workspace path of an HTML file' } }, required: ['url'] }
    },
    primaryArg: 'url',
    readOnly: false,
    // pages on this machine are the project's own; anything else is the open web
    risk: (a) => (local(str(a, 'url')) ? null : 'low'),
    summary: (a) => `open ${str(a, 'url')}`,
    async execute(args) {
      try {
        const r = await host.open(str(args, 'url'))
        return { content: `Opened ${r.url}\nTitle: ${r.title || '(none)'}\n${consoleText(r.console)}`, isError: false, meta: { url: r.url } }
      } catch (e) {
        return err(`Could not open the page: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const look: AgentTool = {
    spec: {
      name: 'browser_look',
      description:
        "See the page that is open in Prism's browser: a picture of it, its visible text, and any console warnings or errors since you last looked. Use it after changing a web page to check the result with your own eyes instead of assuming.",
      parameters: { type: 'object', properties: {} }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: () => 'look at the page',
    async execute() {
      try {
        const r = await host.look()
        return {
          content: `Page: ${r.url}\nTitle: ${r.title || '(none)'}\n${consoleText(r.console)}\n\nVisible text (start):\n${r.text.trim() || '(none)'}`,
          isError: false,
          ...(r.image ? { images: [r.image] } : {}),
          meta: { url: r.url }
        }
      } catch (e) {
        return err(`Could not look at the page: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const evaluate: AgentTool = {
    spec: {
      name: 'browser_eval',
      description:
        "Run JavaScript in the page open in Prism's browser and get the result back as text. Use it to click things, fill fields, read the DOM or measure layout, for example: document.querySelector('button.save').click()  or  [...document.querySelectorAll('h2')].map(h => h.textContent). A single expression is returned as is; for several statements use return.",
      parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] }
    },
    primaryArg: 'script',
    readOnly: false,
    risk: () => 'low',
    summary: (a) => `run in page: ${str(a, 'script').split('\n')[0]?.slice(0, 70) ?? ''}`,
    async execute(args) {
      try {
        return { content: clipOutput(await host.evaluate(str(args, 'script')), 20_000), isError: false }
      } catch (e) {
        return err(`The script failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const a11y: AgentTool = {
    spec: {
      name: 'check_accessibility',
      description:
        "Check a web page for accessibility problems: text too faint or too small to read, pictures and buttons a screen reader cannot name, form fields with no label, things too small to tap, zoom turned off, sound with no words on screen, and the rest of the WCAG 2.2 rules automatic checks can test. Checks the page open in Prism's browser, or a given address or HTML file. Returns the problems worst first, with where they are, and a picture with each one boxed and numbered. Use it whenever you build or change something people will look at.",
      parameters: { type: 'object', properties: { url: { type: 'string', description: "An address or a workspace HTML file; leave out to check the page open in Prism's browser" } } }
    },
    primaryArg: 'url',
    readOnly: true,
    risk: (a) => (!str(a, 'url') || local(str(a, 'url')) ? null : 'low'),
    summary: (a) => `check accessibility${str(a, 'url') ? ` of ${str(a, 'url')}` : ''}`,
    async execute(args) {
      try {
        const r = await host.audit(str(args, 'url') || undefined)
        return { content: reportText(r.report), isError: false, ...(r.image ? { images: [r.image] } : {}), meta: { url: r.report.url, a11y: { problems: r.report.findings.length, worst: r.report.findings[0]?.impact ?? null } } }
      } catch (e) {
        return err(`Could not check the page: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return [open, look, evaluate, a11y]
}
