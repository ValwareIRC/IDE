// Finds passwords, keys and tokens about to be committed by mistake.
//
// The Safety gadget uses it to look at what is waiting to be committed, and copies it
// into a project's git hooks as prism-secrets.mjs, where it runs before every commit
// and stops one that would put a secret into the history (where it stays for ever,
// even after the file is fixed). `git commit --no-verify` skips it once.
//
// It looks only at lines being added. Something it gets wrong can be let through for
// good from the Safety panel, which records a fingerprint of it (never the secret
// itself) in .prism/secrets-allow.json.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RULES = [
  { id: 'private-key', name: 'a private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-key', name: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'aws-secret', name: 'an AWS secret key', re: /aws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/i },
  { id: 'github', name: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { id: 'anthropic', name: 'an Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai', name: 'an OpenAI API key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { id: 'google', name: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack', name: 'a Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'stripe', name: 'a Stripe secret key', re: /\b[rs]k_live_[0-9a-zA-Z]{20,}/ },
  { id: 'telegram', name: 'a Telegram bot token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { id: 'discord', name: 'a Discord bot token', re: /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,38}\b/ },
  { id: 'huggingface', name: 'a Hugging Face token', re: /\bhf_[A-Za-z0-9]{34,}\b/ },
  { id: 'npm', name: 'an npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'url-password', name: 'a password inside an address', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:([^\s@/'"`]{3,})@[^\s'"`]+/i },
  {
    id: 'assignment',
    name: 'a password or key written into the code',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i,
    weak: true
  }
]

/** Files that usually hold secrets, whatever is in them. */
const RISKY_FILE = /(^|\/)(\.env(\.[\w.-]+)?|id_rsa|id_ed25519|id_ecdsa|id_dsa|[^/]+\.pem|[^/]+\.key|[^/]+\.p12|[^/]+\.pfx|[^/]+\.keystore|[^/]+\.jks|credentials\.json|service[-_]?account[^/]*\.json|\.npmrc|\.pypirc|\.netrc|\.htpasswd)$/i
/** Files that look risky by name but are meant to be shared, and files that are only noise. */
const SAFE_FILE = /(^|\/)\.env\.(example|sample|template|dist|defaults)$|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock)$|\.min\.(js|css)$|\.map$/i
/** What a placeholder looks like: not a real secret. */
const PLACEHOLDER = /^(x{4,}|\*{3,}|\.{3,}|<[^>]*>|\$\{?[\w.]+\}?|%[\w]+%|process\.env\.|os\.environ|env\(|getenv|\{secret:|your[_-]|example|changeme|change[_-]me|dummy|placeholder|redacted|password|secret|test|todo)/i

const fingerprint = (rule, value) => createHash('sha1').update(`${rule}\u0000${value}`).digest('hex').slice(0, 16)

function maskLine(text, value) {
  const keep = value.length > 10 ? 4 : 2
  const masked = value.slice(0, keep) + '•'.repeat(Math.min(12, Math.max(4, value.length - keep)))
  const line = text.replace(value, masked).trim()
  return line.length > 160 ? line.slice(0, 157) + '…' : line
}

function checkLine(file, line, text, out) {
  if (text.length > 4000) text = text.slice(0, 4000)
  for (const r of RULES) {
    const m = r.re.exec(text)
    if (!m) continue
    const value = m[1] ?? m[0]
    if ((r.weak || r.id === 'url-password') && PLACEHOLDER.test(value)) continue
    out.push({ file, line, rule: r.id, what: r.name, weak: !!r.weak, preview: maskLine(text, value), key: fingerprint(r.id, value) })
    return
  }
}

/** Findings in the added lines of a unified diff (git diff -U0). */
export function scanDiff(diff) {
  const out = []
  let file = null
  let line = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4).trim()
      file = name === '/dev/null' ? null : name.replace(/^b\//, '')
      continue
    }
    if (raw.startsWith('@@')) {
      line = Number(raw.match(/\+(\d+)/)?.[1] ?? 0)
      continue
    }
    if (raw.startsWith('+') && file && !SAFE_FILE.test(file)) {
      checkLine(file, line, raw.slice(1).replace(/\r$/, ''), out)
      line++
    } else if (raw.startsWith(' ')) line++
  }
  return out
}

/** Findings in a whole new file, every line counted as added. */
export function scanFile(file, text) {
  const out = []
  if (SAFE_FILE.test(file)) return out
  text.split('\n').forEach((l, i) => checkLine(file, i + 1, l.replace(/\r$/, ''), out))
  return out
}

/** A file whose very name says it holds secrets, about to be added. */
export function riskyName(file) {
  return RISKY_FILE.test(file) && !SAFE_FILE.test(file)
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
}

export function allowed(root) {
  try {
    const j = JSON.parse(readFileSync(join(root, '.prism', 'secrets-allow.json'), 'utf8'))
    return { keys: new Set(j.keys ?? []), files: new Set(j.files ?? []) }
  } catch {
    return { keys: new Set(), files: new Set() }
  }
}

/**
 * What is waiting to be committed. staged: only what `git commit` would take now.
 * Otherwise also changes not yet staged and new files git does not know yet.
 */
export function scanProject(root, { staged = true } = {}) {
  const found = []
  const diff = git(root, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff'])
  found.push(...scanDiff(diff))
  const added = git(root, ['diff', '--cached', '--name-only', '--diff-filter=A']).split('\n').filter(Boolean)
  for (const f of added) if (riskyName(f)) found.push({ file: f, line: 0, rule: 'file', what: 'a file that usually holds secrets', weak: false, preview: f, key: fingerprint('file', f) })
  if (!staged) {
    found.push(...scanDiff(git(root, ['diff', '-U0', '--no-color', '--no-ext-diff'])))
    const fresh = git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
    for (const f of fresh) {
      if (riskyName(f)) found.push({ file: f, line: 0, rule: 'file', what: 'a file that usually holds secrets, not yet ignored', weak: false, preview: f, key: fingerprint('file', f) })
      try {
        const p = join(root, f)
        if (statSync(p).size > 1024 * 1024) continue
        const buf = readFileSync(p)
        if (buf.includes(0)) continue
        found.push(...scanFile(f, buf.toString('utf8')))
      } catch {
        /* gone or unreadable */
      }
    }
  }
  const ok = allowed(root)
  const seen = new Set()
  return found.filter((f) => {
    const id = `${f.file}:${f.line}:${f.key}`
    if (seen.has(id) || ok.keys.has(f.key) || ok.files.has(f.file)) return false
    seen.add(id)
    return true
  })
}

// ---------------------------------------------------------------- as a git hook

function hook() {
  let root
  try {
    root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  } catch {
    process.exit(0)
  }
  if (!existsSync(root)) process.exit(0)
  let found
  try {
    found = scanProject(root, { staged: true })
  } catch (e) {
    // a broken check must never block every commit
    process.stderr.write(`[Prism] could not check this commit for secrets: ${e.message}\n`)
    process.exit(0)
  }
  if (!found.length) process.exit(0)
  const lines = found.slice(0, 20).map((f) => `  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.what}${f.weak ? ' (maybe)' : ''}\n      ${f.preview}`)
  process.stderr.write(
    `\n[Prism] This commit would save ${found.length === 1 ? 'something that looks like a secret' : `${found.length} things that look like secrets`} into the history:\n\n${lines.join('\n')}\n\n` +
      'Take them out (or move them somewhere git ignores), then commit again.\n' +
      'If one is not a secret, let it through from the Safety panel in Prism, or commit with --no-verify.\n\n'
  )
  process.exit(1)
}

if (process.argv.includes('--hook') && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) hook()
