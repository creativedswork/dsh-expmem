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
