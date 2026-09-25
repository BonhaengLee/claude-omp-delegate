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

## Prerequisites

- Node.js **20 or newer**.
- OMP **18.3.0** installed and available as `omp` on `PATH`.
- Claude Code with local plugin/marketplace and MCP support.
- macOS or Linux. Windows process-group handling is intentionally unsupported.

The plugin uses OMP's existing authentication and configuration. It does not install OMP, perform login, or provide an automatic Claude-account fallback.

## Release-archive installation

Download the marketplace archive and its `.sha256` file from [GitHub Releases](https://github.com/BonhaengLee/claude-omp-delegate/releases). The archive already contains its production runtime; do not run npm commands in the extracted distribution.

```sh
# macOS (Linux: use sha256sum -c instead)
shasum -a 256 -c claude-omp-delegate-0.1.0-marketplace.tgz.sha256
tar -xzf claude-omp-delegate-0.1.0-marketplace.tgz
claude plugin marketplace add "$PWD/claude-omp-delegate"
claude plugin install omp@local-omp-delegate --scope user
```

Restart Claude after installation. Use a source checkout, below, for development.

## Source-checkout installation

The supported initial installation path is a source checkout followed by an explicit package step:

```sh
git clone https://github.com/BonhaengLee/claude-omp-delegate.git
cd claude-omp-delegate
npm ci
npm run package
```

`npm run package` creates the self-contained plugin runtime under `plugins/omp/runtime/`, including production dependencies and required license files. The source repository ignores both `node_modules/` and generated `plugins/omp/runtime/`; the checkout intentionally does not rely on either being prebuilt or checked in. The runtime must be rebuilt after source changes.

Add that checkout as a local Claude marketplace and install the `omp` plugin:

```sh
claude plugin marketplace add /absolute/path/to/claude-omp-delegate
claude plugin install omp@local-omp-delegate --scope user
```

After changing source, rebuild the runtime. During development, start Claude with `claude --plugin-dir /absolute/path/to/claude-omp-delegate/plugins/omp` to avoid relying on an older installed cache. Publish a new version for installed-plugin updates. A GitHub marketplace one-click install is **not** claimed for the source checkout: a release archive with a self-contained runtime is the intended distribution artifact. Do not infer release, CI, or live-host success from the presence of files alone.

## First diagnostic

From the workspace where jobs should run:

```text
/omp:doctor
```

Doctor checks the platform, configured OMP executable, exact OMP version, plugin hook files, shared state, and stale-job diagnostics. It may initialize the plugin-owned state directory and `config.json` on first use. That write is limited to this plugin's state; doctor does not change Claude/OMP settings, authenticate, update OMP, or choose an account.

If the OMP executable is not already configured, doctor discovers an executable named `omp` on `PATH`, verifies `18.3.0`, and records its absolute path in plugin-owned state. A missing or incompatible executable is an error, not an invitation to install or substitute another runner.

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
