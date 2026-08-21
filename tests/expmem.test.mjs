import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const plugin = await import('../lib/index.js')

test('provides file-backed experience memory over native DSH Recall', async () => {
  assert.equal(manifest.name, '@creative-dswork/dsh-expmem')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(patch, /@deepseek-ai\/dsh-tool-session-query/)
  assert.match(patch, /expmem\/recall-index\.sqlite/)
  assert.match(patch, /@creative-dswork\/dsh-expmem/)

  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-'))
  const definitions = new Map()
  const sections = []
  const ctx = new Context()
  ctx.provide('tools', {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
  })
  ctx.provide('systemPrompt', {
    section(section) {
      sections.push(section)
      return () => sections.splice(sections.indexOf(section), 1)
    },
  })

  try {
    await ctx.plugin(plugin, {
      rootDir,
      maxEntryChars: 1000,
      maxPreviewChars: 100,
      maxSearchResults: 10,
    })

    assert.deepEqual([...definitions.keys()].sort(), [
      'expmem_forget',
      'expmem_reflect',
      'expmem_search',
      'expmem_transition',
      'expmem_write',
    ])
    assert.match(sections[0].text, /session_search/)
    assert.match(sections[0].text, /expmem_search/)
    assert.match(sections[0].text, /candidate/)
    assert.match(sections[0].text, /importance/)
    assert.match(sections[0].text, /personalize planning/)

    const exec = {
      signal: new AbortController().signal,
      agent: {
        session: {
          id: 'session-1',
          header: { cwd: '/workspace/project' },
        },
      },
    }
    const created = await definitions.get('expmem_write').execute({
      kind: 'habit',
      title: 'Documentation preference',
      content: 'Keep English and Chinese README files aligned.',
      tags: ['docs', 'bilingual'],
      evidence: [{
        kind: 'external-uri',
        uri: 'https://example.test/documentation-policy',
      }],
    }, exec)
    assert.match(created.id, /^[0-9a-f-]{36}$/)
    assert.equal(created.schemaVersion, 1)
    assert.equal(created.status, 'candidate')
    assert.deepEqual(created.authoredBy, { kind: 'agent', id: 'session-1' })
    assert.equal(created.workspace, '/workspace/project')

    const page = await definitions.get('expmem_search').execute({
      query: 'Chinese README',
    }, exec)
    assert.equal(page.hits.length, 1)
    assert.equal(page.hits[0].id, created.id)

    const updated = await definitions.get('expmem_write').execute({
      id: created.id,
      kind: 'habit',
      title: 'Documentation preference',
      content: 'Keep English and Chinese README files aligned in npm packages.',
      tags: ['docs', 'bilingual', 'npm'],
      evidence: created.evidence,
    }, exec)
    assert.equal(updated.id, created.id)
    assert.equal(updated.createdAt, created.createdAt)
    assert.ok(updated.updatedAt >= created.updatedAt)

    const stored = JSON.parse(await readFile(
      join(rootDir, 'archive', 'habit', `${created.id}.json`),
      'utf8',
    ))
    assert.equal(stored.content, updated.content)
    assert.equal(stored.status, 'candidate')

    const external = updated.evidence.find(item => item.kind === 'external-uri')
    const verified = await definitions.get('expmem_transition').execute({
      kind: 'habit',
      id: created.id,
      status: 'verified',
      verification: {
        actor: { kind: 'agent', id: 'reviewer' },
        method: 'source-check',
        evidenceIds: [external.id],
      },
    }, exec)
    assert.equal(verified.status, 'verified')
    await assert.rejects(definitions.get('expmem_forget').execute({
      kind: 'habit',
      id: created.id,
    }, exec), /requires confirmed CLI deletion/)

    const disposable = await definitions.get('expmem_write').execute({
      kind: 'experience',
      title: 'Disposable candidate',
      content: 'Delete this candidate.',
    }, exec)
    const forgotten = await definitions.get('expmem_forget').execute({
      kind: 'experience',
      id: disposable.id,
      reasonCode: 'duplicate',
    }, exec)
    assert.equal(forgotten.tombstone.reasonCode, 'duplicate')
    const empty = await definitions.get('expmem_search').execute({ query: '' }, exec)
    assert.deepEqual(empty.hits.map(hit => hit.id), [created.id])
  } finally {
    await ctx.fiber.dispose()
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('promotes once per compaction cycle and recovers threshold jumps from Recall', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-pressure-'))
  const ctx = new Context()
  let totalTokens = 699
  ctx.provide('tools', { register: () => () => undefined })
  ctx.provide('systemPrompt', { section: () => () => undefined })
  ctx.provide('llm', {
    resolveModelInfo: async () => ({ context: { contextWindow: 1000 } }),
  })
  ctx.provide('tokenMeter', {
    measure: () => ({ totalTokens }),
  })

  try {
    await ctx.plugin(plugin, { rootDir, reflectionEnabled: false })
    const session = fakeSession('pressure-session')
    const agent = {
      id: session.id,
      options: { provider: 'mock', model: 'mock' },
      session,
    }
    const dispatch = (terminal = () => Promise.resolve({ kind: 'enter', messages: [] })) =>
      ctx.waterfall('agent/pre-step', {
        agent,
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      }, terminal)

    assert.equal((await dispatch()).messages.length, 0)
    totalTokens = 700
    const warning = (await dispatch()).messages[0]
    assert.equal(warning.source.summary, 'ExpMem memory pressure')
    assert.match(warning.content[0].text, /70%/)
    appendEvent(session, 'user/message', warning)

    totalTokens = 750
    assert.equal((await dispatch()).messages.length, 0)

    appendCompaction(session, 'after-warning', 1, 20)
    totalTokens = 100
    assert.equal((await dispatch()).messages.length, 0)

    appendCompaction(session, 'without-warning', 21, 40)
    const recovery = (await dispatch()).messages[0]
    assert.equal(recovery.source.summary, 'ExpMem post-compaction recovery')
    assert.match(recovery.content[0].text, /events 21 through 40/)
    assert.match(recovery.content[0].text, /session_event_read/)
    appendEvent(session, 'user/message', recovery)
    assert.equal((await dispatch()).messages.length, 0)

    const jumped = fakeSession('jumped-session')
    const jumpedAgent = {
      id: jumped.id,
      options: { provider: 'mock', model: 'mock' },
      session: jumped,
    }
    totalTokens = 850
    const jumpedDecision = await ctx.waterfall('agent/pre-step', {
      agent: jumpedAgent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, () => {
      appendCompaction(jumped, 'threshold-jump', 5, 55)
      return Promise.resolve({ kind: 'enter', messages: [] })
    })
    assert.equal(jumpedDecision.messages[0].source.summary, 'ExpMem post-compaction recovery')
    assert.match(jumpedDecision.messages[0].content[0].text, /events 5 through 55/)
  } finally {
    await ctx.fiber.dispose()
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('runs persistent reflection preparation and consumes only cited sources', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-reflection-notice-'))
  const definitions = new Map()
  const ctx = new Context()
  ctx.provide('tools', {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
  })
  ctx.provide('systemPrompt', { section: () => () => undefined })

  try {
    await ctx.plugin(plugin, {
      rootDir,
      promotionEnabled: false,
      reflectionThreshold: 10,
    })
    const session = fakeSession('reflection-session', { parentSession: 'fork-source' })
    const agent = {
      id: session.id,
      options: {},
      session,
    }
    const exec = {
      signal: new AbortController().signal,
      agent,
    }
    const first = await definitions.get('expmem_write').execute({
      kind: 'experience',
      title: 'Focused changes worked',
      content: 'A focused implementation passed review.',
      importance: 6,
    }, exec)
    const second = await definitions.get('expmem_write').execute({
      kind: 'habit',
      title: 'Evidence preference',
      content: 'The user asks for evidence before conclusions.',
      importance: 5,
    }, exec)
    const dispatch = (turn) => ctx.waterfall('agent/pre-step', {
      agent,
      messages: [],
      turn,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))

    const childSession = fakeSession('reflection-child', {
      origin: 'subagent',
      parentSession: session.id,
    })
    const childAgent = { id: childSession.id, options: {}, session: childSession }
    const childDecision = await ctx.waterfall('agent/pre-step', {
      agent: childAgent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    assert.equal(childDecision.messages.length, 0)
    await assert.rejects(readdir(join(rootDir, 'reflection-runs')), { code: 'ENOENT' })

    const notice = (await dispatch(1)).messages[0]
    assert.equal(notice.source.summary, 'ExpMem reflection pressure')
    assert.match(notice.content[0].text, /11 importance points/)
    assert.match(notice.content[0].text, new RegExp(first.id))
    assert.match(notice.content[0].text, /expmem_reflect/)
    const runId = notice.content[0].text.match(
      /Reflection Run ([0-9a-f-]{36})/,
    )[1]
    await assert.rejects(definitions.get('expmem_reflect').execute({
      action: 'prepare',
      runId,
      questions: ['Which practices work?'],
    }, {
      signal: new AbortController().signal,
      agent: childAgent,
    }), /restricted to the main agent/)
    assert.equal((await dispatch(1)).messages.length, 0)
    const resumedNotice = (await dispatch(2)).messages[0]
    assert.match(resumedNotice.content[0].text, new RegExp(runId))

    const prepared = await definitions.get('expmem_reflect').execute({
      action: 'prepare',
      runId,
      questions: ['Which focused and evidence-based collaboration approach works?'],
    }, exec)
    assert.equal(prepared.run.status, 'prepared')
    assert.deepEqual(
      new Set(prepared.questions[0].hits.map(hit => hit.id)),
      new Set([first.id, second.id]),
    )
    const questionId = prepared.questions[0].id
    const committed = await definitions.get('expmem_reflect').execute({
      action: 'commit',
      runId,
      insights: [{
        questionId,
        title: 'Evidence-oriented collaboration',
        content: 'Focused changes and evidence improve collaboration reliability.',
        importance: 8,
        sourceMemoryIds: [first.id],
      }],
    }, exec)
    assert.equal(committed.run.status, 'completed')
    assert.deepEqual(committed.run.consumedSourceMemoryIds, [first.id])
    assert.equal(committed.insights[0].reflection.runId, runId)
    assert.equal(committed.insights[0].reflection.questionId, questionId)

    const retried = await definitions.get('expmem_reflect').execute({
      action: 'commit',
      runId,
      insights: [{
        questionId,
        title: 'Evidence-oriented collaboration',
        content: 'Focused changes and evidence improve collaboration reliability.',
        importance: 8,
        sourceMemoryIds: [first.id],
      }],
    }, exec)
    assert.equal(retried.insights[0].id, committed.insights[0].id)
    assert.equal((await dispatch(3)).messages.length, 0)

    const third = await definitions.get('expmem_write').execute({
      kind: 'experience',
      title: 'A second focused result',
      content: 'Another focused change passed review.',
      importance: 5,
    }, exec)
    const nextNotice = (await dispatch(4)).messages[0]
    assert.match(nextNotice.content[0].text, new RegExp(second.id))
    assert.match(nextNotice.content[0].text, new RegExp(third.id))
    assert.doesNotMatch(nextNotice.content[0].text, new RegExp(first.id))
    assert.match(nextNotice.content[0].text, /10 importance points/)
    assert.notEqual(
      nextNotice.content[0].text.match(/Reflection Run ([0-9a-f-]{36})/)[1],
      runId,
    )
  } finally {
    await ctx.fiber.dispose()
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('prioritizes context preservation when reflection pressure is also ready', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-expmem-notice-priority-'))
  const definitions = new Map()
  const ctx = new Context()
  ctx.provide('tools', {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
  })
  ctx.provide('systemPrompt', { section: () => () => undefined })
  ctx.provide('llm', {
    resolveModelInfo: async () => ({ context: { contextWindow: 1000 } }),
  })
  ctx.provide('tokenMeter', {
    measure: () => ({ totalTokens: 700 }),
  })

  try {
    await ctx.plugin(plugin, { rootDir, reflectionThreshold: 1 })
    const session = fakeSession('notice-priority-session')
    const agent = {
      id: session.id,
      options: { provider: 'mock', model: 'mock' },
      session,
    }
    await definitions.get('expmem_write').execute({
      kind: 'experience',
      title: 'Important observation',
      content: 'This observation is ready for reflection.',
      importance: 10,
    }, {
      signal: new AbortController().signal,
      agent,
    })
    const decision = await ctx.waterfall('agent/pre-step', {
      agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 1)
    assert.equal(decision.messages[0].source.summary, 'ExpMem memory pressure')
  } finally {
    await ctx.fiber.dispose()
    await rm(rootDir, { recursive: true, force: true })
  }
})

function fakeSession(id, header = {}) {
  return {
    id,
    header: { cwd: '/workspace/project', ...header },
    events: [],
    requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }),
  }
}

function appendEvent(session, type, data) {
  session.events.push({
    seq: session.events.length,
    time: session.events.length,
    type,
    data,
  })
}

function appendCompaction(session, compactionId, start, end) {
  appendEvent(session, 'compaction/start', { compactionId, turn: 1 })
  appendEvent(session, 'compaction/summary', {
    compactionId,
    summary: [],
    shadowedRange: { start, end },
    shadowedSeqs: [start, end],
    shadowedTokenCount: 100,
    provider: 'mock',
    model: 'mock',
    rawOutput: [],
    llmStreamCall: true,
  })
  appendEvent(session, 'compaction/end', { compactionId, turn: 1 })
}
