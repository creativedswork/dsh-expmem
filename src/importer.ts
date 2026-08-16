import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import {
  FileExperienceArchive,
  type ImportedMemorySource,
} from './storage.js'

export type ImportProvider = 'claude' | 'codex'
export type ImportStatus = 'created' | 'updated' | 'skipped' | 'ignored'

export interface MemoryImportOptions {
  provider: ImportProvider
  sourceDir?: string
  rootDir: string
  workspace?: string
  dryRun?: boolean
}

export interface MemoryImportItem {
  path: string
  title?: string
  status: ImportStatus
  id?: string
}

export interface MemoryImportResult {
  provider: ImportProvider
  sourceDir: string
  rootDir: string
  scanned: number
  created: number
  updated: number
  skipped: number
  ignored: number
  dryRun: boolean
  items: MemoryImportItem[]
}

const MAX_IMPORT_CHARS = 1_000_000
const IMPORT_LIMITS = {
  maxEntryChars: MAX_IMPORT_CHARS,
  maxPreviewChars: 1,
  maxSearchResults: 1,
}

/** Import Markdown memories from Claude Code or Codex into the ExpMem Archive. */
export async function importMemories(options: MemoryImportOptions): Promise<MemoryImportResult> {
  const sourceDir = resolve(options.sourceDir ?? defaultMemoryDir(options.provider))
  const rootDir = resolve(options.rootDir)
  const archive = new FileExperienceArchive(rootDir, IMPORT_LIMITS)
  if (!options.dryRun) await archive.initialize()

  const files = await markdownFiles(sourceDir)
  const existing = new Map(
    (await archive.list())
      .filter(memory => memory.importedFrom !== undefined)
      .map(memory => [importKey(memory.importedFrom!), memory]),
  )
  const workspaceByProject = options.provider === 'claude' && options.workspace === undefined
    ? await claudeWorkspaceMap()
    : new Map<string, string>()
  const items: MemoryImportItem[] = []

  for (const path of files) {
    const content = (await readFile(path, 'utf8')).trim()
    if (content.length === 0) {
      items.push({ path, status: 'ignored' })
      continue
    }
    if (content.length > MAX_IMPORT_CHARS) {
      throw new Error(`memory file exceeds ${MAX_IMPORT_CHARS} characters: ${path}`)
    }

    const importedFrom: ImportedMemorySource = {
      provider: options.provider,
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    }
    const previous = existing.get(importKey(importedFrom))
    const title = markdownTitle(content, path)
    if (previous?.importedFrom?.sha256 === importedFrom.sha256) {
      items.push({ path, title, status: 'skipped', id: previous.id })
      continue
    }

    const status = previous === undefined ? 'created' : 'updated'
    if (options.dryRun) {
      items.push({
        path,
        title,
        status,
        ...previous === undefined ? {} : { id: previous.id },
      })
      continue
    }

    const workspace = options.workspace
      ?? previous?.workspace
      ?? claudeWorkspace(path, sourceDir, workspaceByProject)
    const memory = await archive.write({
      ...previous === undefined ? {} : { id: previous.id },
      kind: previous?.kind ?? 'experience',
      title,
      content,
      tags: importTags(options.provider, path),
      importedFrom,
    }, workspace === undefined ? {} : { workspace })
    existing.set(importKey(importedFrom), memory)
    items.push({ path, title, status, id: memory.id })
  }

  return {
    provider: options.provider,
    sourceDir,
    rootDir,
    scanned: files.length,
    created: count(items, 'created'),
    updated: count(items, 'updated'),
    skipped: count(items, 'skipped'),
    ignored: count(items, 'ignored'),
    dryRun: options.dryRun ?? false,
    items,
  }
}

/** Default generated-memory directory for one coding agent. */
export function defaultMemoryDir(provider: ImportProvider): string {
  if (provider === 'claude') {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    return join(claudeHome, 'projects')
  }
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'memories')
}

async function markdownFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await markdownFiles(path))
    else if (entry.isFile() && extname(entry.name).toLocaleLowerCase() === '.md') files.push(path)
  }
  return files.sort()
}

function importKey(source: ImportedMemorySource): string {
  return `${source.provider}\0${source.path}`
}

function markdownTitle(content: string, path: string): string {
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/mu.exec(content)?.[1]?.trim()
  if (heading !== undefined && heading.length > 0) return heading
  const stem = basename(path, extname(path)).replace(/[-_]+/gu, ' ').trim()
  return stem.length === 0 ? 'Imported memory' : stem
}

function importTags(provider: ImportProvider, path: string): string[] {
  return [
    'imported',
    provider === 'claude' ? 'claude-code' : 'codex',
    basename(path, extname(path)).toLocaleLowerCase(),
  ]
}

async function claudeWorkspaceMap(): Promise<Map<string, string>> {
  let raw: string
  try {
    raw = await readFile(join(homedir(), '.claude.json'), 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return new Map()
    throw error
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || !isRecord(value.projects)) return new Map()
    const byKey = new Map<string, string[]>()
    for (const workspace of Object.keys(value.projects)) {
      const key = workspace.replace(/[^a-z0-9]/giu, '-')
      byKey.set(key, [...byKey.get(key) ?? [], workspace])
    }
    return new Map(
      [...byKey]
        .filter((entry): entry is [string, [string]] => entry[1].length === 1)
        .map(([key, [workspace]]) => [key, workspace]),
    )
  } catch {
    return new Map()
  }
}

function claudeWorkspace(
  path: string,
  sourceDir: string,
  workspaceByProject: Map<string, string>,
): string | undefined {
  const parts = relative(sourceDir, path).split(sep)
  return parts.length >= 3 && parts[1] === 'memory'
    ? workspaceByProject.get(parts[0]!)
    : undefined
}

function count(items: MemoryImportItem[], status: ImportStatus): number {
  return items.filter(item => item.status === status).length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
