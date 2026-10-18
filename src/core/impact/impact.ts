// What a set of changes could break, worked out before trusting it: which
// functions, classes and values changed, every place that uses them, and the
// tests that reach the changed files through their imports (so only those need
// running). Symbols are compared by parsing before and after with TypeScript's
// parser (any JS/TS file); uses come from the language service where it can
// read the project, else from a whole-word search.
import ts from 'typescript'
import type { ImpactReport, ReviewFile } from '@shared/types'
import type { Workspace } from '../fs/workspace'
import { findReferences, isScript } from '../refactor/refactor'
import { searchWorkspace } from '../fs/search'

const TEST = /(^|\/)(__tests__\/|tests?\/)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/i
const CODE = /\.([cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|vue|svelte)$/i
const MAX_SYMBOLS = 30

interface Decl {
  name: string
  kind: ImpactReport['symbols'][number]['kind']
  text: string
  line: number
  column: number
}

/** Top-level declarations and class members, with their text (whitespace squeezed) to compare. */
function declarations(path: string, text: string | null): Map<string, Decl> {
  const out = new Map<string, Decl>()
  if (!text || !isScript(path)) return out
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const squeeze = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ')
  const add = (name: string, kind: Decl['kind'], node: ts.Node, at: ts.Node): void => {
    const lc = sf.getLineAndCharacterOfPosition(at.getStart(sf))
    out.set(name, { name, kind, text: squeeze(node), line: lc.line + 1, column: lc.character + 1 })
  }
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) add(st.name.text, 'function', st, st.name)
    else if (ts.isClassDeclaration(st) && st.name) {
      const cls = st.name.text
      for (const m of st.members) {
        if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name && ts.isIdentifier(m.name)) add(`${cls}.${m.name.text}`, 'method', m, m.name)
        else if (ts.isConstructorDeclaration(m)) add(`${cls}.constructor`, 'method', m, m)
      }
      // the class itself counts as changed only for what is outside its members (what it extends or implements)
      const lc = sf.getLineAndCharacterOfPosition(st.name.getStart(sf))
      out.set(cls, { name: cls, kind: 'class', text: st.heritageClauses?.map((h) => h.getText(sf)).join(' ') ?? '', line: lc.line + 1, column: lc.character + 1 })
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name.text, 'variable', d, d.name)
    } else if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) add(st.name.text, 'type', st, st.name)
  }
  return out
}

/** Relative imports of a file, as they are written. */
function importsOf(text: string): string[] {
  const out: string[] = []
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]|^\s*from\s+(\.+[\w.]*)\s+import/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1] ?? m[2]!)
  return out
}

const stripExt = (p: string): string => p.replace(/\.[cm]?[jt]sx?$|\.py$/i, '').replace(/\/index$/, '')

function resolveImport(from: string, spec: string): string {
  if (/^\.+[\w.]*$/.test(spec) && !spec.includes('/')) {
    // python: from .pkg.mod import x
    const dots = spec.match(/^\.+/)![0].length
    const base = from.split('/').slice(0, -dots)
    return [...base, ...spec.slice(dots).split('.').filter(Boolean)].join('/')
  }
  const parts = from.split('/').slice(0, -1)
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return stripExt(parts.join('/'))
}

/** How to run only these test files, from what the project uses. Null when it cannot tell. */
async function testCommand(ws: Workspace, tests: string[]): Promise<string | null> {
  if (!tests.length) return null
  const quoted = tests.map((t) => (/[\s'"]/.test(t) ? `"${t}"` : t)).join(' ')
  if (tests.every((t) => t.endsWith('.py'))) return `python -m pytest ${quoted}`
  try {
    const pkg = JSON.parse((await ws.read('package.json')).content) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const script = pkg.scripts?.['test'] ?? ''
    if (deps['vitest'] || /\bvitest\b/.test(script)) return `npx vitest run ${quoted}`
    if (deps['jest'] || /\bjest\b/.test(script)) return `npx jest ${quoted}`
    if (deps['mocha'] || /\bmocha\b/.test(script)) return `npx mocha ${quoted}`
    if (/node\s+--test/.test(script)) return `node --test ${quoted}`
  } catch {
    /* no package.json */
  }
  return null
}

export async function analyseImpact(ws: Workspace, files: ReviewFile[]): Promise<ImpactReport> {
  const changedPaths = new Set(files.map((f) => f.path))
  const symbols: ImpactReport['symbols'] = []
  for (const f of files) {
    const before = declarations(f.path, f.before)
    const after = declarations(f.path, f.after)
    for (const [name, d] of after) {
      const was = before.get(name)
      if (!was) symbols.push({ path: f.path, name, kind: d.kind, change: 'added', line: d.line, column: d.column })
      else if (was.text !== d.text) symbols.push({ path: f.path, name, kind: d.kind, change: 'changed', line: d.line, column: d.column })
    }
    for (const [name, d] of before) if (!after.has(name)) symbols.push({ path: f.path, name, kind: d.kind, change: 'removed', line: d.line, column: d.column })
  }

  // who uses what changed (an added name has no users yet)
  const callers: ImpactReport['callers'] = []
  let byMeaning = true
  for (const s of symbols.filter((x) => x.change !== 'added').slice(0, MAX_SYMBOLS)) {
    const word = s.name.split('.').pop()!
    let hits: Array<{ path: string; line: number; text: string; kind: string }> = []
    // the language service reads the files on disk, which for changes not yet written still hold the old version
    const onDisk = s.change === 'changed' ? declarations(s.path, await ws.read(s.path).then((x) => x.content).catch(() => null)).get(s.name) : undefined
    if (s.change === 'changed' && onDisk) {
      const r = await findReferences(ws.root, s.path, onDisk.line, onDisk.column, word).catch(() => null)
      if (r) {
        hits = r.hits
        if (!r.byMeaning) byMeaning = false
      }
    } else {
      byMeaning = false
      const r = await searchWorkspace(ws.root, { query: word, regex: false, caseSensitive: true, wholeWord: true, maxResults: 300 }).catch(() => null)
      // found by name: only code counts, not docs that mention it
      hits = (r?.matches ?? []).filter((m) => CODE.test(m.path)).map((m) => ({ path: m.path, line: m.line, text: m.text.trim().slice(0, 200), kind: 'read' }))
    }
    const seen = new Set<string>()
    for (const h of hits) {
      if (seen.has(`${h.path}:${h.line}`)) continue
      seen.add(`${h.path}:${h.line}`)
      if (h.kind === 'definition' || /^\s*(import|export\s+\{)/.test(h.text)) continue
      if (h.path === s.path && Math.abs(h.line - s.line) < 2) continue
      callers.push({ symbol: s.name, path: h.path, line: h.line, text: h.text, inTest: TEST.test(h.path) })
    }
  }

  // which files import the changed ones, and so on, up to a few steps away; the tests among them are the ones that matter
  const all = (await ws.walk(8000)).filter((p) => CODE.test(p) && !p.includes('node_modules/'))
  const importers = new Map<string, string[]>()
  for (const p of all) {
    let text = ''
    try {
      const f = await ws.read(p)
      if (f.binary || f.size > 400_000) continue
      text = f.content
    } catch {
      continue
    }
    for (const spec of importsOf(text)) {
      const target = resolveImport(p, spec)
      importers.set(target, [...(importers.get(target) ?? []), p])
    }
  }
  const reached = new Set<string>()
  let frontier = [...changedPaths].map(stripExt)
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: string[] = []
    for (const t of frontier) {
      for (const imp of importers.get(t) ?? []) {
        if (reached.has(imp)) continue
        reached.add(imp)
        next.push(stripExt(imp))
      }
    }
    frontier = next
  }
  const tests = [...new Set([...reached, ...callers.filter((c) => c.inTest).map((c) => c.path), ...[...changedPaths].filter((p) => TEST.test(p))])].filter((p) => TEST.test(p)).sort()
  const importedBy = [...reached].filter((p) => !TEST.test(p) && !changedPaths.has(p)).sort()

  return {
    files: [...changedPaths],
    symbols,
    callers: callers.sort((a, b) => Number(a.inTest) - Number(b.inTest) || a.path.localeCompare(b.path) || a.line - b.line).slice(0, 300),
    importedBy: importedBy.slice(0, 100),
    tests,
    testCommand: await testCommand(ws, tests),
    byMeaning
  }
}

/** The report as text, for the agent. */
export function impactText(r: ImpactReport): string {
  if (!r.files.length) return 'No changed files to check.'
  const out: string[] = []
  const ch = r.symbols.filter((s) => s.change !== 'added')
  out.push(ch.length ? `Changed or removed: ${ch.map((s) => `${s.name} (${s.change}, ${s.path}:${s.line})`).join(', ')}` : 'No existing function, class or value changed its definition (only additions or edits inside unnamed code).')
  if (r.callers.length) out.push(`Used in ${r.callers.length} place${r.callers.length === 1 ? '' : 's'}${r.byMeaning ? '' : ' (found by name, so some may be unrelated)'}:\n${r.callers.slice(0, 60).map((c) => `- ${c.path}:${c.line} uses ${c.symbol}: ${c.text}`).join('\n')}`)
  else out.push('Nothing else uses what changed.')
  if (r.importedBy.length) out.push(`Files that import the changed files (directly or through others): ${r.importedBy.slice(0, 40).join(', ')}`)
  out.push(r.tests.length ? `Tests that reach this code: ${r.tests.join(', ')}${r.testCommand ? `\nRun just those with: ${r.testCommand}` : ''}` : 'No test file reaches the changed code: consider adding one.')
  return out.join('\n\n')
}
