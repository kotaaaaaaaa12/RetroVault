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
