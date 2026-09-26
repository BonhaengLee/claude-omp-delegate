---
description: Request cancellation and confirm actual process termination
argument-hint: [job UUID]
---
User arguments: $ARGUMENTS
Call MCP omp_cancel({workspace, jobId?}). Omitting jobId targets the only active job; if there is none, report that nothing is running. A job that already finished keeps its result. Cancellation can be requested in Plan mode too.
Distinguish accepting the cancel intent from actual termination. While the job is still running/cancelling, do not claim it has ended; get the outcome through the waiter. Show cancelled only after actual exit, EOF, and process-group disappearance are confirmed. On CANCEL_UNCONFIRMED, explain that the lock is kept and suggest the doctor diagnosis; never read a PID from disk and kill it. File changes already made are not rolled back.

## After requesting
1. Show the short progress card from the response. If the actual model has not been observed yet, label it as the requested model. Do not invent progress percentages or ETAs.
2. If the response has no jobId, stop here. If the job is already terminal, show the existing result and stop. Only for active/cancelling jobs, validate the UUID and call Bash with run_in_background:
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
