#!/usr/bin/env node
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertSuccessfulSpawn } from "./process-utils.mjs";

const app = process.argv[2];
const required = process.argv.includes("--require-tmux");
if (process.platform !== "darwin" || !app) throw new Error("Usage: test-packaged-terminal.mjs <app> [--require-tmux]");
const directory = mkdtempSync(path.join(tmpdir(), "pi-packaged-terminal-"));
const sessionId = `terminal-validation-${process.pid}-${Date.now()}`;
const archive = path.join(path.resolve(app), "Contents/Resources/app.asar");
const executable = path.join(path.resolve(app), "Contents/MacOS/Pi Agent Desktop");
const driver = path.join(directory, "driver.cjs");
try {
  writeFileSync(
    driver,
    String.raw`
const {EventEmitter}=require('node:events');
const {pathToFileURL}=require('node:url');
(async()=>{
 const pty=require(${JSON.stringify(path.join(archive, "node_modules/node-pty"))});
 await new Promise((resolve,reject)=>{
  const child=pty.spawn('/bin/sh',['-c','printf PI_PACKAGED_PTY_OK'],{cwd:${JSON.stringify(directory)},name:'xterm-256color',cols:80,rows:24,env:{PATH:'/usr/bin:/bin',TERM:'xterm-256color',LANG:'en_US.UTF-8'}});
  let output='';child.onData(data=>output+=data);
  child.onExit(({exitCode})=>exitCode===0&&output==='PI_PACKAGED_PTY_OK'?resolve():reject(new Error('PTY output/exit mismatch')));
 });
 console.log('PACKAGED_PTY_SPAWN_OK');
 const port=new EventEmitter();process.parentPort=port;
 const renderer=new EventEmitter();renderer.start=()=>{};
 const pending=new Map();let counter=0;
 renderer.postMessage=message=>{
  if(message.kind!=='response')return;
  const handler=pending.get(message.id);if(!handler)return;pending.delete(message.id);
  message.ok?handler.resolve(message.result):handler.reject(new Error(JSON.stringify(message.error)));
 };
 const rpc=(method,params)=>new Promise((resolve,reject)=>{
  const id='terminal-'+(++counter);pending.set(id,{resolve,reject});
  renderer.emit('message',{data:{kind:'request',id,method,params}});
 });
 let markReady;const ready=new Promise(resolve=>markReady=resolve);
 port.postMessage=message=>{if(message.type==='ready'){port.emit('message',{data:{type:'attach-port'},ports:[renderer]});markReady();}};
 await import(pathToFileURL(${JSON.stringify(path.join(archive, "out/main/agent-host.mjs"))}).href);await ready;
 const id=${JSON.stringify(sessionId)};let created=false;
 try{
  const probe=await rpc('sharedTerminal.probe',{refresh:true});
  if(!probe.supported){if(${required})throw new Error('tmux required: '+JSON.stringify(probe));console.log('PACKAGED_SHARED_TERMINAL_SKIP tmux unavailable');return;}
  await rpc('system.allowRoot',{path:${JSON.stringify(directory)}});
  const attached=await rpc('sharedTerminal.attach',{sessionId:id,cwd:${JSON.stringify(directory)},cols:80,rows:24});created=true;
  if(!attached.attached)throw new Error('tmux attach failed');
  await rpc('sharedTerminal.write',{sessionId:id,data:"printf 'PI_SHARED_TERMINAL_OK\\n'\r"});
  let captured='';
  for(let i=0;i<30;i++){
   captured=(await rpc('sharedTerminal.capture',{sessionId:id,lines:30})).text;
   if(captured.split(/\r?\n/).some(line=>line.trim()==='PI_SHARED_TERMINAL_OK'))break;
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(!captured.split(/\r?\n/).some(line=>line.trim()==='PI_SHARED_TERMINAL_OK'))throw new Error('tmux did not execute PTY input');
  await rpc('sharedTerminal.detach',{sessionId:id});
  const detached=await rpc('sharedTerminal.status',{sessionId:id});if(detached.attached||!detached.exists)throw new Error('tmux detach lost session');
  const reattached=await rpc('sharedTerminal.attach',{sessionId:id,cwd:${JSON.stringify(directory)},cols:100,rows:30});
  if(!reattached.attached||reattached.name!==attached.name)throw new Error('tmux reattach failed');
  const retained=(await rpc('sharedTerminal.capture',{sessionId:id,lines:30})).text;
  if(!retained.includes('PI_SHARED_TERMINAL_OK'))throw new Error('tmux history lost');
  console.log('PACKAGED_SHARED_TERMINAL_ATTACH_WRITE_CAPTURE_REATTACH_OK');
 }finally{
  if(created)await rpc('sharedTerminal.close',{sessionId:id});
  port.emit('message',{data:{type:'shutdown'}});
 }
})().catch(error=>{console.error(error.stack);process.exit(1)});
`,
  );
  const result = spawnSync(executable, [driver], {
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
    timeout: 30_000,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assertSuccessfulSpawn(result, "Packaged terminal integration");
  if (!result.stdout.includes("PACKAGED_PTY_SPAWN_OK")) throw new Error("Missing PTY spawn receipt");
  if (required && !result.stdout.includes("PACKAGED_SHARED_TERMINAL_ATTACH_WRITE_CAPTURE_REATTACH_OK"))
    throw new Error("Missing shared terminal receipt");
} finally {
  for (const tmux of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    spawnSync(tmux, ["kill-session", "-t", `pi-${sessionId}`], { timeout: 5_000 });
  }
  rmSync(directory, { recursive: true, force: true });
}
