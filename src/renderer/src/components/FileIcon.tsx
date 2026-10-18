import {
  Box,
  Braces,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  FileType2,
  Folder,
  FolderOpen,
  Hash,
  Image,
  Music,
  Package,
  Settings2,
  Terminal,
  Video,
  FileLock2,
  BookOpen,
  Cog
} from 'lucide-react'
import { extname } from '@/lib/format'

const COLORS: Record<string, string> = {
  ts: '#8ad8ff',
  tsx: '#8ad8ff',
  js: '#f2d27a',
  jsx: '#f2d27a',
  mjs: '#f2d27a',
  json: '#ffc46b',
  md: '#a7aec0',
  css: '#b9a7ff',
  scss: '#b9a7ff',
  html: '#ff8fab',
  py: '#7ee8c3',
  rs: '#ffb27a',
  go: '#8ad8ff',
  cs: '#b9a7ff',
  cpp: '#8ad8ff',
  c: '#8ad8ff',
  h: '#8ad8ff',
  sh: '#7ee8c3',
  ps1: '#8ad8ff',
  toml: '#a7aec0',
  yml: '#ff8fab',
  yaml: '#ff8fab'
}

export function FileIcon({ name, dir, open, size = 14 }: { name: string; dir?: boolean; open?: boolean; size?: number }): React.JSX.Element {
  if (dir) return open ? <FolderOpen size={size} /> : <Folder size={size} />
  const ext = extname(name).slice(1)
  const color = COLORS[ext]
  const lower = name.toLowerCase()
  const style = color ? { color } : undefined
  if (lower === 'package.json' || lower === 'pnpm-lock.yaml' || lower === 'cargo.toml') return <Package size={size} style={style} />
  if (lower.startsWith('.env') || lower.includes('secret')) return <FileLock2 size={size} style={style} />
  if (lower === 'readme.md' || lower === 'prism.md' || lower === 'agents.md' || lower === 'claude.md') return <BookOpen size={size} style={{ color: '#8ad8ff' }} />
  switch (ext) {
    case 'json':
    case 'jsonc':
      return <FileJson2 size={size} style={style} />
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
    case 'py':
    case 'rs':
    case 'go':
    case 'c':
    case 'h':
    case 'cpp':
    case 'cs':
    case 'java':
    case 'kt':
    case 'rb':
    case 'php':
    case 'lua':
    case 'swift':
    case 'dart':
      return <FileCode2 size={size} style={style} />
    case 'css':
    case 'scss':
    case 'less':
      return <Hash size={size} style={style} />
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return <Braces size={size} style={style} />
    case 'md':
    case 'mdx':
    case 'txt':
    case 'log':
      return <FileText size={size} style={style} />
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'ico':
    case 'avif':
      return <Image size={size} style={{ color: '#b9a7ff' }} />
    case 'svg':
      return <FileImage size={size} style={{ color: '#b9a7ff' }} />
    case 'glb':
    case 'gltf':
    case 'obj':
    case 'fbx':
    case 'stl':
    case 'blend':
      return <Box size={size} style={{ color: '#7ee8c3' }} />
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'flac':
      return <Music size={size} style={style} />
    case 'mp4':
    case 'webm':
    case 'mov':
      return <Video size={size} style={style} />
    case 'sh':
    case 'bash':
    case 'ps1':
    case 'bat':
    case 'cmd':
      return <Terminal size={size} style={style} />
    case 'yml':
    case 'yaml':
    case 'toml':
    case 'ini':
    case 'cfg':
      return <Settings2 size={size} style={style} />
    case 'ttf':
    case 'otf':
    case 'woff':
    case 'woff2':
      return <FileType2 size={size} style={style} />
    default:
      return lower.includes('config') ? <Cog size={size} /> : <FileText size={size} />
  }
}
