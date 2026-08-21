/**
 * Experience Memory plugin for DeepSeek Harness.
 *
 * @module @creative-dswork/dsh-expmem
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  FileExperienceArchive,
  type ExperienceSearchOptions,
  type ExperienceSource,
  type ExperienceTransitionInput,
  type ExperienceWriteInput,
  type MemoryActor,
  type MemoryEvidenceInput,
  type MemoryReflection,
  type MemoryVerificationInput,
  type ReflectionInsightInput,
  type ReflectionRun,
} from './storage.js'

export type {
  ArchiveLimits,
  ArchiveScanResult,
  ArchiveWarning,
  DeletionReasonCode,
  ExperienceKind,
  ExperienceMemory,
  ExperienceSearchHit,
  ExperienceSearchOptions,
  ExperienceSearchPage,
  ExperienceSource,
  ExperienceTransitionInput,
  ExperienceWriteInput,
  ImportedMemorySource,
  MemoryActor,
  MemoryEvidence,
  MemoryEvidenceInput,
  MemoryReflection,
  MemoryStatus,
  MemoryTombstone,
  MemoryVerification,
  MemoryVerificationInput,
  ReflectionCommitResult,
  ReflectionInsightInput,
  ReflectionPreparation,
  ReflectionPrepareOptions,
  ReflectionPressure,
  ReflectionPressureRecord,
  ReflectionRun,
  ReflectionRunQuestion,
  ReflectionRunSource,
  ReflectionRunStatus,
} from './storage.js'
export { FileExperienceArchive } from './storage.js'
export { claimSha256, MemorySchemaError } from './schema.js'

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

/** Default context pressure that asks the agent to promote durable experience. */
export const DEFAULT_WARNING_RATIO = 0.7

/** Default bound the pressure notice places on one promotion pass. */
export const DEFAULT_MAX_PROMOTIONS_PER_CYCLE = 3

/** Default importance accumulated before asking the agent to reflect. */
export const DEFAULT_REFLECTION_THRESHOLD = 30

/** Default hourly recency decay from Generative Agents. */
export const DEFAULT_RECENCY_DECAY = 0.995

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
  /** Ask the agent to promote durable experience before DSH compaction. Defaults to true. */
  promotionEnabled?: boolean
  /** Context-window ratio that triggers one promotion notice per compaction cycle. Defaults to 0.7. */
  warningRatio?: number
  /** Maximum records requested by one promotion notice. Defaults to 3. */
  maxPromotionsPerCycle?: number
  /** Recover from threshold jumps by reading compacted events from Recall. Defaults to true. */
  recoveryAfterCompaction?: boolean
  /** Ask the agent to synthesize higher-level reflections. Defaults to true. */
  reflectionEnabled?: boolean
  /** Importance accumulated before one reflection notice. Defaults to 30. */
  reflectionThreshold?: number
  /** Hourly retrieval recency decay. Defaults to 0.995. */
  recencyDecay?: number
}

/** Runtime schema for Loader validation and defaults. */
export const Config: z<Config> = z.object({
  rootDir: z.string().default(DEFAULT_ROOT_DIR),
  maxEntryChars: z.number().step(1).min(1).default(DEFAULT_MAX_ENTRY_CHARS),
  maxPreviewChars: z.number().step(1).min(1).default(DEFAULT_MAX_PREVIEW_CHARS),
  maxSearchResults: z.number().step(1).min(1).default(DEFAULT_MAX_SEARCH_RESULTS),
  promotionEnabled: z.boolean().default(true),
  warningRatio: z.number().min(0).max(1).default(DEFAULT_WARNING_RATIO),
  maxPromotionsPerCycle: z.number().step(1).min(1).default(DEFAULT_MAX_PROMOTIONS_PER_CYCLE),
  recoveryAfterCompaction: z.boolean().default(true),
  reflectionEnabled: z.boolean().default(true),
  reflectionThreshold: z.number().step(1).min(1).default(DEFAULT_REFLECTION_THRESHOLD),
  recencyDecay: z.number().min(0).max(1).default(DEFAULT_RECENCY_DECAY),
})

interface ResolvedConfig {
  rootDir: string
  maxEntryChars: number
  maxPreviewChars: number
  maxSearchResults: number
  promotionEnabled: boolean
  warningRatio: number
  maxPromotionsPerCycle: number
  recoveryAfterCompaction: boolean
  reflectionEnabled: boolean
  reflectionThreshold: number
  recencyDecay: number
}

const EXPMEM_PROMPT =
  'Use session_search or session_event_search for verbatim Recall from prior DSH sessions. '
  + 'Use expmem_search for distilled user habits, task experience, and reusable insights. '
  + 'Use expmem_write for stable candidate knowledge; update an existing candidate instead of duplicating it. '
  + 'Assign importance from 1 to 10, and record higher-level insight reflections with cited source memory IDs. '
  + 'Only the main agent may complete pending Reflection Runs with expmem_reflect. '
  + 'Use ranked ExpMem results to personalize planning and reactions. '
  + 'Treat candidate and disputed memory as unverified, and use expmem_transition only with cited evidence. '
  + 'A review report is useful provenance but cannot verify a claim by itself. '
  + 'When ExpMem reports memory pressure, preserve the requested high-value records before continuing the task. '
  + 'Never archive secrets, transient progress, or raw logs.'

const PRESSURE_NOTICE = 'ExpMem memory pressure'
const RECOVERY_NOTICE = 'ExpMem post-compaction recovery'
const REFLECTION_NOTICE = 'ExpMem reflection pressure'

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
  ctx.tools.register(reflectionTool(archive, resolved))
  ctx.tools.register(transitionTool(archive))
  ctx.tools.register(forgetTool(archive))

  if (resolved.promotionEnabled) {
    ctx.inject(
      ['llm', 'tokenMeter'],
      runtime => registerMemoryNotices(runtime, resolved, archive),
    )
  } else if (resolved.reflectionEnabled) {
    registerMemoryNotices(ctx, resolved, archive)
  }
}

interface PendingRecovery {
  compactionId: string
  start?: number
  end?: number
}

interface PromotionState {
  consumedEvents: number
  warnedSinceCompaction: boolean
  pendingRecovery?: PendingRecovery
  summaries: Map<string, PendingRecovery>
  lastReflectionNotice?: {
    runId: string
    turn: number
  }
}

function registerMemoryNotices(
  ctx: Context,
  config: ResolvedConfig,
  archive: FileExperienceArchive,
): void {
  const states = new WeakMap<Session, PromotionState>()

  ctx.on('agent/pre-step', async (
    { agent, signal, turn },
    next,
  ): Promise<PreStepDecision> => {
    const before = syncPromotionState(states, agent.session)
    const recoveryPending = config.promotionEnabled
      && config.recoveryAfterCompaction
      && before.pendingRecovery !== undefined
    const ratio = !config.promotionEnabled
      || before.warnedSinceCompaction
      || recoveryPending
      ? undefined
      : await contextPressure(ctx, agent, signal)
    const pressureWarning = ratio !== undefined && ratio >= config.warningRatio
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const after = syncPromotionState(states, agent.session)
    if (
      config.promotionEnabled
      && config.recoveryAfterCompaction
      && !after.warnedSinceCompaction
      && after.pendingRecovery !== undefined
    ) {
      return appendPromotionNotice(
        decision,
        recoveryMessage(agent, after.pendingRecovery, config.maxPromotionsPerCycle),
      )
    }
    if (pressureWarning && !after.warnedSinceCompaction) {
      return appendPromotionNotice(
        decision,
        pressureMessage(ratio, config.maxPromotionsPerCycle),
      )
    }
    if (!config.reflectionEnabled || agent.session.header.origin === 'subagent') return decision
    const reflection = await archive.ensureReflectionRun(
      agent.session.header.cwd,
      config.reflectionThreshold,
    )
    signal.throwIfAborted()
    if (reflection === undefined
      || (after.lastReflectionNotice?.runId === reflection.id
        && after.lastReflectionNotice.turn === turn)) return decision
    after.lastReflectionNotice = { runId: reflection.id, turn }
    return appendPromotionNotice(
      decision,
      reflectionMessage(reflection, config.maxPromotionsPerCycle),
    )
  }, { prepend: true })
}

function appendPromotionNotice(
  decision: Extract<PreStepDecision, { kind: 'enter' }>,
  message: ReturnType<typeof createUserMessage>,
): PreStepDecision {
  return { kind: 'enter', messages: [...decision.messages, message] }
}

function pressureMessage(ratio: number, maxPromotions: number) {
  const text = [
    `ExpMem memory pressure: ${Math.round(ratio * 100)}% of the model context is in use.`,
    'Before continuing the original task, preserve durable knowledge from the current context:',
    '1. Use expmem_search before writing and update an existing record instead of duplicating it.',
    `2. Preserve at most ${maxPromotions} high-value records as candidates.`,
    '3. Use habit for stable user preferences, experience for reusable condition/action/outcome, and insight for generalizable engineering judgment.',
    '4. Assign importance from 1 to 10 and include inspectable evidence when available.',
    '5. Do not promote a candidate without qualifying evidence or preserve secrets, raw logs, or transient progress.',
    'Continue the original task after preservation.',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: PRESSURE_NOTICE,
    },
  })
}

function recoveryMessage(agent: Agent, recovery: PendingRecovery, maxPromotions: number) {
  const range = recovery.start === undefined || recovery.end === undefined
    ? 'the compacted source events'
    : `session events ${recovery.start} through ${recovery.end}`
  const text = [
    `ExpMem recovery: DSH compaction ${recovery.compactionId} completed before experience promotion.`,
    `The original messages remain in Recall. Use session_event_read or session_event_search for session ${String(agent.id)} to review ${range}.`,
    `Preserve at most ${maxPromotions} durable habits, reusable experiences, or generalizable insights as candidates with expmem_write.`,
    'Search ExpMem first, update existing records, and then continue the original task.',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: RECOVERY_NOTICE,
    },
  })
}

function reflectionMessage(reflection: ReflectionRun, maxReflections: number) {
  const records = reflection.sourceMemories
    .slice(0, 10)
    .map(record => `- ${record.memoryId} | importance ${record.importance}`)
  const next = reflection.status === 'pending'
    ? [
        `1. Identify one to ${maxReflections} high-level questions about recurring preferences, effective approaches, or engineering judgment.`,
        `2. Call expmem_reflect with action "prepare", runId "${reflection.id}", and those questions.`,
        '3. Review the ranked evidence returned for each question.',
        `4. Call expmem_reflect with action "commit" and at most ${maxReflections} cited insight candidates.`,
      ]
    : [
        'This run already has prepared questions:',
        ...reflection.questions.map(question =>
          `- ${question.id} | ${question.text} | ${question.retrievedMemoryIds.length} retrieved memories`),
        '1. Review the prepared evidence; use expmem_search again if the earlier tool result is no longer visible.',
        `2. Call expmem_reflect with action "commit", runId "${reflection.id}", and at most ${maxReflections} cited insight candidates.`,
      ]
  const text = [
    `ExpMem Reflection Run ${reflection.id} is ${reflection.status}.`,
    `${reflection.totalImportance} importance points triggered this run.`,
    'Unconsumed source revisions:',
    ...records,
    'Before continuing the original task:',
    ...next,
    'Only source revisions cited by committed insights are consumed.',
    'Keep conclusions bounded by their sources. Reflection does not imply verification.',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: REFLECTION_NOTICE,
    },
  })
}

async function contextPressure(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
): Promise<number | undefined> {
  const routed = agent.session.requestHeader()?.config
  const provider = routed?.provider || agent.options.provider
  const model = routed?.model || agent.options.model
  if (provider === undefined || model === undefined) return undefined

  try {
    const info = await ctx.llm.resolveModelInfo(provider, model, signal)
    const contextWindow = info.context?.contextWindow
    if (contextWindow === undefined) return undefined
    return ctx.tokenMeter.measure(agent.session).totalTokens / contextWindow
  } catch {
    signal.throwIfAborted()
    return undefined
  }
}

function syncPromotionState(
  states: WeakMap<Session, PromotionState>,
  session: Session,
): PromotionState {
  let state = states.get(session)
  if (state === undefined || state.consumedEvents > session.events.length) {
    state = {
      consumedEvents: 0,
      warnedSinceCompaction: false,
      summaries: new Map(),
    }
    states.set(session, state)
  }

  for (let index = state.consumedEvents; index < session.events.length; index += 1) {
    const event = session.events[index]
    if (event === undefined) continue
    if (isPromotionNotice(event)) {
      state.warnedSinceCompaction = true
      state.pendingRecovery = undefined
      continue
    }
    if (event.type === 'compaction/summary') {
      state.summaries.set(String(event.data.compactionId), {
        compactionId: String(event.data.compactionId),
        start: event.data.shadowedRange.start,
        end: event.data.shadowedRange.end,
      })
      continue
    }
    if (event.type !== 'compaction/end') continue
    const compactionId = String(event.data.compactionId)
    if (event.data.error === undefined) {
      state.pendingRecovery = state.warnedSinceCompaction
        ? undefined
        : state.summaries.get(compactionId) ?? { compactionId }
      state.warnedSinceCompaction = false
    }
    state.summaries.delete(compactionId)
  }
  state.consumedEvents = session.events.length
  return state
}

function isPromotionNotice(event: Session['events'][number]): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source
  return source.kind === 'plugin'
    && source.plugin === name
    && source.form === 'notice'
    && (source.summary === PRESSURE_NOTICE || source.summary === RECOVERY_NOTICE)
}

const ACTOR_PARAMETER = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: ['user', 'agent', 'tool'],
      required: true,
    },
    id: { type: 'string' },
  },
} as const

const EVIDENCE_PARAMETER = {
  type: 'array',
  items: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'session-event', required: true },
          id: { type: 'string' },
          sessionId: { type: 'string', required: true },
          startSeq: { type: 'integer' },
          endSeq: { type: 'integer' },
          observedAt: { type: 'integer' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'imported-file', required: true },
          id: { type: 'string' },
          provider: { type: 'string', enum: ['claude', 'codex'], required: true },
          path: { type: 'string', required: true },
          sha256: { type: 'string', required: true },
          observedAt: { type: 'integer' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'external-uri', required: true },
          id: { type: 'string' },
          uri: { type: 'string', required: true },
          capturedTextSha256: { type: 'string' },
          observedAt: { type: 'integer' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'review-report', required: true },
          id: { type: 'string' },
          schemaVersion: { type: 'string', const: 'review-report@1', required: true },
          reportId: { type: 'string', required: true },
          location: { type: 'string', required: true },
          sha256: { type: 'string', required: true },
          targetSha256: { type: 'string', required: true },
          observedAt: { type: 'integer' },
        },
      },
    ],
  },
} as const

const VERIFICATION_PARAMETER = {
  type: 'object',
  additionalProperties: false,
  properties: {
    actor: { ...ACTOR_PARAMETER, required: true },
    method: {
      type: 'string',
      enum: ['user-confirmation', 'tool-reproduction', 'source-check'],
      required: true,
    },
    evidenceIds: {
      type: 'array',
      items: { type: 'string' },
      required: true,
    },
    verifiedAt: { type: 'integer' },
  },
} as const

function searchTool(archive: FileExperienceArchive, config: ResolvedConfig): ToolDefinition {
  return defineTool({
    name: 'expmem_search',
    description:
      'Search distilled personal development experience: user habits, task experience, and reusable insights. Use session_search for verbatim session history.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Case-insensitive ranked query. Empty text ranks all matching records.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['habit', 'experience', 'insight'] },
        description: 'Optional experience categories.',
      },
      statuses: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['candidate', 'verified', 'disputed', 'superseded'],
        },
        description: 'Optional lifecycle states. Superseded records are hidden by default.',
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
    async execute(args) {
      const options: ExperienceSearchOptions = {
        query: args.query,
        limit: args.limit ?? config.maxSearchResults,
        recencyDecay: config.recencyDecay,
        ...args.workspace === undefined ? {} : { workspace: args.workspace },
        ...args.cursor === undefined ? {} : { cursor: args.cursor },
        ...args.kinds === undefined ? {} : { kinds: args.kinds },
        ...args.statuses === undefined ? {} : { statuses: args.statuses },
      }
      return await archive.search(options) as unknown as JsonValue
    },
  })
}

function writeTool(archive: FileExperienceArchive): ToolDefinition {
  return defineTool({
    name: 'expmem_write',
    description:
      'Create or update a candidate experience-memory record. This tool cannot mark memory verified.',
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
        description: 'Existing candidate UUID to update. Omit to create.',
      },
      authoredBy: {
        ...ACTOR_PARAMETER,
        description: 'Optional claim author. User authorship requires complete Session evidence.',
      },
      claimedAt: {
        type: 'integer',
        description: 'Optional time asserted by the claim, as Unix epoch milliseconds.',
      },
      evidence: {
        ...EVIDENCE_PARAMETER,
        description: 'Inspectable provenance. On update, this replaces prior evidence.',
      },
      evidenceText: {
        type: 'string',
        description: 'Optional human-readable evidence context; never verifies a claim.',
      },
      importance: {
        type: 'integer',
        enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        description: 'Personal significance from 1 (mundane) to 10 (highly consequential).',
      },
      reflection: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: {
            type: 'string',
            required: true,
            description: 'High-level question answered by this insight.',
          },
          sourceMemoryIds: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'ExpMem record UUIDs cited by this reflection.',
          },
        },
        description: 'Reflection provenance. Valid only for insight records.',
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
        ...args.authoredBy === undefined
          ? {}
          : { authoredBy: args.authoredBy as MemoryActor },
        ...args.claimedAt === undefined ? {} : { claimedAt: args.claimedAt },
        ...args.evidence === undefined
          ? {}
          : { evidence: args.evidence as MemoryEvidenceInput[] },
        ...args.evidenceText === undefined ? {} : { evidenceText: args.evidenceText },
        ...args.importance === undefined ? {} : { importance: args.importance },
        ...args.reflection === undefined
          ? {}
          : { reflection: args.reflection as MemoryReflection },
      }
      return await archive.writeCandidate(write, sourceOf(exec)) as unknown as JsonValue
    },
  })
}

function reflectionTool(
  archive: FileExperienceArchive,
  config: ResolvedConfig,
): ToolDefinition {
  return defineTool({
    name: 'expmem_reflect',
    description:
      'Prepare or commit one persistent Reflection Run as the main agent. Prepare retrieves ranked evidence for high-level questions; commit writes cited insight candidates.',
    parameters: {
      action: {
        type: 'string',
        enum: ['prepare', 'commit'],
        required: true,
      },
      runId: {
        type: 'string',
        required: true,
        description: 'Reflection Run UUID from the ExpMem notice.',
      },
      questions: {
        type: 'array',
        items: { type: 'string' },
        description: 'One to three high-level questions. Required for prepare.',
      },
      insights: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            questionId: {
              type: 'string',
              required: true,
              description: 'Question UUID returned by prepare.',
            },
            title: { type: 'string', required: true },
            content: { type: 'string', required: true },
            importance: {
              type: 'integer',
              enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
              required: true,
            },
            sourceMemoryIds: {
              type: 'array',
              items: { type: 'string' },
              required: true,
              description: 'Memory UUIDs returned for this question by prepare.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        description: 'One cited insight per prepared question. Required for commit.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      assertMainAgent(exec)
      if (args.action === 'prepare') {
        if (args.questions === undefined || args.insights !== undefined) {
          throw new Error('expmem_reflect prepare requires questions and no insights')
        }
        return await archive.prepareReflectionRun(args.runId, args.questions, {
          maxQuestions: config.maxPromotionsPerCycle,
          maxSearchResults: config.maxSearchResults,
          recencyDecay: config.recencyDecay,
        }) as unknown as JsonValue
      }
      if (args.insights === undefined || args.questions !== undefined) {
        throw new Error('expmem_reflect commit requires insights and no questions')
      }
      return await archive.commitReflectionRun(
        args.runId,
        args.insights as ReflectionInsightInput[],
        sourceOf(exec),
        config.maxPromotionsPerCycle,
      ) as unknown as JsonValue
    },
  })
}

function transitionTool(archive: FileExperienceArchive): ToolDefinition {
  return defineTool({
    name: 'expmem_transition',
    description:
      'Verify or dispute one ExpMem record with inspectable evidence. Review reports cannot verify a claim by themselves.',
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
      status: {
        type: 'string',
        enum: ['verified', 'disputed'],
        required: true,
        description: 'Target lifecycle status.',
      },
      evidence: {
        ...EVIDENCE_PARAMETER,
        description: 'Evidence to append before applying the transition.',
      },
      evidenceText: {
        type: 'string',
        description: 'Optional human-readable evidence context.',
      },
      verification: {
        ...VERIFICATION_PARAMETER,
        description: 'Required when first transitioning a candidate to verified.',
      },
      supersedes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Existing record UUIDs replaced by this verified claim.',
      },
      conflictsWith: {
        type: 'array',
        items: { type: 'string' },
        description: 'Existing record UUIDs that conflict with this disputed claim.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const transition: ExperienceTransitionInput = {
        kind: args.kind,
        id: args.id,
        status: args.status,
        ...args.evidence === undefined
          ? {}
          : { evidence: args.evidence as MemoryEvidenceInput[] },
        ...args.evidenceText === undefined ? {} : { evidenceText: args.evidenceText },
        ...args.verification === undefined
          ? {}
          : { verification: args.verification as MemoryVerificationInput },
        ...args.supersedes === undefined ? {} : { supersedes: args.supersedes },
        ...args.conflictsWith === undefined ? {} : { conflictsWith: args.conflictsWith },
      }
      return await archive.transition(transition, sourceOf(exec)) as unknown as JsonValue
    },
  })
}

function forgetTool(archive: FileExperienceArchive): ToolDefinition {
  return defineTool({
    name: 'expmem_forget',
    description:
      'Delete one candidate ExpMem record. Protected states require explicit CLI confirmation.',
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
      reasonCode: {
        type: 'string',
        enum: ['user-request', 'duplicate', 'incorrect', 'privacy'],
        description: 'Minimal tombstone reason. Defaults to user-request.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const tombstone = await archive.forgetCandidate(
        args.kind,
        args.id,
        args.reasonCode ?? 'user-request',
      )
      return { forgotten: true, tombstone } as unknown as JsonValue
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
    promotionEnabled: config.promotionEnabled ?? true,
    warningRatio: warningRatio(config.warningRatio),
    maxPromotionsPerCycle: positiveInteger(
      config.maxPromotionsPerCycle,
      DEFAULT_MAX_PROMOTIONS_PER_CYCLE,
      'maxPromotionsPerCycle',
    ),
    recoveryAfterCompaction: config.recoveryAfterCompaction ?? true,
    reflectionEnabled: config.reflectionEnabled ?? true,
    reflectionThreshold: positiveInteger(
      config.reflectionThreshold,
      DEFAULT_REFLECTION_THRESHOLD,
      'reflectionThreshold',
    ),
    recencyDecay: resolveRecencyDecay(config.recencyDecay),
  }
}

function warningRatio(value: number | undefined): number {
  const resolved = value ?? DEFAULT_WARNING_RATIO
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved >= 1) {
    throw new TypeError('expmem: warningRatio must be greater than 0 and less than 1')
  }
  return resolved
}

function resolveRecencyDecay(value: number | undefined): number {
  const resolved = value ?? DEFAULT_RECENCY_DECAY
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > 1) {
    throw new TypeError('expmem: recencyDecay must be greater than 0 and no greater than 1')
  }
  return resolved
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
  const actorId = exec.agent?.id ?? session?.id
  return {
    ...session === undefined ? {} : { sessionId: String(session.id) },
    ...session?.header.cwd === undefined ? {} : { workspace: session.header.cwd },
    ...actorId === undefined ? {} : { actor: { kind: 'agent', id: String(actorId) } },
  }
}

function assertMainAgent(exec: ToolRunContext): void {
  if (exec.agent?.session.header.origin === 'subagent') {
    throw new Error('expmem_reflect is restricted to the main agent')
  }
}
