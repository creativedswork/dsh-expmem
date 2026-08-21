# Generative memory upgrade

## Status

Retrieval and prompt-driven reflection shipped in ExpMem 0.4.0. Persistent
Reflection Runs ship in ExpMem 0.5.0.

## Goal

ExpMem already gives DSH durable, auditable memory. This upgrade adds the
cognitive layer from *Generative Agents*: rank memories by current usefulness,
record higher-level reflections with citations, and ask the current agent to
reflect when enough important experience has accumulated.

The design keeps DSH's existing ownership boundaries:

- DSH Session Persistence remains the complete observation stream.
- ExpMem Archive remains the distilled personal memory.
- DSH manages active plans, goals, and task progress.
- ExpMem supplies personalized context to planning and action.

## Paper evidence

The implementation follows three mechanisms from *Generative Agents:
Interactive Simulacra of Human Behavior*:

1. Section 4.1 defines each memory object with a natural-language description,
   creation timestamp, and most recent access timestamp. Retrieval combines
   recency, importance, and relevance after min-max normalization. The paper
   uses an hourly recency decay factor of `0.995` and equal weights.
2. Section 4.2 stores reflections alongside observations. It triggers
   reflection when recent importance reaches a threshold, asks salient
   questions, retrieves records for each question, then writes higher-level
   insights with pointers to cited records. Reflections may cite earlier
   reflections, forming a tree.
3. Section 4.3 feeds observations, reflections, and plans into behavior
   generation. Plans remain mutable working state.

ExpMem adopts the first two mechanisms. DSH already owns the third through its
agent loop, goals, Session history, and task tools.

## Mapping to DSH

| Generative Agents | DSH ExpMem |
| --- | --- |
| Observation stream | DSH Session JSONL and Session Query |
| Memory object | ExpMem candidate/verified/disputed record |
| Importance | Agent-assigned integer from 1 to 10 |
| Most recent access | `lastAccessedAt`, updated when a hit enters a search page |
| Relevance | Literal query-term coverage |
| Reflection | `insight` record with a question and cited memory IDs |
| Reflection trigger | Synthetic user notice from `agent/pre-step` |
| Planning | Existing DSH planning and task state, conditioned by ExpMem search |

## Data contract

Schema v1 gains backward-compatible optional fields on disk. The loader supplies
defaults for existing records.

```ts
interface MemoryReflection {
  question: string
  sourceMemoryIds: string[]
  runId?: string
  questionId?: string
}

interface ExperienceMemory {
  // Existing Schema v1 fields...
  importance: number       // integer 1..10
  lastAccessedAt: number   // Unix epoch milliseconds
  reflection?: MemoryReflection
}
```

Reflection Run state uses its own independently versioned contract:

```ts
interface ReflectionRun {
  schemaVersion: 'reflection-run@1'
  id: string
  status: 'pending' | 'prepared' | 'completed'
  sourceMemories: Array<{
    memoryId: string
    claimSha256: string
    updatedAt: number
    importance: number
  }>
  questions: Array<{
    id: string
    text: string
    retrievedMemoryIds: string[]
  }>
  insightMemoryIds: string[]
  consumedSourceMemoryIds: string[]
  createdAt: number
  updatedAt: number
  completedAt?: number
  workspace?: string
}
```

Defaults:

- Existing v1 and legacy records load with `importance: 5`.
- Existing records load with `lastAccessedAt: updatedAt`.
- New records start with `lastAccessedAt: createdAt`.
- Candidate updates retain importance and reflection unless the caller supplies
  replacements.

`claimSha256()` continues to hash only `kind`, `title`, `content`, and
`claimedAt`. Access time, importance, and reflection provenance do not change
the reviewed claim.

## Reflection rules

A reflection is an `insight` candidate with:

- one non-empty question;
- zero or more cited ExpMem record IDs;
- at least one cited memory ID or one complete Session event range;
- no self-reference;
- no cycle in the reflection graph.

New cited memory IDs must resolve to live records. Existing references may
survive source deletion so the tombstone remains the audit boundary.

Reflection records use the same trust lifecycle as other memories. Reflection
does not imply verification.

## Retrieval

### Candidate selection

An empty query considers every record allowed by the kind, status, and
workspace filters. A non-empty query considers records matching at least one
query term. Matching remains case-insensitive and literal.

### Raw scores

For each candidate:

```text
recency   = 0.995 ^ hours_since_last_access
importance = memory.importance
relevance = matched_query_terms / total_query_terms
```

The implementation clamps negative elapsed time to zero.

### Normalization and final score

ExpMem min-max normalizes each component across the candidate set:

```text
normalized(value) = (value - min) / (max - min)
score = normalized(recency)
      + normalized(importance)
      + normalized(relevance)
```

When every candidate has the same component value, that component contributes
zero because it cannot distinguish the candidates.

Search sorts by score, then by `updatedAt`, then by ID. Each hit returns the
total score and its three normalized components. Only hits placed in the
returned page receive a new `lastAccessedAt`.

Search no longer declares itself concurrency-safe because retrieval now writes
access metadata.

## Reflection pressure

The paper uses a threshold of 150 over a comprehensive observation stream.
ExpMem stores a much smaller, already distilled Archive. Its default threshold
is `30`.

For the current workspace, ExpMem collects non-reflection source revisions that
no completed run has consumed and sums their importance. At the threshold it
creates a persistent run:

1. `pending`: the current agent proposes one to three high-level questions;
2. `prepared`: ExpMem retrieves and records ranked memory IDs for each question;
3. `completed`: the agent submits cited insight candidates and ExpMem writes
   them into the Archive.

The run survives process restart. ExpMem repeats its notice on a later turn
until the run completes, but suppresses duplicate notices within one turn.
Commit retries return the same insight records.

Only the main agent may own this workflow. A session with
`header.origin === 'subagent'` receives no Reflection Run notice, and the tool
rejects prepare or commit calls from that session. `parentSession` alone does
not identify a subagent because ordinary forks also carry that field.

Completion consumes only source revisions cited by committed insights. An
uncited source remains eligible for a later run, and updating a consumed record
creates a new eligible revision. Older reflections without Run metadata retain
their existing source-consumption behavior.

Pressure promotion retains priority. When context pressure and reflection
pressure occur on the same step, the plugin emits the context-preservation
notice first and defers reflection to a later step.

## Configuration

```ts
interface Config {
  reflectionEnabled?: boolean       // default true
  reflectionThreshold?: number      // default 30
  recencyDecay?: number             // default 0.995
}
```

`recencyDecay` must be greater than zero and no greater than one.

## Agent tools

`expmem_write` adds:

- `importance`: integer from 1 to 10;
- `reflection`: question plus source memory IDs.

`expmem_search` changes from strict AND ordering by update time to ranked
retrieval. Existing filters and cursor pagination remain.

`expmem_reflect` has two actions:

- `prepare` accepts a Run ID and high-level questions, performs ranked
  retrieval, and persists the retrieved memory IDs;
- `commit` accepts cited insights, validates every citation against its
  prepared question, writes insight candidates, and completes the Run.

## Explicit boundaries

This upgrade does not add:

- an embedding model or vector database;
- a background summarizer;
- a second model call for importance or reflection;
- plan records in the long-term Archive;
- automatic trust promotion;
- automatic report parsing.

The current DSH agent supplies importance and writes reflections. ExpMem
validates, stores, ranks, and schedules.

## Acceptance criteria

- Existing 0.2.x and Schema v1 records still load.
- Importance accepts only integers from 1 to 10.
- Search ranks by normalized recency, importance, and relevance.
- Search updates access time only for returned hits.
- Reflection records reject missing provenance, dangling sources, self-links,
  and cycles.
- Recursive reflections can cite earlier reflections.
- A pending or prepared Run resumes after process restart.
- Repeated commit is idempotent.
- Only cited source revisions are consumed.
- Uncited and subsequently updated records remain eligible.
- Context pressure still takes priority.
- No runtime dependency or extra model request is added.
