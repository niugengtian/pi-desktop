# LOCAL-SIGN-01: formal package loader failure — 2026-10-02

## Failure / responsibility

User's first overwrite launched an error dialog twice. Actual `.ips` termination: **DYLD / Library missing / SIGABRT**, with Electron framework **“mapping process and mapped file (non-platform) have different Team IDs”**. It was not a missing framework file, SDK dependency error, or established OS-version incompatibility. It occurred before JavaScript Main/Host could start. The release's ad-hoc main had `flags=0x10002(adhoc,runtime)`, no Team ID; deep strict signature verification alone did not exercise hardened-runtime library validation. Comparison GUI acceptance used a different signing policy, so it could not replace formal-bundle startup acceptance. This was a release validation gap.

User successfully ran rollback: production ASAR returned to `f02e50f06b9d0382443e986d4449c971df290d1490c96c71855632f736881825`, with the old app running. No need to restore auth/session/settings. No user app is force-stopped or re-signed in place.

## Minimal local-only fix

- New `scripts/sign-local-mac.mjs` explicitly signs a **staged, already-ad-hoc** local app with `--options 0`, never `/Applications/Pi Agent Desktop.app`, never downgrades a Developer-ID release. Clears hardened flags for the local ad-hoc package, matching the usable previous local app's policy. Retains explicit existing entitlements. No global electron-builder signing-policy changes, SIP/Gatekeeper changes, quarantine removal, credentials, or downloads.
- Postcondition: main flags **0x2(adhoc)**, no runtime bit, codesign deep/strict passes. This is a **local arm64/ad-hoc app**, not hardened/notarized Developer-ID distribution.
- Changes signatures only: native/JS source and ASAR unchanged, new ASAR still **d755619188712b4a70b55499affb11b46b22e41bb87b0aca81dc6369edb75974**. Bundle tree intentionally changed, so installer `plan.json` must pin the new tree, not merely the same ASAR.
- Original failing bundle preserved as `Failed-hardened-Pi Agent Desktop.app`; old plan and builder YAML preserved. Root's local builder configuration disables hardenedRuntime for subsequent ad-hoc packaging; official repo signing configuration stays unchanged.

## Real startup checks (not only codesign)

1. Corrected bundle executable with `ELECTRON_RUN_AS_NODE=1 --version`: **v24.18.0**, exit 0, proving loader can load its Electron framework. This alone was not counted as GUI acceptance.
2. Actual **production** entry `out/main/main.js`, production appId/executable, `--validate-packaged-startup`: exit **0**, report `ok:true`, **rendererReady:true**, **hostReady:true**, piVersion **0.87.1**, Host toolchain ack and bundled **rg/fd** healthy. Uses existing Main startup validator; no comparison launcher/fictional-server entry substituted.
3. Repeated same real packaged check from final `release/mac-arm64/Pi Agent Desktop.app` after replacement of prepared installation source, using a separate fresh HOME/profile: exit **0**, same Renderer/Host/core readiness.

Both runs have isolated empty HOME/userData/agent, `PI_DESKTOP_MEMORY_TEST_BUILD=1`, `PI_MEMORY_TEST_MODE=1`, `PI_OFFLINE=1`, bootstrap skip, unset active session/auth-reference flags. Production updater disabled by existing isolation path. No production history copied, no model prompt/probe/retry/API/Web call. Validation's successful completion stops its own Host/window/process; the user's running old formal app stays running. Startup checks do not prove real-provider turn acceptance/all lifecycle semantics or actual final installed launch.

New local signer contract tests **3/3**, local lint/format/diff passed. Existing app-only transaction tests remain **11/11**. Early test-process start attempts used a nonexistent cwd and never launched; corrected before both successful runs, not counted as passes.

## Updated commands / preserved rollback

Same desktop folder and commands — no new confusing replacement shortcut:

`~/Desktop/Pi-新版覆盖与回滚-20261002/01-覆盖安装新版.command`

points to the **fixed prepared bundle** now; `02-回滚安装前版本.command` still restores the valid immediate previous f02e50f0… version. Updating the backup's prepared source and pin was protected by the existing transaction lock, preserving failing artifact/old plan and never changing production/config. Pre-install integrity/signature check again passes.

Durable evidence beneath:

`~/Library/Application Support/Pi Agent Desktop Backups/Tiered-install-20261002-230558/`

includes `startup-fix-proof.json`, old plan/failed bundle, both `startup-validation/{home,home-second}/Library/Application Support/Pi Agent Desktop Memory Test/packaged-startup-check.json` reports and logs. Current fixed bundle tree **d6e44503031df14edf06240818274813dd52ea47cdc4840d05870d0b79995e8b**.

**Still awaiting normal exit of old app, then overwrite command.** An updated prepared source is not an actual reinstall. Do not delete the durable backup or claim provider/semantic completion from these startup results.
