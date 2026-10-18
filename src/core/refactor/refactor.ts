// Project-wide refactors: rename a symbol, find its references, move a file and
// fix the imports that point at it. Every change comes back as a change set
// (ReviewFile[]) to preview; nothing here writes to disk.
//
// JavaScript and TypeScript are done by meaning, with TypeScript's own language
// service reading the project (its tsconfig/jsconfig when there is one). Other
// languages fall back to whole-word text matches, and the result says so.
import ts from 'typescript'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RefHit, RefactorPlan, ReviewFile } from '@shared/types'
import { searchWorkspace } from '../fs/search'
import { placeOf } from '@shared/place'

const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
const SCRIPT_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const SKIP = ['**/node_modules', '**/.git', '**/dist', '**/out', '**/build', '**/.next', '**/coverage']
const MAX_FILES = 6000

export function isScript(path: string): boolean {
  return SCRIPT.test(path)
}

const registry = ts.createDocumentRegistry()

const posix = (p: string): string => p.split(sep).join('/')
const inside = (root: string, abs: string): boolean => {
  const rel = relative(root, abs)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('node_modules')
}

interface Project {
  service: ts.LanguageService
  root: string
}

/** The project `abs` belongs to: its nearest tsconfig/jsconfig inside the workspace, else every script in the workspace. */
function project(root: string, abs: string): Project {
  const start = existsSync(abs) && statSync(abs).isDirectory() ? abs : dirname(abs)
  const found = ts.findConfigFile(start, ts.sys.fileExists, 'tsconfig.json') ?? ts.findConfigFile(start, ts.sys.fileExists, 'jsconfig.json')
  const config = found && (inside(root, found) || dirname(found) === root) ? found : null
  let files: string[] = []
  let options: ts.CompilerOptions = { allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true, noEmit: true, skipLibCheck: true }
  if (config) {
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
    if (parsed) {
      files = parsed.fileNames
      options = { ...parsed.options, allowJs: parsed.options.allowJs ?? true, noEmit: true }
    }
  }
  // no config, or one that only points at other configs
  if (!files.length) files = ts.sys.readDirectory(config ? dirname(config) : root, SCRIPT_EXT, SKIP, undefined, 12)
  files = files.slice(0, MAX_FILES).map((f) => resolve(f))
  if (isScript(abs) && !files.includes(abs)) files.push(abs)
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (f) => {
      try {
        return String(statSync(f).mtimeMs)
      } catch {
        return '0'
      }
    },
    getScriptSnapshot: (f) => {
      const text = ts.sys.readFile(f)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => (config ? dirname(config) : root),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
  }
  return { service: ts.createLanguageService(host, registry), root }
}

function at(p: Project, abs: string, line: number, column: number): number {
  const sf = p.service.getProgram()?.getSourceFile(abs)
  if (!sf) throw new Error('This file is not part of the project.')
  const l = Math.max(0, Math.min(line - 1, sf.getLineStarts().length - 1))
  return Math.min(sf.getEnd(), ts.getPositionOfLineAndCharacter(sf, l, Math.max(0, Math.min(column - 1, lineText(sf.text, sf.getLineStarts(), l).length))))
}

/** Apply edits to a text, last first so earlier positions stay valid. */
function patch(text: string, edits: Array<{ start: number; length: number; text: string }>): string {
  let out = text
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.start + e.length)
  return out
}

function lineText(text: string, starts: readonly number[], line: number): string {
  return text.slice(starts[line] ?? 0, starts[line + 1] ?? text.length).replace(/\r?\n$/, '')
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------------------------------------------------------------- by text (any language)

async function textHits(root: string, word: string): Promise<RefHit[]> {
  if (!word.trim()) throw new Error('Put the cursor on a name first.')
  const r = await searchWorkspace(root, { query: word, regex: false, caseSensitive: true, wholeWord: true, maxResults: 3000 })
  return r.matches.map((m) => ({ path: m.path, line: m.line, column: m.column, text: m.text.trim().slice(0, 240), kind: 'read' as const }))
}

async function textRename(root: string, word: string, newName: string): Promise<ReviewFile[]> {
  const hits = await textHits(root, word)
  const re = new RegExp(`(?<![\\w$])${escapeRe(word)}(?![\\w$])`, 'g')
  const files: ReviewFile[] = []
  for (const path of [...new Set(hits.map((h) => h.path))]) {
    const before = readFileSync(join(root, path), 'utf8')
    const after = before.replace(re, () => newName)
    if (after !== before) files.push({ path, before, after })
  }
  return files
}

// ---------------------------------------------------------------- the three refactors

export async function findReferences(root: string, path: string, line: number, column: number, word: string): Promise<{ hits: RefHit[]; byMeaning: boolean }> {
  const abs = resolve(root, path)
  // over SSH the files cannot be read by the language service: fall through to the text search, which runs over there
  if (isScript(path) && placeOf(root).kind !== 'ssh') {
    const p = project(root, abs)
    const found = p.service.findReferences(abs, at(p, abs, line, column)) ?? []
    const seen = new Set<string>()
    const hits: RefHit[] = []
    for (const sym of found) {
      for (const r of sym.references) {
        const f = resolve(r.fileName)
        if (!inside(root, f)) continue
        const sf = p.service.getProgram()?.getSourceFile(f)
        if (!sf) continue
        const lc = sf.getLineAndCharacterOfPosition(r.textSpan.start)
        const key = `${f}:${lc.line}:${lc.character}`
        if (seen.has(key)) continue
        seen.add(key)
        const text = lineText(sf.text, sf.getLineStarts(), lc.line).trim().slice(0, 240)
        // an import counts as a write to the language service; to a reader it is just another use
        const imported = /^(import|export)\b/.test(text)
        hits.push({ path: posix(relative(root, f)), line: lc.line + 1, column: lc.character + 1, text, kind: (r as ts.ReferencedSymbolEntry).isDefinition ? 'definition' : r.isWriteAccess && !imported ? 'write' : 'read' })
      }
    }
    if (hits.length) return { hits: hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line), byMeaning: true }
  }
  return { hits: await textHits(root, word), byMeaning: false }
}

function onThisComputer(root: string, what: string): void {
  if (placeOf(root).kind === 'ssh') throw new Error(`${what} is not available yet for a folder on another computer.`)
}

export async function renameSymbol(root: string, path: string, line: number, column: number, word: string, newName: string): Promise<RefactorPlan> {
  onThisComputer(root, 'Renaming across files')
  const name = newName.trim()
  if (!name) throw new Error('Type the new name.')
  const abs = resolve(root, path)
  if (isScript(path)) {
    const p = project(root, abs)
    const pos = at(p, abs, line, column)
    const info = p.service.getRenameInfo(abs, pos, { allowRenameOfImportPath: false })
    if (info.canRename) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name) && !/^['"`]/.test(info.fullDisplayName ?? '')) throw new Error(`"${name}" is not a valid name in JavaScript or TypeScript.`)
      const locs = p.service.findRenameLocations(abs, pos, false, false, { providePrefixAndSuffixTextForRename: true }) ?? []
      const byFile = new Map<string, Array<{ start: number; length: number; text: string }>>()
      let skipped = 0
      for (const l of locs) {
        const f = resolve(l.fileName)
        if (!inside(root, f)) {
          skipped += 1
          continue
        }
        const list = byFile.get(f) ?? []
        list.push({ start: l.textSpan.start, length: l.textSpan.length, text: `${l.prefixText ?? ''}${name}${l.suffixText ?? ''}` })
        byFile.set(f, list)
      }
      const files: ReviewFile[] = []
      for (const [f, edits] of byFile) {
        const before = readFileSync(f, 'utf8')
        files.push({ path: posix(relative(root, f)), before, after: patch(before, edits) })
      }
      files.sort((a, b) => a.path.localeCompare(b.path))
      return {
        title: `Rename ${info.displayName} to ${name}`,
        files,
        byMeaning: true,
        note: skipped ? `${skipped} use${skipped === 1 ? '' : 's'} in files outside the project (installed packages) ${skipped === 1 ? 'is' : 'are'} left alone.` : null
      }
    }
    if (!word.trim()) throw new Error(info.localizedErrorMessage || 'This cannot be renamed.')
  }
  const files = await textRename(root, word, name)
  return {
    title: `Rename ${word} to ${name}`,
    files,
    byMeaning: false,
    note: 'Matched as a whole word, not by meaning: something else with the same name is included too. Reject the pieces that are a different thing.'
  }
}

function scriptsUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) scriptsUnder(p, out)
    else if (isScript(e.name)) out.push(p)
    if (out.length > 2000) break
  }
  return out
}

/** The edits that keep imports working when `from` becomes `to`. The move itself is done by the caller, after these are written. */
export async function moveFile(root: string, from: string, to: string): Promise<RefactorPlan> {
  // a move on another computer is just the move: its imports are not rewritten
  if (placeOf(root).kind === 'ssh') return { title: `Move ${from} to ${to}`, files: [], byMeaning: true, note: null, then: { from, to } }
  const absFrom = resolve(root, from)
  const absTo = resolve(root, to)
  if (!existsSync(absFrom)) throw new Error(`${from} does not exist.`)
  if (existsSync(absTo)) throw new Error(`${to} already exists.`)
  const dir = statSync(absFrom).isDirectory()
  const title = `Move ${from} to ${to}`
  const anchor = dir ? scriptsUnder(absFrom)[0] : isScript(from) ? absFrom : undefined
  if (!anchor) return { title, files: [], byMeaning: true, note: null, then: { from, to } }
  const p = project(root, anchor)
  // the language service compares these with its own file names, which use forward slashes
  const changes = p.service.getEditsForFileRename(posix(absFrom), posix(absTo), {}, { allowTextChangesInNewFiles: true })
  const files: ReviewFile[] = []
  for (const c of changes) {
    const f = resolve(c.fileName)
    if (!inside(root, f) || !existsSync(f)) continue
    const before = readFileSync(f, 'utf8')
    const after = patch(before, c.textChanges.map((t) => ({ start: t.span.start, length: t.span.length, text: t.newText })))
    if (after !== before) files.push({ path: posix(relative(root, f)), before, after })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { title: files.length ? `${title} and update ${files.length} file${files.length === 1 ? '' : 's'}` : title, files, byMeaning: true, note: files.length ? 'These files mention the old location. The file is moved after the changes you accept are written.' : null, then: { from, to } }
}
