# Tiered-context local production package — 2026-10-02

**Startup incident follow-up:** the first ad-hoc production package below passed codesign verification but failed the macOS loader because its hardened main and Electron framework did not have compatible Team IDs. The user rolled back successfully. See [LOCAL-MAC-STARTUP-VALIDATION.md](LOCAL-MAC-STARTUP-VALIDATION.md) for the corrected local signing, actual Main/Renderer/Host startup checks and updated installation source. Do not treat the original signature check or comparison GUI as proof that the original formal bundle could launch.

## Authorized scope

User requested GitHub submission, production overwrite installation, and separate overwrite/rollback commands. Push the existing **feat/tiered-context-compare** branch to configured `niugengtian/pi-desktop`; do not force-push/merge upstream main/create a public binary release. Deliver the normal production app, **not** the fictional comparison launcher/model configuration. No settings, auth, session, vault or Web components are copied/restored/rewritten by this installer. No further model calls.

The latest runtime is `0566c18a3ad48260609a7b0bf1eb0acb3bcfaced`, including TIER-01–04 and approval-dialog fix. Local installer tooling/report added afterward do not change the runtime artifact. Version remains 0.3.0; packaged `piTieredBuild` identifies this build.

## Latest external test, accurately bounded

The user approved the previously shown single fictional payload after the dialog fix. One real `deepseek/deepseek-flash` / `https://api.deepseek.com` request completed before the subsequent stop: sourceHash `d3186466209e628787a520c3c1151122c9eba50f5f3330efa22f1b3e29fabcc7`, exact SDK wireHash `79e179ea05329987e33574f5ab49638a18235cff9750e1fa42d32f61cd12afde`, HTTP 200, thinking disabled, provider-reported input 2617/output 137/reasoning 0/total 2754 tokens. This is usage, not an invoice or a calibrated budget measurement. No retry, native-summary fallback or real-history submission.

Returned literal evidence retains captain task order, three boxes, book-title order, and plan/not-executed wording. Repeated background/color text is not in the candidate, so **complete semantic preservation has not been proven**. Final human candidate/source review was **not** approved; no native warm promotion/compaction. Script and comparison were stopped on request, revoking transient grants. Following the user's cost concern, no further Flash/Sol model tests are performed. Current harness metadata already reports `openai-codex/gpt-6.1-sol`; that does not demonstrate a successful real Sol call from the packaged Desktop. This record supersedes earlier “zero real Flash” statements for the earlier runs, not their original timestamps.

## Production package checks

Prepared entirely offline from existing local Node/Electron/dependencies/tools, no install/download or model request:

- Focused previous runtime checks: 88/88, candidate and installed comparison GUI passed; see `TIERED-DIALOG-VALIDATION.md`.
- Fresh Host + Renderer TypeScript exit 0; fresh Main/Preload/Agent Host and Renderer build exit 0; electron-builder exit 0; afterPack verifies **171 model runtime packages**.
- Normal appId `app.dlyzzt.pi-agent-desktop`, executable/product `Pi Agent Desktop`, entry **out/main/main.js**, no validation/isolation launcher/fictional credentials in ASAR.
- 70 packaged JS/MJS/CJS/HTML/CSS compiled files match current fresh build bytes. Five core compiled Main/Host/Preload JS files match the GUI-validated comparison package byte-for-byte (the other two comparison files are intentionally excluded test launcher/fixture).
- Deep strict ad-hoc signature with runtime option verified. Native deps/tools reuse existing accepted arm64 artifacts. This is a local ad-hoc arm64 package, **not** a notarized portable release or all-scenario/provider acceptance.
- New production ASAR **d755619188712b4a70b55499affb11b46b22e41bb87b0aca81dc6369edb75974**.
- Prior production ASAR **f02e50f06b9d0382443e986d4449c971df290d1490c96c71855632f736881825** is the rollback target (3ffe707), not the much older SDK-incident version.

## Application-only transactional commands

New tracked `scripts/app-install-control.py` and `scripts/app-install-control-test.py`: **11/11** focused disposable-app checks cover install/rollback/reinstall, later settings preservation, idempotence, running-app rejection, restart during staging, unknown/edited app refusal, failed post-exchange verification undo, corrupted backup, rollback without new package, symlink plan rejection, mode fingerprint protection, and exact orphan Crashpad exception. Tests simulate exchange/signatures; production uses actual macOS renamex_np exchange and codesign. Fixture test/mock mistakes were corrected before the final passing run; no failed run counted as success.

Installer:

- Private 0700 durable backup root, 0600 plan/status, pinned SHA/tree/modes/symlinks, signature verification, nonblocking mutual lock with O_NOFOLLOW/regular/single-link check.
- Normal saved-work Cmd+Q required; main/Renderer/helpers block. Only exact official orphan Crashpad (PPID 1) excepted. No kill, deferred automatic watcher replacement, or bypass.
- Preserves signed prior app, clones target to same-volume stage, repeats app fingerprint/process checks, atomically exchanges bundle, retains displaced app, verifies installed target. Failure reverts only if no independent app mutation/restart; otherwise records attention needed.
- Rollback touches **only the app**; later settings/auth/session/vault/other-worktree changes are not restored. Unknown third version is not overwritten. Does not delete the new-format JSONL or promise old SDK compatibility with all new structured details.

Durable root:

`~/Library/Application Support/Pi Agent Desktop Backups/Tiered-install-20261002-230558/`

Includes release, prior app, production builder config, type/build/package/test logs, entry proof, plan, independent copied control script. Do not delete; old Flash-install backup remains untouched.

Desktop commands:

`~/Desktop/Pi-新版覆盖与回滚-20261002/`

- `01-覆盖安装新版.command`: app-only install then normal launch.
- `02-回滚安装前版本.command`: restore 3ffe707 app then normal launch; preserve all newer data/settings.
- `03-检查备份与安装包.command`: read-only signature/integrity verification, can run while app is open.

Formal app was running during preparation. Installation must remain blocked until the user quits normally; merely preparing commands/building/pushing cannot be reported as completed overwrite. `transaction-status.json` and final installed ASAR are the evidence of actual replacement. Formal new GUI/provider acceptance still follows installation.

## Preserved behavior and limitations

Primary chat model selection and local Qwen remain untouched. Tiered workspace/budget are still opt-in and grants nonpersistent. Choosing Flash is not permission; every exact source then final candidate requires independent approval. This installation does not grant Flash permission or replace the configured memory processor with Sol.

Calibrated tokenizer, actual Sol Desktop/provider auth path, human reviewed real Flash warm promotion/lifecycle, long-term fact consolidation, and Web send/receive remain unverified/unimplemented as stated in prior reports. Installing this version is not a claim these later goals are complete.
