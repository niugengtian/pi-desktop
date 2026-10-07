#!/usr/bin/env node
// Shipped Host RPC + restart test. Uses isolated fictional credentials, never a real account or remote request.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertSuccessfulSpawn } from "./process-utils.mjs";
const app = process.argv[2];
if (!app || process.platform !== "darwin") throw new Error("Usage: test-packaged-accounts.mjs <app>");
const directory = mkdtempSync(path.join(tmpdir(), "pi-packaged-accounts-"));
const executable = path.join(path.resolve(app), "Contents/MacOS/Pi Agent Desktop");
const host = path.join(path.resolve(app), "Contents/Resources/app.asar/out/main/agent-host.mjs");
const driver = path.join(directory, "driver.mjs");
try {
  writeFileSync(
    driver,
    `import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
const port=new EventEmitter();process.parentPort=port;
const renderer=new EventEmitter();renderer.start=()=>{};
const pending=new Map();let counter=0;
renderer.postMessage=message=>{if(message.kind!=='response')return;const request=pending.get(message.id);if(!request)return;pending.delete(message.id);message.ok?request.resolve(message.result):request.reject(new Error('RPC failed: '+request.method));};
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id='accounts-'+(++counter);pending.set(id,{resolve,reject,method});renderer.emit('message',{data:{kind:'request',id,method,params}});});
let markReady;const ready=new Promise(resolve=>markReady=resolve);
port.postMessage=message=>{if(message.type==='ready'){port.emit('message',{data:{type:'attach-port'},ports:[renderer]});markReady();}};
await import(pathToFileURL(${JSON.stringify(host)}).href);await ready;
try {
 if(process.argv[2]==='create') {
  for(const kind of ['codex','anthropic-api'])for(const name of ['A','B'])await rpc('accounts.add',{kind,name});
  const {accounts}=await rpc('accounts.list');if(accounts.length!==4)throw new Error('Missing accounts');
  for(const kind of ['codex','anthropic-api']) {
   const rows=accounts.filter(a=>a.kind===kind);if(!rows[0].isDefault||rows[1].isDefault)throw new Error('Initial default mismatch');
   await rpc('accounts.update',{id:rows[1].id,action:'default'});
   await rpc('accounts.update',{id:rows[0].id,action:'rename',name:'Renamed A'});
   if(kind==='anthropic-api')for(const row of rows)await rpc('auth.setApiKey',{provider:row.provider,key:'fictional-'+row.name+'-key'});
  }
  console.log('PACKAGED_ACCOUNTS_CREATE_DEFAULT_RENAME_OK');
 } else {
  const {accounts}=await rpc('accounts.list');if(accounts.length!==4)throw new Error('Restart lost accounts');
  for(const kind of ['codex','anthropic-api']) {
   const rows=accounts.filter(a=>a.kind===kind);if(rows.find(a=>a.isDefault)?.name!=='B'||!rows.some(a=>a.name==='Renamed A'))throw new Error('Restart lost default/name');
   if(kind==='anthropic-api'&&!rows.every(a=>a.loggedIn))throw new Error('Restart lost credentials');
  }
  const {models}=await rpc('models.list',{cwd:${JSON.stringify(directory)}});
  const api=accounts.filter(a=>a.kind==='anthropic-api');for(const row of api)if(!models.some(m=>m.provider===row.provider))throw new Error('Account provider unavailable');
  const removed=api.find(a=>a.name==='Renamed A');await rpc('accounts.update',{id:removed.id,action:'remove'});
  if((await rpc('accounts.list')).accounts.some(a=>a.id===removed.id))throw new Error('Removed account is still listed');
  if((await rpc('models.list',{cwd:${JSON.stringify(directory)}})).models.some(m=>m.provider===removed.provider))throw new Error('Removed account is still available');
  console.log('PACKAGED_ACCOUNTS_RESTART_CREDENTIALS_PROVIDERS_REMOVE_OK');
 }
} finally {port.emit('message',{data:{type:'shutdown'}});}
`,
  );
  for (const phase of ["create", "restart"]) {
    const result = spawnSync(executable, [driver, phase], {
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PI_CODING_AGENT_DIR: path.join(directory, "agent"),
        PI_CODING_AGENT_SESSION_DIR: path.join(directory, "sessions"),
        PI_DESKTOP_USER_DATA: path.join(directory, "desktop"),
        PI_OFFLINE: "1",
        NODE_OPTIONS: "",
        NODE_PATH: "",
      },
      encoding: "utf8",
      timeout: 30000,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assertSuccessfulSpawn(result, `Packaged accounts ${phase}`);
    if (
      !result.stdout.includes(
        phase === "create"
          ? "PACKAGED_ACCOUNTS_CREATE_DEFAULT_RENAME_OK"
          : "PACKAGED_ACCOUNTS_RESTART_CREDENTIALS_PROVIDERS_REMOVE_OK",
      )
    )
      throw new Error("Missing account test receipt");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
