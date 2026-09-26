# claude-omp-delegate

`claude-omp-delegate` is a Claude Code plugin for delegating an approved implementation brief to an existing OMP/Codex harness. Claude remains the planner, conversational interface, and reviewer; OMP remains the implementation executor. The plugin adds an explicit hand-off, durable job state, resumable OMP sessions, and compact result/evidence cards without replacing either tool.

> **Positioning:** this is a local-first integration, not a new model runner, account manager, sandbox, or web dashboard.

## What it provides

- **Explicit delegation.** A new worker starts only after `/omp:implement` (or an explicit `omp_start` call) is requested. Approving a plan alone does not start a job.
- **Existing harness preservation.** The worker invokes the installed `omp` executable with its normal project rules, skills, MCP servers, extensions, and configuration. The plugin does not copy credentials, log in, switch accounts, or silently replace a model.
- **Cross-profile job state.** Job metadata lives outside `CLAUDE_CONFIG_DIR` and `CLAUDE_PLUGIN_DATA`, so two Claude profiles for the same OS user can inspect the same workspace job. Claude conversation history and authentication are not shared.
- **Explicit resume.** `/omp:followup` creates a new job record that resumes the persisted OMP session and keeps the parent result. A resume failure never falls back to a fresh session.
- **Durable cancellation.** Cancellation is an intent recorded for the detached worker. The worker confirms OMP process-group termination before recording `cancelled`; existing workspace changes are never rolled back automatically.
- **Evidence-oriented output.** Result cards separate observed file changes, process/tool evidence, warnings, and next actions. A final assistant message is not treated as acceptance proof.

`writeScope` is review guidance, **not an operating-system sandbox**. OMP and the worker run with the current OS user's permissions; review the diff and acceptance evidence before accepting a result.

## Quick install

Two commands, identical for a person at a terminal and for an AI agent running shell commands:

```sh
claude plugin marketplace add BonhaengLee/claude-omp-delegate
claude plugin install omp@claude-omp-delegate --scope user
```

Then restart Claude Code and run `/omp:doctor` in the workspace where jobs should run. The marketplace entry points at a release zip pinned by SHA-256 (Claude Code refuses a mismatching download), and the zip already contains the production runtime. No `git clone`, `npm`, or build step is needed on your machine.

Update later with:

```sh
claude plugin marketplace update claude-omp-delegate
claude plugin update omp@claude-omp-delegate
```

## Prerequisites

| Requirement | Check | If missing |
| --- | --- | --- |
| macOS or Linux | `uname -s` prints `Darwin` or `Linux` | Windows is intentionally unsupported (process-group handling). |
| Node.js 20+ | `node --version` | Install Node.js 20 or newer. |
| Claude Code with plugin support | `claude plugin --help` | Update Claude Code (`claude update`). The archive plugin source was verified with Claude Code 2.1.283. |
| OMP (oh-my-pi) 18.3.0 or newer, below 19.0.0, on `PATH` | `omp --version` prints `omp/18.x.y` | `curl -fsSL https://omp.sh/install \| sh` (or `brew install can1357/tap/omp`, `bun install -g @oh-my-pi/pi-coding-agent`). See [oh-my-pi](https://github.com/can1357/oh-my-pi). |
| OMP signed in, default model resolving to `openai-codex/<id>` | `omp` works interactively in any repo | Sign in through OMP itself. This plugin never logs in or picks an account for you. |

### OMP version policy

- **Tested** versions have recorded real-host evidence: `18.3.0`, `18.3.2`. Doctor shows `(검증됨)`.
- Any other version from `18.3.0` up to (but excluding) `19.0.0` runs normally, with a warning that it has no recorded host verification yet.
- Versions outside that range are refused with install/upgrade guidance. To run one anyway, start Claude with `OMP_DELEGATE_ALLOW_UNSUPPORTED_OMP=1`; every job then carries a warning.
- A daily CI job classifies the newest published OMP, so the maintainer sees an out-of-range release before users do.

## For AI agents installing this plugin

Follow these steps literally. Stop and report at the first failing check instead of improvising.

1. Run each **Check** in the prerequisites table. If OMP is missing, you may run the official installer only when the user asked you to install OMP; never sign in, switch accounts, or change OMP's global model on their behalf.
2. Run the two **Quick install** commands. `claude plugin list --json` must then list `omp@claude-omp-delegate` as enabled.
3. Tell the user to restart Claude Code, then run `/omp:doctor` from the target workspace.
4. Success means doctor reports `status: ok`, the OMP version, and `hooks.json=true, guard.cjs=true`. `VERSION_UNSUPPORTED` or `OMP_NOT_FOUND` responses carry the exact remedy in `nextActions`.
5. Do not start `/omp:implement` as part of installation. Delegation needs an explicit user request.

## Offline / pinned installation

Every [GitHub Release](https://github.com/BonhaengLee/claude-omp-delegate/releases) also carries a self-contained marketplace archive and its checksum. The archive includes its runtime; do not run npm commands inside it.

```sh
VERSION=0.1.1
# macOS (Linux: use sha256sum -c instead)
shasum -a 256 -c claude-omp-delegate-$VERSION-marketplace.tgz.sha256
tar -xzf claude-omp-delegate-$VERSION-marketplace.tgz
claude plugin marketplace add "$PWD/claude-omp-delegate"
claude plugin install omp@local-omp-delegate --scope user
```

## Development from a source checkout

A plain `git clone` is **not** installable: the generated runtime (`plugins/omp/runtime/`) is intentionally not committed. Build it first:

```sh
git clone https://github.com/BonhaengLee/claude-omp-delegate.git
cd claude-omp-delegate
npm ci
npm run package
claude --plugin-dir "$PWD/plugins/omp"
```

`npm run package` creates the self-contained runtime, including production dependencies and required license files. Rebuild it after every source change; `--plugin-dir` avoids an older installed cache. `npm run e2e:host` runs one real delegated job against your installed OMP in an isolated state directory and throwaway repository (it spends one small model run). Do not infer release, CI, or live-host success from the presence of files alone.

## First diagnostic

From the workspace where jobs should run:

```text
/omp:doctor
```

Doctor checks the platform, the configured OMP executable and its version against the policy above, plugin hook files, shared state, and stale-job diagnostics. It may initialize the plugin-owned state directory and `config.json` on first use. That write is limited to this plugin's state; doctor does not change Claude/OMP settings, authenticate, update OMP, or choose an account.

If the OMP executable is not already configured, doctor discovers an executable named `omp` on `PATH`, checks its version, and records its absolute path in plugin-owned state. A missing or out-of-range executable is an error with the remedy in `nextActions`; the plugin never installs or substitutes another runner by itself.

## Slash commands

All commands resolve the current workspace to an absolute path and pass it explicitly to MCP. The six commands are:

| Command | Purpose | Important behavior |
| --- | --- | --- |
| `/omp:implement [--model openai-codex/<id>] [--thinking <level>] <request>` | Start a new OMP job from a Claude-authored brief. | Requires a request or an approved plan; Plan mode blocks the start; no queue or automatic retry. |
| `/omp:status` | Show the active job and the five most recent jobs for the workspace. | Read-only and available after switching Claude profiles; an empty list is normal. |
| `/omp:result [job UUID]` | Review a terminal job. | Shows change/evidence/caution/next-action groups and artifact paths; omitted UUID means the most recent terminal job. |
| `/omp:followup [job UUID] [--model ...] [--thinking ...] <additional request>` | Resume an existing OMP session with a new job record. | Omitted UUID is allowed only when exactly one resumable session exists; ambiguity is presented for selection; no fresh-session fallback. |
| `/omp:cancel [job UUID]` | Request cancellation of an active job. | Omitted UUID means the only active job; cancellation does not undo changes and is not the same as confirmed termination. |
| `/omp:doctor` | Diagnose installation and stale-worker state. | Read-only with respect to the workspace and external configuration, but may initialize plugin-owned state/config on first use. |

The MCP tools behind these commands are `omp_start`, `omp_status`, `omp_result`, `omp_followup`, `omp_cancel`, and `omp_doctor`. They require an explicit absolute `workspace`; the MCP server's own `process.cwd()` is never assumed to be the Claude workspace.

### Model and thinking overrides

The default model is OMP's configured `@default` role. The plugin asks OMP for `modelRoles --json`, resolves aliases, and requires the result to be an exact `openai-codex/<id>` selector. If the configured default points to another provider or a role cycle, the job fails rather than silently changing models.

Per-command overrides are:

- `--model openai-codex/<id>` — an exact provider/id selector.
- `--thinking off|minimal|low|medium|high|xhigh|max|auto` — an OMP-supported thinking level.

The selected model and observed actual provider/model are retained in the job card when OMP reports them. This plugin does not maintain a price table, choose a “cheap” model, alter global OMP defaults, or promise a cost/performance ranking.

### Permissions and Plan mode

The PreToolUse hook examines MCP calls only. It fails closed when hook JSON, `permission_mode`, or workspace identity is missing/unknown. Mutating `omp_start` and `omp_followup` calls are blocked in `plan` mode; the user must leave Plan mode and request the command again. `omp_status`, `omp_result`, `omp_cancel`, and `omp_doctor` remain available in Plan mode. Other supported permission modes continue through Claude's normal permission flow; the plugin does not force approval.

## Operational boundaries

- The detached worker and OMP child continue independently of the Claude client connection. Switching between company and personal Claude profiles does not cancel or delete the job.
- Shared state is for job coordination only. It does not migrate Claude transcripts, credentials, or account sessions between profiles.
- The OMP child receives a recursion guard (`OMP_DELEGATE_DEPTH=1`), so an inherited delegate plugin cannot recursively start another delegate job. A recursion-blocked server exposes no mutating tools.
- Dirty worktrees are allowed. The baseline is captured for evidence; pre-existing changes are not attributed to the worker, committed, stashed, reset, or reverted.
- A cancellation may leave files changed. Inspect the current diff before starting follow-up work.
- Command descriptions and documentation are English. Status/result cards currently use Korean labels (Change, Verification, Caution, and Next action).
- The plugin is not an OS sandbox. A brief's write scope cannot prevent OMP from writing elsewhere; out-of-scope changes are reported for review.
- The plugin does not auto-publish, auto-update OMP, log in, switch Claude accounts, send Telegram notifications, or guarantee a reconnect push notification. Use `/omp:status` after reconnecting.

## Development and evidence

The development workflow and script contract are documented in [CONTRIBUTING.md](CONTRIBUTING.md). The architecture and failure boundaries are in [docs/public/architecture.md](docs/public/architecture.md). The verification policy distinguishes fixture tests from actual Claude/OMP host verification in [docs/public/verification.md](docs/public/verification.md).

Before treating a change as complete, run the repository's verification and packaging checks, then perform the required manual host checks. Source edits invalidate generated runtime parity and any host evidence produced from the previous package. This repository deliberately does not claim release, CI, or live-host PASS without recorded command output and reviewable evidence.

## License

This project is released under the [MIT License](LICENSE). Third-party attribution and adapted upstream boundaries are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
