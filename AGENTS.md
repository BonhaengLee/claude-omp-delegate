# Agent instructions

These instructions apply to automated and human contributors working in this repository.

## Non-negotiable behavior

- Frustration, urgency, and questions about capability do not by themselves cancel an approved task. Do not infer cancellation from criticism. An explicit request to stop, pause, or cancel MUST be honored immediately.
- Do not widen a review indefinitely. Review the requested scope and downstream effects, record concrete findings, and avoid speculative “while you are here” work.
- Do not report completion, PASS, release readiness, or live behavior without the command output or host observation that proves it. A plausible implementation and an exit code alone are not evidence.
- Do not publish, push, release, or change global user rules/settings without current explicit user authorization. Authorization for this repository does not authorize changes to unrelated repositories.
- Preserve existing user changes and repository files outside the requested write set. Never use reset, stash, rollback, or destructive cleanup to manufacture a clean result.

## Required execution order

1. **Freeze source.** Finish source changes and inspect the intended diff. Do not collect runtime evidence while the source is still moving.
2. **Typecheck/tests.** Run the deterministic checks after the final source edit (`npm run verify`, or the narrowed commands with a recorded reason).
3. **Package/parity.** Rebuild with `npm run package`; then run `npm run check:package` and any relevant parity checks. Source, hook, command, and dependency-lock changes invalidate affected package/host evidence. Check installed-profile bytes and dependency versions too: a same-version plugin update can report success without replacing its cache.
4. **Actual host evidence.** Run `npm run e2e:host` and the manual Claude/OMP scenarios with a tested OMP version (`OMP_COMPAT.tested` in `src/contracts.js`) on a supported macOS/Linux host. Keep fixture/test results separate from interactive host observations.
5. **Publish only after evidence.** Release/archive steps package what was verified; they do not turn unverified behavior into PASS.

## Evidence hygiene

- Use generic or repository-relative paths in public output. Never copy account configuration, authentication tokens, full transcripts, private QA artifacts, or personal filesystem paths into the repository.
- Label fixture, package/parity, and actual-host observations separately.
- Measure native-provider completion separately from delegate terminalization. Streaming progress must use bounded, backpressured batches; a timer must not create an unbounded chain of pending writes. Preserve event order and drain before terminal state.
- Persist interactive evidence incrementally. A controller timeout is not proof that Claude or OMP exited; inspect the owned native processes. Never kill unrelated processes to simplify a test.
- Inspect release archives with an independent reader. Native macOS tar listings can hide AppleDouble entries; a source-only privacy scan does not cover generated release contents.
- If source changes after a check, rerun the affected check; do not reuse stale artifacts.
- If a behavior was not exercised, say `not run` or `not verified`. Never infer it from a related test.

## Delegation boundaries

Claude plans and reviews. OMP executes only through the explicit plugin/MCP path. Do not add shell fallbacks, automatic account/model substitution, login automation, or sandbox claims. Cancellation must not imply rollback, and resume must not silently start a fresh session.
