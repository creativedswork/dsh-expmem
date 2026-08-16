import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

/** Stable categories for reusable personal development experience. */
export type ExperienceKind = 'habit' | 'experience' | 'insight'

/** One actively maintained experience-memory record stored as JSON. */
export interface ExperienceMemory {
  version: 1
  id: string
  kind: ExperienceKind
  title: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
  workspace?: string
  sourceSession?: string
}

/** One Archive search result. */
export interface ExperienceSearchHit {
  id: string
  kind: ExperienceKind
  title: string
  text: string
  tags: string[]
  timestamp: number
  path: string
  workspace?: string
}

/** Cursor-based Archive search page. */
export interface ExperienceSearchPage {
  hits: ExperienceSearchHit[]
  nextCursor?: string
}

/** Inputs for creating or updating one experience memory. */
export interface ExperienceWriteInput {
  kind: ExperienceKind
  title: string
  content: string
  tags?: string[]
  id?: string
}

/** Session provenance attached to an Archive write. */
export interface ExperienceSource {
  sessionId?: string
  workspace?: string
}

/** Archive search filters and pagination. */
export interface ExperienceSearchOptions {
  query: string
  kinds?: ExperienceKind[]
  workspace?: string
  limit: number
  cursor?: string
}

/** Deployment limits resolved by the plugin. */
export interface ArchiveLimits {
  maxEntryChars: number
  maxPreviewChars: number
  maxSearchResults: number
}

const EXPERIENCE_KINDS: readonly ExperienceKind[] = ['habit', 'experience', 'insight']
const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Transparent JSON-file Archive for DSH ExpMem. */
export class FileExperienceArchive {
  constructor(
    readonly rootDir: string,
    private readonly limits: ArchiveLimits,
  ) {}

  /** Create the owned Archive directory. */
  async initialize(): Promise<void> {
    await mkdir(join(this.rootDir, 'archive'), { recursive: true, mode: 0o700 })
  }

  /** Create or replace one experience memory. */
  async write(input: ExperienceWriteInput, source: ExperienceSource): Promise<ExperienceMemory> {
    const title = requiredText(input.title, 'title')
    const content = requiredText(input.content, 'content')
    if (content.length > this.limits.maxEntryChars) {
      throw new Error(`ExpMem content exceeds maxEntryChars (${this.limits.maxEntryChars})`)
    }
    const tags = [...new Set((input.tags ?? []).map(tag => tag.trim()).filter(Boolean))]
    const id = input.id ?? randomUUID()
    if (!MEMORY_ID.test(id)) throw new Error('ExpMem id must be a UUID')

    const path = this.memoryPath(input.kind, id)
    const previous = input.id === undefined ? undefined : await this.read(path)
    const now = Date.now()
    const memory: ExperienceMemory = {
      version: 1,
      id,
      kind: input.kind,
      title,
      content,
      tags,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...source.workspace === undefined ? {} : { workspace: source.workspace },
      ...source.sessionId === undefined ? {} : { sourceSession: source.sessionId },
    }
    await atomicJsonWrite(path, memory)
    return memory
  }

  /** Delete one experience memory by category and id. */
  async forget(kind: ExperienceKind, id: string): Promise<void> {
    if (!MEMORY_ID.test(id)) throw new Error('ExpMem id must be a UUID')
    await rm(this.memoryPath(kind, id))
  }

  /** Search the Archive using case-insensitive AND terms. */
  async search(options: ExperienceSearchOptions): Promise<ExperienceSearchPage> {
    const offset = parseCursor(options.cursor)
    if (!Number.isSafeInteger(options.limit)
      || options.limit < 1
      || options.limit > this.limits.maxSearchResults) {
      throw new Error(`limit must be between 1 and ${this.limits.maxSearchResults}`)
    }
    const terms = options.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    const hits: ExperienceSearchHit[] = []

    // ponytail: linear scans keep files transparent; add an index only when measured corpus size requires it.
    for (const kind of options.kinds ?? EXPERIENCE_KINDS) {
      const directory = join(this.rootDir, 'archive', kind)
      for (const name of await jsonFiles(directory)) {
        const path = join(directory, name)
        const memory = await this.read(path)
        if (memory === undefined) continue
        if (options.workspace !== undefined && memory.workspace !== options.workspace) continue
        const searchable = [
          memory.kind,
          memory.title,
          memory.content,
          memory.tags.join(' '),
          memory.workspace ?? '',
        ].join('\n').toLocaleLowerCase()
        if (!terms.every(term => searchable.includes(term))) continue
        hits.push({
          id: memory.id,
          kind: memory.kind,
          title: memory.title,
          text: preview(memory.content, this.limits.maxPreviewChars),
          tags: memory.tags,
          timestamp: memory.updatedAt,
          path: relative(this.rootDir, path),
          ...memory.workspace === undefined ? {} : { workspace: memory.workspace },
        })
      }
    }
    hits.sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))
    const page = hits.slice(offset, offset + options.limit)
    const nextOffset = offset + page.length
    return {
      hits: page,
      ...(nextOffset < hits.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  private async read(path: string): Promise<ExperienceMemory | undefined> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        if (MEMORY_ID.test(basename(path, '.json'))) {
          throw new Error(`ExpMem record not found: ${relative(this.rootDir, path)}`)
        }
        return undefined
      }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error(`invalid ExpMem JSON: ${relative(this.rootDir, path)}`)
    }
    if (!isExperienceMemory(value)) {
      throw new Error(`invalid ExpMem record: ${relative(this.rootDir, path)}`)
    }
    return value
  }

  private memoryPath(kind: ExperienceKind, id: string): string {
    return join(this.rootDir, 'archive', kind, `${id}.json`)
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function jsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort()
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return []
    throw error
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error('cursor is invalid')
  const value = Number(cursor)
  if (!Number.isSafeInteger(value)) throw new Error('cursor is invalid')
  return value
}

function preview(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`
}

function requiredText(value: string, name: string): string {
  const text = value.trim()
  if (text.length === 0) throw new Error(`${name} must not be empty`)
  return text
}

function isExperienceMemory(value: unknown): value is ExperienceMemory {
  return isRecord(value)
    && value.version === 1
    && typeof value.id === 'string'
    && MEMORY_ID.test(value.id)
    && EXPERIENCE_KINDS.includes(value.kind as ExperienceKind)
    && typeof value.title === 'string'
    && typeof value.content === 'string'
    && Array.isArray(value.tags)
    && value.tags.every(tag => typeof tag === 'string')
    && Number.isSafeInteger(value.createdAt)
    && Number.isSafeInteger(value.updatedAt)
    && (value.workspace === undefined || typeof value.workspace === 'string')
    && (value.sourceSession === undefined || typeof value.sourceSession === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
