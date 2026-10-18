import { extname, basename } from './format'

const BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.json5': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.vue': 'html',
  '.svelte': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.py': 'python',
  '.pyi': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.cs': 'csharp',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.env': 'ini',
  '.xml': 'xml',
  '.svg': 'xml',
  '.plist': 'xml',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.r': 'r',
  '.dart': 'dart',
  '.scala': 'scala',
  '.pl': 'perl',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.hs': 'haskell',
  '.clj': 'clojure',
  '.zig': 'zig',
  '.glsl': 'c',
  '.hlsl': 'c',
  '.wgsl': 'rust',
  '.proto': 'protobuf',
  '.tf': 'hcl',
  '.gd': 'python',
  '.txt': 'plaintext',
  '.log': 'plaintext',
  '.csv': 'plaintext'
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  cmakelists: 'cmake',
  '.gitignore': 'ini',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
  'package.json': 'json',
  'tsconfig.json': 'json'
}

export function languageFor(path: string): string {
  const name = basename(path).toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]!
  return BY_EXT[extname(path)] ?? 'plaintext'
}

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg'])
export const MODEL3D_EXT = new Set(['.glb', '.gltf', '.obj', '.stl', '.fbx', '.ply', '.3mf'])
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a'])
export const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov'])
export const PDF_EXT = new Set(['.pdf'])
export const HTML_EXT = new Set(['.html', '.htm'])

export type PreviewKind = 'image' | 'model3d' | 'audio' | 'video' | 'pdf' | 'html' | 'markdown' | null

export function previewKindFor(path: string): PreviewKind {
  const e = extname(path)
  if (IMAGE_EXT.has(e)) return 'image'
  if (MODEL3D_EXT.has(e)) return 'model3d'
  if (AUDIO_EXT.has(e)) return 'audio'
  if (VIDEO_EXT.has(e)) return 'video'
  if (PDF_EXT.has(e)) return 'pdf'
  if (HTML_EXT.has(e)) return 'html'
  if (e === '.md' || e === '.markdown') return 'markdown'
  return null
}

/** Files that open in a viewer rather than the editor. */
export function opensInPreview(path: string): boolean {
  const k = previewKindFor(path)
  return k !== null && k !== 'markdown' && k !== 'html'
}
