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
import {
  EXPERIENCE_KINDS,
  MemorySchemaError,
  assertMemoryId,
  claimSha256,
  isMemoryStatus,
  normalizeEvidenceInput,
  normalizeMemory,
  normalizeTombstone,
  normalizeVerificationInput,
  type DeletionReasonCode,
  type ExperienceKind,
  type ExperienceMemory,
  type ImportedMemorySource,
  type MemoryActor,
  type MemoryEvidence,
  type MemoryEvidenceInput,
  type MemoryStatus,
  type MemoryTombstone,
  type MemoryVerification,
  type MemoryVerificationInput,
} from './schema.js'

export type {
  DeletionReasonCode,
  ExperienceKind,
  ExperienceMemory,
  ImportedMemorySource,
  MemoryActor,
  MemoryEvidence,
  MemoryEvidenceInput,
  MemoryStatus,
  MemoryTombstone,
  MemoryVerification,
  MemoryVerificationInput,
} from './schema.js'

/** One Archive search result. */
export interface ExperienceSearchHit {
  id: string
  kind: ExperienceKind
  title: string
  text: string
  tags: string[]
  timestamp: number
  path: string
  status: MemoryStatus
  authoredBy: MemoryActor
  evidence: MemoryEvidence[]
  claimSha256: string
  workspace?: string
  verification?: MemoryVerification
  supersedes?: string[]
  supersededBy?: string
  conflictsWith?: string[]
  importedFrom?: ImportedMemorySource
}

/** Cursor-based Archive search page. */
export interface ExperienceSearchPage {
  hits: ExperienceSearchHit[]
  warnings: ArchiveWarning[]
  nextCursor?: string
}

/** Inputs for creating or updating one candidate memory. */
export interface ExperienceWriteInput {
  kind: ExperienceKind
  title: string
  content: string
  tags?: string[]
  id?: string
  authoredBy?: MemoryActor
  evidence?: MemoryEvidenceInput[]
  evidenceText?: string
  claimedAt?: number
  /** @deprecated Use imported-file evidence. */
  importedFrom?: ImportedMemorySource
}

/** Inputs for a lifecycle transition or metadata append. */
export interface ExperienceTransitionInput {
  kind: ExperienceKind
  id: string
  status: 'verified' | 'disputed'
  evidence?: MemoryEvidenceInput[]
  evidenceText?: string
  verification?: MemoryVerificationInput
  supersedes?: string[]
  conflictsWith?: string[]
}

/** Session provenance attached to an Archive write. */
export interface ExperienceSource {
  sessionId?: string
  workspace?: string
  actor?: MemoryActor
}

/** Archive search filters and pagination. */
export interface ExperienceSearchOptions {
  query: string
  kinds?: ExperienceKind[]
  statuses?: MemoryStatus[]
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

export interface ArchiveWarning {
  path: string
  code: 'invalid-json' | 'invalid-record' | 'unsupported-schema'
  message: string
}

export interface ArchiveScanResult {
  memories: ExperienceMemory[]
  warnings: ArchiveWarning[]
}

interface LoadedArchive extends ArchiveScanResult {
  tombstones: Map<string, MemoryTombstone>
}

interface ResolvedArchive {
  memories: ExperienceMemory[]
  supersededBy: Map<string, string>
  conflicts: Map<string, Set<string>>
}

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

  /** Create or update a candidate memory. */
  async writeCandidate(
    input: ExperienceWriteInput,
    source: ExperienceSource,
  ): Promise<ExperienceMemory> {
    const title = requiredText(input.title, 'title')
    const content = requiredText(input.content, 'content')
    if (content.length > this.limits.maxEntryChars) {
      throw new Error(`ExpMem content exceeds maxEntryChars (${this.limits.maxEntryChars})`)
    }
    const id = input.id ?? randomUUID()
    assertMemoryId(id)
    const previous = input.id === undefined
      ? undefined
      : await this.readRecord(input.kind, input.id)
    if (previous !== undefined && previous.status !== 'candidate') {
      throw new Error(`ExpMem ${previous.status} memory cannot be edited; create a new candidate`)
    }

    const now = Date.now()
    let evidence = input.evidence === undefined
      ? [...previous?.evidence ?? []]
      : input.evidence.map(item => normalizeEvidenceInput(item, now))
    if (input.importedFrom !== undefined) {
      evidence = [
        ...evidence.filter(item => item.kind !== 'imported-file'
          || item.provider !== input.importedFrom!.provider
          || item.path !== input.importedFrom!.path),
        normalizeEvidenceInput(legacyImportEvidence(input.importedFrom), now),
      ]
    }
    evidence = addSourceEvidence(dedupeEvidence(evidence), source.sessionId, now)

    const memory = normalizeMemory({
      schemaVersion: 1,
      id,
      kind: input.kind,
      title,
      content,
      tags: normalizedTags(input.tags ?? previous?.tags ?? []),
      status: 'candidate',
      authoredBy: previous?.authoredBy
        ?? input.authoredBy
        ?? source.actor
        ?? { kind: 'agent', ...(source.sessionId === undefined ? {} : { id: source.sessionId }) },
      evidence,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(input.evidenceText === undefined
        ? previous?.evidenceText === undefined ? {} : { evidenceText: previous.evidenceText }
        : { evidenceText: requiredText(input.evidenceText, 'evidenceText') }),
      ...(input.claimedAt === undefined
        ? previous?.claimedAt === undefined ? {} : { claimedAt: previous.claimedAt }
        : { claimedAt: input.claimedAt }),
      ...(source.workspace === undefined
        ? previous?.workspace === undefined ? {} : { workspace: previous.workspace }
        : { workspace: source.workspace }),
    })
    await atomicJsonWrite(this.memoryPath(memory.kind, memory.id), memory)
    return memory
  }

  /** Backward-compatible alias for candidate writes. */
  async write(input: ExperienceWriteInput, source: ExperienceSource): Promise<ExperienceMemory> {
    return await this.writeCandidate(input, source)
  }

  /** Apply a verified/disputed transition and relation changes. */
  async transition(
    input: ExperienceTransitionInput,
    source: ExperienceSource = {},
  ): Promise<ExperienceMemory> {
    assertMemoryId(input.id)
    const loaded = await this.loadArchive()
    const resolved = resolveArchive(loaded.memories)
    const previous = resolved.memories.find(
      memory => memory.kind === input.kind && memory.id === input.id,
    )
    if (previous === undefined) throw new Error(`ExpMem record not found: ${input.kind}/${input.id}`)
    if (previous.status === 'superseded') {
      throw new Error('ExpMem superseded memory is terminal')
    }
    if (!validTransition(previous.status, input.status)) {
      throw new Error(`invalid ExpMem transition: ${previous.status} -> ${input.status}`)
    }
    if (input.status === 'disputed' && input.verification !== undefined) {
      throw new Error('verification is accepted only for verified status')
    }
    if (input.status !== 'verified' && input.supersedes !== undefined) {
      throw new Error('only verified memory may supersede records')
    }
    if (input.status !== 'disputed' && input.conflictsWith !== undefined) {
      throw new Error('only disputed memory may declare conflicts')
    }

    const now = Date.now()
    const incomingEvidence = (input.evidence ?? []).map(
      item => normalizeEvidenceInput(item, now),
    )
    const evidence = addSourceEvidence(
      dedupeEvidence([...previous.evidence, ...incomingEvidence]),
      source.sessionId,
      now,
    )
    const verification = input.status === 'verified'
      ? input.verification === undefined
        ? previous.verification
        : normalizeVerificationInput(input.verification, now)
      : previous.verification
    const supersedes = mergedIds(previous.supersedes, input.supersedes)
    const conflictsWith = mergedIds(previous.conflictsWith, input.conflictsWith)
    const memory = normalizeMemory({
      ...previous,
      status: input.status,
      evidence,
      updatedAt: now,
      ...(input.evidenceText === undefined
        ? {}
        : { evidenceText: requiredText(input.evidenceText, 'evidenceText') }),
      ...(verification === undefined ? {} : { verification }),
      ...(supersedes === undefined ? {} : { supersedes }),
      ...(conflictsWith === undefined ? {} : { conflictsWith }),
    })

    validateNewTargets(input, loaded)
    const records = loaded.memories.map(record => record.id === memory.id ? memory : record)
    validateSupersessionGraph(records)
    await atomicJsonWrite(this.memoryPath(memory.kind, memory.id), memory)

    for (const targetId of memory.supersedes ?? []) {
      const target = loaded.memories.find(record => record.id === targetId)
      if (target === undefined || target.status === 'superseded') continue
      await atomicJsonWrite(this.memoryPath(target.kind, target.id), normalizeMemory({
        ...target,
        status: 'superseded',
        updatedAt: now,
      }))
    }
    return memory
  }

  /** Delete a candidate through the Agent-safe path. */
  async forgetCandidate(
    kind: ExperienceKind,
    id: string,
    reasonCode: DeletionReasonCode = 'user-request',
  ): Promise<MemoryTombstone> {
    const memory = await this.readRecord(kind, id)
    if (memory.status !== 'candidate') {
      throw new Error(
        `ExpMem ${memory.status} memory requires confirmed CLI deletion: `
        + `dsh-expmem forget ${kind} ${id}`,
      )
    }
    return await this.forgetConfirmed(kind, id, reasonCode)
  }

  /** Delete any record after the caller has obtained explicit confirmation. */
  async forgetConfirmed(
    kind: ExperienceKind,
    id: string,
    reasonCode: DeletionReasonCode,
  ): Promise<MemoryTombstone> {
    const memory = await this.readRecord(kind, id)
    const tombstone = normalizeTombstone({
      schemaVersion: 1,
      id: memory.id,
      kind: memory.kind,
      deletedAt: Date.now(),
      reasonCode,
    })
    await atomicJsonWrite(this.tombstonePath(id), tombstone)
    await rm(this.memoryPath(kind, id))
    return tombstone
  }

  /** Backward-compatible candidate-only deletion. */
  async forget(kind: ExperienceKind, id: string): Promise<void> {
    await this.forgetCandidate(kind, id)
  }

  /** Read one exact record and resolve its effective lifecycle status. */
  async readRecord(kind: ExperienceKind, id: string): Promise<ExperienceMemory> {
    assertMemoryId(id)
    if (await this.readTombstone(id) !== undefined) {
      throw new Error(`ExpMem record was deleted: ${kind}/${id}`)
    }
    await this.readMemoryFile(this.memoryPath(kind, id), true)
    const resolved = resolveArchive((await this.loadArchive()).memories)
    const memory = resolved.memories.find(item => item.kind === kind && item.id === id)
    if (memory === undefined) throw new Error(`ExpMem record not found: ${kind}/${id}`)
    return memory
  }

  /** Scan all files, returning valid records and per-file diagnostics. */
  async scan(): Promise<ArchiveScanResult> {
    const loaded = await this.loadArchive()
    return {
      memories: resolveArchive(loaded.memories).memories,
      warnings: loaded.warnings,
    }
  }

  /** Backward-compatible list of valid records. */
  async list(): Promise<ExperienceMemory[]> {
    return (await this.scan()).memories
  }

  /** Search the Archive using case-insensitive AND terms. */
  async search(options: ExperienceSearchOptions): Promise<ExperienceSearchPage> {
    const offset = parseCursor(options.cursor)
    if (!Number.isSafeInteger(options.limit)
      || options.limit < 1
      || options.limit > this.limits.maxSearchResults) {
      throw new Error(`limit must be between 1 and ${this.limits.maxSearchResults}`)
    }
    if (options.statuses?.some(status => !isMemoryStatus(status))) {
      throw new Error('invalid ExpMem status filter')
    }
    const statuses = options.statuses ?? ['candidate', 'verified', 'disputed']
    const terms = options.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    const loaded = await this.loadArchive()
    const resolved = resolveArchive(loaded.memories)
    const hits: ExperienceSearchHit[] = []

    // ponytail: linear scans keep files transparent; add an index only when corpus size requires it.
    for (const memory of resolved.memories) {
      if (!statuses.includes(memory.status)) continue
      if (options.kinds !== undefined && !options.kinds.includes(memory.kind)) continue
      if (options.workspace !== undefined && memory.workspace !== options.workspace) continue
      const searchable = [
        memory.kind,
        memory.status,
        memory.title,
        memory.content,
        memory.tags.join(' '),
        memory.workspace ?? '',
        JSON.stringify(memory.authoredBy),
        JSON.stringify(memory.evidence),
      ].join('\n').toLocaleLowerCase()
      if (!terms.every(term => searchable.includes(term))) continue
      const imported = memory.evidence.find(
        (item): item is Extract<MemoryEvidence, { kind: 'imported-file' }> =>
          item.kind === 'imported-file',
      )
      const supersededBy = resolved.supersededBy.get(memory.id)
      const conflicts = [...resolved.conflicts.get(memory.id) ?? []].sort()
      hits.push({
        id: memory.id,
        kind: memory.kind,
        title: memory.title,
        text: preview(memory.content, this.limits.maxPreviewChars),
        tags: memory.tags,
        timestamp: memory.updatedAt,
        path: relative(this.rootDir, this.memoryPath(memory.kind, memory.id)),
        status: memory.status,
        authoredBy: memory.authoredBy,
        evidence: memory.evidence,
        claimSha256: claimSha256(memory),
        ...(memory.workspace === undefined ? {} : { workspace: memory.workspace }),
        ...(memory.verification === undefined ? {} : { verification: memory.verification }),
        ...(memory.supersedes === undefined ? {} : { supersedes: memory.supersedes }),
        ...(supersededBy === undefined ? {} : { supersededBy }),
        ...(conflicts.length === 0 ? {} : { conflictsWith: conflicts }),
        ...(imported === undefined
          ? {}
          : {
              importedFrom: {
                provider: imported.provider,
                path: imported.path,
                sha256: imported.sha256,
              },
            }),
      })
    }
    hits.sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))
    const page = hits.slice(offset, offset + options.limit)
    const nextOffset = offset + page.length
    return {
      hits: page,
      warnings: loaded.warnings,
      ...(nextOffset < hits.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  private async loadArchive(): Promise<LoadedArchive> {
    const memories: ExperienceMemory[] = []
    const warnings: ArchiveWarning[] = []
    const tombstones = new Map<string, MemoryTombstone>()
    const tombstoneDirectory = join(this.rootDir, 'archive', 'tombstones')
    for (const name of await jsonFiles(tombstoneDirectory)) {
      const path = join(tombstoneDirectory, name)
      try {
        const tombstone = normalizeTombstone(await readJson(path))
        tombstones.set(tombstone.id, tombstone)
      } catch (error) {
        warnings.push(this.warning(path, error))
      }
    }
    for (const kind of EXPERIENCE_KINDS) {
      const directory = join(this.rootDir, 'archive', kind)
      for (const name of await jsonFiles(directory)) {
        const path = join(directory, name)
        try {
          const memory = normalizeMemory(await readJson(path))
          if (memory.kind !== kind || memory.id !== basename(name, '.json')) {
            throw new MemorySchemaError('record path does not match kind and id', 'invalid-record')
          }
          if (!tombstones.has(memory.id)) memories.push(memory)
        } catch (error) {
          warnings.push(this.warning(path, error))
        }
      }
    }
    return { memories, warnings, tombstones }
  }

  private async readMemoryFile(path: string, required: boolean): Promise<ExperienceMemory | undefined> {
    let value: unknown
    try {
      value = await readJson(path)
    } catch (error) {
      if (isNodeError(error, 'ENOENT') && !required) return undefined
      if (isNodeError(error, 'ENOENT')) {
        throw new Error(`ExpMem record not found: ${relative(this.rootDir, path)}`)
      }
      throw contextualError(path, this.rootDir, error)
    }
    try {
      return normalizeMemory(value)
    } catch (error) {
      throw contextualError(path, this.rootDir, error)
    }
  }

  private async readTombstone(id: string): Promise<MemoryTombstone | undefined> {
    try {
      return normalizeTombstone(await readJson(this.tombstonePath(id)))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined
      throw contextualError(this.tombstonePath(id), this.rootDir, error)
    }
  }

  private warning(path: string, error: unknown): ArchiveWarning {
    return {
      path: relative(this.rootDir, path),
      code: error instanceof SyntaxError
        ? 'invalid-json'
        : error instanceof MemorySchemaError
          ? error.code
          : 'invalid-record',
      message: error instanceof Error ? error.message : String(error),
    }
  }

  private memoryPath(kind: ExperienceKind, id: string): string {
    return join(this.rootDir, 'archive', kind, `${id}.json`)
  }

  private tombstonePath(id: string): string {
    return join(this.rootDir, 'archive', 'tombstones', `${id}.json`)
  }
}

function resolveArchive(memories: ExperienceMemory[]): ResolvedArchive {
  const supersededBy = new Map<string, string>()
  const conflicts = new Map<string, Set<string>>()
  for (const memory of memories) {
    for (const target of memory.supersedes ?? []) supersededBy.set(target, memory.id)
    for (const target of memory.conflictsWith ?? []) {
      addRelation(conflicts, memory.id, target)
      addRelation(conflicts, target, memory.id)
    }
  }
  return {
    memories: memories.map(memory => supersededBy.has(memory.id)
      ? { ...memory, status: 'superseded' }
      : memory),
    supersededBy,
    conflicts,
  }
}

function validateNewTargets(input: ExperienceTransitionInput, loaded: LoadedArchive): void {
  const liveIds = new Set(loaded.memories.map(memory => memory.id))
  for (const target of [...input.supersedes ?? [], ...input.conflictsWith ?? []]) {
    assertMemoryId(target)
    if (target === input.id) throw new Error('ExpMem relation cannot reference itself')
    if (!liveIds.has(target)) {
      const deleted = loaded.tombstones.has(target) ? 'deleted' : 'missing'
      throw new Error(`ExpMem relation target is ${deleted}: ${target}`)
    }
  }
}

function validateSupersessionGraph(memories: ExperienceMemory[]): void {
  const incoming = new Map<string, string>()
  const edges = new Map<string, string[]>()
  for (const memory of memories) {
    const targets = memory.supersedes ?? []
    edges.set(memory.id, targets)
    for (const target of targets) {
      const previous = incoming.get(target)
      if (previous !== undefined && previous !== memory.id) {
        throw new Error(`ExpMem record already superseded by ${previous}: ${target}`)
      }
      incoming.set(target, memory.id)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`ExpMem supersession cycle includes ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of edges.get(id) ?? []) {
      if (edges.has(target)) visit(target)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of edges.keys()) visit(id)
}

function validTransition(from: MemoryStatus, to: 'verified' | 'disputed'): boolean {
  return (from === 'candidate' && (to === 'verified' || to === 'disputed'))
    || (from === 'verified' && (to === 'verified' || to === 'disputed'))
    || (from === 'disputed' && to === 'disputed')
}

function addSourceEvidence(
  evidence: MemoryEvidence[],
  sessionId: string | undefined,
  observedAt: number,
): MemoryEvidence[] {
  if (sessionId === undefined || evidence.some(
    item => item.kind === 'session-event' && item.sessionId === sessionId,
  )) return evidence
  return [...evidence, normalizeEvidenceInput({
    kind: 'session-event',
    sessionId,
    observedAt,
  })]
}

function dedupeEvidence(evidence: MemoryEvidence[]): MemoryEvidence[] {
  const ids = new Set<string>()
  const imports = new Set<string>()
  return evidence.filter(item => {
    if (ids.has(item.id)) return false
    ids.add(item.id)
    if (item.kind !== 'imported-file') return true
    const key = `${item.provider}\0${item.path}\0${item.sha256}`
    if (imports.has(key)) return false
    imports.add(key)
    return true
  })
}

function legacyImportEvidence(source: ImportedMemorySource): MemoryEvidenceInput {
  const sha256 = source.sha256.startsWith('sha256:')
    ? source.sha256
    : `sha256:${source.sha256.toLowerCase()}`
  return {
    kind: 'imported-file',
    provider: source.provider,
    path: source.path,
    sha256,
  }
}

function mergedIds(
  current: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  if (incoming === undefined) return current
  const result = [...new Set([...current ?? [], ...incoming])]
  return result.length === 0 ? undefined : result
}

function addRelation(relations: Map<string, Set<string>>, source: string, target: string): void {
  const targets = relations.get(source) ?? new Set()
  targets.add(target)
  relations.set(source, targets)
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
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

function contextualError(path: string, rootDir: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`invalid ExpMem record ${relative(rootDir, path)}: ${message}`)
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

function normalizedTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))]
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
