# Security policy

## Scope

This project connects Claude Code to a locally installed OMP process that can modify a workspace. Treat both the Claude host and OMP installation as trusted components running under the current OS user. The plugin is **not** an operating-system sandbox and cannot turn `writeScope` into an access-control boundary.

The supported platforms are macOS and Linux. Windows process-group behavior is intentionally out of scope.

## Security properties implemented by the plugin

- MCP input requires an existing absolute workspace; the hook resolves both hook `cwd` and tool workspace and rejects mismatches.
- Mutating delegation is blocked in Claude Plan mode and when hook input/permission mode is missing or unknown. The hook does not force approval in other modes.
- Child processes are spawned with `shell:false` and an argv array. User text is sent through the OMP child's stdin, not interpolated into a shell command.
- The worker uses a detached process group and confirms exit, stdout EOF, stderr close, and group disappearance before recording cancellation or completion. Unconfirmed termination retains the lock for diagnosis.
- POSIX process-group identifiers are reusable. Observing a group and signaling it are not one atomic identity check; a narrow reuse race remains. The runner retires groups observed gone and never uses persisted PIDs to kill processes. Deliberately detached work outside the owned group is not an OS-sandbox guarantee.
- Shared state uses plugin-owned directories/files with restrictive modes, atomic replacement, schema validation, and symlink/path checks. Corrupt state is reported instead of silently replaced with an empty state.
- The recursion guard prevents an OMP child inheriting this plugin from recursively starting another delegation job.

These controls reduce accidental cross-workspace or cross-process actions; they do not make a malicious prompt, OMP extension, plugin, or OS user safe.

## Data handling

The plugin does not copy Claude authentication, account settings, or the full Claude conversation into its shared job state. A job does persist the approved brief, sanitized OMP event evidence, bounded stderr, final result text, workspace baseline/evidence, and the OMP session transcript under the plugin-owned state root. These files can still contain sensitive source code or user instructions. Protect the state directory, do not commit it, and redact evidence before sharing it.

The packaging step excludes user configuration, authentication material, transcripts, logs, and environment dumps. Review generated archives before distribution.

## Reporting a vulnerability

Please use a private GitHub Security Advisory for this repository when that feature is available. Include:

- a concise description and impact;
- the affected commit or package/archive version;
- reproducible steps that do not disclose credentials or private workspace contents;
- a minimal proof of concept, with secrets and personal paths removed.

If private advisories are unavailable, open a minimal public issue asking for a private reporting channel and do not include exploit details, tokens, transcripts, or user data. Do not use public issues for active credential exposure; revoke the credential through its provider first.

Security fixes must include regression evidence and must not claim protection beyond the controls actually exercised on a supported host.
