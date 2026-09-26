---
description: Show active jobs and the five most recent results
---
Call MCP omp_status({workspace: <current absolute cwd>}) once. Show active jobs and the five most recent finished jobs as short cards. No jobs is normal; suggest /omp:implement. Works in Plan mode. Never describe failed, interrupted, or cancelled jobs as successful completions. Another Claude profile of the same OS user can find the same jobs, but the Claude conversation itself does not move.

## Shared boundaries
- Reply to the user in their language. Result cards follow OMP_DELEGATE_LANG (en|ko) or the system locale.
- Claude designs, talks with the user, and reviews results. Implementation is delegated to OMP only on an explicit request; approving a plan is not a delegation trigger.
- Pass the conversation's real working directory to MCP as an absolute `workspace`. Never substitute the server's process.cwd().
- While OMP runs, Claude does not edit files in the same writeScope. Preserve other people's dirty changes; never auto commit/reset/stash/rollback.
- Job state is shared by Claude profiles of the same OS user. Conversations and authentication are not shared, and reconnect notifications are not guaranteed; after reconnecting, recover with /omp:status.
- writeScope is the intended scope for review, not an OS sandbox. "Completed" means the run ended; Claude decides acceptance only after checking real evidence and the diff.
- Never start OMP directly from Bash, and never bypass through --yolo, another account, automatic login, or global model changes.
