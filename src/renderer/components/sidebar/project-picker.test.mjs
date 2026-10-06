import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement, useState } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { ProjectPicker, api, history } = await importTestBundle("project-picker", {
  stdin: {
    contents:
      'export {ProjectPicker} from "./ProjectPicker.tsx"; export * as api from "@/lib/api-client"; export * as history from "@/lib/project-history";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "project-picker-fixture",
      setup(build) {
        build.onResolve({ filter: /^@\/(i18n|lib\/api-client)$/ }, ({ path }) => ({ path, namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "@/i18n"
              ? `export function useI18n() { return {t: (_key,fallback)=>fallback}; }`
              : `export const requests=[], callbacks=[]; export let labels=[]; export let failure=false;
         export function reset(next,fail=false) { labels=next;failure=fail;requests.length=callbacks.length=0; }
         export async function call(method) { requests.push(method);if(failure)throw new Error('Old Host');throw new Error('Unexpected RPC: '+method); }
         export async function subscribe(topic,key,on) {const entry={topic,key,on,closed:0};callbacks.push(entry);return()=>entry.closed++;}`,
        }));
      },
    },
  ],
});
const rolePath = "/home/user/Library/Application Support/Pi Agent Desktop/teams/workspaces/instance-1234-abcd";
const sessions = [rolePath, "/home/user/work/project"].map((cwd, id) => ({
  id: String(id),
  cwd,
  projectRoot: cwd,
  modified: `2026-10-0${6 - id}`,
}));
const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
async function fixture(t, fail = false) {
  const descriptors = new Map(
    ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const storage = new Map();
  globalThis.window = {
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  api.reset([{ workspace: rolePath, taskTitle: "Pi improvements", role: "Backend", retained: 0 }], fail);
  let renderer, selected;
  function Probe() {
    const [cwd, setCwd] = useState(rolePath);
    selected = cwd;
    return createElement(ProjectPicker, {
      selectedCwd: cwd,
      selectedProject: cwd,
      homeDir: "/home/user",
      allSessions: sessions,
      restoringInitialSession: false,
      setSelectedCwd: setCwd,
    });
  }
  const mount = async () => {
    await act(async () => {
      renderer = create(createElement(Probe));
    });
    return renderer;
  };
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  await mount();
  t.after(async () => {
    await unmount();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    get renderer() {
      return renderer;
    },
    get selected() {
      return selected;
    },
    storage,
    mount,
    unmount,
  };
}
const text = (node) => (typeof node === "string" ? node : (node.children ?? []).map(text).join(""));
const open = async (f) => {
  await act(async () => f.renderer.root.findAllByType("button")[0].props.onClick());
};
const remove = (f) =>
  f.renderer.root
    .findAllByType("button")
    .filter((button) => button.props["aria-label"]?.startsWith("Remove from list"));
test("project removal persists across remount without deleting data and can be restored", async (t) => {
  const f = await fixture(t);
  await open(f);
  assert.equal(api.requests.length, 0);
  assert.equal(remove(f).length, 2);
  await act(async () => remove(f)[0].props.onClick());
  assert.equal(f.selected, "/home/user/work/project");
  assert.equal(remove(f).length, 1);
  assert.ok(history.readHiddenProjects().has(rolePath));
  assert.deepEqual(
    sessions.map((s) => s.cwd),
    [rolePath, "/home/user/work/project"],
  );
  await f.unmount();
  await f.mount();
  await open(f);
  assert.equal(remove(f).length, 1);
  const restore = f.renderer.root.findAllByType("button").find((b) => text(b).startsWith("Restore removed projects"));
  await act(async () => restore.props.onClick());
  assert.equal(remove(f).length, 2);
  assert.equal(history.readHiddenProjects().size, 0);
  await f.unmount();
});
test("old Host and malformed storage still allow readable fallback and removal", async (t) => {
  const f = await fixture(t, true);
  await open(f);
  assert.equal(api.requests.length, 0);
  await act(async () => remove(f)[0].props.onClick());
  assert.ok(history.readHiddenProjects().has(rolePath));
  f.storage.set("pi-desktop:hidden-projects", "{bad");
  assert.equal(history.readHiddenProjects().size, 0);
});

test("storage failure leaves project selection and list intact", async (t) => {
  const f = await fixture(t);
  await open(f);
  globalThis.window.localStorage.setItem = () => {
    throw new Error("Storage unavailable");
  };
  await act(async () => remove(f)[0].props.onClick());
  assert.equal(f.selected, rolePath);
  assert.equal(remove(f).length, 2);
  assert.match(text(f.renderer.toJSON()), /Storage unavailable/);
});
