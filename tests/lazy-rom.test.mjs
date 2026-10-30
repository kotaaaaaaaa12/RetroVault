import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../assets/js/lazy-rom.js', import.meta.url), 'utf8');
class Worker {
  postMessage(message) {
    if (message.type === 'init') { this.shared = message.shared; queueMicrotask(() => this.onmessage({data:{ready:true}})); return; }
    const state = new Int32Array(this.shared,0,2); const bytes = new Uint8Array(this.shared,8);
    for(let i=0;i<message.end-message.start;i++) bytes[i]=(message.start+i)%256;
    Atomics.store(state,1,message.end-message.start); Atomics.store(state,0,2);
  }
  terminate() { this.terminated=true; }
}
const window={};
vm.runInNewContext(source,{window,Worker,SharedArrayBuffer,Atomics,performance,setTimeout,clearTimeout});
test('large file reads preserve high offsets, bound the cache and stop the worker',async()=>{
  const reader=new window.RetroLazyRom.LazyRom({size:4294967296,name:'test.3ds'});await reader.ready;
  assert.deepEqual([...reader.read(4294967040,256)],Array.from({length:256},(_,i)=>i));
  assert.equal(reader.read(4294967296,32).length,0);
  assert.deepEqual([...reader.read(1048574,4)],[254,255,0,1]);
  for(let i=0;i<20;i++)reader.read(i*1048576,128);
  assert.ok(reader.stats.cacheBytes<=8388608);assert.equal(reader.stats.largestRead,1048576);
  reader.stop();assert.equal(reader.stats.cacheBytes,0);assert.equal(reader.worker.terminated,true);
  assert.throws(()=>reader.read(0,1),/lazyRomReadError/);
});
test('unsupported runtimes are rejected before the normal download method changes',()=>{
  const emulator={ejs_version:'4.2.3',getCore(){return 'azahar';},download(){}};
  const original=emulator.download;
  assert.throws(()=>window.RetroLazyRom.install(emulator,{size:4294967296}),/lazyRomUnavailable/);
  assert.equal(emulator.download,original);
});

const workerSource = await readFile(new URL('../assets/js/rom-reader-worker.js', import.meta.url), 'utf8');
function workerEnvironment(fetch) {
  const messages = [];
  const self = { location: { href: 'https://retro.example/assets/js/rom-reader-worker.js', origin: 'https://retro.example' }, postMessage: message => messages.push(message) };
  vm.runInNewContext(workerSource, { self, fetch, URL, AbortController, setTimeout, clearTimeout, Atomics });
  const shared = new SharedArrayBuffer(262144 + 8);
  return { self, shared, messages, init: url => self.onmessage({ data: { type: 'init', url, shared } }), read: (start, end) => self.onmessage({ data: { type: 'read', start, end } }) };
}
test('range worker reads 4 GiB offsets using bounded requests and rejects changed objects', async () => {
  const calls = []; let tag = '"fixed"';
  const env = workerEnvironment(async (url, options) => {
    calls.push(options.headers.Range);
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range); const start = Number(a), end = Math.min(Number(b),4294967295);
    return new Response(Uint8Array.from({ length: end-start+1 }, (_,i)=>(start+i)%251), { status:206, headers:{ 'Content-Range':`bytes ${start}-${end}/4294967296`, ETag:tag } });
  });
  await env.init('https://retro.example/data/roms/test.3ds');
  assert.equal(env.messages[0].size,4294967296);
  await env.read(4294705152,4294967296);
  assert.equal(Atomics.load(new Int32Array(env.shared,0,2),0),2);
  assert.equal(new Uint8Array(env.shared,8)[262143],4294967295%251);
  assert.deepEqual(calls,['bytes=0-262143','bytes=4294705152-4294967295']);
  tag='"changed"'; await env.read(262144,524288);
  assert.equal(Atomics.load(new Int32Array(env.shared,0,2),0),-1);
});
test('range worker rejects full HTTP 200 bodies without consuming them and rejects external URLs',async()=>{
  let cancelled=0, consumed=0, requests=0;
  const env=workerEnvironment(async()=>{requests++;return { status:200,headers:new Headers(),body:{cancel(){cancelled++;return Promise.resolve();},getReader(){consumed++;throw new Error('Full download attempted');}} };});
  await env.init('https://retro.example/data/roms/test.3ds');
  assert.equal(env.messages[0].ready,false);assert.equal(consumed,0);assert.equal(cancelled,1);
  await env.init('https://external.example/data/roms/test.3ds');assert.equal(requests,1);
});
test('range worker rejects truncated and oversized partial responses',async()=>{
  for(const size of [262143,262145]) {
    const env=workerEnvironment(async()=>new Response(new Uint8Array(size),{status:206,headers:{'Content-Range':'bytes 0-262143/4294967296',ETag:'"fixed"'}}));
    await env.init('https://retro.example/data/roms/test.3ds');assert.equal(env.messages[0].ready,false);
  }
});
