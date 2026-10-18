import { runLine } from '../remote/command'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { CheckResult, CheckerInfo, Problem } from '@shared/types'

/**
 * Project checkers: the commands a project already has for finding mistakes
 * (type checker, linter, compiler, tests), detected from its files, run on
 * demand, and their output turned into a list of problems with file and line.
 * A project can add its own in .prism/checks.json: [{ "label", "command" }].
 */

interface Checker extends CheckerInfo {
  command: string
}

function has(root: string, ...names: string[]): boolean {
  return names.some((n) => existsSync(join(root, n)))
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function detectCheckers(root: string): Checker[] {
  const out: Checker[] = []
  const pkg = readJson(join(root, 'package.json'))
  const scripts = (pkg?.['scripts'] ?? {}) as Record<string, string>
  const deps = { ...((pkg?.['dependencies'] ?? {}) as object), ...((pkg?.['devDependencies'] ?? {}) as object) } as Record<string, string>
  const pm = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : has(root, 'bun.lockb', 'bun.lock') ? 'bun' : 'npm'
  const npx = pm === 'pnpm' ? 'pnpm exec' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bunx' : 'npx --no-install'

  if (has(root, 'tsconfig.json')) {
    out.push({ id: 'typescript', label: 'TypeScript', kind: 'types', command: scripts['typecheck'] ? `${pm} run typecheck` : `${npx} tsc --noEmit --pretty false` })
  }
  if (deps['eslint'] || has(root, 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs')) {
    out.push({ id: 'eslint', label: 'ESLint', kind: 'lint', command: `${npx} eslint . --format unix` })
  }
  if (scripts['test'] && !/no test specified/.test(scripts['test'])) {
    out.push({ id: 'tests', label: 'Tests', kind: 'test', command: `${pm} test` })
  }
  if (has(root, 'Cargo.toml')) {
    out.push({ id: 'cargo', label: 'Cargo check', kind: 'types', command: 'cargo check --message-format=short --color never' })
    out.push({ id: 'cargo-test', label: 'Cargo test', kind: 'test', command: 'cargo test --color never' })
  }
  if (has(root, 'go.mod')) {
    out.push({ id: 'go-vet', label: 'Go vet', kind: 'lint', command: 'go vet ./...' })
    out.push({ id: 'go-test', label: 'Go test', kind: 'test', command: 'go test ./...' })
  }
  if (has(root, 'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg')) {
    const pyproject = existsSync(join(root, 'pyproject.toml')) ? readFileSync(join(root, 'pyproject.toml'), 'utf8') : ''
    if (/\[tool\.ruff/.test(pyproject) || has(root, 'ruff.toml', '.ruff.toml')) out.push({ id: 'ruff', label: 'Ruff', kind: 'lint', command: 'ruff check --output-format concise .' })
    if (/\[tool\.mypy/.test(pyproject) || has(root, 'mypy.ini')) out.push({ id: 'mypy', label: 'mypy', kind: 'types', command: 'mypy . --no-color-output --no-error-summary' })
    if (/\[tool\.pytest/.test(pyproject) || has(root, 'pytest.ini', 'conftest.py', 'tests')) out.push({ id: 'pytest', label: 'pytest', kind: 'test', command: 'pytest -q --no-header -x' })
  }
  if (has(root, 'CMakeLists.txt') && has(root, 'build')) {
    out.push({ id: 'cmake', label: 'CMake build', kind: 'types', command: 'cmake --build build' })
  }
  const custom = readJson(join(root, '.prism', 'checks.json'))
  const list = Array.isArray(custom) ? custom : Array.isArray(custom?.['checks']) ? (custom['checks'] as unknown[]) : []
  list.forEach((c, i) => {
    const o = c as { label?: unknown; command?: unknown; kind?: unknown }
    if (typeof o.command !== 'string' || !o.command.trim()) return
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : o.command.split(/\s+/)[0]!
    out.push({ id: `custom-${i}`, label, kind: o.kind === 'test' || o.kind === 'lint' || o.kind === 'types' ? o.kind : 'custom', command: o.command })
  })
  return out
}

export function listCheckers(root: string): CheckerInfo[] {
  return detectCheckers(root).map(({ id, label, kind, command }) => ({ id, label, kind, command }))
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

/** Paths in tool output come absolute, relative or with a leading ./; the panel wants workspace-relative with forward slashes. */
function toRel(root: string, file: string): string | null {
  let f = file.trim().replace(/^["']|["']$/g, '')
  if (!f || f.length > 400) return null
  if (isAbsolute(f)) {
    const r = relative(root, f)
    if (r.startsWith('..')) return null
    f = r
  }
  f = f.split(sep).join('/').replace(/^\.\//, '')
  return existsSync(join(root, f)) ? f : null
}

/** The shapes compilers, linters and test runners print their findings in. */
export function parseProblems(root: string, output: string, source: string): Problem[] {
  const problems: Problem[] = []
  const seen = new Set<string>()
  const add = (file: string, line: number, column: number, severity: Problem['severity'], message: string, code?: string): void => {
    const rel = toRel(root, file)
    if (!rel || !message.trim()) return
    const key = `${rel}:${line}:${column}:${message}`
    if (seen.has(key)) return
    seen.add(key)
    problems.push({ file: rel, line: Math.max(1, line), column: Math.max(1, column), severity, message: message.trim().slice(0, 600), source, ...(code ? { code } : {}) })
  }
  const sev = (s: string | undefined): Problem['severity'] => (/warn/i.test(s ?? '') ? 'warning' : /info|note|hint/i.test(s ?? '') ? 'info' : 'error')
  const lines = output.replace(ANSI, '').split(/\r?\n/)
  for (let i = 0; i < lines.length && problems.length < 500; i++) {
    const line = lines[i]!
    let m: RegExpExecArray | null
    // tsc: src/a.ts(12,5): error TS2322: message
    if ((m = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+([A-Z]+\d+):\s+(.*)$/.exec(line))) {
      add(m[1]!, Number(m[2]), Number(m[3]), sev(m[4]), m[6]!, m[5])
      continue
    }
    // eslint unix: path:line:col: message [Error/rule]
    if ((m = /^(.+?):(\d+):(\d+):\s+(.*?)\s+\[(Error|Warning)(?:\/([^\]]+))?\]$/.exec(line))) {
      add(m[1]!, Number(m[2]), Number(m[3]), sev(m[5]), m[4]!, m[6])
      continue
    }
    // gcc/clang/cargo short/go/mypy/ruff: path:line:col: [error|warning[CODE]]: message
    if ((m = /^\s*(.+?):(\d+):(\d+):\s+(?:(fatal error|error|warning|note|info)(?:\[([^\]]+)\])?:\s*)?(.*)$/.exec(line)) && !/^\s*(at |https?:)/.test(line)) {
      const codeM = !m[4] ? /^([A-Z]+\d+)\s+(.*)$/.exec(m[6] ?? '') : null
      add(m[1]!, Number(m[2]), Number(m[3]), sev(m[4]), codeM ? codeM[2]! : m[6]!, m[5] ?? codeM?.[1])
      continue
    }
    // path:line: message (go vet, mypy without columns, grep-like tools)
    if ((m = /^\s*(.+?\.[A-Za-z0-9]+):(\d+):\s+(?:(error|warning|note):\s*)?(.+)$/.exec(line)) && !/^\s*(at |https?:)/.test(line)) {
      add(m[1]!, Number(m[2]), 1, sev(m[3]), m[4]!)
      continue
    }
    // python traceback:   File "x.py", line 12, in f   (message is the last line of the trace)
    if ((m = /^\s*File "(.+?)", line (\d+)/.exec(line))) {
      let msg = ''
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
        if (/^\S/.test(lines[j]!) && !/^Traceback/.test(lines[j]!)) {
          msg = lines[j]!
          break
        }
      }
      add(m[1]!, Number(m[2]), 1, 'error', msg || 'error here')
      continue
    }
    // node / jest / vitest stack frame:   at fn (path:line:col)  — keep only the first frame inside the project per failure
    if ((m = /^\s+(?:at\s+.*?\(?|❯\s+)((?:[A-Za-z]:)?[^():\s]+\.[cm]?[jt]sx?):(\d+):(\d+)\)?$/.exec(line))) {
      let msg = ''
      for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
        const t = lines[j]!.trim()
        if (t && !/^(at |❯ )/.test(t)) {
          msg = t
          break
        }
      }
      if (!/node_modules|node:internal/.test(m[1]!)) add(m[1]!, Number(m[2]), Number(m[3]), 'error', msg || 'failed here')
    }
  }
  return problems
}

export function runChecker(root: string, id: string, signal?: AbortSignal): Promise<CheckResult> {
  const checker = detectCheckers(root).find((c) => c.id === id)
  if (!checker) return Promise.reject(new Error(`No checker named ${id} in this project.`))
  const started = Date.now()
  // a WSL or SSH project is checked on that side
  return runLine(root, checker.command, { timeoutMs: 300_000, maxBuffer: 24 * 1024 * 1024, env: { FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' } }).then((r) => {
    const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.replace(ANSI, '')
    const code = signal?.aborted ? 130 : r.code
    const missing = code !== 0 && /not recognized as an internal|command not found|ENOENT|could not determine executable|Cannot find module/i.test(output)
    return {
      checker: { id: checker.id, label: checker.label, kind: checker.kind, command: checker.command },
      problems: parseProblems(root, output, checker.label),
      output: output.length > 60_000 ? `${output.slice(0, 20_000)}\n…\n${output.slice(-38_000)}` : output,
      code,
      durationMs: Date.now() - started,
      ...(missing ? { note: `${checker.label} could not run. Is it installed in this project?` } : {})
    }
  })
}
