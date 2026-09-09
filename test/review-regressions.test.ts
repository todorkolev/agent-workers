import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Writable } from "node:stream";
import { once } from "node:events";
import { after, it } from "node:test";
import { pathToFileURL } from "node:url";
import { ensureDirs, privateDir, workerPaths, writeJsonAtomic, appendLine, appendText, acquireWriteLock } from "../src/core/store.ts";
import { ensureWorktree, resolveCommit, summarizeWork } from "../src/core/git.ts";
import { terminateChild } from "../src/core/process.ts";
import { CodexAppServerAdapter } from "../src/providers/codex/adapter.ts";
import { Supervisor } from "../src/supervisor/supervisor.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-review-"));
const previousHome = process.env.AGENT_WORKERS_HOME;
process.env.AGENT_WORKERS_HOME = path.join(tmp, "state");
after(() => {
  if (previousHome === undefined) delete process.env.AGENT_WORKERS_HOME; else process.env.AGENT_WORKERS_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

it("keeps persisted profiles, journals and existing state private under umask 022", async () => {
  const old = process.umask(0o022);
  try {
    await ensureDirs("privacy");
    const p = workerPaths("privacy");
    await writeJsonAtomic(path.join(p.dir, "spec.json"), { env: { TOKEN: "fixture-secret" } });
    appendLine(p.journal, { seq: 1, text: "private prompt" });
    appendText(p.providerLog, "private output");
    fs.chmodSync(p.dir, 0o755);
    fs.chmodSync(p.journal, 0o644);
    await ensureDirs("privacy");
    assert.equal(fs.statSync(p.dir).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(p.dir)) assert.equal(fs.statSync(path.join(p.dir, name)).mode & 0o777, 0o600, name);
    const linked = path.join(tmp, "linked");
    fs.symlinkSync(p.dir, linked);
    await assert.rejects(privateDir(linked), /symlink/);
  } finally { process.umask(old); }
});

it("atomically excludes parent, child and symlink write claims across processes", async () => {
  const repo = path.join(tmp, "overlap"); fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const link = path.join(tmp, "alias"); fs.symlinkSync(repo, link);
  const moduleUrl = pathToFileURL(path.resolve("src/core/store.ts")).href;
  const code = 'import {acquireWriteLock} from '+JSON.stringify(moduleUrl)+'; const r=await acquireWriteLock(process.argv[1],process.argv[2]); console.log(JSON.stringify({won:"lock" in r})); if("lock" in r) { await new Promise(r=>setTimeout(r,700)); await r.lock.release(); }';
  const run = promisify(execFile);
  const results = await Promise.all([repo, path.join(repo,"src"), link].map((dir,i) => run(process.execPath, ["--input-type=module", "-e", code, dir, "race-"+i])));
  assert.equal(results.filter(r => JSON.parse(r.stdout).won).length, 1);
  const claim = await acquireWriteLock(repo, "after-exit");
  assert.ok("lock" in claim);
  if ("lock" in claim) await claim.lock.release();
});

it("does not attribute existing or adopted commits without an observed starting HEAD", async () => {
  const repo = path.join(tmp, "git"); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, {cwd:repo, stdio:"pipe"}).toString().trim();
  git("init"); git("config","user.name","Test"); git("config","user.email","test@example.invalid");
  fs.writeFileSync(path.join(repo,"file"),"base"); git("add","file"); git("commit","-m","base");
  const base = await resolveCommit(repo,"HEAD");
  assert.equal((await summarizeWork(repo, undefined)).commit, undefined);
  assert.equal((await summarizeWork(repo, base)).commit, undefined);
  const dir=path.join(tmp,"adopt");
  await ensureWorktree({repo,workerId:"adopt",dir});
  execFileSync("git", ["-C",dir,"commit","--allow-empty","-m","pre-existing"]);
  const adopted = await ensureWorktree({repo,workerId:"adopt-2",dir});
  const startingHead=await resolveCommit(dir,"HEAD");
  assert.notEqual(startingHead, adopted.base);
  assert.equal((await summarizeWork(dir, startingHead)).commit, undefined);
  fs.writeFileSync(path.join(dir,"file"),"changed");
  assert.deepEqual((await summarizeWork(dir, startingHead)).changedFiles, ["file"]);
  fs.writeFileSync(path.join(dir,"file"),"base");
  assert.deepEqual((await summarizeWork(dir, startingHead)).changedFiles, []);
});

function supervisor(id: string): any {
  return new Supervisor({workerId:id,provider:"codex",task:"fixture",cwd:tmp,targetCwd:tmp,writeAccess:false,
    transcriptMode:"activity",execProfile:"local",launcher:[],env:{},bin:"codex",
    owner:{host:"codex",clientId:"test",since:new Date().toISOString()},version:"test",approvalTimeoutMs:5000});
}

it("retains a failed response for retry and does not regress a completed turn to running", async () => {
  await ensureDirs("respond");
  const s=supervisor("respond"); s.record.state="blocked";
  s.record.pending=[{requestId:"q",kind:"question",text:"choose",ts:new Date().toISOString()}];
  s.adapter={respond:async()=>{throw new Error("pipe failed");}};
  assert.equal((await s.opRespond("q",{decision:"answer",text:"a"})).ok,false);
  assert.equal(s.record.pending.length,1);
  assert.equal(s.record.state,"blocked");
  assert.ok(s.approvalTimers.has("q"));
  s.adapter={respond:async()=>{s.record.state="idle";}};
  assert.equal((await s.opRespond("q",{decision:"answer",text:"a"})).ok,true);
  assert.equal(s.record.pending.length,0);
  assert.equal(s.record.state,"idle");
  assert.equal(s.approvalTimers.size,0);
});

it("routes distinct Codex question answers and preserves the request after a failed write", async () => {
  const a: any=new CodexAppServerAdapter();
  const events: any[]=[];a.onEvent((e:any)=>events.push(e));
  a.onServerRequest({id:42,method:"item/tool/requestUserInput",params:{questions:[
    {id:"colour",question:"Colour?",options:[{label:"Blue",description:"the blue option"}]},
    {id:"size",question:"Size?",options:[{label:"Large",description:"the large option"}]}]}});
  assert.match(events[0].text,/\[colour\].*Colour/);
  assert.match(events[0].text,/Blue: the blue option/);
  await assert.rejects(a.respond("codex-42",{decision:"answer",text:"same"}),/every question/);
  assert.ok(a.parked.has("codex-42"));
  const broken=new Writable({write(_c,_e,cb){cb(new Error("broken pipe"));}}); broken.on("error",()=>{});
  a.child={stdin:broken};
  await assert.rejects(a.respond("codex-42",{decision:"answer",answers:{colour:["Blue"],size:["Large"]}}),/broken pipe/);
  assert.ok(a.parked.has("codex-42"));
  let wire:any;
  a.child={stdin:new Writable({write(c,_e,cb){wire=JSON.parse(c.toString());cb();}})};
  await a.respond("codex-42",{decision:"answer",answers:{colour:["Blue"],size:["Large"]}});
  assert.deepEqual(wire.result.answers,{colour:{answers:["Blue"]},size:{answers:["Large"]}});
  assert.equal(a.parked.has("codex-42"),false);
});

it("does not confirm rejected or timed-out interrupts or clear the active turn", async () => {
  const a:any=new CodexAppServerAdapter(); a.threadId="thread";a._turnId="active";a.interruptTimeoutMs=20;
  a.request=async()=>{throw new Error("rejected");};
  await assert.rejects(a.interrupt(),/rejected/);assert.equal(a.turnId,"active");
  a.request=async()=>({});
  await assert.rejects(a.interrupt(),/not confirmed/);assert.equal(a.turnId,"active");
  a.request=async()=>{a.onNotification("turn/completed",{turn:{id:"active",status:"interrupted"}});return {};};
  await a.interrupt();assert.equal(a.turnId,undefined);
});

it("replaces stale result artifacts after tracked edits are reverted", async () => {
  const repo=path.join(tmp,"git");
  await ensureDirs("clean-result");
  const s=supervisor("clean-result");s.record.cwd=repo;s.record.writeAccess=true;s.record.startingHead=await resolveCommit(repo,"HEAD");
  s.touchedFiles.add("file");s.latestDiff="old patch";
  fs.writeFileSync(s.record.paths.diff,"old patch");fs.writeFileSync(s.record.paths.changedFiles,"file");
  await s.snapshotResult();
  const result=JSON.parse(fs.readFileSync(s.record.paths.result,"utf8"));
  assert.deepEqual(result.changedFiles,[]);
  assert.equal(result.commit,undefined);
  assert.equal(result.artifacts.diff,undefined);
  assert.equal(fs.existsSync(s.record.paths.diff),false);
  assert.equal(fs.existsSync(s.record.paths.changedFiles),false);
});

it("observes provider exit even when SIGTERM is ignored", async () => {
  const child=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'],{stdio:"pipe"});
  await once(child.stdout,"data");
  await terminateChild(child,20,1000);
  assert.equal(child.signalCode,"SIGKILL");
});



it("persists an idle takeover even when no new turn or state change occurs", async () => {
  await ensureDirs("takeover-idle");
  const s=supervisor("takeover-idle");s.record.state="idle";
  const next={host:"claude-code",clientId:"new-manager",since:new Date().toISOString()};
  const response=await s.handleControl({op:"resume",owner:next,takeover:true});
  assert.equal(response.ok,true);
  const saved=JSON.parse(fs.readFileSync(s.record.paths.record,"utf8"));
  assert.equal(saved.owner.clientId,"new-manager");
});

it("serializes timeout denial and a concurrent manager answer into one provider response", async () => {
  await ensureDirs("timeout-race");
  const s=supervisor("timeout-race");s.record.state="blocked";s.spec.approvalTimeoutMs=10;
  s.record.pending=[{requestId:"q",kind:"question",text:"choose",ts:new Date().toISOString()}];
  let release!:()=>void, entered!:()=>void, writes=0;
  const pending=new Promise<void>(r=>{release=r;});const began=new Promise<void>(r=>{entered=r;});
  s.adapter={respond:async()=>{writes++;entered();await pending;}};
  s.armApprovalTimer("q");
  // Keep the test event loop alive while the production timer is unref'ed.
  const keepAlive=setTimeout(()=>{},1000);
  await began;
  const reply=s.handleControl({op:"respond",requestId:"q",decision:{decision:"answer",text:"late"}});
  await new Promise(r=>setTimeout(r,10));
  assert.equal(writes,1);
  release();assert.equal((await reply).ok,false);
  assert.equal(s.record.pending.length,0);assert.equal(writes,1);
  clearTimeout(keepAlive);
});
