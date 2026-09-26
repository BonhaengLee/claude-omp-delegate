---
description: Continue an existing OMP conversation with a new request
argument-hint: [job UUID] [--model openai-codex/<id>] [--thinking <level>] <additional request>
---
User arguments: $ARGUMENTS
1. If there is no additional request, ask once. Read the first argument as jobId only when it is a UUID. Pass leading model/thinking options verbatim at the front of brief.goal, as in implement, and let the shared parser handle them. Only jobId is passed as a separate field.
2. Read the earlier decisions from data.brief in omp_status/omp_result or from the brief artifact, and have Claude write a strict brief that adds the new goal and acceptance. Do not make the user re-enter every field.
3. Do not start in Plan mode. Call MCP omp_followup({workspace, jobId?, brief}). Omitting jobId is allowed only when the workspace has exactly one resumable session.
4. On AMBIGUOUS_SESSION, ask once with a selection UI that distinguishes candidates by goal, short ID, and model. Never pick the latest arbitrarily. On WORKSPACE_BUSY, show the current card.
5. A new job UUID with parentJobId is created and the same OMP session is resumed. On RESUME_FAILED, report the evidence; never silently start a fresh session.

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
