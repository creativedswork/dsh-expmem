#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  defaultMemoryDir,
  importMemories,
  type ImportProvider,
  type MemoryImportResult,
} from './importer.js'
import {
  FileExperienceArchive,
  type DeletionReasonCode,
  type ExperienceKind,
} from './storage.js'
import { isDeletionReason, isExperienceKind } from './schema.js'

const HELP = `Usage:
  dsh-expmem import <claude|codex|all> [options]
  dsh-expmem forget <habit|experience|insight> <uuid> [options]

Options:
  --root-dir <path>    ExpMem root (default: $DSH_HOME/expmem or ~/.dsh/expmem)
  --workspace <path>   Override the workspace attached to imported records
  --claude-dir <path>  Claude projects or custom memory directory
  --codex-dir <path>   Codex memories directory
  --dry-run            Report import changes without writing
  --reason-code <code> Deletion reason: user-request, duplicate, incorrect, privacy
  --yes                Confirm deletion without prompting
  --json               Print machine-readable results
  -h, --help           Show this help
`

const CLI_LIMITS = {
  maxEntryChars: 1_000_000,
  maxPreviewChars: 1,
  maxSearchResults: 1,
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      'root-dir': { type: 'string' },
      workspace: { type: 'string' },
      'claude-dir': { type: 'string' },
      'codex-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'reason-code': { type: 'string' },
      yes: { type: 'boolean' },
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
  if (positionals[0] === 'import') {
    await importCommand(positionals, values)
    return
  }
  if (positionals[0] === 'forget') {
    await forgetCommand(positionals, values)
    return
  }
  throw new Error(`invalid command\n\n${HELP}`)
}

interface CliValues {
  'root-dir'?: string
  workspace?: string
  'claude-dir'?: string
  'codex-dir'?: string
  'dry-run'?: boolean
  'reason-code'?: string
  yes?: boolean
  json?: boolean
}

async function importCommand(positionals: string[], values: CliValues): Promise<void> {
  if (positionals.length !== 2 || !['claude', 'codex', 'all'].includes(positionals[1]!)) {
    throw new Error(`invalid import command\n\n${HELP}`)
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
  for (const result of results) printImportResult(result)
}

async function forgetCommand(positionals: string[], values: CliValues): Promise<void> {
  if (positionals.length !== 3 || !isExperienceKind(positionals[1])) {
    throw new Error(`invalid forget command\n\n${HELP}`)
  }
  const reasonCode = values['reason-code'] ?? 'user-request'
  if (!isDeletionReason(reasonCode)) throw new Error(`invalid reason code: ${reasonCode}`)
  const kind: ExperienceKind = positionals[1]
  const id = positionals[2]!
  const rootDir = resolve(values['root-dir'] ?? defaultRootDir())
  const archive = new FileExperienceArchive(rootDir, CLI_LIMITS)
  const memory = await archive.readRecord(kind, id)

  if (!values.yes) {
    process.stderr.write(
      `Delete ExpMem record?\n`
      + `  id: ${memory.id}\n`
      + `  kind: ${memory.kind}\n`
      + `  status: ${memory.status}\n`
      + `  title: ${memory.title}\n`,
    )
    const readline = createInterface({ input: process.stdin, output: process.stderr })
    const answer = (await readline.question('Type yes to confirm: ')).trim().toLocaleLowerCase()
    readline.close()
    if (answer !== 'yes' && answer !== 'y') {
      printForgetResult(values.json ?? false, {
        forgotten: false,
        id,
        kind,
        status: memory.status,
      })
      return
    }
  }

  const tombstone = await archive.forgetConfirmed(
    kind,
    id,
    reasonCode as DeletionReasonCode,
  )
  printForgetResult(values.json ?? false, {
    forgotten: true,
    id,
    kind,
    status: memory.status,
    tombstone,
    path: join('archive', 'tombstones', `${id}.json`),
  })
}

function defaultRootDir(): string {
  const dshHome = process.env.DSH_HOME === undefined
    ? join(homedir(), '.dsh')
    : resolve(process.env.DSH_HOME)
  return join(dshHome, 'expmem')
}

function printImportResult(result: MemoryImportResult): void {
  const mode = result.dryRun ? 'dry run' : 'import'
  process.stdout.write(
    `${result.provider} ${mode}: ${result.scanned} scanned, `
    + `${result.created} created, ${result.updated} updated, `
    + `${result.skipped} unchanged, ${result.ignored} empty, `
    + `${result.warnings.length} archive warnings\n`
    + `  source: ${result.sourceDir}\n`
    + `  archive: ${result.rootDir}\n`,
  )
  for (const warning of result.warnings) {
    process.stderr.write(`  warning: ${warning.code} ${warning.path}: ${warning.message}\n`)
  }
}

function printForgetResult(json: boolean, result: Record<string, unknown>): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(result.forgotten
    ? `forgotten ${String(result.kind)}/${String(result.id)}; tombstone: ${String(result.path)}\n`
    : `deletion cancelled for ${String(result.kind)}/${String(result.id)}\n`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dsh-expmem: ${message}\n`)
  process.exitCode = 1
})
