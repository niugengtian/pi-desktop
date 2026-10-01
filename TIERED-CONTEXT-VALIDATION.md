# TIER-01 — local native-context comparison, stage 1

Historical checkpoint: `e426baf`. For the later, separately opted-in budget prototype and its narrower API/token-estimation limits, see [TIERED-BUDGET-VALIDATION.md](TIERED-BUDGET-VALIDATION.md).

## Identity / scope

- Baseline: `3ffe707`; branch: `feat/tiered-context-compare`.
- Worktree: `.worktrees/pi-desktop-tiered-context` (independent private APFS dependency copy, no downloads).
- This is a source/build comparison version, **not a packaged or installed Desktop release**.
- Production ASAR rechecked: `f02e50f06b9d0382443e986d4449c971df290d1490c96c71855632f736881825`. The baseline worktree remains clean; production app, settings, rollback scripts and Web packages were not changed.
- Only synthetic histories were used. No real session history or credentials were copied into fixtures or sent to Flash/Web.

## Conflict resolution boundary

There is ONE context owner: native SDK `SessionManager.buildSessionProjection()`.

- cold = byte-preserving export of native JSONL, including inactive branches, tools and metadata. Original JSONL remains authoritative and unmodified by the feature.
- warm = the single selected **native compaction** contribution. Existing task-memory/Flash Markdown is never added to provider context or treated as another compaction.
- hot = all other selected non-system messages with source entry IDs. No additional slicing, no lost uncovered increment; incomplete tool calls are retained and marked pending. Orphan tool results pause export rather than being silently rewritten.
- `context/projection.json` preserves the full native projection including system/protocol state and provenance. It is a LOCAL view, not proof of a sent request. Live-only ephemeral restoration and other extension/provider transformations remain outside this persisted view.
- `facts.jsonl` is deliberately empty with `factsStatus: not-extracted`; opaque native summaries are NOT claimed to be structured or lossless facts. Coverage is a source boundary, not a semantic-quality guarantee.
- No context, before-provider-request or before-compaction hook; no settings/budget change. Thus this stage avoids dual scheduling by not introducing a second compressor. It does NOT finish the future unified budget/Flash/Web integration.

## Local workspace / opt-in

`/tiered-workspace-enable` requires idle/UI confirmation of full LOCAL source export, including sensitive/inactive/tool history. Local approval is separate from remote authorization. `/tiered-workspace-refresh` refreshes approved views; `/tiered-workspace-disable` stops updates without deleting evidence.

Default is OFF, never restored from files. Session navigation/replacement/fork/shutdown invalidates approval. Settlement schedules local export after returning; new turns cancel scheduled exports. The filesystem export itself is synchronous and bounded; latency has not been production-benchmarked.

The bound SDK cwd creates `pi_agent_desktop_session-<SDK sessionId>/` with `cool/`, `warm/`, `hot/`, `context/`, `agents.md`, deterministic `handoff.md`, `workspace.json`, `.revisions/` and a workspace-local `.gitignore`. Project Git rules are not modified.

Every enabled model selection creates a local `<target>_session-<UUID>/` containing frozen `handoff.md`, `binding.json` and **`prepared-context.json`**. Binding is `pending-not-sent`, remote binding is null. No `sent-context.json` or `received.jsonl` is fabricated. Freezing the actual next request and successful return belongs to a later stage.

## Protection / deliberate prototype limits

- New directories 0700, files 0600; reject symlink/hardlinked generated files, unsafe identifiers, wrong session/cwd, changed permissions and changed generated-file hashes.
- Human `agents.md` remains untouched and is not injected into context.
- Exclusive writer directory lock; no takeover of another writer or crash residue.
- Identity/branch leaf/epoch and native source SHA256 guard publication; pre-existing future revisions are never deleted.
- Immutable revision is staged first, generated mirrors replaced, manifest pointer committed LAST. A partial/inconsistent export is rejected on reopening; there is no automatic destructive repair.
- This is **not** a claim of cross-file crash atomicity, adversarial OS-level CAS, or disk-power-loss recovery. There is no injected power-loss test. A hostile same-UID process racing directory replacement is outside the tested protection.
- Full re-export/versioning is intentionally prototype-only: per-file 16 MiB, 32 revisions, approximately 128 MiB generated-view budget with metadata margin. At the limit, updates pause explicitly; no original history or archived views are deleted. Incremental cold export/storage compaction remains TODO.
- Token measurement: **not measured**. Byte/record counts are storage metadata only, never labelled tokens. 8k/12k hot and 2k/4k warm policy is not yet enforced.

## Checks / actual paths

- Final **39/39** checks passed: 18 new local/SDK checks plus 21 existing Flash/background/compile/extension checks. Final log: `/tmp/pi-tiered01-final-check.log`. No full-suite verify.
- Local ESLint/Prettier, Host and Renderer TypeScript, `git diff --check`.
- Offline Main/Preload/Agent Host build passed. Preserved existing plugin-worker unused-import warnings and Node `MODULE_TYPELESS_PACKAGE_JSON` warning.
- Real SDK services/session + TWO loopback OpenAI-compatible HTTP routes, synthetic history only: baseline (no feature), feature OFF, feature ON, each A→B→A on the same bound cwd. Each round makes exactly 3 normal requests, no summary/probe/handoff/retry/fallback requests.
- Captured actual serialized request JSON bodies compare deeply equal across all three modes, with no field masking or normalization. Exactly one native summary, cold-only marker absent, uncovered hot marker and tool call/result/schema present. Original native history prefix is unchanged; normal request results still append normally.
- This verifies the actual SDK/provider loopback path, NOT the Electron GUI or a cross-protocol Anthropic/Responses/Web switch. HTTP fixtures emit deterministic responses; no model summary quality or performance claim.

### Test/tool corrections retained

The first HTTP comparison failed because separate mode-specific cwds legitimately changed the system prompt. Fixtures were moved to ONE identical cwd and full request JSON comparison retained; no fields were masked. The test was rerun only against loopback fixtures.

Initial lint invocation included `.d.mts`, which the existing ESLint configuration ignores and reports as a warning. Corrected to configured `.mjs`/`.ts` paths; declaration formatting and TypeScript are checked separately.

One combined tests/types command hit its 60s tool deadline after reporting all 38 tests passed. It was not declared a typecheck pass. Explicit managed Host/Renderer typechecks subsequently completed with exit 0. An additional storage-limit check was added afterward; the final focused rerun passed **39/39**.

## Next closure

1. TIER-02 adds a first native-budget/fail-closed-dispatch prototype (see linked report). Exact/calibrated tokenizer strategy, Codex/Responses and isolated GUI comparison remain pending; this is not full all-model budget acceptance.
2. Approved Flash incremental warm generation through the SAME native compaction boundary; source/coverage/version/cancel/late/failure/semantic-quality checks, no permission inheritance from local export.
3. Web consumes the Desktop projection only after real submission/retrieval closure and specific site/source authorization; actual request/response evidence, no implicit resend.
4. Separate packaged candidate + real isolated Electron acceptance before any production installation.
