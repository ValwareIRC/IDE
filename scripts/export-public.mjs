// Makes the public copy of Prism: the committed code, without what is one person's own,
// in a folder of its own with a history of its own. The private history is never part of
// it: the first run makes one commit, and each later run adds one commit with whatever
// changed since, so the public repo grows release by release.
//
//   node scripts/export-public.mjs <folder>            e.g. ..\IDE-public
//   node scripts/export-public.mjs <folder> --dry      list what would go, change nothing
//
// It only ever exports what is committed (HEAD), never the working tree, so a half-made
// change or a stray test file cannot slip out. Pushing is a separate step, done by hand.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const target = args.find((a) => !a.startsWith('--'))
if (!target) {
  console.error('Say where the public copy goes: node scripts/export-public.mjs <folder>')
  process.exit(1)
}
const out = resolve(target)

/** One person's own: their project's tooling and settings, their notes for their agent. */
const PRIVATE = [/^\.prism\//, /^CLAUDE\.md$/, /^docs\/ai\/big-build-[^/]*\.md$/]

const git = (cwd, ...a) => execFileSync('git', a, { cwd, maxBuffer: 1 << 30 })
const files = git(repo, 'ls-tree', '-r', '-z', '--name-only', 'HEAD')
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
const going = files.filter((f) => !PRIVATE.some((p) => p.test(f)))
const version = JSON.parse(git(repo, 'show', 'HEAD:package.json').toString('utf8')).version

if (dry) {
  console.log(going.join('\n'))
  console.log(`\n${going.length} files go out, ${files.length - going.length} stay private: ${files.filter((f) => !going.includes(f)).join(', ')}`)
  process.exit(0)
}

const fresh = !existsSync(join(out, '.git'))
mkdirSync(out, { recursive: true })
if (fresh) git(out, 'init', '-q', '-b', 'main')
// the folder is made exactly like HEAD: everything but its own .git is replaced
for (const name of readdirSync(out)) if (name !== '.git') rmSync(join(out, name), { recursive: true, force: true })
for (const f of going) {
  const dest = join(out, f)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, git(repo, 'show', `HEAD:${f}`))
}

git(out, 'add', '-A')
const changed = git(out, 'status', '--porcelain').toString().trim()
if (!changed) {
  console.log(`Nothing changed since the last export (Prism ${version}).`)
  process.exit(0)
}
const who = ['-c', 'user.name=Valerie Liu', '-c', 'user.email=v.a.pond@outlook.com']
git(out, ...who, 'commit', '-q', '-m', fresh ? `Prism ${version}` : `Prism ${version}`)
console.log(`${fresh ? 'Made' : 'Updated'} the public copy in ${out}: Prism ${version}, ${going.length} files.`)
