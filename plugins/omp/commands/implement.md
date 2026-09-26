---
description: Delegate a new implementation to your existing OMP Codex harness
argument-hint: [--model openai-codex/<id>] [--thinking <level>] <request>
---
User arguments: $ARGUMENTS
1. A request or a currently approved plan is required. If neither exists, ask once what to build and do not start. Claude writes the brief.
2. Do not start in Plan mode; the user must ask again after leaving it. The MCP PreToolUse guard blocks the call and there is no shell fallback.
3. Do not interpret or rewrite leading --model/--thinking options from the user. Pass them verbatim at the front of brief.goal together with the request. When using an approved plan, build goal as the verbatim option prefix plus the plan goal. The shared contracts parser validates and strips the options before start and stores the semantic goal and model/thinking. Duplicate, unknown, or conflicting options fail before start. Omitting the model uses OMP's @default; the provider is never swapped automatically.
4. Build a strict brief {goal, decisions, writeScope, acceptance, constraints, verification, model?, thinking?}. Every list has at least one real item. Pass only the decisions the approved plan needs; never copy the transcript, tokens, or credentials. Include preserving the user's changes and real execution checks.
5. Call MCP omp_start({workspace, brief}). On WORKSPACE_BUSY, show the current card and suggest /omp:status or /omp:cancel. There is no queue, automatic retry, or detour to another workspace.

## After starting
1. Show the short progress card from the start response. If the actual model has not been observed yet, label it as the requested model; do not claim it is the actual model. Do not invent progress percentages or ETAs.
2. If the job is already terminal, go straight to omp_result. Otherwise validate the UUID from the response and call Bash with run_in_background:
   node "${CLAUDE_PLUGIN_ROOT}/runtime/cli.js" wait <UUID> --workspace <absolute-workspace>
   Never interpolate user text or model options into the shell command. Shell-quote the workspace so it stays a single argv.
3. Only on hosts without background support, wait once with --timeout-ms 20000 and return the progress card plus /omp:status. Do not busy-poll.
4. When the background completion notification arrives, call omp_result and review it in four groups: change, verification, caution, next action. The waiter exiting does not cancel the job.

## Shared boundaries
- Reply to the user in their language. Result cards follow OMP_DELEGATE_LANG (en|ko) or the system locale.
- Claude designs, talks with the user, and reviews results. Implementation is delegated to OMP only on an explicit request; approving a plan is not a delegation trigger.
- Pass the conversation's real working directory to MCP as an absolute `workspace`. Never substitute the server's process.cwd().
- While OMP runs, Claude does not edit files in the same writeScope. Preserve other people's dirty changes; never auto commit/reset/stash/rollback.
- Job state is shared by Claude profiles of the same OS user. Conversations and authentication are not shared, and reconnect notifications are not guaranteed; after reconnecting, recover with /omp:status.
- writeScope is the intended scope for review, not an OS sandbox. "Completed" means the run ended; Claude decides acceptance only after checking real evidence and the diff.
- Never start OMP directly from Bash, and never bypass through --yolo, another account, automatic login, or global model changes.
