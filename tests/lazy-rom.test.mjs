import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
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

function hashEnvironment(crypto = webcrypto, WorkerClass = Worker) {
  const window = {};
  vm.runInNewContext(source, { window, crypto, Worker: WorkerClass, SharedArrayBuffer, Atomics, performance, setTimeout, clearTimeout });
  return window.RetroLazyRom;
}
function exheaderFixture(ncsd = false) {
  const bytes = new Uint8Array(262144), offset = ncsd ? 0x4000 : 0;
  const view = new DataView(bytes.buffer);
  if (ncsd) {
    bytes.set(Buffer.from('NCSD'), 0x100);
    view.setUint32(0x120, offset / 512, true); view.setUint32(0x124, 1024, true);
  }
  bytes.set(Buffer.from('NCCH'), offset + 0x100);
  view.setUint32(offset + 0x180, 0x400, true);
  for (let i = 0; i < 0x400; i++) bytes[offset + 0x200 + i] = (i * 13 + 7) % 256;
  bytes.set(createHash('sha256').update(bytes.subarray(offset + 0x200, offset + 0x600)).digest(), offset + 0x160);
  return { bytes, offset, view };
}
test('exheader hash checks plaintext independently of the crypto flag without modifying or exporting content', async () => {
  const api = hashEnvironment();
  for (const ncsd of [false, true]) {
    const { bytes, offset } = exheaderFixture(ncsd), original = bytes.slice();
    const header = api.inspectHeader(bytes, 1048576);
    assert.equal(header.noCryptoFlag, false);
    const result = await api.inspectExheaderHash(bytes, 1048576, header);
    assert.equal(result.state, 'match'); assert.equal(result.bytesHashed, 1024);
    assert.equal(result.scope, 'NCCH exheader only');
    assert.deepEqual(Object.keys(result).sort(), ['algorithm', 'bytesHashed', 'scope', 'state']);
    assert.deepEqual(bytes, original);
    bytes[offset + 0x200] ^= 1;
    assert.equal((await api.inspectExheaderHash(bytes, 1048576, header)).state, 'mismatch');
    bytes[offset + 0x18f] = 4;
    assert.equal((await api.inspectExheaderHash(bytes, 1048576, api.inspectHeader(bytes, 1048576))).state, 'mismatch');
  }
});
test('exheader inspection bounds input and reports missing, unsupported and unavailable checks without guessing', async () => {
  const api = hashEnvironment(); const { bytes, offset, view } = exheaderFixture(true);
  const header = api.inspectHeader(bytes, 1048576);
  const check = (input = bytes, size = 1048576, h = header) => api.inspectExheaderHash(input, size, h);
  assert.equal((await check(bytes, 1048576, { state: 'unrecognized' })).state, 'header-unavailable');
  assert.equal((await check(bytes.subarray(0, offset + 0x300))).state, 'outside-probe');
  assert.equal((await check(bytes, offset + 0x500)).state, 'invalid-bounds');
  assert.equal((await check(bytes, 1048576, { ...header, partitionSize: 0x400 })).state, 'invalid-bounds');
  view.setUint32(offset + 0x180, 0, true); assert.equal((await check()).state, 'no-exheader');
  view.setUint32(offset + 0x180, 0xffffffff, true); assert.equal((await check()).state, 'unsupported-size');
  view.setUint32(offset + 0x180, 0x400, true);
  assert.equal((await hashEnvironment(null).inspectExheaderHash(bytes, 1048576, header)).state, 'unavailable');
  assert.equal((await hashEnvironment({ subtle: { digest() { throw new Error('Denied'); } } }).inspectExheaderHash(bytes, 1048576, header)).state, 'unavailable');
  bytes.fill(0, offset + 0x160, offset + 0x180); assert.equal((await check()).state, 'missing-digest');
});
test('the remote mount retains hash results after close and needs only the existing probe', async () => {
  const { bytes } = exheaderFixture(true); let reads = 0;
  class ProbeWorker extends Worker {
    postMessage(message) {
      reads++;
      assert.equal(message.type, 'init');
      new Uint8Array(message.shared, 8).set(bytes);
      queueMicrotask(() => this.onmessage({ data: { ready: true, size: 1048576, firstLength: bytes.length } }));
    }
  }
  const reader = new (hashEnvironment(webcrypto, ProbeWorker).LazyRom)({ url: '/data/roms/test.3ds', name: 'test.3ds' });
  try {
    await reader.ready;
    assert.equal(reader.stats.header.exheaderHash.state, 'match');
    assert.equal(reader.stats.bytesRead, 262144); assert.equal(reads, 1);
  } finally { reader.stop(); }
  assert.equal(reader.stats.header.exheaderHash.state, 'match');
  assert.equal(reader.stats.cacheBytes, 0);
});

test('header metadata reports raw NCCH flags without claiming payload decryption or modifying bytes', () => {
  const bytes = new Uint8Array(0x200);
  bytes.set([78, 67, 67, 72], 0x100);
  const original = bytes.slice();
  const encryptedFlag = window.RetroLazyRom.inspectHeader(bytes, 1048576);
  assert.equal(encryptedFlag.format, 'NCCH'); assert.equal(encryptedFlag.flagsByte, 0);
  assert.equal(encryptedFlag.noCryptoFlag, false); assert.equal(encryptedFlag.flagsOffset, 0x18f);
  assert.deepEqual(bytes, original);
  bytes[0x18f] = 4;
  const clearFlag = window.RetroLazyRom.inspectHeader(bytes, 1048576);
  assert.equal(clearFlag.noCryptoFlag, true); assert.equal(bytes[0x18f], 4);
  assert.equal('decrypted' in clearFlag, false);
});

test('NCSD header inspection follows partition zero and bounds observations to the existing probe', () => {
  const bytes = new Uint8Array(262144), view = new DataView(bytes.buffer);
  bytes.set([78, 67, 83, 68], 0x100);
  view.setUint32(0x120, 0x20, true); view.setUint32(0x124, 1024, true);
  bytes.set([78, 67, 67, 72], 0x4000 + 0x100); bytes[0x4000 + 0x18f] = 4;
  const info = window.RetroLazyRom.inspectHeader(bytes, 1048576);
  assert.equal(info.ncchOffset, 0x4000); assert.equal(info.noCryptoFlag, true);
  view.setUint32(0x120, 512, true);
  assert.equal(window.RetroLazyRom.inspectHeader(bytes, 1048576).state, 'outside-probe');
  assert.equal(window.RetroLazyRom.inspectHeader(bytes, 400000).state, 'invalid-partition-bounds');
  assert.equal(window.RetroLazyRom.inspectHeader(new Uint8Array(20), 20).state, 'short-probe');
  assert.equal(window.RetroLazyRom.inspectHeader(new Uint8Array(512), 512).state, 'unrecognized');
});
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

test('the exact ROM source uses the adapter with native uppercase metadata and never falls back', async () => {
  const file = { name: 'test.3ds', size: 4294967296 };
  const node = { node_ops: { getattr() { return {}; }, setattr() {} }, stream_ops: {} };
  const FS = { createDataFile() {}, lookupPath() { return { node }; }, ErrnoError: Error };
  const forwarded = [];
  const original = (url, type) => { forwarded.push({ url, type }); return 'native'; };
  const emulator = { ejs_version: '4.3.0-pre', getCore: () => 'azahar', config: { gameUrl: file }, gameManager: { FS }, download: original };
  const installed = window.RetroLazyRom.install(emulator, file);
  try {
    const record = await emulator.download(file, { name: 'ROM', dontCache: false });
    assert.equal(record.files[0].filename, file.name);
    assert.equal(installed.stats.state, 'mounted');
    assert.equal(forwarded.length, 0);
    assert.equal(await emulator.download('/bios/test.bin', { name: 'BIOS' }), 'native');
    assert.equal(forwarded.length, 1);
    FS.createDataFile = () => { throw new Error('mount failed'); };
    await assert.rejects(emulator.download(file, { name: 'ROM' }), /mount failed/);
    assert.equal(forwarded.length, 1);
  } finally { installed.stop(); }
  assert.equal(emulator.download, original);
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
