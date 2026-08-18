# DSH ExpMem

English | [简体中文](README.zh-CN.md)

**Experience Memory for DeepSeek Harness.**

DSH ExpMem is a community plugin, not an official DeepSeek project. It gives a DSH agent a file-backed Archive for distilled user habits, task experience, and reusable insights while reusing DSH's existing session history as Recall.

## Architecture

```mermaid
flowchart LR
  Agent["DSH Agent"]
  Sources["Claude Code / Codex<br/>Markdown memory"]

  Agent -->|"search / write / transition / forget"| Archive["ExpMem Archive<br/>JSON files"]
  Agent -->|"session_search / event_search"| Query["DSH Session Query<br/>SQLite FTS index"]
  Meter["DSH Token Meter"] -->|"70% pressure notice"| Agent
  Query --> Recall["DSH Recall<br/>session JSONL"]
  Sources -->|"dsh-expmem import"| Archive

  Archive --> Habits["Habits"]
  Archive --> Experience["Task experience"]
  Archive --> Insights["Insights"]
```

- **Recall** is verbatim prior-session history. DSH already stores it in JSONL and provides search through `dsh-session-query`.
- **Archive** is knowledge deliberately distilled by the agent. Each JSON record carries its trust status, author, and evidence.
- **Pressure promotion** asks the current agent to preserve high-value experience before DSH compacts the context.
- ExpMem does not duplicate session events or modify the Agent Loop.

## Install

```sh
dsh plugin --profile web add @creative-dswork/dsh-expmem
```

The bundle:

1. enables the existing DSH session-query SQLite backend on first search;
2. adds DSH's `session_search`, `session_event_search`, trace, and read tools;
3. adds `expmem_search`, `expmem_write`, `expmem_transition`, and `expmem_forget`;
4. enables one ExpMem promotion notice per DSH compaction cycle.

Start DSH normally:

```sh
dsh web
```

## Import Claude Code and Codex Memory

Preview and then import both agents' generated Markdown memories:

```sh
pnpm dlx @creative-dswork/dsh-expmem import all --dry-run
pnpm dlx @creative-dswork/dsh-expmem import all
```

The defaults are `~/.claude/projects/**/memory/*.md` for Claude Code and
`$CODEX_HOME/memories/**/*.md` (or `~/.codex/memories/**/*.md`) for Codex.
Override custom locations when needed:

```sh
pnpm dlx @creative-dswork/dsh-expmem import claude --claude-dir /path/to/memory
pnpm dlx @creative-dswork/dsh-expmem import codex --codex-dir /path/to/memories
```

Each source file becomes a candidate `experience` record with imported-file evidence: provider,
absolute source path, SHA-256, and observation time. ExpMem skips unchanged files. A changed
candidate updates in place; a changed verified, disputed, or superseded record produces a new
candidate and leaves the earlier record intact.

ExpMem never modifies or deletes source files. Use `--workspace /path/to/project` to attach an
explicit project scope; the default Claude layout is mapped to its project when that mapping is
unambiguous.

## Storage

The default files are:

```text
$DSH_HOME/
├── sessions/                         # DSH-owned Recall JSONL
└── expmem/
    ├── recall-index.sqlite           # derived DSH full-text index
    └── archive/
        ├── habit/<uuid>.json
        ├── experience/<uuid>.json
        ├── insight/<uuid>.json
        └── tombstones/<uuid>.json
```

Schema v1 records contain the claim, `candidate|verified|disputed|superseded` status, author,
evidence, timestamps, optional workspace, and record relations. ExpMem reads 0.2.x records as
v1 candidates in memory and writes v1 on their next update. A malformed or future-version file
produces a scan warning without hiding valid records in the same directory.

Each write creates a temporary file in the target directory and atomically renames it. Searches
read only final `.json` files, so an interrupted temporary write cannot become a partial record.

## Trust lifecycle

New records and imported memories start as `candidate`. `expmem_transition` can mark a candidate
`verified` only when its verification points to qualifying evidence:

- a user confirmation anchored to a complete DSH Session event range;
- a tool reproduction anchored to a complete event range;
- a source check linked to external URI evidence.

A record can move from candidate or verified to `disputed`. A verified replacement may declare
one-way `supersedes` links; ExpMem computes `supersededBy` when it reads the archive. Disputed
records may declare record-level `conflictsWith` links. ExpMem keeps the earlier claims instead
of rewriting them.

External review reports are opaque evidence. ExpMem stores the report schema, ID, location,
report SHA-256, and the SHA-256 of the exact claim reviewed. It does not open report locations,
parse verdicts, run review models, or grant `verified` from a report alone.

## Tools

| Tool | Purpose |
|---|---|
| `session_search` | Find relevant prior sessions in the current workspace. |
| `session_event_search` | Search events inside one prior session. |
| `expmem_search` | Search distilled experience across projects or one exact workspace. |
| `expmem_write` | Create or update a candidate record. |
| `expmem_transition` | Verify or dispute a record with evidence; add conflicts or supersession. |
| `expmem_forget` | Delete a candidate and leave a minimal tombstone. |

Search returns candidate, verified, and disputed records by default. Request `superseded`
explicitly when inspecting history. ExpMem tells the agent to treat candidate and disputed
records as unverified and to avoid secrets, transient progress, and raw logs.

## Confirmed deletion

The Agent tool deletes candidates only. Delete a verified, disputed, or superseded record through
the CLI:

```sh
pnpm dlx @creative-dswork/dsh-expmem forget insight <uuid> \
  --reason-code incorrect
```

The command prints the record's ID, kind, status, and title, then asks for confirmation. Use
`--yes` for an already approved non-interactive operation and `--json` for machine-readable
output. The tombstone contains only schema version, ID, kind, deletion time, and reason code.

## Pressure Promotion

Before each model step, ExpMem reuses DSH's token meter to measure the current context. At the
default 70% threshold, it adds one synthetic user notice asking the agent to search existing
ExpMem records and preserve at most three durable candidates before continuing the original
task.

The notice is stored in the DSH session log, so ExpMem emits it only once per successful
compaction cycle. If DSH compacts before the notice can be delivered, ExpMem instead cites the
compacted event range and asks the agent to recover the original messages from Recall. No
background worker or separate LLM summarizer is involved.

## Configuration

Override the `expmem` row in the profile's `cordis.patch.yml`:

```yaml
- id: expmem
  config:
    rootDir: /absolute/path/to/expmem
    maxEntryChars: 20000
    maxPreviewChars: 1000
    maxSearchResults: 20
    promotionEnabled: true
    warningRatio: 0.7
    maxPromotionsPerCycle: 3
    recoveryAfterCompaction: true
```

`rootDir` must be absolute. Search is a case-insensitive literal AND over whitespace-separated terms. An empty query lists the newest records.
Pressure promotion activates only when the active DSH composition provides both the token meter
and model context-window metadata.

To change Recall indexing, override the bundle's existing row:

```yaml
- id: session-query-sqlite
  config:
    path: /absolute/path/to/recall-index.sqlite
    openAt: first-search
```

## Development

```sh
pnpm install
pnpm run check
pnpm run pack:dry-run
```

Install this checkout into a profile:

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
```

## Current Scope

- Archive search is a transparent linear scan; add an index only after corpus size demonstrates the need.
- Promotion is cooperative: the current agent decides which records qualify and may decline to write any.
- No embeddings, background LLM summarizer, semantic deduplication model, or retention scheduler is included.
- ExpMem stores external review-report links but does not run or parse an audit pipeline.
- Recall deletion and retention remain owned by DSH session persistence.

## License

[MIT](LICENSE)
