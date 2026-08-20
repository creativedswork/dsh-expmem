import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceManifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'dsh-expmem-pack-'))
const packed = join(temporary, 'packed')
const installed = join(temporary, 'installed')
const source = join(temporary, 'claude-memory')
const rootDir = join(temporary, 'archive')
await Promise.all([
  mkdir(packed),
  mkdir(installed),
  mkdir(source),
])
await writeFile(join(installed, 'package.json'), '{"private":true}\n')
await writeFile(join(source, 'MEMORY.md'), '# Packed memory\n\nPrefer focused changes.\n')
await writeFile(join(source, 'SECOND.md'), '# Second memory\n\nConfirm protected deletion.\n')

try {
  execFileSync('pnpm', [
    'pack',
    '--pack-destination',
    packed,
  ], {
    cwd: repository,
    stdio: 'inherit',
  })
  const archives = (await readdir(packed)).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1)
  const archive = join(packed, archives[0])

  execFileSync('pnpm', [
    '--dir',
    installed,
    'add',
    '--ignore-scripts',
    archive,
  ], { stdio: 'inherit' })

  const packageRoot = join(installed, 'node_modules', '@creative-dswork', 'dsh-expmem')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.version, sourceManifest.version)
  assert.equal(manifest.bin['dsh-expmem'], './lib/cli.js')
  await Promise.all([
    readFile(join(packageRoot, 'lib', 'index.js')),
    readFile(join(packageRoot, 'lib', 'cli.js')),
    readFile(join(packageRoot, 'cordis.patch.yml')),
    readFile(join(packageRoot, 'README.md')),
    readFile(join(packageRoot, 'README.zh-CN.md')),
    readFile(join(packageRoot, 'LICENSE')),
  ])
  const declarations = await readFile(join(packageRoot, 'lib', 'types', 'index.d.ts'), 'utf8')
  assert.match(declarations, /claimSha256/)
  assert.match(declarations, /ExperienceTransitionInput/)
  assert.match(declarations, /MemoryTombstone/)
  assert.match(declarations, /MemoryReflection/)
  assert.match(declarations, /ReflectionPressure/)

  const command = join(installed, 'node_modules', '.bin', 'dsh-expmem')
  assert.match(execFileSync(command, ['--help'], { encoding: 'utf8' }), /import <claude\|codex\|all>/)
  assert.match(execFileSync(command, ['--help'], { encoding: 'utf8' }), /forget <habit\|experience\|insight>/)
  const imported = JSON.parse(execFileSync(command, [
    'import',
    'claude',
    '--claude-dir',
    source,
    '--root-dir',
    rootDir,
    '--json',
  ], { encoding: 'utf8' }))
  assert.equal(imported[0].created, 2)

  const records = await readdir(join(rootDir, 'archive', 'experience'))
  assert.equal(records.length, 2)
  const memoryPaths = records.map(name => join(rootDir, 'archive', 'experience', name))
  const memories = await Promise.all(memoryPaths.map(async path => ({
    path,
    value: JSON.parse(await readFile(path, 'utf8')),
  })))
  assert.deepEqual(new Set(memories.map(item => item.value.title)), new Set([
    'Packed memory',
    'Second memory',
  ]))
  assert.ok(memories.every(item => item.value.status === 'candidate'))
  assert.ok(memories.every(item =>
    item.value.evidence.some(evidence =>
      evidence.kind === 'imported-file' && evidence.provider === 'claude')))

  for (const [index, item] of memories.entries()) {
    const evidenceId = `${index + 1}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
    item.value.evidence.push({
      id: evidenceId,
      kind: 'external-uri',
      uri: `https://example.test/packed/${index + 1}`,
      observedAt: Date.now(),
    })
    item.value.status = 'verified'
    item.value.verification = {
      actor: { kind: 'agent', id: 'packed-test' },
      method: 'source-check',
      evidenceIds: [evidenceId],
      verifiedAt: Date.now(),
    }
    await writeFile(item.path, `${JSON.stringify(item.value, null, 2)}\n`)
  }

  const first = memories[0].value
  const cancelled = spawnSync(command, [
    'forget',
    first.kind,
    first.id,
    '--root-dir',
    rootDir,
    '--json',
  ], {
    encoding: 'utf8',
    input: 'no\n',
  })
  assert.equal(cancelled.status, 0, cancelled.stderr)
  assert.equal(JSON.parse(cancelled.stdout).forgotten, false)
  await readFile(memories[0].path)

  const confirmed = spawnSync(command, [
    'forget',
    first.kind,
    first.id,
    '--root-dir',
    rootDir,
    '--reason-code',
    'incorrect',
    '--json',
  ], {
    encoding: 'utf8',
    input: 'yes\n',
  })
  assert.equal(confirmed.status, 0, confirmed.stderr)
  assert.equal(JSON.parse(confirmed.stdout).tombstone.reasonCode, 'incorrect')

  const second = memories[1].value
  const nonInteractive = JSON.parse(execFileSync(command, [
    'forget',
    second.kind,
    second.id,
    '--root-dir',
    rootDir,
    '--reason-code',
    'privacy',
    '--yes',
    '--json',
  ], { encoding: 'utf8' }))
  assert.equal(nonInteractive.tombstone.reasonCode, 'privacy')
  assert.deepEqual((await readdir(join(rootDir, 'archive', 'experience'))), [])
  const tombstones = await readdir(join(rootDir, 'archive', 'tombstones'))
  assert.equal(tombstones.length, 2)
  const storedTombstone = JSON.parse(await readFile(
    join(rootDir, 'archive', 'tombstones', tombstones[0]),
    'utf8',
  ))
  assert.deepEqual(Object.keys(storedTombstone).sort(), [
    'deletedAt',
    'id',
    'kind',
    'reasonCode',
    'schemaVersion',
  ])

  process.stdout.write(`${JSON.stringify({
    archive,
    version: manifest.version,
    executable: command,
    tombstones: tombstones.length,
  }, null, 2)}\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
