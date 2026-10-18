// Common MCP servers that can be added with one click. Each entry is the
// command its own documentation gives; {name} in an argument is filled from
// the entry's inputs. Inputs marked `secret` are kept in the vault and handed
// to the server as an environment variable.

export interface CatalogInput {
  key: string
  label: string
  placeholder?: string
  /** Start with the open project's folder. */
  workspace?: boolean
  /** Kept in the encrypted vault and passed as this environment variable. */
  secret?: string
  hint?: string
}

export interface CatalogEntry {
  id: string
  name: string
  blurb: string
  /** Part of the command line that gives the server away, however it was added. */
  match: string
  /** The program that starts it; the page says when it is missing. */
  needs: 'npx' | 'uvx' | 'docker'
  command: string
  args: string[]
  inputs?: CatalogInput[]
  note?: string
  link: string
}

export const NEEDS: Record<CatalogEntry['needs'], { label: string; get: string; url: string }> = {
  npx: { label: 'Node.js', get: 'Install Node.js', url: 'https://nodejs.org/' },
  uvx: { label: 'uv', get: 'Install uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' },
  docker: { label: 'Docker', get: 'Install Docker Desktop', url: 'https://www.docker.com/products/docker-desktop/' }
}

export const MCP_CATALOG: CatalogEntry[] = [
  {
    id: 'playwright',
    match: '@playwright/mcp',
    name: 'Playwright',
    blurb: 'Drives a real web browser: open pages, click, type, read what is there.',
    needs: 'npx',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    link: 'https://github.com/microsoft/playwright-mcp'
  },
  {
    id: 'chrome-devtools',
    match: 'chrome-devtools-mcp',
    name: 'Chrome DevTools',
    blurb: 'Inspects a page in Chrome: console, network, performance traces, screenshots.',
    needs: 'npx',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    link: 'https://github.com/ChromeDevTools/chrome-devtools-mcp'
  },
  {
    id: 'context7',
    match: 'context7-mcp',
    name: 'Context7',
    blurb: 'Looks up current documentation for libraries, so answers match the version you use.',
    needs: 'npx',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    link: 'https://github.com/upstash/context7'
  },
  {
    id: 'fetch',
    match: 'mcp-server-fetch',
    name: 'Fetch',
    blurb: 'Reads web pages and hands them over as clean text.',
    needs: 'uvx',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    link: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch'
  },
  {
    id: 'filesystem',
    match: 'server-filesystem',
    name: 'Files in another folder',
    blurb: 'Lets the agent read and write a folder outside the open project.',
    needs: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{folder}'],
    inputs: [{ key: 'folder', label: 'Folder', placeholder: 'C:\\Users\\you\\Documents\\notes' }],
    link: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem'
  },
  {
    id: 'git',
    match: 'mcp-server-git',
    name: 'Git',
    blurb: 'Reads and searches a repository: history, diffs, branches.',
    needs: 'uvx',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '{folder}'],
    inputs: [{ key: 'folder', label: 'Repository folder', workspace: true }],
    link: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git'
  },
  {
    id: 'memory',
    match: 'server-memory',
    name: 'Memory',
    blurb: 'A notebook of facts the agent keeps between sessions.',
    needs: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    link: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory'
  },
  {
    id: 'sequential-thinking',
    match: 'server-sequential-thinking',
    name: 'Sequential thinking',
    blurb: 'A scratch space that helps a model work through a hard problem step by step.',
    needs: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    link: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking'
  },
  {
    id: 'time',
    match: 'mcp-server-time',
    name: 'Time',
    blurb: 'The current time and conversions between time zones.',
    needs: 'uvx',
    command: 'uvx',
    args: ['mcp-server-time'],
    link: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time'
  },
  {
    id: 'sqlite',
    match: 'mcp-server-sqlite',
    name: 'SQLite',
    blurb: 'Asks questions of a SQLite database file and can change it.',
    needs: 'uvx',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '{file}'],
    inputs: [{ key: 'file', label: 'Database file', placeholder: 'C:\\path\\to\\data.db' }],
    link: 'https://pypi.org/project/mcp-server-sqlite/'
  },
  {
    id: 'github',
    match: 'github-mcp-server',
    name: 'GitHub',
    blurb: 'Issues, pull requests, code search and more on GitHub.',
    needs: 'docker',
    command: 'docker',
    args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
    inputs: [{ key: 'token', label: 'Personal access token', placeholder: 'github_pat_…', secret: 'GITHUB_PERSONAL_ACCESS_TOKEN', hint: 'Made at github.com, Settings, Developer settings. Kept encrypted on this computer.' }],
    link: 'https://github.com/github/github-mcp-server'
  },
  {
    id: 'blender',
    match: 'blender-mcp',
    name: 'Blender',
    blurb: 'Builds and changes scenes in a running Blender.',
    needs: 'uvx',
    command: 'uvx',
    args: ['blender-mcp'],
    note: 'Blender needs the BlenderMCP add-on installed and its server started from the sidebar.',
    link: 'https://github.com/ahujasid/blender-mcp'
  }
]
