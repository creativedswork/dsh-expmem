import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FileExperienceArchive,
  claimSha256,
} from '../lib/index.js'

const LIMITS = {
  maxEntryChars: 10_000,
  maxPreviewChars: 500,
  maxSearchResults: 20,
}

test('loads mixed legacy and v1 files without silently losing valid records', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-schema-'))
  const archive = new FileExperienceArchive(rootDir, LIMITS)
  const legacyId = '11111111-1111-4111-8111-111111111111'
  const invalidId = '22222222-2222-4222-8222-222222222222'
  const futureId = '33333333-3333-4333-8333-333333333333'

  try {
    await archive.initialize()
    const current = await archive.writeCandidate({
      kind: 'habit',
      title: 'Current record',
      content: 'Use focused changes.',
    }, { sessionId: 'session-current' })
    const directory = join(rootDir, 'archive', 'experience')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${legacyId}.json`), JSON.stringify({
      version: 1,
      id: legacyId,
      kind: 'experience',
      title: 'Legacy imported record',
      content: 'Use pnpm.',
      tags: ['legacy'],
      createdAt: 100,
      updatedAt: 200,
      importedFrom: {
        provider: 'claude',
        path: '/tmp/legacy.md',
        sha256: 'a'.repeat(64),
      },
    }))
    await writeFile(join(directory, `${invalidId}.json`), '{"broken":')
    await writeFile(join(directory, `${futureId}.json`), JSON.stringify({
      schemaVersion: 2,
      id: futureId,
    }))
    await writeFile(join(directory, '.44444444-4444-4444-8444-444444444444.tmp'), '{"partial":')

    const scan = await archive.scan()
    assert.deepEqual(new Set(scan.memories.map(memory => memory.id)), new Set([
      current.id,
      legacyId,
    ]))
    assert.deepEqual(scan.warnings.map(warning => warning.code).sort(), [
      'invalid-json',
      'unsupported-schema',
    ])
    const legacy = scan.memories.find(memory => memory.id === legacyId)
    assert.equal(legacy.status, 'candidate')
    assert.equal(legacy.schemaVersion, 1)
    assert.equal(legacy.importance, 5)
    assert.equal(legacy.lastAccessedAt, legacy.updatedAt)
    assert.deepEqual(legacy.authoredBy, { kind: 'agent', id: 'claude' })
    assert.equal(legacy.evidence[0].kind, 'imported-file')
    assert.equal(legacy.evidence[0].sha256, `sha256:${'a'.repeat(64)}`)

    const page = await archive.search({ query: '', limit: 20 })
    assert.equal(page.hits.length, 2)
    assert.equal(page.warnings.length, 2)
    await assert.rejects(
      archive.readRecord('experience', invalidId),
      /invalid ExpMem record/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('ranks retrieval by recency importance and relevance, then touches only returned hits', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-ranking-'))
  const archive = new FileExperienceArchive(rootDir, LIMITS)

  try {
    await archive.initialize()
    const important = await archive.writeCandidate({
      kind: 'experience',
      title: 'Important TypeScript note',
      content: 'TypeScript requires focused type checks.',
      importance: 10,
    }, {})
    const relevant = await archive.writeCandidate({
      kind: 'experience',
      title: 'Relevant TypeScript memory',
      content: 'TypeScript memory ranking uses all query terms.',
      importance: 1,
    }, {})
    const importantPath = join(
      rootDir,
      'archive',
      important.kind,
      `${important.id}.json`,
    )
    const relevantPath = join(
      rootDir,
      'archive',
      relevant.kind,
      `${relevant.id}.json`,
    )
    const importantStored = JSON.parse(await readFile(importantPath, 'utf8'))
    const relevantStored = JSON.parse(await readFile(relevantPath, 'utf8'))
    const now = Date.now()
    importantStored.lastAccessedAt = now - 10 * 3_600_000
    relevantStored.lastAccessedAt = now - 3_600_000
    await writeFile(importantPath, `${JSON.stringify(importantStored, null, 2)}\n`)
    await writeFile(relevantPath, `${JSON.stringify(relevantStored, null, 2)}\n`)

    const page = await archive.search({
      query: 'TypeScript memory',
      limit: 1,
      recencyDecay: 0.5,
    })
    assert.equal(page.hits[0].id, relevant.id)
    assert.equal(page.hits[0].score, 2)
    assert.deepEqual(page.hits[0].scoreComponents, {
      recency: 1,
      importance: 0,
      relevance: 1,
    })
    assert.equal(page.nextCursor, '1')
    assert.equal((await archive.readRecord(important.kind, important.id)).lastAccessedAt,
      importantStored.lastAccessedAt)
    assert.ok((await archive.readRecord(relevant.kind, relevant.id)).lastAccessedAt
      > relevantStored.lastAccessedAt)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('stores auditable recursive reflections and rejects invalid source graphs', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-reflection-'))
  const archive = new FileExperienceArchive(rootDir, LIMITS)

  try {
    await archive.initialize()
    const first = await archive.writeCandidate({
      kind: 'experience',
      title: 'First observation',
      content: 'Focused diffs reduce review risk.',
      importance: 8,
    }, {})
    const second = await archive.writeCandidate({
      kind: 'habit',
      title: 'Second observation',
      content: 'The user prefers evidence before conclusions.',
      importance: 7,
    }, {})
    assert.equal((await archive.reflectionPressure()).totalImportance, 15)

    const reflection = await archive.writeCandidate({
      kind: 'insight',
      title: 'Evidence-oriented implementation style',
      content: 'Use focused changes and verify claims before presenting conclusions.',
      importance: 9,
      reflection: {
        question: 'Which implementation style consistently works for this user?',
        sourceMemoryIds: [first.id, second.id],
      },
    }, {})
    assert.deepEqual(reflection.reflection.sourceMemoryIds, [first.id, second.id])
    assert.equal((await archive.reflectionPressure()).totalImportance, 0)

    const recursive = await archive.writeCandidate({
      kind: 'insight',
      title: 'Reusable collaboration pattern',
      content: 'Evidence-oriented implementation supports reliable collaboration.',
      importance: 8,
      reflection: {
        question: 'What broader collaboration pattern follows from prior insights?',
        sourceMemoryIds: [reflection.id],
      },
    }, {})
    assert.deepEqual(recursive.reflection.sourceMemoryIds, [reflection.id])

    await assert.rejects(archive.writeCandidate({
      kind: 'insight',
      title: 'Missing source',
      content: 'This reflection cites no live record.',
      reflection: {
        question: 'Can a missing source support a reflection?',
        sourceMemoryIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      },
    }, {}), /reflection source is missing/)
    await assert.rejects(archive.writeCandidate({
      kind: 'experience',
      title: 'Wrong kind',
      content: 'Only insight records may be reflections.',
      reflection: {
        question: 'Is this a reflection?',
        sourceMemoryIds: [first.id],
      },
    }, {}), /only insight memory may be a reflection/)
    await assert.rejects(archive.writeCandidate({
      id: reflection.id,
      kind: reflection.kind,
      title: reflection.title,
      content: reflection.content,
      importance: reflection.importance,
      evidence: reflection.evidence,
      reflection: {
        question: reflection.reflection.question,
        sourceMemoryIds: [recursive.id],
      },
    }, {}), /reflection cycle/)
    await assert.rejects(archive.writeCandidate({
      kind: 'experience',
      title: 'Invalid importance',
      content: 'Importance is bounded.',
      importance: 11,
    }, {}), /importance must be an integer from 1 to 10/)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('persists Reflection Runs across restart and commits idempotently', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-reflection-run-'))
  const archive = new FileExperienceArchive(rootDir, LIMITS)

  try {
    await archive.initialize()
    const first = await archive.writeCandidate({
      kind: 'experience',
      title: 'Focused implementation',
      content: 'Focused implementation reduced review risk.',
      importance: 6,
    }, { workspace: '/workspace/project' })
    const second = await archive.writeCandidate({
      kind: 'habit',
      title: 'Evidence preference',
      content: 'The user expects evidence before conclusions.',
      importance: 5,
    }, { workspace: '/workspace/project' })

    const pending = await archive.ensureReflectionRun('/workspace/project', 10)
    assert.equal(pending.status, 'pending')
    assert.equal(pending.totalImportance, 11)
    assert.equal(
      (await archive.ensureReflectionRun('/workspace/project', 10)).id,
      pending.id,
    )

    const prepared = await archive.prepareReflectionRun(pending.id, [
      'Which focused evidence practice works?',
    ], {
      maxQuestions: 3,
      maxSearchResults: 20,
      recencyDecay: 0.995,
    })
    assert.equal(prepared.run.status, 'prepared')
    assert.deepEqual(
      new Set(prepared.questions[0].hits.map(hit => hit.id)),
      new Set([first.id, second.id]),
    )

    const restarted = new FileExperienceArchive(rootDir, LIMITS)
    const resumed = await restarted.ensureReflectionRun('/workspace/project', 10)
    assert.equal(resumed.id, pending.id)
    assert.equal(resumed.status, 'prepared')
    const questionId = resumed.questions[0].id

    await assert.rejects(restarted.commitReflectionRun(pending.id, [{
      questionId,
      title: 'Unsupported reflection',
      content: 'This cites a record that was not retrieved.',
      importance: 7,
      sourceMemoryIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    }], {}, 3), /not retrieved/)

    const input = [{
      questionId,
      title: 'Focused evidence practice',
      content: 'Focused implementation and explicit evidence improve review reliability.',
      importance: 8,
      sourceMemoryIds: [first.id],
      tags: ['reflection'],
    }]
    const partialInsight = await restarted.writeCandidate({
      kind: 'insight',
      title: input[0].title,
      content: input[0].content,
      importance: input[0].importance,
      tags: input[0].tags,
      reflection: {
        question: resumed.questions[0].text,
        sourceMemoryIds: input[0].sourceMemoryIds,
        runId: pending.id,
        questionId,
      },
    }, { sessionId: 'reflection-session', workspace: '/workspace/project' })
    const committed = await restarted.commitReflectionRun(
      pending.id,
      input,
      { sessionId: 'reflection-session', workspace: '/workspace/project' },
      3,
    )
    assert.equal(committed.run.status, 'completed')
    assert.deepEqual(committed.run.consumedSourceMemoryIds, [first.id])
    assert.equal(committed.insights[0].id, partialInsight.id)
    assert.equal(committed.insights[0].reflection.runId, pending.id)
    assert.equal(committed.insights[0].reflection.questionId, questionId)

    const retry = await restarted.commitReflectionRun(pending.id, input, {}, 3)
    assert.equal(retry.insights[0].id, committed.insights[0].id)
    assert.equal((await restarted.reflectionPressure('/workspace/project')).totalImportance, 5)
    const stored = JSON.parse(await readFile(
      join(rootDir, 'reflection-runs', `${pending.id}.json`),
      'utf8',
    ))
    assert.equal(stored.status, 'completed')
    assert.deepEqual(stored.insightMemoryIds, [committed.insights[0].id])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('requires qualifying evidence and treats review reports as opaque non-verifying links', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-evidence-'))
  const archive = new FileExperienceArchive(rootDir, LIMITS)

  try {
    await archive.initialize()
    const claim = {
      kind: 'insight',
      title: 'Review reports are advisory',
      content: 'A model review is provenance, not factual verification.',
    }
    const candidate = await archive.writeCandidate({
      ...claim,
      evidence: [{
        kind: 'review-report',
        schemaVersion: 'review-report@1',
        reportId: 'rr-1',
        location: '/path/that/does/not/exist/report.json',
        sha256: `sha256:${'b'.repeat(64)}`,
        targetSha256: claimSha256(claim),
      }],
    }, {})
    const report = candidate.evidence[0]
    assert.equal(report.kind, 'review-report')

    await assert.rejects(archive.transition({
      kind: candidate.kind,
      id: candidate.id,
      status: 'verified',
      verification: {
        actor: { kind: 'tool', id: 'review-pipeline' },
        method: 'source-check',
        evidenceIds: [report.id],
      },
    }), /source-check requires external-uri evidence/)
    assert.equal((await archive.readRecord(candidate.kind, candidate.id)).status, 'candidate')

    await assert.rejects(archive.writeCandidate({
      ...claim,
      content: `${claim.content} Changed.`,
      evidence: [report],
    }, {}), /targetSha256 does not match/)
    await assert.rejects(archive.writeCandidate({
      kind: 'habit',
      title: 'Claimed user preference',
      content: 'Use concise output.',
      authoredBy: { kind: 'user', id: 'user-1' },
    }, {}), /user-authored memory requires complete Session evidence/)

    const external = await archive.writeCandidate({
      kind: 'experience',
      title: 'Reproduced behavior',
      content: 'The documented source confirms the behavior.',
      evidence: [{
        kind: 'external-uri',
        uri: 'https://example.test/evidence',
        capturedTextSha256: `sha256:${'c'.repeat(64)}`,
      }],
    }, {})
    const source = external.evidence[0]
    const verified = await archive.transition({
      kind: external.kind,
      id: external.id,
      status: 'verified',
      verification: {
        actor: { kind: 'agent', id: 'reviewer' },
        method: 'source-check',
        evidenceIds: [source.id],
      },
    })
    assert.equal(verified.status, 'verified')
    assert.equal(verified.verification.method, 'source-check')
    await assert.rejects(
      archive.writeCandidate({
        id: verified.id,
        kind: verified.kind,
        title: verified.title,
        content: `${verified.content} rewritten`,
      }, {}),
      /verified memory cannot be edited/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('projects conflicts and supersession while preserving earlier records', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-relations-'))
  const archive = new FileExperienceArchive(rootDir, LIMITS)

  try {
    await archive.initialize()
    const left = await archive.writeCandidate({
      kind: 'insight',
      title: 'Conflicting claim A',
      content: 'Use strategy A.',
    }, {})
    const right = await archive.writeCandidate({
      kind: 'insight',
      title: 'Conflicting claim B',
      content: 'Use strategy B.',
    }, {})
    const disputed = await archive.transition({
      kind: left.kind,
      id: left.id,
      status: 'disputed',
      conflictsWith: [right.id],
    })
    assert.deepEqual(disputed.conflictsWith, [right.id])
    const conflictPage = await archive.search({
      query: 'Conflicting',
      statuses: ['candidate', 'disputed'],
      limit: 20,
    })
    assert.deepEqual(
      conflictPage.hits.find(hit => hit.id === right.id).conflictsWith,
      [left.id],
    )

    const resolution = await archive.writeCandidate({
      kind: 'insight',
      title: 'Resolved claim',
      content: 'Use strategy C.',
      evidence: [{
        kind: 'external-uri',
        uri: 'https://example.test/resolution',
      }],
    }, {})
    const evidence = resolution.evidence[0]
    const verified = await archive.transition({
      kind: resolution.kind,
      id: resolution.id,
      status: 'verified',
      supersedes: [left.id, right.id],
      verification: {
        actor: { kind: 'agent', id: 'resolver' },
        method: 'source-check',
        evidenceIds: [evidence.id],
      },
    })
    assert.deepEqual(verified.supersedes, [left.id, right.id])
    assert.equal((await archive.readRecord(left.kind, left.id)).status, 'superseded')
    assert.equal((await archive.readRecord(right.kind, right.id)).status, 'superseded')
    await assert.rejects(archive.transition({
      kind: verified.kind,
      id: verified.id,
      status: 'disputed',
    }), /only verified memory may declare supersession/)

    const defaultPage = await archive.search({ query: '', limit: 20 })
    assert.deepEqual(defaultPage.hits.map(hit => hit.id), [verified.id])
    const superseded = await archive.search({
      query: '',
      statuses: ['superseded'],
      limit: 20,
    })
    assert.equal(superseded.hits.length, 2)
    assert.ok(superseded.hits.every(hit => hit.supersededBy === verified.id))

    const another = await archive.writeCandidate({
      kind: 'insight',
      title: 'Second resolution',
      content: 'Use strategy D.',
      evidence: [{ kind: 'external-uri', uri: 'https://example.test/second' }],
    }, {})
    await assert.rejects(archive.transition({
      kind: another.kind,
      id: another.id,
      status: 'verified',
      supersedes: [left.id],
      verification: {
        actor: { kind: 'agent', id: 'resolver' },
        method: 'source-check',
        evidenceIds: [another.evidence[0].id],
      },
    }), /already superseded/)
    await assert.rejects(archive.transition({
      kind: another.kind,
      id: another.id,
      status: 'verified',
      supersedes: [another.id],
      verification: {
        actor: { kind: 'agent', id: 'resolver' },
        method: 'source-check',
        evidenceIds: [another.evidence[0].id],
      },
    }), /reference (?:themselves|itself)/)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('requires confirmation for protected deletion and writes minimal tombstones', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-delete-'))
  const archive = new FileExperienceArchive(rootDir, LIMITS)

  try {
    await archive.initialize()
    const candidate = await archive.writeCandidate({
      kind: 'habit',
      title: 'Delete candidate',
      content: 'Temporary candidate.',
    }, {})
    const candidateTombstone = await archive.forgetCandidate(
      candidate.kind,
      candidate.id,
      'duplicate',
    )
    assert.deepEqual(Object.keys(candidateTombstone).sort(), [
      'deletedAt',
      'id',
      'kind',
      'reasonCode',
      'schemaVersion',
    ])
    assert.equal(candidateTombstone.reasonCode, 'duplicate')

    const protectedRecord = await archive.writeCandidate({
      kind: 'experience',
      title: 'Protected record',
      content: 'Confirmed by source.',
      evidence: [{ kind: 'external-uri', uri: 'https://example.test/protected' }],
    }, {})
    const verified = await archive.transition({
      kind: protectedRecord.kind,
      id: protectedRecord.id,
      status: 'verified',
      verification: {
        actor: { kind: 'agent', id: 'reviewer' },
        method: 'source-check',
        evidenceIds: [protectedRecord.evidence[0].id],
      },
    })
    await assert.rejects(
      archive.forgetCandidate(verified.kind, verified.id),
      /requires confirmed CLI deletion/,
    )
    const tombstone = await archive.forgetConfirmed(
      verified.kind,
      verified.id,
      'user-request',
    )
    const stored = JSON.parse(await readFile(
      join(rootDir, 'archive', 'tombstones', `${verified.id}.json`),
      'utf8',
    ))
    assert.deepEqual(stored, tombstone)
    assert.equal('title' in stored, false)
    assert.equal('content' in stored, false)
    assert.equal('evidence' in stored, false)
    await assert.rejects(
      archive.readRecord(verified.kind, verified.id),
      /was deleted/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
