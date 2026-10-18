// Builds the installer for the platform it runs on.
//   Windows: dist/Prism-Setup-<version>.exe
//   Linux:   dist/Prism-<version>.AppImage and dist/prism-<version>.tar.gz (run it on Linux or in WSL;
//            node-pty has no prebuilt Linux binary, so run `pnpm rebuild:pty` there first)
//
//   corepack pnpm dist           the installer
//   corepack pnpm dist --dir     only the unpacked app, for a quick check
//   corepack pnpm dist --out X   put the installers in folder X instead of dist
//
// Everything else (staging, the unpacked app) is built under the system temp
// folder, out of reach of Windows search: a runnable Prism.exe left in the
// user's folders once got launched by mistake instead of the installed one.
// The unpacked app stays at <temp>/prism-build/<version>/<win|linux>-unpacked
// for smoke tests until the next build of that version.
//
// The app is staged by hand instead of letting electron-builder walk
// node_modules: the renderer and almost all of main are already bundled into
// out/, so the only things that must ship as files are node-pty (a native
// module), TypeScript (the refactoring engine reads its library files from
// disk) and the ripgrep binary. Staging them explicitly keeps the installer
// small and does not depend on how pnpm lays out node_modules.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dirOnly = process.argv.includes('--dir')
const outAt = process.argv.indexOf('--out')
const outDir = outAt > 0 && process.argv[outAt + 1] ? resolve(process.argv[outAt + 1]) : join(root, 'dist')
const work = join(tmpdir(), 'prism-build', pkg.version)
const stage = join(work, 'stage')
const stageRes = join(work, 'stage-resources')
const buildOut = join(work, 'out')
rmSync(work, { recursive: true, force: true })

const step = (s) => console.log(`\n[package] ${s}`)

step('building the app')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
execFileSync(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: root, stdio: 'inherit', env })

step('staging')
rmSync(stage, { recursive: true, force: true })
rmSync(stageRes, { recursive: true, force: true })
mkdirSync(join(stage, 'node_modules'), { recursive: true })
mkdirSync(join(stageRes, 'bin'), { recursive: true })
cpSync(join(root, 'out'), join(stage, 'out'), { recursive: true, filter: (src) => !src.endsWith('.built-rev') })
const tsDir = dirname(require.resolve('typescript/package.json'))
const tsVersion = JSON.parse(readFileSync(join(tsDir, 'package.json'), 'utf8')).version
const ptyVersion = JSON.parse(readFileSync(join(dirname(require.resolve('node-pty/package.json')), 'package.json'), 'utf8')).version
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({ name: pkg.name, productName: 'Prism', desktopName: 'prism.desktop', version: pkg.version, description: pkg.description, author: pkg.author, license: pkg.license, main: pkg.main, packageManager: 'traversal@1', dependencies: { 'node-pty': ptyVersion, typescript: tsVersion } }, null, 2)
)

// node-pty: its JavaScript and the prebuilt binaries for this platform, nothing else
const pty = dirname(require.resolve('node-pty/package.json'))
const ptyOut = join(stage, 'node_modules', 'node-pty')
mkdirSync(ptyOut, { recursive: true })
cpSync(join(pty, 'lib'), join(ptyOut, 'lib'), { recursive: true, filter: (src) => !/\.test\.js(\.map)?$|\.map$/.test(src) })
const prebuilt = join(pty, 'prebuilds', `${process.platform}-${process.arch}`)
const compiled = join(pty, 'build', 'Release')
if (existsSync(prebuilt)) {
  cpSync(prebuilt, join(ptyOut, 'prebuilds', `${process.platform}-${process.arch}`), { recursive: true, filter: (src) => !src.endsWith('.pdb') })
} else if (existsSync(join(compiled, 'pty.node'))) {
  // no prebuilt binary for this platform (Linux): the one compiled here for Electron by pnpm rebuild:pty
  mkdirSync(join(ptyOut, 'build', 'Release'), { recursive: true })
  for (const f of readdirSync(compiled)) if (/\.node$|^spawn-helper$/.test(f)) cpSync(join(compiled, f), join(ptyOut, 'build', 'Release', f))
} else throw new Error(`node-pty has no binaries for ${process.platform}-${process.arch}: run "pnpm rebuild:pty" first`)
const ptyPkg = JSON.parse(readFileSync(join(pty, 'package.json'), 'utf8'))
// its listed dependency (node-addon-api) and install script are only needed to compile it
writeFileSync(join(ptyOut, 'package.json'), JSON.stringify({ name: ptyPkg.name, version: ptyPkg.version, main: ptyPkg.main, license: ptyPkg.license }, null, 2))
if (existsSync(join(pty, 'LICENSE'))) cpSync(join(pty, 'LICENSE'), join(ptyOut, 'LICENSE'))

// TypeScript: the compiler itself and the .d.ts files that describe the language's built-ins
const tsOut = join(stage, 'node_modules', 'typescript')
mkdirSync(join(tsOut, 'lib'), { recursive: true })
cpSync(join(tsDir, 'lib', 'typescript.js'), join(tsOut, 'lib', 'typescript.js'))
for (const f of readdirSync(join(tsDir, 'lib'))) if (/^lib\..*\.d\.ts$/.test(f)) cpSync(join(tsDir, 'lib', f), join(tsOut, 'lib', f))
writeFileSync(join(tsOut, 'package.json'), JSON.stringify({ name: 'typescript', version: tsVersion, main: './lib/typescript.js', license: 'Apache-2.0' }, null, 2))
for (const f of ['LICENSE.txt', 'ThirdPartyNoticeText.txt']) if (existsSync(join(tsDir, f))) cpSync(join(tsDir, f), join(tsOut, f))

// ripgrep: one executable, found at run time under resources/bin (see core/fs/search.ts)
const rg = require('@vscode/ripgrep').rgPath
const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg'
if (!rg || !existsSync(rg)) throw new Error('ripgrep binary not found')
cpSync(rg, join(stageRes, 'bin', rgName))
console.log(`  typescript ${tsVersion}; node-pty ${ptyPkg.version}, ${existsSync(join(ptyOut, 'build')) ? 'compiled here' : 'prebuilt'}; ripgrep from ${rg}`)

step(dirOnly ? 'packing (unpacked app only)' : 'packing and building the installer')
const { build, Platform } = require('electron-builder')
const linux = process.platform === 'linux'
const electronVersion = JSON.parse(readFileSync(join(dirname(require.resolve('electron/package.json')), 'package.json'), 'utf8')).version
await build({
  targets: linux ? Platform.LINUX.createTarget(dirOnly ? 'dir' : ['AppImage', 'tar.gz']) : Platform.WINDOWS.createTarget(dirOnly ? 'dir' : 'nsis'),
  projectDir: stage,
  config: {
    appId: 'com.valware.prism',
    productName: 'Prism',
    copyright: 'Copyright © Valerie Liu',
    directories: { output: buildOut, buildResources: join(root, 'build') },
    electronVersion,
    electronDist: join(dirname(require.resolve('electron/package.json')), 'dist'),
    asar: true,
    asarUnpack: ['node_modules/node-pty/**'],
    // node-pty ships prebuilt binaries; nothing needs compiling
    npmRebuild: false,
    nodeGypRebuild: false,
    // icon.png goes beside the program for the notification-area icon (main/float.ts),
    // face/ holds the face shown in calls (main/face.ts), and gadgets/ the gadgets that
    // come with Prism (core/gadgets/manager.ts)
    extraResources: [{ from: join(stageRes, 'bin'), to: 'bin' }, { from: join(root, 'build', 'icon.png'), to: 'icon.png' }, { from: join(root, 'build', 'face'), to: 'face' }, { from: join(root, 'build', 'gadgets'), to: 'gadgets', filter: ['**/*', '!**/node_modules/**'] }],
    win: { icon: join(root, 'build', 'icon.ico'), executableName: 'Prism' },
    linux: { icon: join(root, 'build', 'icon.png'), executableName: 'prism', syncDesktopName: true, category: 'Development', synopsis: 'An agentic code editor for any model', maintainer: 'Valerie Liu <v.a.pond@outlook.com>', artifactName: '${productName}-${version}.${ext}' },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      // both are created, then build/installer.nsh removes the ones unticked on its page
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Prism',
      uninstallDisplayName: 'Prism',
      artifactName: 'Prism-Setup-${version}.${ext}',
      include: join(root, 'build', 'installer.nsh'),
      installerIcon: join(root, 'build', 'icon.ico'),
      uninstallerIcon: join(root, 'build', 'icon.ico')
    }
  }
})
const unpacked = join(buildOut, linux ? 'linux-unpacked' : 'win-unpacked')
if (dirOnly) step(`done: ${unpacked}`)
else {
  mkdirSync(outDir, { recursive: true })
  const made = readdirSync(buildOut).filter((f) => /\.(exe|AppImage|tar\.gz)$/.test(f) && f.includes(pkg.version) && !f.includes('__uninstaller'))
  for (const f of made) cpSync(join(buildOut, f), join(outDir, f))
  rmSync(stage, { recursive: true, force: true })
  rmSync(stageRes, { recursive: true, force: true })
  step(`done: ${made.map((f) => join(outDir, f)).join(', ')}
  unpacked app for testing: ${unpacked}`)
}
