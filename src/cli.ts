#!/usr/bin/env node

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  defaultMemoryDir,
  importMemories,
  type ImportProvider,
  type MemoryImportResult,
} from './importer.js'

const HELP = `Usage:
  dsh-expmem import <claude|codex|all> [options]

Options:
  --root-dir <path>    ExpMem root (default: $DSH_HOME/expmem or ~/.dsh/expmem)
  --workspace <path>   Override the workspace attached to imported records
  --claude-dir <path>  Claude projects or custom memory directory
  --codex-dir <path>   Codex memories directory
  --dry-run            Report changes without writing
  --json               Print machine-readable results
  -h, --help           Show this help
`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      'root-dir': { type: 'string' },
      workspace: { type: 'string' },
      'claude-dir': { type: 'string' },
      'codex-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP)
    return
  }
  if (positionals[0] !== 'import'
    || positionals.length !== 2
    || !['claude', 'codex', 'all'].includes(positionals[1]!)) {
    throw new Error(`invalid command\n\n${HELP}`)
  }

  const providers: ImportProvider[] = positionals[1] === 'all'
    ? ['claude', 'codex']
    : [positionals[1] as ImportProvider]
  const rootDir = resolve(values['root-dir'] ?? defaultRootDir())
  const workspace = values.workspace === undefined ? undefined : resolve(values.workspace)
  const results: MemoryImportResult[] = []

  for (const provider of providers) {
    const sourceDir = provider === 'claude' ? values['claude-dir'] : values['codex-dir']
    results.push(await importMemories({
      provider,
      rootDir,
      sourceDir: sourceDir ?? defaultMemoryDir(provider),
      ...workspace === undefined ? {} : { workspace },
      dryRun: values['dry-run'] ?? false,
    }))
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
    return
  }
  for (const result of results) printResult(result)
}

function defaultRootDir(): string {
  const dshHome = process.env.DSH_HOME === undefined
    ? join(homedir(), '.dsh')
    : resolve(process.env.DSH_HOME)
  return join(dshHome, 'expmem')
}

function printResult(result: MemoryImportResult): void {
  const mode = result.dryRun ? 'dry run' : 'import'
  process.stdout.write(
    `${result.provider} ${mode}: ${result.scanned} scanned, `
    + `${result.created} created, ${result.updated} updated, `
    + `${result.skipped} unchanged, ${result.ignored} empty\n`
    + `  source: ${result.sourceDir}\n`
    + `  archive: ${result.rootDir}\n`,
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dsh-expmem: ${message}\n`)
  process.exitCode = 1
})
