#!/usr/bin/env node
// Local arm64 ad-hoc builds only. Not a Developer-ID/notarized release signer.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function localSigningArgs(appPath, entitlementsPath) {
  const app = path.resolve(appPath);
  if (!app.endsWith(".app") || app === "/Applications/Pi Agent Desktop.app") {
    throw new Error("Sign a staged local .app, never the installed production app");
  }
  // Ad-hoc main code has no Team ID. Do not enable hardened library validation
  // against the vendor-signed Electron framework; explicit zero clears runtime.
  return ["--force", "--deep", "--sign", "-", "--options", "0", "--entitlements", entitlementsPath, app];
}

export function signLocalMac(appPath) {
  if (process.platform !== "darwin") throw new Error("macOS local signer only");
  const app = path.resolve(appPath);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = localSigningArgs(app, path.join(root, "build", "entitlements.mac.plist"));
  if (fs.lstatSync(app).isSymbolicLink()) throw new Error("Refusing symlink bundle");
  fs.accessSync(path.join(app, "Contents", "Resources", "app.asar"));
  const identity = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  if (identity.status !== 0 || !identity.stderr.includes("Signature=adhoc")) {
    throw new Error("Refuse downgrading a non-ad-hoc release signature");
  }
  execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const signed = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  const flags = signed.stderr.match(/flags=0x([a-f0-9]+)/i);
  if (signed.status !== 0 || !flags || (Number.parseInt(flags[1], 16) & 0x10000) !== 0) {
    throw new Error("Local ad-hoc signature must not retain hardened-runtime flags");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/sign-local-mac.mjs <staged.app>");
  signLocalMac(process.argv[2]);
}
