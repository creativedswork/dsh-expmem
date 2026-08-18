import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  FileExperienceArchive,
  claimSha256,
} from '../lib/index.js'

const fixtures = fileURLToPath(new URL('./fixtures/audit/', import.meta.url))
const limits = {
  maxEntryChars: 10_000,
  maxPreviewChars: 500,
  maxSearchResults: 20,
}

test('review-report fixture binds report bytes and exact claim without parsing verdicts', async () => {
  const directory = join(fixtures, 'review-report-v1')
  const reportBytes = await readFile(join(directory, 'report.json'))
  const report = JSON.parse(reportBytes)
  const link = await json(join(directory, 'evidence-link.json'))
  assert.equal(report.schemaVersion, 'review-report@1')
  assert.equal(report.reportId, link.reportId)
  assert.equal(
    link.sha256,
    `sha256:${createHash('sha256').update(reportBytes).digest('hex')}`,
  )
  assert.equal(link.targetSha256, claimSha256({
    kind: 'insight',
    title: 'Fixture review claim',
    content: 'Review reports are opaque evidence.',
  }))
  assert.equal('verdict' in link, false)
  assert.equal('reviewers' in link, false)
})

test('fx-04 reports every rejected record while returning all valid records', async () => {
  const { rootDir, cleanup } = await fixtureRoot('fx-04-loader')
  try {
    const expected = await json(join(fixtures, 'fx-04-loader', 'expected.json'))
    const scan = await new FileExperienceArchive(rootDir, limits).scan()
    assert.deepEqual(scan.memories.map(memory => memory.id).sort(), expected.memoryIds.sort())
    assert.deepEqual(scan.warnings.map(warning => warning.code).sort(), expected.warningCodes.sort())
  } finally {
    await cleanup()
  }
})

test('fx-05 ignores an interrupted temporary write and permits the next replacement', async () => {
  const { rootDir, cleanup } = await fixtureRoot('fx-05-atomic-write')
  const temporary = join(
    rootDir,
    'archive',
    'experience',
    '.66666666-6666-4666-8666-666666666666.tmp',
  )
  try {
    const expected = await json(join(fixtures, 'fx-05-atomic-write', 'expected.json'))
    const archive = new FileExperienceArchive(rootDir, limits)
    await archive.initialize()
    const before = await archive.readRecord('experience', expected.id)
    assert.equal(before.content, expected.before)
    await access(temporary)

    const after = await archive.writeCandidate({
      id: before.id,
      kind: before.kind,
      title: before.title,
      content: expected.after,
      tags: before.tags,
      evidence: before.evidence,
    }, {})
    assert.equal(after.content, expected.after)
    assert.equal((await archive.scan()).warnings.length, 0)
    await access(temporary)
  } finally {
    await cleanup()
  }
})

test('fx-07 rejects verification without qualifying evidence and preserves candidate status', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-fx-07-'))
  try {
    const directory = join(rootDir, 'archive', 'insight')
    await mkdir(directory, { recursive: true })
    const record = await json(join(fixtures, 'fx-07-verification', 'record.json'))
    const transition = await json(join(fixtures, 'fx-07-verification', 'transition.json'))
    const expected = await json(join(fixtures, 'fx-07-verification', 'expected.json'))
    await cp(
      join(fixtures, 'fx-07-verification', 'record.json'),
      join(directory, `${record.id}.json`),
    )
    const archive = new FileExperienceArchive(rootDir, limits)
    await assert.rejects(
      archive.transition(transition),
      error => error instanceof Error && error.message.includes(expected.errorIncludes),
    )
    assert.equal((await archive.readRecord(record.kind, record.id)).status, expected.status)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('fx-08 leaves only the approved minimal tombstone fields', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-fx-08-'))
  try {
    const directory = join(rootDir, 'archive', 'habit')
    await mkdir(directory, { recursive: true })
    const record = await json(join(fixtures, 'fx-08-tombstone', 'record.json'))
    const deletion = await json(join(fixtures, 'fx-08-tombstone', 'delete.json'))
    const expected = await json(join(fixtures, 'fx-08-tombstone', 'expected.json'))
    await cp(
      join(fixtures, 'fx-08-tombstone', 'record.json'),
      join(directory, `${record.id}.json`),
    )
    const archive = new FileExperienceArchive(rootDir, limits)
    const tombstone = await archive.forgetCandidate(
      deletion.kind,
      deletion.id,
      deletion.reasonCode,
    )
    assert.deepEqual(Object.keys(tombstone).sort(), expected.keys.sort())
    assert.equal(tombstone.reasonCode, expected.reasonCode)
    assert.equal('content' in tombstone, false)
    await assert.rejects(access(join(directory, `${record.id}.json`)))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

async function fixtureRoot(name) {
  const rootDir = await mkdtemp(join(tmpdir(), `dsh-expmem-${name}-`))
  await cp(join(fixtures, name, 'archive'), join(rootDir, 'archive'), { recursive: true })
  return {
    rootDir,
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  }
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
