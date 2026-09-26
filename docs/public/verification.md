# Verification and evidence policy

This project has two different verification surfaces:

1. **Deterministic repository/package checks** run against source, fixtures, and the generated runtime.
2. **Manual host verification** run through an installed Claude Code plugin and a tested OMP version on macOS/Linux; `npm run e2e:host` automates the core start → wait → result path.

A fixture or package check cannot prove interactive Claude behavior. A successful process exit cannot prove acceptance. Keep the records separate and never report an unobserved behavior as PASS.

## Required order

Run these stages after the final source edit:

| Stage | Command or activity | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Source checks | `npm run verify` (or the narrowed `npm run typecheck` and `npm test`) | Contract/type/test behavior exercised by the repository | Installed Claude/OMP host behavior |
| Package build | `npm run package` | A runtime was generated from the current source and lockfile | That the runtime is installed or accepted by Claude |
| Package parity | `npm run check:package` | Manifest, entrypoints, production dependencies, generated notices, and excluded data match the package contract | Interactive slash completion or a live OMP session |
| Public-file check | `npm run check:public` | Required public files/links and forbidden private material checks | Runtime correctness |
| Manual host | Supported host scenarios below | Actual Claude plugin/MCP/OMP interactions observed in the stated environment | Other hosts, accounts, or future source/package states |
| Archive | `npm run release:archive` after the above | A release archive was assembled from the verified package | Release approval, publication, or live adoption |

The script names above are the repository's gate contract. If a gate is unavailable or narrowed, record the exact replacement command and why. Do not silently skip a stage.

## Deterministic test expectations

Repository tests should cover behavior and boundaries rather than wiring:

- OMP JSONL success, terminal/non-terminal agent endings, malformed/oversized lines, missing final output, session identity mismatch, and non-zero exits;
- strict brief/model/thinking validation and exact provider selectors;
- atomic state writes, corrupt/symlink state, workspace locks, profile-independent listing, and invalid job identities;
- cancellation before spawn, during execution, after completion, and unconfirmed process-group termination;
- detached-worker readiness, heartbeat/recovery safety, follow-up parent/session preservation, and MCP disconnect behavior;
- Plan-mode hook decisions and workspace realpath matching;
- generated runtime manifest/package parity and public-document path/link checks.

Fake child processes are useful for deterministic races and protocol errors. They are not a substitute for the actual OMP stream or Claude host.

## Manual Claude/OMP host matrix

Run these scenarios on a supported macOS or Linux host with the exact OMP version. Capture command output and the redacted result envelope; do not copy credentials, full transcripts, or personal paths into the repository.

1. **Doctor and package installation**
   - Build with `npm ci` and `npm run package`.
   - Install the local marketplace/plugin from the packaged checkout.
   - Run `/omp:doctor`; observe exact OMP path/version, supported platform, hook presence, and plugin-owned state initialization if it is the first run.
   - Confirm that login, account changes, global OMP settings, and unrelated files are not performed.
2. **Explicit implementation**
   - In normal permission mode, request `/omp:implement` with a small throwaway workspace and a brief that names a real executable verification command.
   - Observe the job card, worker readiness, actual model field (or the explicit “requested, actual unconfirmed” state), OMP session id, terminal result, changed-file evidence, and final diff.
   - Confirm that a dirty sentinel file remains unchanged and that acceptance is reviewed from evidence rather than final prose.
3. **Plan-mode boundary**
   - In Claude Plan mode, request `/omp:implement` and `/omp:followup`.
   - Observe hook exit 2, no worker/job spawn, and a clear request to leave Plan mode and repeat.
   - In the same mode, confirm `/omp:status`, `/omp:result`, `/omp:cancel`, and `/omp:doctor` remain available.
4. **Profile switch and resume**
   - Start a job from one Claude profile, end that client session, and inspect it from the other profile with `/omp:status`.
   - Use `/omp:followup` and verify a new job UUID/parent id with the same persisted OMP session id and prior decision context.
   - Repeat in the reverse direction. This proves shared job state, not migration of Claude conversation or credentials.
5. **Cancellation and recovery**
   - Run a real long-lived OMP operation and request `/omp:cancel`.
   - Observe intent, `cancelling`, child/process-group termination, EOF/close evidence, and final `cancelled`; verify existing changes remain and are not rolled back.
   - Exercise an unconfirmed termination fixture/host condition only where safe; expect `CANCEL_UNCONFIRMED`, retained lock, and doctor guidance rather than an unsafe kill.
6. **Overrides and recursion**
   - Run `--model openai-codex/<id>` and each relevant thinking level; compare requested and observed actual model fields.
   - Verify a non-Codex default or role cycle fails explicitly rather than selecting a replacement.
   - Confirm OMP-inherited delegation is blocked at depth 1 and no recursive mutating tool catalog is exposed.
7. **Interactive UX**
   - In an interactive Claude session, verify slash completion, the background waiter/notification path, empty status behavior, ambiguous follow-up selection, and long-result artifact truncation.
   - Headless `claude -p` output alone is not interactive UX evidence.

Record host-specific limitations (for example, missing plugin support or unavailable background notifications) as `not verified`, not as inferred PASS.

## Evidence record format

For each stage, store a small reviewable record outside source code or in an approved relative verification location with:

- source commit or working-tree identifier and package/runtime manifest digest;
- exact command/activity, redacted environment facts, and timestamp;
- observed exit/status, relevant stdout/stderr excerpt, and artifact paths relative to the workspace/state root;
- scenario result: `PASS`, `FAIL`, or `NOT RUN`, with the observation that justifies it;
- reviewer and any follow-up issue.

Never store API keys, cookies, account configuration, full Claude transcripts, private workspace contents, or personal absolute paths. If a source file changes after an evidence record, mark the record stale and repeat the affected package/host stage.

## Completion rule

Completion requires the specified behavior to be exercised end-to-end. “Files exist,” “the process exited 0,” “the model said it passed,” and “a fixture passed” are insufficient by themselves. Report unverified host behavior explicitly and keep release/archive output downstream of the evidence record.

## Recorded pre-release checks (2026-09-25)

These observations are scoped to macOS arm64, Node.js 24.13.0, Claude Code 2.1.282, and OMP 18.3.0. Raw host transcripts and personal paths are intentionally excluded from the public repository.

- Final source typecheck and 52 deterministic tests passed, including a real detached-worker fixture preserving all 5,005 ordered JSONL events from a 5,000-update burst.
- Generated runtime parity and an isolated stdio MCP handshake passed; all six tools were present.
- Both personal and company Claude profiles have the same seven runtime source files and exact MCP SDK 1.30.1 / Zod 3.25.76 dependencies. The five pre-existing personal entries and eleven company entries were preserved.
- Interactive host observations include all six slash commands, empty-request clarification, Plan-mode start/follow-up denial, real implementation and same-session follow-up, background completion notification, ambiguous-session selection, and cancellation without rollback after the creating Claude process exited.
- A 6,962-character real result produced an exactly 2,048-byte preview and a full-result artifact. A fresh company Claude conversation retrieved the same personal-profile job/preview/artifact without inheriting the personal Claude transcript.
- The result-card UX review passed independently. Process completion is still not automatic acceptance approval.

An early implementation wrote job state once per streaming event. A real run showed a 734.256-second gap between the native final response and delegate terminal state. The final implementation uses bounded event batches, backpressure, and coalesced progress; timer-triggered writes cannot form another unbounded queue. The final installed-plugin follow-up changed one authorized module, executed 19 Node assertions with exit status 0, preserved the protected-file hashes and sealed ancestor artifacts, and produced a 7,454-character report. Native final-response timestamp to delegate terminal state was **1.180 seconds**; the actual Claude background notification arrived at **1.431 seconds**. This is one measured host run, not a latency guarantee.

The seven verified runtime source files have aggregate SHA-256 `6df4ee6387979fd68660423f78325e3b441e252ff1fb68147f0062e791462c89` (SHA-256 of the ordered JSON map of filename to file SHA-256 for cli, contracts, jobs, render, runner, server, and worker). Production dependency audit at this verification point reported zero vulnerabilities.

## Recorded checks for 0.1.1 (2026-09-26)

Scope: macOS arm64, Node.js 24.13.0, Claude Code 2.1.283. Each run used the packaged runtime, a real OMP executable, an isolated `OMP_DELEGATE_STATE_DIR`, and a throwaway git workspace. The OMP 18.3.2 binary was the official `omp-darwin-arm64` release asset, verified against its published `SHA256SUMS.txt`.

| OMP | doctor | start → wait → result | independent `node add.test.mjs` | changed files | `job.json` ompVersion |
| --- | --- | --- | --- | --- | --- |
| 18.3.0 | ok, tested | completed, `openai-codex/gpt-6-astra` | exit 0 | `add.js`, `add.test.mjs` only | 18.3.0 |
| 18.3.2 | ok (run before it was added to the tested list, so it reported the untested warning) | completed, `openai-codex/gpt-6-astra` | exit 0 | `add.js`, `add.test.mjs` only | 18.3.2 |

The 18.3.1 and 18.3.2 upstream changelogs list no change to the command-line flags or JSON event stream this plugin consumes (`--mode`, `--json`, `--resume`, `--session-dir`, `--model`, `--thinking`); the only listed breaking change is a TUI editor API. Unknown JSON event types remain tolerated by the reducer.

Release-archive privacy: tar headers are written with an empty owner, uid/gid 0, and no extended attributes; the plugin zip is written with `zip -X`. `release:archive` parses the produced headers and fails if a builder account, uid/gid, or xattr remains. The 0.1.0 archive predates this check; its headers recorded the build machine's local account name.

## Recorded checks for 0.1.2 (2026-09-26)

0.1.2 moves card text into `src/messages.js` (English default, Korean via `OMP_DELEGATE_LANG=ko` or a Korean locale), translates the command prompts to English, and removes launcher notes that only applied to the maintainer's own setup. Runtime protocol handling is unchanged. `OMP_DELEGATE_LANG=en node scripts/host-e2e.mjs --omp <OMP 18.3.2>` passed all eight checks (doctor, start, completion, result, independent `node add.test.mjs`, write-scope-only changes, README untouched, recorded OMP version) on macOS arm64, Node.js 24.13.0. The README example card is rendered from a real 18.3.2 job by the new English renderer.

## Recorded checks for 0.1.3 (2026-09-26)

0.1.3 records OMP-reported token usage and cost estimate per job (counted from assistant `message_end` events only; `turn_end`/`agent_end` repeat the same numbers) and a ring of the last eight tool names with ok/error outcomes (arguments and output are not copied). `node scripts/host-e2e.mjs` gained two checks, `usageRecorded` and `toolActivityRecorded`; against OMP 18.3.2 all ten checks passed on macOS arm64 / Node.js 24.13.0. Sample: 5 model responses, 117,034 tokens, OMP cost estimate $0.155, tools `eval ok, write ok, write ok, eval ok`. The README example card is that run rendered by the English renderer. `tests/readme-guarantees.test.js` fails if a test cited in the README guarantees table is renamed or removed.
