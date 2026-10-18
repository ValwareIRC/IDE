// Turns a notebook cell into something that can be run again and again in one
// long-lived process:
//   - TypeScript is reduced to JavaScript;
//   - top-level names (const, let, functions, classes, imports) become plain
//     assignments, so they are still there for the next cell;
//   - imports become calls to __import, which resolves them against the project
//     (see runtime.mjs), so `import { add } from './src/calc.js'` just works;
//   - a cell that ends in an expression returns it, which is the cell's value;
//   - everything sits in an async function, so `await` works at the top.
import ts from 'typescript'

interface Edit {
  start: number
  end: number
  text: string
}

const apply = (src: string, edits: Edit[]): string => {
  let out = src
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

function parse(js: string): ts.SourceFile {
  const sf = ts.createSourceFile('cell.js', js, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  const bad = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics?.[0]
  if (bad) {
    const at = sf.getLineAndCharacterOfPosition(bad.start)
    throw new SyntaxError(`${ts.flattenDiagnosticMessageText(bad.messageText, ' ')} (line ${at.line + 1})`)
  }
  return sf
}

/** The text of a declaration without its export/default words. */
function bare(sf: ts.SourceFile, node: ts.Node): string {
  const mods = (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.filter((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword) ?? []
  const from = mods.length ? mods[mods.length - 1]!.end : node.getStart(sf)
  return sf.text.slice(from, node.end).trim()
}

/**
 * In a notebook people end a cell with `({ a, b })` or `[x, y]` to see a value, and leave semicolons out. JavaScript
 * would read that line as a call or an index on the line above. A line that starts at the left margin with a bracket
 * is taken as a new statement instead; a continuation that is meant is always indented.
 */
function separate(code: string): string {
  const lines = code.split('\n')
  for (let i = 1; i < lines.length; i += 1) {
    if (!/^[([`]/.test(lines[i]!)) continue
    let p = i - 1
    while (p >= 0 && !lines[p]!.trim()) p -= 1
    if (p < 0) continue
    const prev = lines[p]!.replace(/\/\/.*$/, '').trimEnd()
    // the line above is plainly unfinished, or already ended
    if (!prev || /[,;{([=+\-*/%&|^<>?:!~]$/.test(prev) || /=>$/.test(prev)) continue
    // the semicolon goes in front of this line: the line above may end in a comment
    lines[i] = `;${lines[i]!}`
  }
  return lines.join('\n')
}

export function prepareCell(source: string, lang: 'js' | 'ts'): string {
  const code = separate(source)
  let js = code
  if (lang === 'ts') {
    js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true, sourceMap: false }, reportDiagnostics: false }).outputText
  }

  // 1. import(...) written by hand goes through the project-aware loader too
  let sf = parse(js)
  const dynamic: Edit[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) dynamic.push({ start: n.expression.getStart(sf), end: n.expression.end, text: '__import' })
    ts.forEachChild(n, walk)
  }
  walk(sf)
  if (dynamic.length) {
    js = apply(js, dynamic)
    sf = parse(js)
  }

  // 2. top-level declarations become assignments that outlive the cell
  const edits: Edit[] = []
  const last = sf.statements[sf.statements.length - 1]
  for (const s of sf.statements) {
    const span = { start: s.getStart(sf), end: s.end }
    if (ts.isImportDeclaration(s)) {
      const spec = s.moduleSpecifier.getText(sf)
      const c = s.importClause
      if (!c) {
        edits.push({ ...span, text: `await __import(${spec});` })
        continue
      }
      const parts: string[] = []
      if (c.name) parts.push(`${c.name.text} = __m.default;`)
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) parts.push(`${c.namedBindings.name.text} = __m;`)
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) parts.push(`${e.name.text} = __m[${JSON.stringify((e.propertyName ?? e.name).text)}];`)
      edits.push({ ...span, text: `{ const __m = await __import(${spec}); ${parts.join(' ')} }` })
    } else if (ts.isVariableStatement(s)) {
      const out = s.declarationList.declarations.map((d) => {
        const init = d.initializer ? d.initializer.getText(sf) : 'undefined'
        return ts.isIdentifier(d.name) ? `${d.name.text} = ${init};` : `(${d.name.getText(sf)} = ${init});`
      })
      edits.push({ ...span, text: out.join(' ') })
    } else if (ts.isFunctionDeclaration(s) && s.name) {
      edits.push({ ...span, text: `${s.name.text} = ${bare(sf, s)};` })
    } else if (ts.isClassDeclaration(s) && s.name) {
      edits.push({ ...span, text: `${s.name.text} = ${bare(sf, s)};` })
    } else if (s === last && ts.isExpressionStatement(s)) {
      edits.push({ ...span, text: `return (${s.expression.getText(sf)});` })
    }
  }
  // kept on the first line so the line numbers in an error match the cell
  return `(async () => { ${apply(js, edits)}\n})()`
}
