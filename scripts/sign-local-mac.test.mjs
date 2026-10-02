import test from "node:test";
import assert from "node:assert/strict";
import { localSigningArgs } from "./sign-local-mac.mjs";

test("local ad-hoc signing explicitly clears hardened-runtime flags", () => {
  const args = localSigningArgs("/private/test/Staged.app", "/private/test/entitlements.plist");
  assert.deepEqual(args.slice(0, 7), ["--force", "--deep", "--sign", "-", "--options", "0", "--entitlements"]);
  assert.equal(args.includes("runtime"), false);
  assert.equal(args.at(-1), "/private/test/Staged.app");
});

test("local signer refuses directly re-signing installed production", () => {
  assert.throws(() => localSigningArgs("/Applications/Pi Agent Desktop.app", "/tmp/e.plist"), /never the installed/);
});

test("local signer requires an app bundle target", () => {
  assert.throws(() => localSigningArgs("/private/test/Contents/MacOS/Pi", "/tmp/e.plist"), /staged local .app/);
});
