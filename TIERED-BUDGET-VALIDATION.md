# TIER-02 — native budget coordinator / fail-closed dispatch prototype

Historical checkpoint `6fb43c9`. The later incremental Flash hook is documented separately in [TIERED-WARM-VALIDATION.md](TIERED-WARM-VALIDATION.md); it does not broaden this stage's API/token acceptance.

## Version and boundaries

- Independent `feat/tiered-context-compare`, following stage 1 `e426baf` / production baseline `3ffe707`.
- Default OFF; commands `/tiered-budget-enable`, `/tiered-budget-disable`, `/tiered-budget-status`. Session/UI approval is separate from local workspace export and Flash/Web authorization; no persisted grant.
- No production deployment or packaged comparison `.app` yet. Installed ASAR rechecked unchanged: `f02e50f06b9d0382443e986d4449c971df290d1490c96c71855632f736881825`.
- No real histories/keys copied to tests, no overseas requests/downloads. Only generated histories and loopback fixture HTTP providers. SDK credentials used in fixtures are invented literal values, never user authentication.
- Prototype supports standard **OpenAI-completions text / byte-BPE assumption**, default provider IDs `openai`/`deepseek`. Custom stream functions/native-provider overrides, images and other APIs are refused when enabled. Fixture IDs are allowed only by an explicitly injected test contract.
- **GPT-6.1 Sol / Codex-Responses is NOT covered by this prototype.** Formal main chat stays unchanged. Cross-protocol/Responses/Web guards remain future work; switching to an unsupported API while opted in refuses rather than downgrading/falling back.

## What changed

Desktop creates one controller per SDK session; public SettingsManager reads are proxied only for that session. No settings.json writes or shared-runtime method replacement. When OFF, settings and stream/compaction calls pass through unchanged.

ONE compressor remains native SDK:

1. Read canonical SDK projection and replay current system/tool state through public pi-ai helpers.
2. Compute conservative input/protocol/warm/hot estimates, reserve normal output `min(model maximum, 2048, floor(window/4))` and safety, then shrink target-window history allowance.
3. Select a numerical **native keepRecentTokens hint** over complete recent user spans, using the SDK's own estimateTokens heuristic. No new message slicing or compaction entry injection. Latest user span is preserved even if too large; final dispatch then refuses it.
4. Only when compaction is needed and the protected span can fit, enable the native scheduler. A reserve sentinel `contextWindow + 1` forces its own threshold path even when last provider usage is zero; this sentinel is **NOT output reservation**. Actual summary output is independently capped before dispatch.
5. `session_before_compact` validates the native kept boundary, branch/file provenance and source consistency. Summary stays on the currently selected normal API/model; no automatic Flash or other-provider fallback.
6. A wrapper around public `SessionManager.appendCompaction()` rejects changed/revoked sources, altered cuts, empty or oversized warm candidates BEFORE native append. Thus failed warm does not replace hot context.
7. Failed/cancelled compaction latches automatic compaction paused. An ordinary later turn is not permission to silently regenerate the same failed range. Explicit manual `/compact` or disable/re-approval is required for another attempt.

The existing Flash task-memory vault is neither read nor inserted. No new handoff prompt, native JSONL deletion, history migration or second compaction owner.

## Fail-closed final boundary (BUDGET-HOOK-01)

Real SDK investigation and loopback reproduction proved `context`, `context_with_system`, and `before_provider_request` handler exceptions are caught/logged and dispatch continues. They are NOT a safe blocking mechanism.

The per-session public `agent.streamFunction` wrapper therefore:

- Checks supported provider implementation/session, source consistency and a conservative preflight before calling the normal SDK stream implementation.
- Supplies an OUTER provider `onPayload` callback, awaits existing payload transforms first, checks permission generation/model/projection/native file again, detaches the final JSON from live references/accessors, then validates it.
- Runs outside the fail-open extension handler catcher. Refusal occurs before the pi-ai OpenAI client calls HTTP; tests assert zero loopback requests for the refused cases.
- Validates final selected model, leading protocol, output field, warm present exactly once, whole tool-call/result chain, text-only format and total input/window reservations.
- Suppresses cache warming and agent/provider retries while enabled through session-local settings reads. A 503 fixture has exactly one request. Disabling restores current native settings reads, not a stale saved file.
- Recognizes an obviously non-fitting incoming prompt before native pre-prompt compaction, suppresses useless summary dispatch, but lets SDK record the user request and final refusal. Oversized protected tool batches likewise do not trigger a futile summary request.

A refused request is a visible SDK assistant/error or preflight failure, not a dropped or fabricated tool result. Already-dispatched cancellations do not prove provider computation or billing stopped.

## Token measurement honesty / limits

There is **no downloaded tokenizer and no exact token counting** here.

`estimateEnvelope()` reports separate `wireBytes` and `estimatedTokens`, with:

- method `byte-bpe-json-envelope-plus-framing`;
- accuracy `conservative-estimate-not-token-count`;
- text-only byte-level BPE assumption: use at most one estimated text token per UTF-8 byte, plus 32/message and 128/tool framing allowances. Serialized JSON metadata/syntax often does not reach model text, so this can refuse much earlier than a real tokenizer.
- provider framing/schema rendering is **not officially calibrated or certified**. This is not a universal model-window guarantee, vocabulary-specific tokenizer, stable benchmark or actual billed input count.

8k/12k hot and 2k/4k warm are prototype **estimate thresholds**, not demonstrated real token occupancies. SDK cut hints remain its chars/4 heuristic and are kept distinct from the envelope estimate. Base64/images and opaque thinking signatures are rejected rather than counted as text tokens.

Final request JSON, not an earlier SDK usage value, is checked. Source consistency reads are bounded at 16 MiB; wire measurement at 8 MiB. Checks are synchronous/bounded; production latency has not been benchmarked. Active raw-file editing creates a conflict requiring reconciliation/reload; no automatic repair is attempted.

Protection is for ordinary lifecycle/late/manual changes, not arbitrary hostile same-UID code replacing public runtime methods or OS-level CAS. A signed/package/start success would not validate this policy's content quality or all lifecycle cases.

## Observed checks

Final focused run: **59/59** (20 new budget checks + 39 prior relevant workspace/Flash/background/compile checks). Log: `/tmp/pi-tiered02-final-check.log`. No full-suite verify.

Actual SDK services/session + loopback HTTP observations:

- Controller installed but OFF versus no controller: A→B→A actual complete JSON bodies deeply equal, same bound cwd, no normalization/masking.
- Reproduced fail-open extension exception still dispatching one request without budget opt-in.
- An oversized body inserted AFTER preflight is refused at the final callback: zero HTTP.
- A→4096-window B→A: non-fitting B input is preserved locally, zero B HTTP, one native warm contribution on return, no hidden retry/downgrade.
- Long older source: exactly one native summary request and one normal request; latest user span preserved verbatim, cold-only older source absent from normal payload, native history prefix unchanged.
- Oversized generated warm: no native compaction append; original hot retained; automatic retry/re-entry paused across later normal turns. Explicit manual retry tested separately.
- Real SDK tool execution/continuation: initial tool-call request executes a fictional tool; oversized complete result remains paired in native projection, second HTTP and summary are refused.
- Pending payload permission revocation: zero late dispatch.
- Model switch during already-dispatched native summary: cancelled old candidate does not append; no B request with oversized source.
- Native JSONL externally changed during pending summary: changed manual text preserved, no warm append or stale normal chat dispatch.
- Pure planner checks cover system/schema/output/safety subtraction, estimate labels, missing/duplicated/oversized warm, pending/orphan chains, media/API/output/protocol refusal and NaN/unsafe arithmetic.

Host and Renderer TypeScript, local ESLint/Prettier, diff checks and offline Main/Preload/Agent Host build passed. Node MODULE_TYPELESS_PACKAGE_JSON and existing plugin-worker unused-import warnings remain.

## Failures and corrections kept visible

- Early small-window test observed two B summary requests before the new giant input was recorded. Added admission signalling to suppress pre-prompt compression for obviously non-fitting input; no input is silently removed. The A-return sample was adjusted to stay below A's hot target while still not fitting B, so it tests handoff continuity rather than an unrelated second valid A compaction.
- Native compaction initially made zero requests: its backward `>=` threshold could retain an oversized old span, yielding no summarizable prefix. Whole-span numerical hints corrected that; no independent projector was added. Zero reported usage also required the explicit scheduler sentinel.
- Oversized warm first got refused, but a later threshold check automatically generated another candidate and appended it. The pause latch fixes this as a source-preservation/no-hidden-retry boundary; regression now checks later normal turns and explicit manual retry.
- Initial Host typecheck rejected narrowing/definite assignment around a const-arrow `never` helper. Changed to an explicit `never` function declaration, then reran Host/Renderer checks to actual exit 0. Node tests alone were not treated as TypeScript acceptance.

## Next

- TIER-03 adds a reviewed extractive native-range Flash prototype (linked report), tested only with synthetic mocked transport. Real Flash quality/history dispatch still needs explicit payload approval; full structured state/contradiction reduction is not complete.
- Exact/calibrated token strategy and Responses/Codex protocol guard before claiming usable comparison for Sol.
- Separate isolated Electron comparison package and actual GUI/source/payload checks; then Web submission/retrieval closure. Not yet installed, packaged or GUI-accepted.
