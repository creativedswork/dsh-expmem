import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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

  const command = join(installed, 'node_modules', '.bin', 'dsh-expmem')
  assert.match(execFileSync(command, ['--help'], { encoding: 'utf8' }), /import <claude\|codex\|all>/)
  const imported = JSON.parse(execFileSync(command, [
    'import',
    'claude',
    '--claude-dir',
    source,
    '--root-dir',
    rootDir,
    '--json',
  ], { encoding: 'utf8' }))
  assert.equal(imported[0].created, 1)

  const records = await readdir(join(rootDir, 'archive', 'experience'))
  assert.equal(records.length, 1)
  const memory = JSON.parse(await readFile(
    join(rootDir, 'archive', 'experience', records[0]),
    'utf8',
  ))
  assert.equal(memory.title, 'Packed memory')
  assert.equal(memory.importedFrom.provider, 'claude')

  process.stdout.write(`${JSON.stringify({
    archive,
    version: manifest.version,
    executable: command,
    record: join(rootDir, 'archive', 'experience', records[0]),
  }, null, 2)}\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
