# omp — Claude Code → OMP delegation

This plugin lets Claude Code hand an approved implementation brief to your locally installed [OMP (oh-my-pi)](https://github.com/can1357/oh-my-pi) coding agent, then track, resume, cancel, and review that job. Claude keeps planning and reviewing; OMP does the implementation with its own configuration and account.

## Commands

| Command | What it does |
| --- | --- |
| `/omp:implement <request>` | Claude writes a brief (goal, decisions, write scope, acceptance, constraints, verification) and starts one OMP job. Blocked in Plan mode. |
| `/omp:status` | Active job plus the five most recent jobs for this workspace, with the latest tool outcomes and the OMP cost estimate. |
| `/omp:result [id]` | Change / verification / caution / next-action card with tokens, OMP cost estimate, and artifact paths. Completion is not treated as acceptance. |
| `/omp:followup [id] <request>` | Resumes the same OMP session as a new job. Never falls back to a fresh session. |
| `/omp:cancel [id]` | Records a cancellation and reports `cancelled` only after the OMP process group has exited. Changes are not rolled back. |
| `/omp:doctor` | Checks platform, OMP executable and version (18.3.0 ≤ v < 19.0.0), hooks, shared state, and stale jobs. |

Cards are English by default and Korean when `OMP_DELEGATE_LANG=ko` or the system locale is Korean.

## What it runs, reads, and writes

- **Runs** the `omp` executable found on `PATH` (or the path recorded by doctor): `omp --version`, `omp config get modelRoles --json`, and the delegated job itself in `--mode json`, detached from Claude, with `OMP_DELEGATE_DEPTH=1` so OMP cannot recursively delegate again.
- **Runs** `git` read-only in the workspace: `rev-parse --show-toplevel`, `status --porcelain`, `diff --no-ext-diff --binary`, and `ls-files -s`, to record before/after evidence. It never commits, resets, stashes, or reverts.
- **Runs** a bundled Node.js worker (`runtime/worker.js`) that supervises the OMP process, and an MCP server (`runtime/server.js`) over stdio.
- **Records** per job: token counts and OMP's own cost estimate from its JSON events, and the names and ok/error outcomes of the last tools run (never their arguments or output).
- **Writes** job state only under `~/.local/state/claude-omp-delegate/` (override with `OMP_DELEGATE_STATE_DIR`), with owner-only permissions.
- **Network:** the plugin itself makes no network requests. OMP talks to its model provider exactly as it does when you run it yourself.
- **Credentials:** none are read, copied, or stored. The plugin never logs in, switches accounts, or changes OMP's global model.
- **Hook:** a `PreToolUse` guard on this plugin's own MCP tools blocks starting or resuming a job in Plan mode and fails closed on malformed hook input.

The write scope in a brief is review guidance, not an operating-system sandbox. Review the diff before accepting a result.

## Requirements

macOS or Linux, Node.js 20+, and OMP 18.3.x signed in with a default model that resolves to `openai-codex/<id>`. Full documentation, verification records, and the offline installation archive: https://github.com/BonhaengLee/claude-omp-delegate

License: MIT.
