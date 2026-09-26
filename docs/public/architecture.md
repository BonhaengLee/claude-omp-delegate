# Architecture

`claude-omp-delegate` is a local integration between Claude Code and an already installed OMP executable inside the supported range (`OMP_COMPAT` in `src/contracts.js`: 18.3.0 up to, not including, 19.0.0). The architecture keeps planning/review in Claude and implementation execution in OMP, with a durable job boundary between them.

## Responsibilities

```text
Claude command or MCP call
        |
        v
src/server.js  -- strict MCP schemas, tool registration, error envelope
        |
        v
src/jobs.js    -- workspace identity, state, lock, model resolution, job lifecycle
        |
        +--> detached src/worker.js -- heartbeat, cancel polling, evidence, terminal commit
        |             |
        |             v
        |       src/runner.js -- shell:false OMP process, JSONL reducer, EOF/session proof
        |
        +--> src/render.js -- compact progress/result/doctor envelopes

src/cli.js      -- bounded waiter and doctor CLI used by Claude background execution
src/contracts.js-- schemas, limits, status/error codes, option parsing
plugins/omp/   -- Claude commands, MCP manifest, Plan-mode guard, generated runtime
```

- `src/contracts.js` is the single source for strict brief/job/tool schemas, status/error constants, limits, model selectors, and `--model`/`--thinking` parsing.
- `src/server.js` registers six MCP tools and delegates to `src/jobs.js`; it does not own durable work. When `OMP_DELEGATE_DEPTH=1`, it exposes an empty tool catalog to prevent recursion.
- `src/jobs.js` creates and validates state, resolves the OMP executable/model, enforces one active lock per workspace key, starts a detached worker, selects resumable sessions, and performs fail-closed recovery.
- `src/worker.js` is the durable owner after readiness. It updates heartbeat/activity, polls cancellation intent, forwards OMP events/evidence, captures before/after workspace state, and commits terminal state.
- `src/runner.js` starts OMP with an argv array and stdin prompt, reduces the OMP 18.3.x JSONL dialect, validates the persisted session identity, and confirms process-group termination.
- `src/render.js` is the shared user-facing envelope for MCP and CLI output. It intentionally distinguishes observed evidence from acceptance decisions.
- `plugins/omp/commands/` contains the six slash-command interaction contracts. The generated `plugins/omp/runtime/` contains the source entrypoints, production dependencies, and upstream license texts required for an installed plugin.

## Start and worker hand-off

1. Claude authors a strict brief containing a goal, decisions, write scope, acceptance criteria, constraints, and verification steps. A leading model/thinking override is parsed by the shared contract.
2. The MCP call supplies an existing absolute workspace. The server does not infer it from its own `process.cwd()`.
3. `jobs.js` resolves the workspace with `realpath`, captures a dirty-worktree/filesystem baseline, resolves the configured OMP model, and writes a temporary job directory.
4. An exclusive workspace lock is acquired. The temporary job is atomically published under its UUID; only the owning nonce may release that lock.
5. A detached Node worker is spawned and must publish a matching ready marker within five seconds. The client receives the job card after this hand-off; Claude disconnection does not own or cancel the worker.
6. The worker starts OMP with `shell:false` and these core arguments:

   `text
   omp -p --mode json --no-title --cwd <workspace>
       --session-dir <job state>/sessions --model <openai-codex/id>
       [--thinking <level>] [--resume <session id>]
   `

   The brief-derived prompt is written to OMP stdin and then the stream is ended. OMP's normal project rules, skills, MCP servers, extensions, and settings remain in effect.

7. `OMP_DELEGATE_DEPTH=1` is added to the worker/OMP environment. This is a recursion guard, not an account or sandbox boundary.

## OMP completion proof

The runner consumes incremental UTF-8 JSONL with a 16 MiB line limit and keeps only a bounded stderr tail. Event persistence uses bounded batches (256 events or a 64 KiB flush threshold), coalesced progress updates, and a short idle flush timer. A single frame may exceed the batch threshold but remains subject to the line limit. Only one batch writes at a time; a pending batch applies backpressure, and all accepted events drain in order before terminal state. Timer flushes do not enqueue an unbounded chain of disk writes. It does not treat exit code zero alone as success. A normal completed result requires all of the following:

- a version-3 OMP `session` header with an id;
- a terminal `agent_end` (an explicitly non-terminal `agent_end` is not enough);
- a final assistant message with text and a non-error/non-aborted stop reason;
- no unfinished tool executions;
- exit code zero;
- a persisted session file directly inside the job session directory whose header id matches the event id;
- confirmed stdout EOF, stderr close, and OMP process-group disappearance.

Malformed/oversized output, an incomplete terminal sequence, missing/mismatched session identity, or unconfirmed process cleanup produces an explicit error code and does not silently become a successful job. Unknown event types are retained for evidence but do not establish completion.

## State and profile independence

The default state root is `~/.local/state/claude-omp-delegate`; `OMP_DELEGATE_STATE_DIR` may override it. It is independent of `CLAUDE_CONFIG_DIR` and `CLAUDE_PLUGIN_DATA`.

The layout is conceptually:

```text
<state root>/
  config.json
  locks/<sha256(lock key)>/lock.json
  workspaces/<sha256(real workspace)>/jobs/<job UUID>/
    job.json
    brief.json
    baseline.json
    events.jsonl
    stderr.log
    result.json
    sessions/<OMP transcript>.jsonl
```

Directories are secured as `0700` and files as `0600` where the state engine creates them. Writes use temporary files plus rename. Symlinked state components, invalid schemas, path escapes, and corrupt JSON fail closed as `STATE_CORRUPT`; they are not replaced with an empty state.

The workspace lock key is the real Git top-level path when available, otherwise the real workspace path. Only one active job may hold a key; there is no queue or automatic retry. This lock is shared across Claude profiles for the same OS user. Switching profiles changes the client, not the worker or persisted OMP session.

## Resume and follow-up

A follow-up always receives a new job UUID and `parentJobId`, while retaining the parent's `sessionDir` and `sessionId`. Before spawning, the recorded transcript header and direct-file location are revalidated. The merged brief carries forward prior decisions, scope, acceptance, constraints, and verification entries.

When no job id is supplied, the engine considers resumable terminal jobs grouped by session. Exactly one session must remain; multiple sessions produce `AMBIGUOUS_SESSION` and a selection card. A failed validation produces `RESUME_FAILED`. There is no implicit fresh-session fallback, and a detached live process/cache is not promised to survive as a process.

## Cancellation and recovery

`omp_cancel` writes an atomic cancellation intent; the worker polls it every 250 ms. The runner sends `SIGTERM`, waits up to five seconds, then sends `SIGKILL` and waits for confirmation. Cancellation is committed only after child exit, stdout EOF, stderr close, and process-group disappearance. If those observations cannot be confirmed, the job is `CANCEL_UNCONFIRMED`/failed and the lock remains for diagnosis; the system does not read a stale disk PID and kill an unrelated process.

A worker heartbeat is refreshed every two seconds. Doctor reports stale ownership and only permits explicit recovery after matching nonce, stale heartbeat, owner PID absence, and child-group disappearance have all been rechecked. It never auto-runs a replacement job. Existing workspace changes are preserved; no cancellation or recovery path rolls them back.

## Plan-mode guard and boundaries

The Claude PreToolUse hook matches MCP calls but acts only on tool names ending in `__omp_start` or `__omp_followup`. It rejects malformed/unknown permission modes, denies mutating calls in `plan`, and requires the hook `cwd` and tool workspace to resolve to the same directory. Status/result/cancel/doctor are not mutation targets and remain available in Plan mode.

This project does not:

- copy or migrate Claude transcripts, credentials, or account sessions;
- automatically log in, change Claude profiles, update OMP, or choose another provider/model;
- provide an OS sandbox, web dashboard, cloud service, Telegram/cxd launcher, or automatic reconnect push;
- commit, stash, reset, revert, or otherwise roll back workspace changes;
- infer acceptance PASS from a final model message, a tool payload, or an exit code alone.

Review the workspace diff and recorded evidence in Claude after each terminal result.
