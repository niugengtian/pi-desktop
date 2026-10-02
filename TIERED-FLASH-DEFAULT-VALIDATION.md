# Default warm processor correction — 2026-10-03

User clarified that warm defaults to DeepSeek Flash, while primary chat remains Sol. Existing controller initialization and disable reset both selected native; old task-memory.json's Flash primary did not select the new tier warm processor. That was not the intended default.

## Minimal change

- Initialize/reset session warm selection to Flash (`warmMode=true`). Budget/grants remain OFF by default and nonpersistent. Selecting Flash is NOT source authorization.
- Budget dialog now clearly says default Flash/nonthinking, not selected main model; separate exact-source and final-candidate approvals; processor unavailable/cancel/failure cannot fall back to main-model summary.
- `/tiered-warm-native` stays an explicit session-only opt-in. Disable/navigation/restart returns selection to Flash without restoring source permission. No global settings/main model/SDK OFF behavior changes.
- Missing runner/UI enters existing guarded refusal and notification instead of silently cancelling; no fallback or history promotion.
- Existing native-budget test fixtures explicitly choose native, so they test the native opt-in instead of preserving an accidental production default. One Flash integration test now omits `/tiered-warm-flash`, proving default selection has no dispatch until source approval. Added denied-default-source/reset and missing-processor tests.

Focused checks: **22/22 SDK budget tests**, **82/82 related tier/memory checks**, local lint/format/diff. Initial missing-runner test expected a visible refusal but old path silently cancelled; changed to the existing guarded error path, reran successfully. No real provider call. Does not claim GUI/install/provider/semantic completeness.

## Fresh fictional session source preview

Session `01a0fd66-68eb-71ca-b573-4c516a19fd7e`, created through SessionManager, contains clearly labelled artificial seed acknowledgements (not actual Sol output, zero usage is synthetic). Original real conversation is not copied.

Actual `AgentSession.compact()` + controller hook built a preview in an SDK RPC UI shim; source approval deliberately denied. Short fixture uses an in-memory test hotTarget **256**, not the production **8000**, solely to trigger native preparation without adding expensive padding. Production thresholds/config are untouched. No hand-crafted compaction entry/cut or fake warm promoted.

Eligible range is the original user datum and artificial acknowledgement, sourceHash **a4450d3936cbac9903ee44df08deaf2a370387be2ce771f44b666d0a63daba8e**. Later update from 3 to 4 planned boxes remains hot. Default processor reported Flash; source cancelled; real requests **0**, compactions **0**, original native prefix preserved. SDK legitimately appended normalized thinking-level metadata when opening Sol, so an initial full-byte-equality assertion failed; replaced with original-prefix preservation plus no-compaction assertions. Earlier CJS export resolution/uncached model catalog attempts failed before any provider request; local-only catalog refresh resolved the model. No failed run counted as pass.

Full fresh source preview and metadata are on Desktop:

`Pi-独立对话机制验收-20261003/Flash-本次完整源审批.txt`

`Flash-本次preview-state.json`

Earlier direct prepareCompaction preview (sourceHash 06eaae7e…) used explicit keep settings and is superseded by this actual-hook preview, not authorization for a different range. Initial cached plan file is not the active hook/wire proof. No old Flash consent is reused. At that preview checkpoint the new exact payload still needed source and candidate approval; both occurred in the bounded actual run recorded below.

## Deployment / matrix status

This correction is **source only, not yet rebuilt/installed**. Current formal ASAR d7556191… still has the earlier native default. Source-level shim/test acceptance is not formal GUI acceptance.

User asked warm then every configured API/Web pseudo API. Recon found one custom Ollama provider, 9 cached Codex model variants, and Web pseudo models opencli-page/{chatgpt-web,deepseek-chat,deepseek-reasoner}. Do not loop through the entire SDK builtin catalog or treat 9 variants of one Codex API as 9 API families.

### Actual bounded run, after native macOS human approvals

A separate script showed the full fresh SYSTEM/USER in TextEdit plus a native approval dialog (Cancel default); actual SDK compaction used the same prepared hash a4450d39…. After Flash returned, a second native candidate/source review dialog was confirmed. Neither approval was auto-clicked or inferred from a previous grant. Original data remained synthetic-only.

- Flash warm: **1** actual api.deepseek.com POST, HTTP200, thinking disabled; actual wireHash **308db9b399b3a966ec670e5429be8efdbb5a776cbc6e1c1a5231ad36e89340f9**; reported **428 input +155 output / reasoning0 / total583**. Native compaction **f39ed413**, human-approved-not-proven, factVersion1, original JSONL prefix preserved.
- Actual **GPT-6.1 Sol** Codex request: **1** POST, HTTP200; reported input370/output114/total484.
- Actual **DeepSeek Flash primary** Completions request: **1** POST, HTTP200, thinking disabled; reported input442/output97/total539. This primary-provider transfer test is separate from warm generation, not background-memory permission.
- Both actual serialized request bodies (plain/zstd decoded before HTTP) contained warm **exactly once**, the latest hot change to **4** boxes, and did not resend the old user source as a separate raw message. Actual model replies were strict JSON and passed all seven fixture checks: code name, current4, blue, step order, book order, not executed, read not equal modified. This is bounded fixture/provider evidence, not general semantic losslessness.
- Ollama Qwen model selected in actual SDK: **0 HTTP**, native assistant error **TIERED_POLICY_REFUSED: unsupported-or-replaced-session-model**; provider not supported by current tier budget.
- Loaded the **actual installed page-provider extension through SDK's resource loader aliases**, selected all three Web pseudo models and prompted each. Replaced its stream driver with a refusal sentinel to prevent accidental website sends. All three were rejected by the actual budget before the driver (invocations0), same TIERED_POLICY_REFUSED error; **0 website submissions**. Independently called the real existing Web continuity builder with actual projected test context: all omit the warm summary. This verifies registry/switch/refusal/formatter incompatibility, **not** website send/receive success.

The first matrix script stopped during Qwen relay export because its manual label contained a colon; the real Desktop extension already sanitizes labels. Preserved failed report, fixed only the harness label and resumed missing offline checks, no charged call repeated. Direct Node ESM loading of the installed Web extension failed SDK alias resolution; loaded through SDK instead, no dependency install. After the three successful refusal checks, the auth-free offline instance could not restore Sol via setModel; it was disposed, and SessionManager restored the final model metadata without a network request. These failures are retained, not hidden or counted as initially passing.

Final evidence: Desktop `Pi-独立对话机制验收-20261003/验收结果汇总.md`, `真实warm与API-Web矩阵结果.json`, audit JSONL, private actual API payloads (no headers), native/macOS source and candidate review files, failed initial report and scripts. Cold equals final native bytes; exactly **1** native warm; original prefix remains; model metadata restored to Sol for reload. Close/reopen the test conversation before GUI inspection because an externally opened SDK instance is not the live Renderer/Host cache.

**Actual generation calls total3** (warm1 + primary2), reported total1606 tokens across these calls—not an invoice. No retry/probe/implicit native/provider/Web fallback, no further charged calls during offline recovery. Authentication reused only inside SDK.

**Outcome: two supported API families pass the fixture wire/response checks; local Qwen and three Web targets do NOT fulfill the unified-context goal.** Ollama/Web need implementation work, not a disabled guard or fabricated sent/received evidence. This test uses real SDK/provider transport plus native human approvals, not the installed Electron Renderer command/lifecycle path. Default Flash code correction is still not deployed to the current app.
