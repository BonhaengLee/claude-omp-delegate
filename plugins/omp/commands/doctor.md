---
description: Diagnose the OMP executable, shared state, and permission guard
---
Call MCP omp_doctor({workspace}) and show the executable path, the OMP version policy (18.3.0 or newer, below 19.0.0, tested or not), shared config/state permissions, hook status, and orphaned-job diagnostics. On first use it may create the shared state directory and record the verified executable path in config.json. Existing OMP/Claude settings and authentication are not changed. Never print auth tokens or the full environment. macOS/Linux only.
Other tools' authentication warnings are reported as-is; never log in, switch accounts, or update anything on the user's behalf.
Only on an explicit orphan-recovery request, run node "${CLAUDE_PLUGIN_ROOT}/runtime/cli.js" doctor --workspace <safely quoted absolute cwd> --recover <validated UUID>. Recovery requires no PID, a stale heartbeat, child group ESRCH, and a matching nonce; there is no automatic rerun or uncertain kill. For default-model changes, point to OMP's own /models and config; never overwrite global settings here.

## Shared boundaries
- Reply to the user in their language. Result cards follow OMP_DELEGATE_LANG (en|ko) or the system locale.
- Claude designs, talks with the user, and reviews results. Implementation is delegated to OMP only on an explicit request; approving a plan is not a delegation trigger.
- Pass the conversation's real working directory to MCP as an absolute `workspace`. Never substitute the server's process.cwd().
- While OMP runs, Claude does not edit files in the same writeScope. Preserve other people's dirty changes; never auto commit/reset/stash/rollback.
- Job state is shared by Claude profiles of the same OS user. Conversations and authentication are not shared, and reconnect notifications are not guaranteed; after reconnecting, recover with /omp:status.
- writeScope is the intended scope for review, not an OS sandbox. "Completed" means the run ended; Claude decides acceptance only after checking real evidence and the diff.
- Never start OMP directly from Bash, and never bypass through --yolo, another account, automatic login, or global model changes.
