// Opt-in QA for the installed, isolated Tier Compare app ONLY. Never confirms a Flash source.
// Requires the app running with loopback CDP 9227 and its pre-existing fictional fixture.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const fixtureRoot = process.argv[2];
if (!fixtureRoot || !resolve(fixtureRoot).endsWith("/Pi Agent Desktop Tier Compare"))
  throw new Error("Pass the existing isolated Tier Compare data root; never a real session directory");
const evidence = join(fixtureRoot, "validation-ui");
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const wirePath = join(fixtureRoot, "main-wire.jsonl");
const flashPath = join(fixtureRoot, "flash-audit.jsonl");
const fingerprint = (path) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
const before = { main: fingerprint(wirePath), flash: fingerprint(flashPath) };
assert.ok(before.main, "Expected existing fictional main fixture wire log");
const models = JSON.parse(
  readFileSync(
    join(fixtureRoot, "home/Library/Application Support/Pi Agent Desktop Memory Test/agent/models.json"),
    "utf8",
  ),
);
assert.equal(models.providers["tier-compare-codex"].baseUrl, "http://127.0.0.1:37645");

const targets = await (await globalThis.fetch("http://127.0.0.1:9227/json/list")).json();
const target = targets.find((item) => item.type === "page" && item.url.startsWith("app://bundle/"));
assert.ok(target?.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:9227/"));
const socket = new globalThis.WebSocket(target.webSocketDebuggerUrl);
await new Promise((yes, no) => {
  socket.addEventListener("open", yes, { once: true });
  socket.addEventListener("error", no, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => {
  const reply = JSON.parse(data),
    item = pending.get(reply.id);
  if (!item) return;
  pending.delete(reply.id);
  clearTimeout(item.timer);
  if (reply.error) item.reject(new Error(reply.error.message));
  else item.resolve(reply.result);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expression) {
  const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails)
    throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
  return reply.result.value;
}
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((yes) => setTimeout(yes, 40));
  }
  throw new Error(`Timed out: ${label}`);
}
async function key(key, code, modifiers = 0) {
  const windowsVirtualKeyCode = key === "Escape" ? 27 : 9;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode });
}
async function pointerButton(label, dialog = false) {
  const coordinates = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll(${JSON.stringify(dialog ? "dialog button" : "button")})];
    const b = buttons.find(b => b.innerText === ${JSON.stringify(label)});
    if (!b || b.disabled) throw Error('Missing/disabled observed button');
    const r = b.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) throw Error('Button outside viewport');
    const x=r.x+r.width/2,y=r.y+r.height/2;
    if(!b.contains(document.elementFromPoint(x,y))) throw Error('Button occluded');
    return {x,y};
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...coordinates });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...coordinates });
}
async function command(text) {
  assert.ok(text.startsWith("/tiered-"), "Only known local commands, never arbitrary chat prompts");
  await until(() => evaluate(`[...document.querySelectorAll('button')].some(b=>b.innerText==='Send')`), "idle");
  await evaluate(
    `(()=>{const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await until(
    () => evaluate(`[...document.querySelectorAll('button')].some(b=>b.innerText==='Send'&&!b.disabled)`),
    "Send enabled",
  );
  assert.equal(await evaluate(`document.querySelector('textarea').value`), text);
  await pointerButton("Send");
}
const modal = (needle) =>
  until(() => evaluate(`document.querySelector('dialog')?.innerText.includes(${JSON.stringify(needle)})`), needle);
const dismissed = () => until(() => evaluate(`!document.querySelector('dialog')`), "dismissed");
async function geometry() {
  return evaluate(
    `(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect(),s=d.querySelector('.extension-dialog-content');return{viewport:{width:innerWidth,height:innerHeight},rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},tag:d.tagName,modal:d.matches(':modal'),focusInside:d.contains(document.activeElement),scroll:{client:s.clientHeight,total:s.scrollHeight,width:s.clientWidth,totalWidth:s.scrollWidth},buttons:[...d.querySelectorAll('button')].map(b=>({label:b.innerText,top:b.getBoundingClientRect().top,bottom:b.getBoundingClientRect().bottom}))}})()`,
  );
}
const results = [];
try {
  assert.equal(
    await evaluate(`Boolean(document.querySelector('dialog,[role="dialog"]'))`),
    false,
    "Do not take over a pending user confirmation",
  );
  assert.ok(await evaluate(`document.body.innerText.includes('Sol/Codex 协议回环（非真实Sol）')`));
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.startsWith('虚构三层验收：')).click()`);
  await until(() => evaluate(`document.body.innerText.includes('【虚构预置】')`), "fictional session");
  // Establish a known local-only state. Disabling preserves all native/generated files.
  await command("/tiered-budget-disable");
  await command("/tiered-workspace-disable");
  await command("/tiered-workspace-enable");
  await modal("Enable local tiered comparison?");
  assert.equal(await evaluate(`document.activeElement.innerText`), "Cancel");
  await pointerButton("Cancel", true);
  await dismissed();
  await command("/tiered-budget-enable");
  await modal("Enable experimental session budget?");
  await pointerButton("Confirm", true); // LOCAL budget ONLY. Never the source/review dialog.
  await dismissed();
  await command("/tiered-warm-flash");
  await until(() => evaluate(`document.body.innerText.includes('Flash warm selected, NOT authorized')`), "selection");
  await pointerButton("Compact");
  await modal("Approve this ONE incremental Flash payload?");
  const source = await evaluate(`document.querySelector('dialog').innerText`);
  assert.match(source, /api\.deepseek\.com/);
  assert.match(source, /松鼠船长/);
  for (const size of [
    { width: 980, height: 720 },
    { width: 720, height: 560 },
  ]) {
    await send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
    await until(async () => (await geometry()).viewport.height === size.height, "viewport resized");
    const g = await geometry();
    assert.equal(g.tag, "DIALOG");
    assert.equal(g.modal, true);
    assert.equal(g.focusInside, true);
    assert.ok(g.rect.top >= 0 && g.rect.bottom <= size.height && g.rect.left >= 0 && g.rect.right <= size.width);
    assert.ok(g.scroll.total > g.scroll.client);
    assert.ok(g.scroll.totalWidth <= g.scroll.width + 1);
    assert.ok(g.buttons.every((b) => b.top >= 0 && b.bottom <= size.height));
    results.push(g);
    // Scroll the complete source to its tail, without truncating DOM text or hiding footer controls.
    await evaluate(`document.querySelector('.extension-dialog-content').scrollTop=1e9`);
    assert.equal(await evaluate(`document.querySelector('dialog').innerText`), source);
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidence, `source-${size.width}x${size.height}.png`), Buffer.from(screenshot.data, "base64"));
  }
  const composer = await evaluate(`document.querySelector('textarea').value`);
  await evaluate(`document.querySelector('textarea').focus()`);
  assert.equal(
    await evaluate(`document.querySelector('dialog').contains(document.activeElement)`),
    true,
    "Inert background must reject focus",
  );
  await send("Input.insertText", { text: "¥" });
  assert.equal(await evaluate(`document.querySelector('textarea').value`), composer, "No yen/input leak into chat");
  for (let i = 0; i < 10; i++) {
    await key("Tab", "Tab", i % 2 ? 8 : 0);
    assert.equal(await evaluate(`document.querySelector('dialog').contains(document.activeElement)`), true);
  }
  await key("Escape", "Escape");
  await dismissed();
  // Restore the app viewport before interacting with its fixed-width composer.
  await send("Emulation.clearDeviceMetricsOverride");
  await until(
    () => evaluate(`[...document.querySelectorAll('button')].some(b=>b.innerText==='Send')`),
    "cancel settled",
  );
  // Manual retry is explicit, opens a new review, and still sends nothing before confirmation.
  await pointerButton("Compact");
  await modal("Approve this ONE incremental Flash payload?");
  assert.equal(await evaluate(`document.activeElement.innerText`), "Cancel", "Never autofocus remote Confirm");
  await pointerButton("Cancel", true);
  await dismissed();
  await command("/tiered-budget-disable");
  assert.deepEqual(
    { main: fingerprint(wirePath), flash: fingerprint(flashPath) },
    before,
    "No model request during dialog QA",
  );
  const proof = {
    ok: true,
    results,
    sourceTextHash: createHash("sha256").update(source).digest("hex"),
    pointerCancel: true,
    escapeCancel: true,
    focusContained: true,
    noComposerLeak: true,
    modelAuditUnchanged: true,
    realFlashRequest: false,
    semanticReview: "not-performed",
  };
  writeFileSync(join(evidence, "after.json"), JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(proof));
} finally {
  await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  socket.close();
}
