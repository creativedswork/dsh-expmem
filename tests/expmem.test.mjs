import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
      'expmem_search',
      'expmem_write',
    ])
    assert.match(sections[0].text, /session_search/)
    assert.match(sections[0].text, /expmem_search/)

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
    }, exec)
    assert.match(created.id, /^[0-9a-f-]{36}$/)
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
    }, exec)
    assert.equal(updated.id, created.id)
    assert.equal(updated.createdAt, created.createdAt)
    assert.ok(updated.updatedAt >= created.updatedAt)

    const stored = JSON.parse(await readFile(
      join(rootDir, 'archive', 'habit', `${created.id}.json`),
      'utf8',
    ))
    assert.equal(stored.content, updated.content)

    await definitions.get('expmem_forget').execute({
      kind: 'habit',
      id: created.id,
    }, exec)
    const empty = await definitions.get('expmem_search').execute({ query: '' }, exec)
    assert.deepEqual(empty.hits, [])
  } finally {
    await ctx.fiber.dispose()
    await rm(rootDir, { recursive: true, force: true })
  }
})
