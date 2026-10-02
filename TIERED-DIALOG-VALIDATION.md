# TIER-UI-01: readable, genuinely modal source approvals — 2026-10-02

## Scope / current task status

Read project README/architecture, GOAL and TIER-04 evidence plus actual extension, budget, RPC and Renderer paths before continuing from `fcce4a8`. The old `/tmp/pi-tiered04-desktop-validation` directory no longer exists. Its historical report is not fresh acceptance evidence. The installed comparison and desktop source/payload previews survived; formal ASAR still matches the recorded production version.

This closes a **real GUI approval usability defect**, and adds the missing Codex + incremental warm composition check. It does **not** complete actual Sol/Flash provider acceptance or human semantic review. No real model request was authorized/performed this round. Existing synthetic main wire log stayed byte-identical; Flash audit remains absent.

## Reproduction, then minimal fix

Old installed comparison `29271403…`: real full Flash source approval in an 808px-high Electron renderer measured top **-710.39**, bottom **1562.39**, height **2272.78**. Cancel/Confirm bottom **1551.39** was outside the viewport. `aria-modal` on a div did not make the composer inert: programmatic focus moved to the background textarea. This explains why DOM `.click()`-only QA was not sufficient proof of usable approval. The earlier screenshot's yen glyph alone did not establish its cause; this round directly reproduced the focus boundary defect.

Changed only production Renderer files:

- `src/renderer/components/ChatWindow.tsx`: native `<dialog>.showModal()` top layer, native inert background/focus containment/restore; viewport-bounded flex layout; independent scrollable, wrapping **complete** content with persistent header/footer. Confirmation/select opens on **Cancel**, not Confirm. Native Escape calls the existing cancellation response; unmount closes the native dialog. Input/editor still get their own initial focus.
- `src/renderer/globals.css`: modal backdrop.

No source truncation, no approval bypass, no auto-confirm, no altered authority/permissions/model settings. SDK/Host/native compaction logic was not changed. The native dialog exposes its implicit dialog role (test selectors must not assume an explicit `[role]` attribute).

## Real Electron checks

New tracked, explicitly opt-in script:

```sh
node scripts/test-tiered-dialog-electron.mjs \
  '/Users/niugengtian/Library/Application Support/Pi Agent Desktop Tier Compare'
```

Requires the **isolated fictional** comparison app with loopback CDP 9227. Rejects a pre-existing pending user dialog, verifies fixture config and visible synthetic model identity, records before/after model audit fingerprints. Does not accept a real-session root or click Flash source/candidate Confirm. It enables only the local experimental budget; cancels local export; disables budget at the end. Uses native pointer events on visible/unoccluded buttons, not hidden DOM clicks.

Passed on the signed candidate **and again after independent installation**:

- 980×720: source dialog y20..700, buttons y654..689; content scroll 1671px / visible 557px.
- 720×560: dialog y20..540, buttons y494..529; content scroll 1858px / visible 397px.
- Source `innerText` unchanged while scrolling, no horizontal overflow; source text SHA `65c8a7a670b5ef4e02d64ed2dbf8e715038b98a99a7b17ff3d6f99d82f298be9` (UI source text, NOT native/source payload hash).
- Native `:modal` true; attempted background focus and inserted yen glyph do not change composer; repeated Tab/Shift-Tab stay within modal.
- Escape cancels; explicit manual Compact opens a fresh approval; visible pointer Cancel closes it. **No Flash/source Confirm clicked.** Model logs unchanged, no compaction promotion.
- Screenshot viewed at 720×560: complete scroll tail and both footer buttons readable, not just measured bounds.

Test-script failures retained honestly: old `[role="dialog"]` selector did not find native implicit-role dialog; corrected selector. CDP Escape without Windows virtual-key code did not invoke native default handling; corrected trusted key payload. After narrow-viewport testing, the ordinary fixed-width composer Compact button was outside viewport; restored normal viewport before ordinary UI interactions. No offscreen `.click()` workaround, no failed run counted as passed.

## Codex + Flash composition (offline model response)

Added one real SDK/loopback test in `tiered-budget-sdk.test.mjs`: Codex A→B→A consumes reviewed mock-Flash warm exactly once per actual Responses input, never restores repeated cold text, retains opaque hot replay, and triggers a second **SDK-scheduled** incremental warm when the new span is large. Delta includes omittedReasoning metadata, excludes encrypted replay/reasoning summary and old warm facts; native prefix unchanged and cumulative version advances to 2.

Initial small-span fixture did not cover a thinking-bearing record because SDK kept it hot; after adding the large latest span the SDK automatically prepared the second delta, so the test follows actual scheduling rather than assuming a manual cut. Fake UI approval/SSE response does not prove actual Flash quality/human completeness.

## Validation and delivery

- **88/88** focused checks: previous 79 tier/memory checks + 1 composition check + 8 existing UI ownership/copy checks. `final-tests.log`; no all-project suite.
- Local ESLint, Prettier and diff check; Renderer TypeScript and offline Renderer build; electron-builder offline using existing Electron/tools/dependencies; **171 runtime package** afterPack verification; ad-hoc deep strict signature passed.
- Related warnings retained: react-test-renderer deprecated, MODULE_TYPELESS_PACKAGE_JSON and existing large renderer chunks.
- Both candidate and previous comparison quit normally. One-shot comparison-only installer checks exact process executable paths (only orphan exact Crashpad excepted), expected prior ASAR, signature and production hash, then same-volume atomic-exchanges **only** `/Applications/Pi Agent Desktop Tier Compare.app`. No forced stop, production install/config/session/auth/vault/Web edits or download.
- New comparison ASAR **`d081a6584c62daf9e8db73c7fd00da23244d54bf8b307e042366e121992b0204`**.
- Old comparison retained: `/Applications/.TierCompare-ui-prior-d455b1cfed564648aafcc8fa46b3b6e1.app`, ASAR `292714030b0f75fe89dc74eacbadf83a9dadc91b1b954254fbedf22e3f3c9621`.
- Formal remains **`f02e50f06b9d0382443e986d4449c971df290d1490c96c71855632f736881825`**. Compared all 7 compiled JS/MJS/CJS files under out/main, out/agent-host, out/preload to prior installed comparison: byte-identical. This update changes Renderer only.

Evidence is now durable beneath:

`~/Library/Application Support/Pi Agent Desktop Tier Compare/validation-ui/`

Includes before.json/png, after.json, two source screenshots, package/build/test logs, install proof/script, unchanged non-Renderer proof, packaging YAML and preserved generated comparison entry/fixture. No credentials copied. After QA the comparison quits normally, closing its temporary CDP port and fixture server; permissions are not left enabled. Desktop shortcut continues to open the updated independent app without debug port.

## Remaining external gate (not silently converted to consent)

Actual Flash test remains the previously previewed **one** payload (sourceHash `d3186466209e628787a520c3c1151122c9eba50f5f3330efa22f1b3e29fabcc7`, 11039 UTF-8 wire bytes, NOT tokens). Desktop has full source and SDK JSON. It requires specific approval to api.deepseek.com, followed by separate candidate/source review. Actual Sol provider testing needs its own source/payload scope; the fictional Codex fixture and SDK support must not be renamed actual Sol success. Cancellation after real provider dispatch, settings-epoch and late-result GUI paths still need the authorized real-source round. Web and calibrated tokenizer/long-term fact consolidation remain later phases.
