# Contributing

Thank you for improving `claude-omp-delegate`. Contributions should keep the hand-off explicit, preserve the existing OMP/Codex harness, and make runtime claims traceable to observed evidence.

## Scope and design constraints

- Claude is the planner and reviewer; the installed OMP harness is the executor.
- Do not add automatic Claude-account fallback, login automation, model catalog duplication, or a second process-runner path.
- Do not describe `writeScope` as a sandbox. It is intent and review guidance only.
- Preserve user dirty changes. Do not add automatic commit, reset, stash, or rollback behavior.
- Keep shared state independent of Claude profile configuration so manual profile switching remains safe.
- Do not copy credentials, full Claude transcripts, environment dumps, or user-specific artifacts into source, tests, package output, or documentation.
- Use Node ESM, JSDoc/checkJs, strict Zod contracts, `shell:false`, and the existing module boundaries unless a design change is explicitly justified.

## Local setup

```sh
npm ci
```

Use Node.js 20 or newer and a tested OMP version (`OMP_COMPAT.tested` in `src/contracts.js`) when running host-dependent checks. The source package and the generated plugin runtime are separate surfaces: `plugins/omp/runtime/` is generated and must not be hand-edited.

## Verification workflow

Use the scripts in this order; each later stage depends on the preceding source and package state:

1. **Freeze source.** Finish the intended source/docs change and inspect the bounded diff. Do not begin host evidence while source is still changing.
2. **Typecheck and tests.** Run `npm run verify` (the repository gate combines the deterministic checks) or, when isolating a failure, run `npm run typecheck` and `npm test` directly.
3. **Package.** Run `npm run package` to rebuild the self-contained plugin runtime from the current source and lockfile.
4. **Package parity.** Run `npm run check:package`; it must inspect the generated ownership manifest, production dependency closure, entrypoints, and absence of credentials/transcripts.
5. **Public-file checks.** Run `npm run check:public` for links, required public files, and forbidden personal/configuration material.
6. **Actual host evidence.** On a supported macOS/Linux host with a tested OMP version (`OMP_COMPAT.tested` in `src/contracts.js`) and Claude Code, run `npm run e2e:host` and the manual scenarios in [docs/public/verification.md](docs/public/verification.md). Keep these results separate from fixture/test output.
7. **Publish only after evidence.** `npm run release:archive` is a packaging step, not proof that installation or live behavior passed. Never auto-publish from a worktree.
8. **Release order.** Bump `package.json`, `package-lock.json`, and `plugins/omp/.claude-plugin/plugin.json` together; run `npm run release:archive`; `npm run marketplace:set` (points `.claude-plugin/marketplace.json` at the new zip digest); commit and push; wait for green CI; create the GitHub release `v<version>` on that commit with the tgz, zip, and both `.sha256` files built in the same run; then `npm run marketplace:verify` must download the published zip and match the digest.
9. **New OMP releases.** When the daily `OMP compatibility` workflow warns about an untested version, run `npm run e2e:host -- --omp <path>` against it and add the version to `OMP_COMPAT.tested` only with a recorded passing run. Raise `belowMajor` only after the same evidence on the new major.

A source edit invalidates generated runtime parity and any host evidence from the previous package. Rebuild and repeat the relevant checks rather than reusing stale output.

## Code changes

- Put shared schemas, status/error codes, limits, and option parsing in `src/contracts.js`.
- Keep OMP process parsing and termination semantics in `src/runner.js`.
- Keep durable state, locks, job selection, and recovery in `src/jobs.js`.
- Keep detached worker lifecycle and heartbeat/cancellation handling in `src/worker.js`.
- Keep MCP registration/error envelopes in `src/server.js`, and the CLI waiter/doctor entrypoint in `src/cli.js`.
- Keep user-facing result/progress text in `src/render.js` rather than duplicating it in tools or commands.
- Any new asynchronous listener, timer, stream, or `AbortSignal` handler must have an explicit cleanup path.

Tests should exercise consumer-visible behavior and race/error boundaries. Avoid tests that only assert wiring, copied strings, non-empty output, or that a function does not throw. Fake processes are appropriate for deterministic cancellation/protocol races, but they do not replace actual Claude/OMP host evidence.

## Documentation changes

Public documentation is English and must describe the implementation that exists in source. Use relative links and generic paths; never add personal filesystem paths, account configuration, transcripts, tokens, or private QA artifacts. State whether a claim is a deterministic fixture result, package/parity result, or manual host observation.

## Pull request checklist

- [ ] The source and generated-runtime implications are understood.
- [ ] `npm run verify` (or the narrowed equivalent with the reason recorded) was run after the final source edit.
- [ ] `npm run package` and `npm run check:package` were run for runtime changes.
- [ ] `npm run check:public` was run for documentation/packaging changes.
- [ ] No credential, transcript, personal path, or unrelated-repository content was added.
- [ ] Actual host behavior is labeled separately from fixture tests and is not described as PASS without command output and reviewable evidence.
- [ ] Cancellation, resume, profile switching, and Plan-mode behavior are covered when affected.
- [ ] No automatic publish or global user-rule/settings change is part of the patch.

For security-sensitive changes, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with exploit details.
