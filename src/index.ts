/**
 * Experience Memory plugin for DeepSeek Harness.
 *
 * @module @creative-dswork/dsh-expmem
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  FileExperienceArchive,
  type ExperienceKind,
  type ExperienceSearchOptions,
  type ExperienceSource,
  type ExperienceWriteInput,
} from './storage.js'

export type {
  ArchiveLimits,
  ExperienceKind,
  ExperienceMemory,
  ExperienceSearchHit,
  ExperienceSearchOptions,
  ExperienceSearchPage,
  ExperienceSource,
  ExperienceWriteInput,
} from './storage.js'
export { FileExperienceArchive } from './storage.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'expmem'

/** Required Harness services. */
export const inject = ['tools', 'systemPrompt']

/** Default persistent directory, shared by DSH profiles on one machine. */
export const DEFAULT_ROOT_DIR = join(
  process.env.DSH_HOME === undefined ? join(homedir(), '.dsh') : resolve(process.env.DSH_HOME),
  'expmem',
)

/** Default maximum Archive content length. */
export const DEFAULT_MAX_ENTRY_CHARS = 20_000

/** Default maximum model-visible characters per search hit. */
export const DEFAULT_MAX_PREVIEW_CHARS = 1_000

/** Default maximum hits returned by one search call. */
export const DEFAULT_MAX_SEARCH_RESULTS = 20

/** Plugin configuration. */
export interface Config {
  /** Absolute storage directory. Defaults to `$DSH_HOME/expmem` or `~/.dsh/expmem`. */
  rootDir?: string
  /** Maximum characters accepted in one Archive record. Defaults to 20000. */
  maxEntryChars?: number
  /** Maximum model-visible characters per search hit. Defaults to 1000. */
  maxPreviewChars?: number
  /** Maximum hits returned by one search call. Defaults to 20. */
  maxSearchResults?: number
}

/** Runtime schema for Loader validation and defaults. */
export const Config: z<Config> = z.object({
  rootDir: z.string().default(DEFAULT_ROOT_DIR),
  maxEntryChars: z.number().step(1).min(1).default(DEFAULT_MAX_ENTRY_CHARS),
  maxPreviewChars: z.number().step(1).min(1).default(DEFAULT_MAX_PREVIEW_CHARS),
  maxSearchResults: z.number().step(1).min(1).default(DEFAULT_MAX_SEARCH_RESULTS),
})

interface ResolvedConfig {
  rootDir: string
  maxEntryChars: number
  maxPreviewChars: number
  maxSearchResults: number
}

const EXPMEM_PROMPT =
  'Use session_search or session_event_search for verbatim Recall from prior DSH sessions. '
  + 'Use expmem_search for distilled user habits, task experience, and reusable insights. '
  + 'Use expmem_write only for stable, verified knowledge; update an existing hit instead of duplicating it. '
  + 'Never archive secrets, transient progress, raw logs, or unverified assumptions.'

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }],
}

/** Register ExpMem guidance and Archive tools. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const resolved = resolveConfig(config)
  const archive = new FileExperienceArchive(resolved.rootDir, resolved)
  await archive.initialize()

  ctx.systemPrompt.section({
    name: 'tool:expmem',
    order: 114,
    text: EXPMEM_PROMPT,
  })
  ctx.tools.register(searchTool(archive, resolved))
  ctx.tools.register(writeTool(archive))
  ctx.tools.register(forgetTool(archive))
}

function searchTool(archive: FileExperienceArchive, config: ResolvedConfig): ToolDefinition {
  return defineTool({
    name: 'expmem_search',
    description:
      'Search distilled personal development experience: user habits, task experience, and reusable insights. Use session_search for verbatim session history.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Case-insensitive search text. Space-separated terms are all required. Empty lists newest entries.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['habit', 'experience', 'insight'] },
        description: 'Optional experience categories.',
      },
      workspace: {
        type: 'string',
        description: 'Optional exact workspace path. Omit to search across projects.',
      },
      limit: {
        type: 'integer',
        description: `Results per page, from 1 to ${config.maxSearchResults}. Defaults to ${config.maxSearchResults}.`,
      },
      cursor: {
        type: 'string',
        description: 'nextCursor from the previous call with the same filters.',
      },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      const options: ExperienceSearchOptions = {
        query: args.query,
        limit: args.limit ?? config.maxSearchResults,
        ...args.workspace === undefined ? {} : { workspace: args.workspace },
        ...args.cursor === undefined ? {} : { cursor: args.cursor },
        ...args.kinds === undefined ? {} : { kinds: args.kinds },
      }
      return await archive.search(options) as unknown as JsonValue
    },
  })
}

function writeTool(archive: FileExperienceArchive): ToolDefinition {
  return defineTool({
    name: 'expmem_write',
    description:
      'Create a distilled experience-memory record, or update one by passing its existing id and category.',
    parameters: {
      kind: {
        type: 'string',
        enum: ['habit', 'experience', 'insight'],
        required: true,
        description: 'Experience category.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Short specific title.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'Self-contained reusable knowledge without secrets or transient status.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional search terms.',
      },
      id: {
        type: 'string',
        description: 'Existing ExpMem UUID to update. Omit to create.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const write: ExperienceWriteInput = {
        kind: args.kind,
        title: args.title,
        content: args.content,
        ...args.id === undefined ? {} : { id: args.id },
        ...args.tags === undefined ? {} : { tags: args.tags },
      }
      return await archive.write(write, sourceOf(exec)) as unknown as JsonValue
    },
  })
}

function forgetTool(archive: FileExperienceArchive): ToolDefinition {
  return defineTool({
    name: 'expmem_forget',
    description: 'Delete one distilled ExpMem Archive record by exact category and id.',
    parameters: {
      kind: {
        type: 'string',
        enum: ['habit', 'experience', 'insight'],
        required: true,
        description: 'Category from the search hit.',
      },
      id: {
        type: 'string',
        required: true,
        description: 'UUID from the search hit.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      await archive.forget(args.kind, args.id)
      return { forgotten: true, kind: args.kind, id: args.id }
    },
  })
}

function resolveConfig(config: Config): ResolvedConfig {
  const rootDir = config.rootDir ?? DEFAULT_ROOT_DIR
  if (!isAbsolute(rootDir)) throw new TypeError('expmem: rootDir must be an absolute path')
  return {
    rootDir,
    maxEntryChars: positiveInteger(config.maxEntryChars, DEFAULT_MAX_ENTRY_CHARS, 'maxEntryChars'),
    maxPreviewChars: positiveInteger(config.maxPreviewChars, DEFAULT_MAX_PREVIEW_CHARS, 'maxPreviewChars'),
    maxSearchResults: positiveInteger(
      config.maxSearchResults,
      DEFAULT_MAX_SEARCH_RESULTS,
      'maxSearchResults',
    ),
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`expmem: ${name} must be a positive safe integer`)
  }
  return resolved
}

function sourceOf(exec: ToolRunContext): ExperienceSource {
  const session = exec.agent?.session
  return {
    ...session === undefined ? {} : { sessionId: String(session.id) },
    ...session?.header.cwd === undefined ? {} : { workspace: session.header.cwd },
  }
}
