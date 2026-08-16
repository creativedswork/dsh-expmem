import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('imports Claude and Codex Markdown memories idempotently', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-expmem-import-'))
  const rootDir = join(temporary, 'archive')
  const claudeDir = join(temporary, 'claude-projects')
  const claudeMemory = join(claudeDir, '-workspace-project', 'memory')
  const codexDir = join(temporary, 'codex-memories')
  const topicPath = join(claudeMemory, 'debugging.md')

  try {
    await mkdir(claudeMemory, { recursive: true })
    await mkdir(codexDir, { recursive: true })
    await writeFile(join(claudeMemory, 'MEMORY.md'), '# Project memory\n\nUse pnpm.\n')
    await writeFile(topicPath, '# Debugging insight\n\nRestart the fixture server.\n')
    await writeFile(join(codexDir, 'memory_summary.md'), '# Codex memory\n\nPrefer focused diffs.\n')

    const dryRoot = join(temporary, 'dry-archive')
    const preview = runCli([
      'import',
      'all',
      '--root-dir',
      dryRoot,
      '--claude-dir',
      claudeDir,
      '--codex-dir',
      codexDir,
      '--dry-run',
      '--json',
    ])
    assert.equal(preview[0].created + preview[1].created, 3)
    await assert.rejects(access(dryRoot), error => error.code === 'ENOENT')

    const fakeHome = join(temporary, 'home')
    await mkdir(fakeHome)
    await writeFile(join(fakeHome, '.claude.json'), JSON.stringify({
      projects: { '/workspace/project': {} },
    }))
    const mappedRoot = join(temporary, 'mapped-archive')
    runCli([
      'import',
      'claude',
      '--root-dir',
      mappedRoot,
      '--claude-dir',
      claudeDir,
      '--json',
    ], { HOME: fakeHome })
    assert.ok((await records(mappedRoot)).every(
      record => record.workspace === '/workspace/project',
    ))

    const first = runCli([
      'import',
      'all',
      '--root-dir',
      rootDir,
      '--claude-dir',
      claudeDir,
      '--codex-dir',
      codexDir,
      '--workspace',
      '/workspace/project',
      '--json',
    ])
    assert.equal(first[0].created, 2)
    assert.equal(first[1].created, 1)

    const initial = await records(rootDir)
    assert.equal(initial.length, 3)
    assert.deepEqual(new Set(initial.map(record => record.importedFrom.provider)), new Set([
      'claude',
      'codex',
    ]))
    assert.ok(initial.every(record => record.workspace === '/workspace/project'))

    const second = runCli([
      'import',
      'all',
      '--root-dir',
      rootDir,
      '--claude-dir',
      claudeDir,
      '--codex-dir',
      codexDir,
      '--json',
    ])
    assert.equal(second[0].skipped, 2)
    assert.equal(second[1].skipped, 1)

    const topicBefore = initial.find(record => record.importedFrom.path === topicPath)
    await writeFile(topicPath, '# Debugging insight\n\nRestart only the fixture server.\n')
    const changed = runCli([
      'import',
      'claude',
      '--root-dir',
      rootDir,
      '--claude-dir',
      claudeDir,
      '--json',
    ])
    assert.equal(changed[0].updated, 1)
    assert.equal(changed[0].skipped, 1)

    const afterUpdate = await records(rootDir)
    const topicAfter = afterUpdate.find(record => record.importedFrom.path === topicPath)
    assert.equal(afterUpdate.length, 3)
    assert.equal(topicAfter.id, topicBefore.id)
    assert.match(topicAfter.content, /Restart only/)

    await writeFile(join(codexDir, 'new.md'), '# New memory\n\nDo not write this yet.\n')
    const dryRun = runCli([
      'import',
      'codex',
      '--root-dir',
      rootDir,
      '--codex-dir',
      codexDir,
      '--dry-run',
      '--json',
    ])
    assert.equal(dryRun[0].created, 1)
    assert.equal((await records(rootDir)).length, 3)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, ['lib/cli.js', ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

async function records(rootDir) {
  const directory = join(rootDir, 'archive', 'experience')
  const names = await readdir(directory)
  return await Promise.all(names.map(async name => JSON.parse(
    await readFile(join(directory, name), 'utf8'),
  )))
}
