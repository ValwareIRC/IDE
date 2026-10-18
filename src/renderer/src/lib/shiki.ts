import type { Highlighter } from 'shiki'

let highlighterPromise: Promise<Highlighter> | null = null
const loaded = new Set<string>()

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  cs: 'csharp',
  'c++': 'cpp',
  plaintext: 'text',
  text: 'text',
  txt: 'text',
  console: 'shellscript',
  jsonc: 'json',
  dockerfile: 'docker',
  bat: 'bat',
  cmd: 'bat',
  protobuf: 'proto'
}

const SUPPORTED = new Set([
  'typescript', 'tsx', 'javascript', 'jsx', 'json', 'html', 'css', 'scss', 'less', 'markdown', 'python', 'rust', 'go', 'c', 'cpp', 'csharp', 'java',
  'kotlin', 'swift', 'ruby', 'php', 'lua', 'shellscript', 'powershell', 'bat', 'yaml', 'toml', 'ini', 'xml', 'sql', 'graphql', 'docker',
  'diff', 'make', 'cmake', 'dart', 'scala', 'perl', 'elixir', 'haskell', 'zig', 'glsl', 'hlsl', 'wgsl', 'proto', 'hcl', 'r', 'vue', 'svelte'
])

export function normalizeLang(lang: string | undefined): string {
  const l = (lang ?? '').toLowerCase().trim()
  const n = LANG_ALIASES[l] ?? l
  return SUPPORTED.has(n) ? n : 'text'
}

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([import('shiki'), import('shiki/engine/javascript')]).then(([m, eng]) =>
      m.createHighlighter({ themes: [m.createCssVariablesTheme({ name: 'prism', variablePrefix: '--shiki-', fontStyle: true })], langs: [], engine: eng.createJavaScriptRegexEngine() })
    )
  }
  return highlighterPromise
}

/** Returns highlighted HTML or null when the language is unknown or loading fails. */
export async function highlight(code: string, lang: string): Promise<string | null> {
  const l = normalizeLang(lang)
  if (l === 'text') return null
  try {
    const h = await getHighlighter()
    if (!loaded.has(l)) {
      await h.loadLanguage(l as Parameters<Highlighter['loadLanguage']>[0])
      loaded.add(l)
    }
    return h.codeToHtml(code, { lang: l, theme: 'prism' })
  } catch {
    return null
  }
}
