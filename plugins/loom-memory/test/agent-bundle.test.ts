import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { CompactEncrypt, importJWK, SignJWT, jwtVerify } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it("runs the shipped hook command and stdio MCP bundle against a real HTTP batch receiver", async () => {
	const dir = mkdtempSync(join(tmpdir(), "loom-bundle-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const received: Array<{ path: string; body: any; authorization: string | undefined }> = [];
	const http = createServer(async (req, res) => {
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		received.push({ path: req.url!, body, authorization: req.headers.authorization });
		res.setHeader("content-type", "application/json");
		if (req.url === "/retrieve") res.end(JSON.stringify({ candidate_lines: ['<knowledge id="7">Remember the prior outage</knowledge>'], candidates: [{ ref: "kn:7", label: "outage" }] }));
		else if (req.url === "/ingest/episodes/batch") res.end(JSON.stringify({ results: body.episodes.map((ep: any, i: number) => ({ idempotency_key: ep.idempotency_key, episode_id: i + 1 })), inserted: body.episodes.length, skipped: 0 }));
		else res.end(JSON.stringify({ ok: true }));
	});
	await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
	cleanup.push(() => new Promise<void>((done) => http.close(() => done())));
	const address = http.address() as { port: number };
	const bundle = join(dir, "plugin");
	await promisify(execFile)(process.execPath, [resolve("scripts/build-memory-plugin.mjs"), bundle]);
	writeFileSync(join(bundle, "package.json"), '{"type":"module"}');
	const home = join(dir, "home"); mkdirSync(home);
	writeFileSync(join(home, "config.json"), JSON.stringify({ token: "fixture-token", url: `http://127.0.0.1:${address.port}`, flushMs: 1000 }));
	const transcript = join(dir, "session.jsonl");
	const raw = '{"type":"user","uuid":"event-1","message":{"role":"user","content":"all of this experience"}}';
	writeFileSync(transcript, raw + "\n");
	const hooks = JSON.parse(readFileSync(resolve("plugins/loom-memory/hooks/hooks.json"), "utf8"));
	const hookCommand = hooks.hooks.UserPromptSubmit[0].hooks[0].command as string;
	expect(hookCommand).toBe('node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hook');
	const env = { PATH: process.env.PATH!, LOOM_MEMORY_HOME: home };
	const invalid = spawn(process.execPath, [join(bundle, "dist/cli.js"), "configure"], { env, stdio: ["pipe", "pipe", "pipe"] });
	const invalidOutput: Buffer[] = [];
	invalid.stdout.on("data", (chunk) => invalidOutput.push(chunk)); invalid.stderr.on("data", (chunk) => invalidOutput.push(chunk));
	invalid.stdin.end("SECRET_CONFIG_CANARY");
	expect(await new Promise<number | null>((done) => invalid.on("exit", done))).toBe(1);
	expect(Buffer.concat(invalidOutput).toString()).not.toContain("SECRET_CONFIG_CANARY");
	const hook = spawn(process.execPath, [join(bundle, "dist/cli.js"), "hook"], { env, stdio: ["pipe", "pipe", "pipe"] });
	const output: Buffer[] = []; const errors: Buffer[] = [];
	hook.stdout.on("data", (chunk) => output.push(chunk)); hook.stderr.on("data", (chunk) => errors.push(chunk));
	hook.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "test-session", transcript_path: transcript, prompt: "What happened before?" }));
	const exit = await new Promise<number | null>((done) => hook.on("exit", done));
	expect(exit, Buffer.concat(errors).toString()).toBe(0);
	expect(JSON.parse(Buffer.concat(output).toString()).hookSpecificOutput.additionalContext).toContain("kn:7");
	const mcpConfig = JSON.parse(readFileSync(resolve("plugins/loom-memory/.mcp.json"), "utf8"));
	const args = (mcpConfig.mcpServers["loom-memory"].args as string[]).map((arg) => arg.replace("${CLAUDE_PLUGIN_ROOT}", bundle));
	const client = new Client({ name: "bundle-fixture", version: "1" });
	const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: "pipe" });
	await client.connect(transport); cleanup.push(() => client.close());
	expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("report_memory_use");
	await expect.poll(() => received.filter((request) => request.path === "/ingest/episodes/batch").length, { timeout: 5000 }).toBe(1);
	const batch = received.find((request) => request.path === "/ingest/episodes/batch")!;
	expect(batch.authorization).toBe("Bearer fixture-token");
	expect(batch.body.episodes[0].content).toBe(raw);
	const status = await client.callTool({ name: "memory_status", arguments: {} });
	expect(JSON.stringify(status)).not.toContain("fixture-token");
}, 15_000);


it("connects a fresh installed bundle once and keeps capture/recall/feedback after restarting", async () => {
 const dir = mkdtempSync(join(tmpdir(), "loom-login-bundle-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
 const home = join(dir,"home"); mkdirSync(home);
 const userId = "11111111-1111-4111-8111-111111111111";
 const secret = new TextEncoder().encode("local-issuer-fixture");
 const token = await new SignJWT({scope:"memory:read memory:write"}).setProtectedHeader({alg:"HS256"})
  .setSubject(userId).setAudience("mcp").setIssuedAt().setExpirationTime("1h").sign(secret);
 const received: Array<{path:string; body:any}> = [];
 const http = createServer(async (req,res) => {
  try {
   await jwtVerify((req.headers.authorization ?? "").slice(7),secret,{audience:"mcp"});
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
   const body = JSON.parse(Buffer.concat(chunks).toString());received.push({path:req.url!,body});
   res.setHeader("content-type","application/json");
   if(req.url==="/mcp")res.end(JSON.stringify({jsonrpc:"2.0",id:body.id,result:{content:[{type:"text",text:JSON.stringify({graphs:[{kind:"personal",id:userId}]})}]}}));
   else if(req.url==="/retrieve")res.end(JSON.stringify({candidate_lines:['<knowledge id="7">prior lesson</knowledge>'],candidates:[{ref:"kn:7"}]}));
   else if(req.url==="/ingest/episodes/batch")res.end(JSON.stringify({results:body.episodes.map((ep:any)=>({idempotency_key:ep.idempotency_key}))}));
   else res.end(JSON.stringify({ok:true}));
  }catch{res.statusCode=401;res.end('{}');}
 });
 await new Promise<void>(done=>http.listen(0,"127.0.0.1",done));
 cleanup.push(()=>new Promise<void>(done=>http.close(()=>done())));
 const url=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
 const bundle=join(dir,"plugin");
 await promisify(execFile)(process.execPath,[resolve("scripts/build-memory-plugin.mjs"),bundle]);
 writeFileSync(join(bundle,"package.json"),'{"type":"module"}');
 const env={PATH:process.env.PATH!,LOOM_MEMORY_HOME:home,LOOM_MEMORY_API_URL:url};
 const openClient=async()=>{
  const client=new Client({name:"fresh-host",version:"1"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(bundle,"dist/cli.js"),"mcp"],env,stderr:"pipe"}));
  cleanup.push(()=>client.close());return client;
 };
 const hook=async(input:unknown)=>{
  const child=spawn(process.execPath,[join(bundle,"dist/cli.js"),"hook"],{env,stdio:["pipe","pipe","pipe"]});
  const output:Buffer[]=[];child.stdout.on("data",chunk=>output.push(chunk));child.stderr.resume();child.stdin.end(JSON.stringify(input));
  expect(await new Promise(done=>child.on("exit",done))).toBe(0);
  return JSON.parse(Buffer.concat(output).toString());
 };
 const client=await openClient();
 for(const event of ["PreToolUse","PostToolUse","Stop","PreCompact"])expect(await hook({hook_event_name:event,session_id:"fresh"})).toEqual({});
 const initial=await client.callTool({name:"memory_status",arguments:{}});
 const status=JSON.parse((initial.content as any)[0].text);expect(status.connection).toBe("authentication_required");
 const encrypted=await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({nonce:status.request.nonce,user_id:userId,expires_at:Date.now()+120000,
  access_token:token,refresh_token:"fixture-refresh",expires_in:3600,scope:"memory:read memory:write"})))
  .setProtectedHeader({alg:"ECDH-ES",enc:"A256GCM"}).encrypt(await importJWK(status.request.public_key,"ECDH-ES"));
 const completed=await client.callTool({name:"complete_connection",arguments:{encrypted}});expect(completed.isError).toBeUndefined();
 expect(JSON.stringify(completed)).not.toContain(token);
 const transcript=join(dir,"session.jsonl");writeFileSync(transcript,JSON.stringify({type:"user",message:{role:"user",content:"complete first experience"}})+"\n");
 const input={hook_event_name:"UserPromptSubmit",session_id:"fresh",transcript_path:transcript,prompt:"What was the prior lesson?"};
 const recalled=await hook(input);expect(recalled.systemMessage).toBeUndefined();
 const receipt=recalled.hookSpecificOutput.additionalContext.match(/Receipt: ([\w-]+)/)[1];
 expect((await client.callTool({name:"report_memory_use",arguments:{receipt,picked:["kn:7"]}})).isError).toBeUndefined();
 await hook({...input,hook_event_name:"Stop"});
 await expect.poll(()=>received.filter(x=>x.path==="/ingest/picks").length,{timeout:5000}).toBe(1);
 expect(received.find(x=>x.path==="/ingest/episodes/batch")!.body.episodes[0].content).toContain("complete first experience");
 await client.close();
 const restarted=await openClient();
 const result=await restarted.callTool({name:"memory_status",arguments:{}});
 expect(JSON.parse((result.content as any)[0].text)).toMatchObject({connection:"connected",account:userId,queue:{events:0}});
},20000);
