import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

export const EXPERIENCE_KINDS = ['habit', 'experience', 'insight'] as const
export const MEMORY_STATUSES = ['candidate', 'verified', 'disputed', 'superseded'] as const
export const DELETION_REASONS = ['user-request', 'duplicate', 'incorrect', 'privacy'] as const

export type ExperienceKind = typeof EXPERIENCE_KINDS[number]
export type MemoryStatus = typeof MEMORY_STATUSES[number]
export type DeletionReasonCode = typeof DELETION_REASONS[number]

export interface MemoryActor {
  kind: 'user' | 'agent' | 'tool'
  id?: string
}

export type MemoryEvidence =
  | {
      id: string
      kind: 'session-event'
      sessionId: string
      startSeq?: number
      endSeq?: number
      observedAt: number
    }
  | {
      id: string
      kind: 'imported-file'
      provider: 'claude' | 'codex'
      path: string
      sha256: string
      observedAt: number
    }
  | {
      id: string
      kind: 'external-uri'
      uri: string
      capturedTextSha256?: string
      observedAt: number
    }
  | {
      id: string
      kind: 'review-report'
      schemaVersion: 'review-report@1'
      reportId: string
      location: string
      sha256: string
      targetSha256: string
      observedAt: number
    }

export type MemoryEvidenceInput =
  | {
      id?: string
      kind: 'session-event'
      sessionId: string
      startSeq?: number
      endSeq?: number
      observedAt?: number
    }
  | {
      id?: string
      kind: 'imported-file'
      provider: 'claude' | 'codex'
      path: string
      sha256: string
      observedAt?: number
    }
  | {
      id?: string
      kind: 'external-uri'
      uri: string
      capturedTextSha256?: string
      observedAt?: number
    }
  | {
      id?: string
      kind: 'review-report'
      schemaVersion: 'review-report@1'
      reportId: string
      location: string
      sha256: string
      targetSha256: string
      observedAt?: number
    }

export interface MemoryVerification {
  actor: MemoryActor
  method: 'user-confirmation' | 'tool-reproduction' | 'source-check'
  evidenceIds: string[]
  verifiedAt: number
}

export interface MemoryVerificationInput {
  actor: MemoryActor
  method: MemoryVerification['method']
  evidenceIds: string[]
  verifiedAt?: number
}

export interface MemoryReflection {
  question: string
  sourceMemoryIds: string[]
}

export interface ExperienceMemory {
  schemaVersion: 1
  id: string
  kind: ExperienceKind
  title: string
  content: string
  tags: string[]
  status: MemoryStatus
  authoredBy: MemoryActor
  evidence: MemoryEvidence[]
  importance: number
  lastAccessedAt: number
  evidenceText?: string
  createdAt: number
  updatedAt: number
  claimedAt?: number
  workspace?: string
  verification?: MemoryVerification
  supersedes?: string[]
  conflictsWith?: string[]
  reflection?: MemoryReflection
}

export interface MemoryTombstone {
  schemaVersion: 1
  id: string
  kind: ExperienceKind
  deletedAt: number
  reasonCode: DeletionReasonCode
}

/** Legacy import provenance retained as a source-compatible public type. */
export interface ImportedMemorySource {
  provider: 'claude' | 'codex'
  path: string
  sha256: string
}

export class MemorySchemaError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-record' | 'unsupported-schema',
  ) {
    super(message)
    this.name = 'MemorySchemaError'
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^sha256:[0-9a-f]{64}$/
const LEGACY_SHA256 = /^[0-9a-f]{64}$/i

/** Hash only fields that form the claim reviewed by an external report. */
export function claimSha256(
  memory: Pick<ExperienceMemory, 'kind' | 'title' | 'content' | 'claimedAt'>,
): string {
  const claim = {
    kind: memory.kind,
    title: memory.title,
    content: memory.content,
    claimedAt: memory.claimedAt ?? null,
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(claim)).digest('hex')}`
}

/** Parse a v1 record or lazily normalize one 0.2.x record. */
export function normalizeMemory(value: unknown): ExperienceMemory {
  if (!isRecord(value)) invalid('record must be an object')
  if (value.schemaVersion !== undefined) {
    if (typeof value.schemaVersion === 'number' && value.schemaVersion > 1) {
      throw new MemorySchemaError(
        `unsupported ExpMem schemaVersion: ${String(value.schemaVersion)}`,
        'unsupported-schema',
      )
    }
    if (value.schemaVersion !== 1) invalid('schemaVersion must be 1')
    return normalizeV1(value)
  }
  return normalizeLegacy(value)
}

/** Parse one tombstone stored by ExpMem. */
export function normalizeTombstone(value: unknown): MemoryTombstone {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isMemoryId(value.id)
    || !isExperienceKind(value.kind)
    || !isTimestamp(value.deletedAt)
    || !isDeletionReason(value.reasonCode)) {
    invalid('invalid ExpMem tombstone')
  }
  return {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    deletedAt: value.deletedAt,
    reasonCode: value.reasonCode,
  }
}

/** Normalize one tool or importer evidence input for persistence. */
export function normalizeEvidenceInput(
  value: MemoryEvidenceInput,
  now = Date.now(),
): MemoryEvidence {
  return normalizeEvidence({
    ...value,
    id: value.id ?? randomUUID(),
    observedAt: value.observedAt ?? now,
  })
}

/** Normalize verification metadata and default its observation time. */
export function normalizeVerificationInput(
  value: MemoryVerificationInput,
  now = Date.now(),
): MemoryVerification {
  return normalizeVerification({
    ...value,
    verifiedAt: value.verifiedAt ?? now,
  })
}

export function assertMemoryId(value: string): void {
  if (!isMemoryId(value)) throw new Error('ExpMem id must be a UUID')
}

export function isExperienceKind(value: unknown): value is ExperienceKind {
  return typeof value === 'string' && EXPERIENCE_KINDS.includes(value as ExperienceKind)
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && MEMORY_STATUSES.includes(value as MemoryStatus)
}

export function isDeletionReason(value: unknown): value is DeletionReasonCode {
  return typeof value === 'string' && DELETION_REASONS.includes(value as DeletionReasonCode)
}

function normalizeV1(value: Record<string, unknown>): ExperienceMemory {
  if (!isMemoryId(value.id)) invalid('id must be a UUID')
  if (!isExperienceKind(value.kind)) invalid('invalid memory kind')
  if (!isMemoryStatus(value.status)) invalid('invalid memory status')
  const title = nonEmpty(value.title, 'title')
  const content = nonEmpty(value.content, 'content')
  const tags = stringArray(value.tags, 'tags')
  const authoredBy = normalizeActor(value.authoredBy)
  if (!Array.isArray(value.evidence)) invalid('evidence must be an array')
  const evidence = value.evidence.map(normalizeEvidence)
  if (new Set(evidence.map(item => item.id)).size !== evidence.length) {
    invalid('evidence ids must be unique')
  }
  const createdAt = timestamp(value.createdAt, 'createdAt')
  const updatedAt = timestamp(value.updatedAt, 'updatedAt')
  const importance = value.importance === undefined
    ? 5
    : importanceScore(value.importance)
  const lastAccessedAt = value.lastAccessedAt === undefined
    ? updatedAt
    : timestamp(value.lastAccessedAt, 'lastAccessedAt')
  const claimedAt = optionalTimestamp(value.claimedAt, 'claimedAt')
  const verification = value.verification === undefined
    ? undefined
    : normalizeVerification(value.verification)
  const supersedes = optionalIds(value.supersedes, 'supersedes')
  const conflictsWith = optionalIds(value.conflictsWith, 'conflictsWith')
  const reflection = value.reflection === undefined
    ? undefined
    : normalizeReflection(value.reflection)
  const memory: ExperienceMemory = {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    title,
    content,
    tags,
    status: value.status,
    authoredBy,
    evidence,
    importance,
    lastAccessedAt,
    createdAt,
    updatedAt,
    ...optionalString(value.evidenceText, 'evidenceText'),
    ...(claimedAt === undefined ? {} : { claimedAt }),
    ...optionalString(value.workspace, 'workspace'),
    ...(verification === undefined ? {} : { verification }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(conflictsWith === undefined ? {} : { conflictsWith }),
    ...(reflection === undefined ? {} : { reflection }),
  }
  validateRecord(memory)
  return memory
}

function normalizeLegacy(value: Record<string, unknown>): ExperienceMemory {
  if (value.version !== 1) invalid('missing supported schemaVersion')
  if (!isMemoryId(value.id)) invalid('legacy id must be a UUID')
  if (!isExperienceKind(value.kind)) invalid('invalid legacy memory kind')
  const createdAt = timestamp(value.createdAt, 'createdAt')
  const updatedAt = timestamp(value.updatedAt, 'updatedAt')
  const evidence: MemoryEvidence[] = []
  const imported = value.importedFrom
  if (imported !== undefined) {
    if (!isRecord(imported)
      || (imported.provider !== 'claude' && imported.provider !== 'codex')
      || typeof imported.path !== 'string'
      || !isAbsolute(imported.path)
      || typeof imported.sha256 !== 'string'
      || !LEGACY_SHA256.test(imported.sha256)) {
      invalid('invalid legacy import source')
    }
    evidence.push({
      id: deterministicUuid(`${value.id}:imported-file`),
      kind: 'imported-file',
      provider: imported.provider,
      path: imported.path,
      sha256: `sha256:${imported.sha256.toLowerCase()}`,
      observedAt: createdAt,
    })
  }
  if (value.sourceSession !== undefined) {
    const sessionId = nonEmpty(value.sourceSession, 'sourceSession')
    evidence.push({
      id: deterministicUuid(`${value.id}:session-event`),
      kind: 'session-event',
      sessionId,
      observedAt: createdAt,
    })
  }
  const memory: ExperienceMemory = {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    title: nonEmpty(value.title, 'title'),
    content: nonEmpty(value.content, 'content'),
    tags: stringArray(value.tags, 'tags'),
    status: 'candidate',
    authoredBy: imported === undefined
      ? {
          kind: 'agent',
          ...(typeof value.sourceSession === 'string' ? { id: value.sourceSession } : {}),
        }
      : { kind: 'agent', id: imported.provider as 'claude' | 'codex' },
    evidence,
    importance: 5,
    lastAccessedAt: updatedAt,
    createdAt,
    updatedAt,
    ...optionalString(value.workspace, 'workspace'),
  }
  validateRecord(memory)
  return memory
}

function validateRecord(memory: ExperienceMemory): void {
  if (memory.status === 'verified' && memory.verification === undefined) {
    invalid('verified memory requires verification')
  }
  if (memory.supersedes?.includes(memory.id) || memory.conflictsWith?.includes(memory.id)) {
    invalid('memory relations cannot reference themselves')
  }
  if (memory.conflictsWith !== undefined
    && memory.conflictsWith.length > 0
    && memory.status !== 'disputed'
    && memory.status !== 'superseded') {
    invalid('only disputed memory may declare conflicts')
  }
  if (memory.supersedes !== undefined
    && memory.supersedes.length > 0
    && memory.status !== 'verified'
    && memory.status !== 'superseded') {
    invalid('only verified memory may declare supersession')
  }
  if (memory.authoredBy.kind === 'user'
    && !memory.evidence.some(isCompleteSessionEvidence)) {
    invalid('user-authored memory requires complete Session evidence')
  }
  if (memory.reflection !== undefined) {
    if (memory.kind !== 'insight') invalid('only insight memory may be a reflection')
    if (memory.reflection.sourceMemoryIds.includes(memory.id)) {
      invalid('reflection cannot reference itself')
    }
    if (memory.reflection.sourceMemoryIds.length === 0
      && !memory.evidence.some(isCompleteSessionEvidence)) {
      invalid('reflection requires source memories or complete Session evidence')
    }
  }
  for (const report of memory.evidence.filter(
    (item): item is Extract<MemoryEvidence, { kind: 'review-report' }> =>
      item.kind === 'review-report',
  )) {
    if (report.targetSha256 !== claimSha256(memory)) {
      invalid('review-report targetSha256 does not match the current claim')
    }
  }
  if (memory.verification !== undefined) validateVerification(memory)
}

function validateVerification(memory: ExperienceMemory): void {
  const verification = memory.verification!
  if (verification.evidenceIds.length === 0) invalid('verification requires evidence')
  const byId = new Map(memory.evidence.map(item => [item.id, item]))
  const selected = verification.evidenceIds.map(id => {
    const evidence = byId.get(id)
    if (evidence === undefined) invalid(`verification evidence not found: ${id}`)
    return evidence
  })
  if (verification.method === 'user-confirmation') {
    if (verification.actor.kind !== 'user' || !selected.some(isCompleteSessionEvidence)) {
      invalid('user-confirmation requires a user actor and complete Session evidence')
    }
  } else if (verification.method === 'tool-reproduction') {
    if (verification.actor.kind !== 'tool' || !selected.some(isCompleteSessionEvidence)) {
      invalid('tool-reproduction requires a tool actor and complete Session evidence')
    }
  } else if (!selected.some(item => item.kind === 'external-uri')) {
    invalid('source-check requires external-uri evidence')
  }
}

function normalizeActor(value: unknown): MemoryActor {
  if (!isRecord(value)
    || (value.kind !== 'user' && value.kind !== 'agent' && value.kind !== 'tool')) {
    invalid('invalid memory actor')
  }
  return {
    kind: value.kind,
    ...optionalString(value.id, 'actor id'),
  }
}

function normalizeEvidence(value: unknown): MemoryEvidence {
  if (!isRecord(value) || !isMemoryId(value.id) || !isTimestamp(value.observedAt)) {
    invalid('invalid evidence identity or observation time')
  }
  if (value.kind === 'session-event') {
    const sessionId = nonEmpty(value.sessionId, 'sessionId')
    const startSeq = optionalSequence(value.startSeq, 'startSeq')
    const endSeq = optionalSequence(value.endSeq, 'endSeq')
    if ((startSeq === undefined) !== (endSeq === undefined)) {
      invalid('startSeq and endSeq must both be present or absent')
    }
    if (startSeq !== undefined && endSeq !== undefined && startSeq > endSeq) {
      invalid('startSeq must not exceed endSeq')
    }
    return {
      id: value.id,
      kind: 'session-event',
      sessionId,
      observedAt: value.observedAt,
      ...(startSeq === undefined ? {} : { startSeq, endSeq: endSeq! }),
    }
  }
  if (value.kind === 'imported-file') {
    if ((value.provider !== 'claude' && value.provider !== 'codex')
      || typeof value.path !== 'string'
      || !isAbsolute(value.path)) {
      invalid('invalid imported-file evidence')
    }
    return {
      id: value.id,
      kind: 'imported-file',
      provider: value.provider,
      path: value.path,
      sha256: hash(value.sha256, 'sha256'),
      observedAt: value.observedAt,
    }
  }
  if (value.kind === 'external-uri') {
    const capturedTextSha256 = value.capturedTextSha256 === undefined
      ? undefined
      : hash(value.capturedTextSha256, 'capturedTextSha256')
    return {
      id: value.id,
      kind: 'external-uri',
      uri: nonEmpty(value.uri, 'uri'),
      observedAt: value.observedAt,
      ...(capturedTextSha256 === undefined ? {} : { capturedTextSha256 }),
    }
  }
  if (value.kind === 'review-report') {
    if (value.schemaVersion !== 'review-report@1') {
      invalid('unsupported review-report schemaVersion')
    }
    return {
      id: value.id,
      kind: 'review-report',
      schemaVersion: 'review-report@1',
      reportId: nonEmpty(value.reportId, 'reportId'),
      location: nonEmpty(value.location, 'location'),
      sha256: hash(value.sha256, 'sha256'),
      targetSha256: hash(value.targetSha256, 'targetSha256'),
      observedAt: value.observedAt,
    }
  }
  invalid('invalid evidence kind')
}

function normalizeVerification(value: unknown): MemoryVerification {
  if (!isRecord(value)
    || (value.method !== 'user-confirmation'
      && value.method !== 'tool-reproduction'
      && value.method !== 'source-check')) {
    invalid('invalid verification')
  }
  return {
    actor: normalizeActor(value.actor),
    method: value.method,
    evidenceIds: ids(value.evidenceIds, 'verification evidenceIds'),
    verifiedAt: timestamp(value.verifiedAt, 'verifiedAt'),
  }
}

function normalizeReflection(value: unknown): MemoryReflection {
  if (!isRecord(value)) invalid('invalid reflection')
  return {
    question: nonEmpty(value.question, 'reflection question'),
    sourceMemoryIds: ids(value.sourceMemoryIds, 'reflection sourceMemoryIds'),
  }
}

function deterministicUuid(seed: string): string {
  const value = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  value[12] = '4'
  value[16] = ['8', '9', 'a', 'b'][Number.parseInt(value[16]!, 16) % 4]!
  return `${value.slice(0, 8).join('')}-${value.slice(8, 12).join('')}-${value.slice(12, 16).join('')}-${value.slice(16, 20).join('')}-${value.slice(20).join('')}`
}

function isCompleteSessionEvidence(
  evidence: MemoryEvidence,
): evidence is Extract<MemoryEvidence, { kind: 'session-event' }> & {
  startSeq: number
  endSeq: number
} {
  return evidence.kind === 'session-event'
    && evidence.startSeq !== undefined
    && evidence.endSeq !== undefined
}

function isMemoryId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value)
}

function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    invalid(`${name} must use sha256:<lowercase hex>`)
  }
  return value
}

function timestamp(value: unknown, name: string): number {
  if (!isTimestamp(value)) invalid(`${name} must be a non-negative safe integer`)
  return value
}

function optionalTimestamp(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : timestamp(value, name)
}

function importanceScore(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10) {
    invalid('importance must be an integer from 1 to 10')
  }
  return value as number
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function optionalSequence(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${name} must be a non-negative safe integer`)
  }
  return value as number
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${name} must not be empty`)
  }
  return value
}

function optionalString(
  value: unknown,
  name: string,
): Record<string, string> {
  if (value === undefined) return {}
  return { [name === 'actor id' ? 'id' : name]: nonEmpty(value, name) }
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    invalid(`${name} must be a string array`)
  }
  return [...value]
}

function ids(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(isMemoryId)) invalid(`${name} must contain UUIDs`)
  if (new Set(value).size !== value.length) invalid(`${name} must not contain duplicates`)
  return [...value]
}

function optionalIds(value: unknown, name: string): string[] | undefined {
  return value === undefined ? undefined : ids(value, name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new MemorySchemaError(message, 'invalid-record')
}
