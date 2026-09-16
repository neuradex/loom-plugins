// Exercise an installed, standalone bundle without repository dependencies or credentials.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const plugin = resolve(process.argv[2] ?? 'plugins/loom-memory');
const home = await mkdtemp(join(tmpdir(), 'loom-installed-smoke-'));
let child;
try {
  await writeFile(join(home, 'config.json'), JSON.stringify({token:'synthetic-smoke-token',url:'http://127.0.0.1:1',capture:false,recall:false}), {mode:0o600});
  child = spawn(process.execPath, [join(plugin,'dist/cli.js'),'mcp'], {
    cwd:home, env:{PATH:process.env.PATH,LOOM_MEMORY_HOME:home}, stdio:['pipe','pipe','pipe'],
  });
  const pending = new Map();
  const lines = createInterface({input:child.stdout});
  lines.on('line',line=>{
    try {const message=JSON.parse(line);const p=pending.get(message.id);if(p){pending.delete(message.id);p.resolve(message);}} catch {}
  });
  const call = async (id,method,params) => {
    const promise = new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
    const timer=setTimeout(()=>pending.get(id)?.reject(new Error(`Timed out: ${method}`)),10000);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    try {const response=await promise;assert(!response.error,JSON.stringify(response.error));return response.result;}
    finally {clearTimeout(timer);pending.delete(id);}
  };
  await call(1,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'distribution-smoke',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await call(2,'tools/list',{});
  assert.deepEqual(tools.tools.map(x=>x.name).sort(),['memory_read','memory_search','memory_status','remember','report_memory_use']);
  const result=await call(3,'tools/call',{name:'memory_status',arguments:{}});
  assert(!result.isError);assert.equal(JSON.parse(result.content[0].text).queue.events,0);
  assert(!JSON.stringify(result).includes('synthetic-smoke-token'));
  console.log('Installed bundle: MCP initialize, five tools, and memory_status passed without node_modules or external services.');
} finally {
  if(child && child.exitCode===null){
    const exited=new Promise(done=>child.once('exit',done));child.kill('SIGTERM');
    const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await exited;clearTimeout(timer);
  }
  await rm(home,{recursive:true,force:true});
}
