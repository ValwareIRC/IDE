import { monaco } from './monaco'
import { useEditor } from '@/state/editor'

export interface SymbolEntry {
  name: string
  /** function | method | class | interface | type | enum | variable | property | heading | section */
  kind: string
  line: number
  depth: number
}

interface NavTree {
  text: string
  kind: string
  spans: Array<{ start: number; length: number }>
  childItems?: NavTree[]
}

const TS_KINDS: Record<string, string> = {
  function: 'function',
  'local function': 'function',
  method: 'method',
  constructor: 'method',
  getter: 'property',
  setter: 'property',
  class: 'class',
  'local class': 'class',
  interface: 'interface',
  type: 'type',
  enum: 'enum',
  const: 'variable',
  let: 'variable',
  var: 'variable',
  property: 'property',
  module: 'section'
}

/** [pattern, kind or index of the keyword group, index of the name group] per language family. */
type Rule = [RegExp, string | number, number]

const RULES: Record<string, Rule[]> = {
  python: [[/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/, 2, 3]],
  rust: [[/^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+)*(fn|struct|enum|trait|impl|mod|type)\s+([A-Za-z_][\w<>, ]*)/, 2, 3]],
  go: [
    [/^()(func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 2, 3],
    [/^()(type)\s+([A-Za-z_]\w*)/, 2, 3]
  ],
  markdown: [[/^()(#{1,6})\s+(.+?)\s*#*$/, 'heading', 3]],
  css: [[/^(\s*)()([^{}@/][^{};]*?)\s*\{\s*$/, 'section', 3]],
  c: [
    [/^(\s*)(class|struct|enum|namespace|union)\s+([A-Za-z_]\w*)/, 2, 3],
    [/^()((?:[\w:*&<>,~]+\s+)+[*&]?)([A-Za-z_~][\w:~]*)\s*\([^;]*$/, 'function', 3]
  ],
  generic: [[/^(\s*)(?:export\s+|public\s+|private\s+|protected\s+|static\s+|local\s+)*(?:async\s+)?(function|class|def|fn|func|interface|struct|enum|module|sub|procedure)\s+([A-Za-z_$][\w$.:]*)/, 2, 3]]
}

const FAMILY: Record<string, string> = {
  python: 'python',
  rust: 'rust',
  go: 'go',
  markdown: 'markdown',
  css: 'css',
  scss: 'css',
  less: 'css',
  c: 'c',
  cpp: 'c',
  csharp: 'c',
  java: 'c',
  objectivec: 'c'
}

const WORD_KIND: Record<string, string> = {
  def: 'function',
  fn: 'function',
  func: 'function',
  function: 'function',
  sub: 'function',
  procedure: 'function',
  class: 'class',
  struct: 'class',
  union: 'class',
  impl: 'class',
  trait: 'interface',
  interface: 'interface',
  enum: 'enum',
  type: 'type',
  mod: 'section',
  module: 'section',
  namespace: 'section'
}

const NOT_FUNCTIONS = /^(if|for|while|switch|return|else|catch|sizeof|do)$/

function byPattern(text: string, language: string): SymbolEntry[] {
  const rules = RULES[FAMILY[language] ?? 'generic'] ?? RULES['generic']!
  const out: SymbolEntry[] = []
  const lines = text.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length && out.length < 2000; i++) {
    const line = lines[i]!
    if (language === 'markdown' && /^(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    for (const [re, kindSpec, nameIdx] of rules) {
      const m = re.exec(line)
      if (!m) continue
      const name = (m[nameIdx] ?? '').trim()
      if (!name || NOT_FUNCTIONS.test(name)) continue
      const word = typeof kindSpec === 'number' ? (m[kindSpec] ?? '') : kindSpec
      const kind = language === 'markdown' ? 'heading' : (WORD_KIND[word] ?? word)
      const depth = language === 'markdown' ? (m[2] ?? '#').length - 1 : Math.floor((m[1] ?? '').replace(/\t/g, '  ').length / 2)
      out.push({ name: name.slice(0, 120), kind, line: i + 1, depth: Math.min(depth, 6) })
      break
    }
  }
  return out
}

/** Functions, classes, headings… of an open file, in file order. */
export async function symbolsFor(path: string): Promise<SymbolEntry[]> {
  const doc = useEditor.getState().docs[path]
  if (!doc || doc.binary) return []
  const lang = doc.language
  if (lang === 'typescript' || lang === 'javascript') {
    const model = monaco.editor.getModel(monaco.Uri.file(path))
    if (model) {
      try {
        const get = lang === 'typescript' ? monaco.typescript.getTypeScriptWorker : monaco.typescript.getJavaScriptWorker
        const worker = await (await get())(model.uri)
        const tree = (await worker.getNavigationTree(model.uri.toString())) as NavTree | undefined
        const out: SymbolEntry[] = []
        const walk = (n: NavTree, depth: number): void => {
          for (const c of n.childItems ?? []) {
            const kind = TS_KINDS[c.kind]
            if (kind && c.text && !c.text.startsWith('<') && c.spans[0]) {
              out.push({ name: c.text, kind, line: model.getPositionAt(c.spans[0].start).lineNumber, depth })
              if (depth < 4) walk(c, depth + 1)
            } else if (depth < 4) walk(c, depth)
          }
        }
        if (tree) walk(tree, 0)
        if (out.length) return out.sort((a, b) => a.line - b.line)
      } catch {
        /* worker not ready: fall through to patterns */
      }
    }
  }
  return byPattern(doc.content, lang)
}
