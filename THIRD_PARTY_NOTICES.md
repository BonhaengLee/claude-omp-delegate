# Third-party notices

This project implements an OMP-backed Claude plugin. The pinned upstream revisions below were consulted as design references, not vendored as complete runtime implementations. The notices below record the exact upstream revisions consulted and the limited adapted interface and process patterns.

## OpenAI — codex-plugin-cc

- Repository: https://github.com/openai/codex-plugin-cc
- Pinned commit: `db52e28f4d9ded852ab3942cea316258ae4ef346`, resolved from the GitHub tree API and fetched from commit-addressed raw URLs.
- License: Apache License 2.0. The complete upstream license is preserved at `licenses/openai-codex-plugin-cc-LICENSE.txt` (Git blob SHA-1 `d0be6cdcf06cb8b67f7471b4a687cd9c434a2526`, local SHA-256 `e591c02a0b2ea7717d99e15bd51ea05d879bbf5a4452d66d15b51a7107d3821a`).
- Notice: the upstream `NOTICE` is preserved at `licenses/openai-codex-plugin-cc-NOTICE.txt` (Git blob SHA-1 `295a8dc618af2e5bb68be150684fa9cfb33f3292`, local SHA-256 `6728b3dff175efe673c1d6a402f5d9f548127a20960a6efdf9047dae1e36ecfb`).

### Consulted OpenAI files

| Upstream path | Git blob SHA-1 | Local SHA-256 |
| --- | --- | --- |
| package.json | b1d984d1a1a9634d90df3e23078a29f1ecf67f17 | 69eced95aa77d1559f0ee94d25e2a933ff3815d0f210e31587a256aca910a309 |
| plugins/codex/commands/rescue.md | 56de9555d6e4b8c8ec142df187cceed3ab4da590 | 089207554cc3d34907916fbbf34b1954b1f5f1f3178e72dcbfb7ebd2d61d4e1e |
| plugins/codex/commands/status.md | 8f70663d1a99ed871befa6120f4219971ba52469 | 1af1dadf984bc65349935b288d8c078caedfd6272a6514a9ee93992f17bda489 |
| plugins/codex/hooks/hooks.json | 19e33b818d143aa7bdb666ffc00f93de8f275eab | 6ba33b3f6a75ba4271a76160b0465e7050a607a02e1ec212a7c0f3b9cd3cb35a |
| plugins/codex/scripts/session-lifecycle-hook.mjs | 778571e6ce81b11bcd79de1b6718f33e34c6c9fa | cb8781e6a12bddcde94776e82c743f79e5e11c81bd4e4e9571dbb7002108292a |
| plugins/codex/scripts/lib/state.mjs | 2da23498f893dd2a936199ba0020eeb62ba6b3c8 | eabfb53f0226791560cc9eb0dfc598e888107187dee64fef79ab3b2c6104faa0 |
| plugins/codex/scripts/lib/process.mjs | dd8fc3751fb446e264635287e54b45dde0af3a43 | e09168dbd61dff5d5d70bcb2bc937835f719b5294869d55176ac9bcc96a4bc85 |
| plugins/codex/scripts/lib/tracked-jobs.mjs | 902869012ae02ffd1a16c4157b5379a098a2acc3 | e2ce2a2b32c9315665300c8d10279073e3268ce3b149320b2a9d90aef53a6e43 |
| plugins/codex/scripts/lib/job-control.mjs | ad152c15733c2fb29347446c0cd73db136c7f603 | 0c38581c96e8bec2ff75be7786be5d0ef8706fb1b3672cbe8c0ff7c4d98d567d |
| plugins/codex/scripts/lib/workspace.mjs | 89a0060b856eb89f0e81031c24d06dba6796a555 | 7dbdcb927818da4105f65dd0c826caa4dd1781b8050905f8f83f472ce4201e2e |
| LICENSE | d0be6cdcf06cb8b67f7471b4a687cd9c434a2526 | e591c02a0b2ea7717d99e15bd51ea05d879bbf5a4452d66d15b51a7107d3821a |
| NOTICE | 295a8dc618af2e5bb68be150684fa9cfb33f3292 | 6728b3dff175efe673c1d6a402f5d9f548127a20960a6efdf9047dae1e36ecfb |

### Reuse scope and attribution

- Reuse the command/manifest conventions and concise status/result interaction patterns as design references for the Claude-facing commands.
- Study the process, tracked-job, workspace, and hook/session lifecycle helpers for failure handling, cleanup, and hook-input boundaries; implement the durable cross-profile state contract separately.
- Preserve Apache-2.0 attribution and applicable notices if any source expression is later copied into runtime code. At this stage no OpenAI file is a runtime import.

### Explicitly excluded OpenAI patterns

- Do not copy the Codex app-server backend or make it the OMP execution backend.
- Do not copy SessionEnd behavior that kills jobs or deletes their state; worker lifetime must survive Claude/profile changes.
- Do not use profile-scoped `CLAUDE_PLUGIN_DATA` state, silent damaged-JSON-to-empty fallback, or non-atomic whole-list writes.
- Do not vendor the full repository, its unrelated commands/skills, or its dependency tree.

## Andrei Lungeanu — codex-delegate-mcp

- Repository: https://github.com/andreilungeanu/codex-delegate-mcp
- Pinned commit: `0ab0c42c4fdbc3fca2cf923bb8b23fefdd056e0c`, resolved from the GitHub tree API and fetched from commit-addressed raw URLs.
- License: MIT. The complete upstream license is preserved at `licenses/codex-delegate-mcp-LICENSE.txt` (Git blob SHA-1 `7e38a227b817f83e70acc8bf08625444925a9643`, local SHA-256 `8cf3334bfa0b9f3bc0e1f7a23a24b384bba1679ed4157079ae331a33282ac949`).

### Consulted Andrei Lungeanu files

| Upstream path | Git blob SHA-1 | Local SHA-256 |
| --- | --- | --- |
| package.json | bdfb8140b06114bbb37d17c2b2e8747252acd6f6 | 3239285a86342a7d3e63905f41b6a2f17658b038770645a62c9b802bc0fbd5e8 |
| src/server.js | 1b3249f8ae6df716d5e730c5ba8e68b82f5f21f9 | 623352ceba95ea4210e0d3865c4c8e3939e6352bda72fdd601ef8b7c1be5dfdf |
| src/proc.js | e174d67e48e40318ed214b58b11bdd5c166919d0 | f90d5e564e0bd13458f2ff2da79390f3999218f5866a82235e60ecd1990e93ef |
| src/run-codex.js | e183c507db98015a4fb23e27859b2317a249e9f1 | a540159afae5df6412179eadb66be5e82bd8120a97fb467c89f37f14649dacb5 |
| LICENSE | 7e38a227b817f83e70acc8bf08625444925a9643 | 8cf3334bfa0b9f3bc0e1f7a23a24b384bba1679ed4157079ae331a33282ac949 |
| test/fixtures/spawns-grandchild.mjs | 4741f6acadef92a8fe883176bceb293441720ee0 | cf3cc43a1197fac8a0e70bdab7e2cc4a3b143710d2a92c95ba6928cb9b20b57a |
| test/proc.test.js | dd43fd6ec93035b71bc660bfc366351355d383ec | 2cdc12619bf0d4657482e7815a217f522cdd96e59377bcc4a536d3df24a18f59 |

### Reuse scope and attribution

- Reuse the Node ESM/JSDoc/checkJs shape, strict MCP SDK/Zod schema discipline, single JSON text envelope, and StdioServerTransport registration approach as implementation references.
- Adapt the `shell:false` argv-spawn process boundary, bounded stderr, separate exit/close handling, process-group observations, and grandchild fixture/test shape to OMP 18.3.0. The research fixture is not shipped as product code.
- Preserve MIT attribution if any source expression is later copied into runtime code. At this stage no Andrei Lungeanu file is a runtime import.

### Explicitly excluded Andrei Lungeanu patterns

- Do not retain Codex-specific output-last-message/thread event handling, default-model selection, or branding in the OMP runner.
- Do not copy the complete delegate implementation, its plugin packaging, model catalog, or unrelated command behavior.
- Do not treat the research fixture as proof of real OMP/Claude integration; actual OMP 18.3.0 evidence remains required.

## Verification record

The development research snapshot covered the 19 upstream paths listed above. SHA-256 and Git blob SHA-1 comparisons passed for all 19 files. The private research snapshot is not distributed; the pinned repository commits and hashes in these tables support independent reproduction. Public license copies are additionally checked against `licenses/SHA256SUMS.txt` during packaging. Product verification is documented in [docs/public/verification.md](docs/public/verification.md).

## Implemented adaptation — runner

`src/runner.js` adapts the MIT upstream argv/pipe spawn boundary, bounded stderr, exit/close separation, and cancellation lifecycle. OMP JSONL reduction, EOF/session proof, terminal handling and confirmed process-group cancellation replace Codex-specific code. The file header records the upstream SHA. Fresh/resume host checks are separate from fixture tests; see the public verification document for their evidence policy.

## Direct npm dependencies

The root lockfile pins the direct dependencies used by the MCP/runtime boundary:

- [@modelcontextprotocol/sdk 1.30.1](https://github.com/modelcontextprotocol/typescript-sdk) — MIT License.
- [zod 3.25.76](https://github.com/colinhacks/zod) — MIT License.
- [typescript 5.9.3](https://github.com/microsoft/TypeScript) — Apache License 2.0 (development dependency).
- [@types/node 22.18.6](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) — MIT License (development dependency).

`npm run package` installs only the production dependency closure into the generated plugin runtime. npm package metadata and the lockfile remain the authoritative source for transitive dependency notices.

## Public-repository boundary

The root notices describe provenance and licenses, not a claim that an interactive Claude/OMP host run has passed. Generated runtime notices are created during packaging and include the complete upstream license texts needed by that runtime. User configuration, credentials, transcripts, logs, and private verification artifacts are not third-party dependencies and must not be copied into a release.
