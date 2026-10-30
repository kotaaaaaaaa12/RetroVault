import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStorage } from '../assets/js/storage-usage.js';

const file = (key, kind, size, name = key, status = 'ready') => ({ key, kind, size, name, status });
const sizes = result => Object.fromEntries(result.categories.map(group => [group.id, group.size]));

test('storage counts completed unique files once across shared games, parents, drafts and trash', () => {
  const files = [file('shared.zip', 'rom', 4096), file('parent.zip', 'rom', 1024), file('image', 'thumbnail', 512), file('bios', 'bios', 256), file('patch', 'patch', 128), file('unknown.zip', 'rom', 64), file('pending', 'rom', 10000, 'pending.nds', 'uploading'), file('deleting', 'rom', 10000, 'deleting.nds', 'deleting')];
  const games = [
    { rom: 'shared.zip', gameParent: 'parent.zip', system: 'nds', core: 'melonds', status: 'ready' },
    { rom: 'shared.zip', system: 'nds', core: 'desmume', status: 'draft' },
    { rom: 'parent.zip', core: 'nds', status: 'trashed' }
  ];
  const result = summarizeStorage([...files, files[0]], games);
  assert.equal(result.total, 6080); assert.equal(result.count, 6);
  assert.equal(result.categories.find(group => group.id === 'nds').count, 2);
  assert.deepEqual(sizes(result), { nds: 5120, thumbnail: 512, bios: 256, patch: 128, unclassified: 64 });
  assert.equal(result.categories.reduce((total, group) => total + group.size, 0), result.total);
});

test('storage uses declared systems first, unique core aliases second, and known extensions for unattached ROMs', () => {
  const files = [file('shared-core.bin', 'rom', 100), file('core.zip', 'rom', 200), file('unattached', 'rom', 300, 'UPPER.NES'), file('unknown.bin', 'rom', 400), file('ambiguous.bin', 'rom', 500), file('conflict.nes', 'rom', 600)];
  const games = [
    { rom: 'shared-core.bin', system: 'segaMD', core: 'genesis_plus_gx' },
    { rom: 'core.zip', core: 'snes9x' },
    { rom: 'ambiguous.bin', core: 'genesis_plus_gx' },
    { rom: 'conflict.nes', system: 'nes' }, { rom: 'conflict.nes', system: 'nds' }
  ];
  const result = summarizeStorage(files, games), totals = sizes(result);
  assert.equal(totals.segaMD, 100); assert.equal(totals.snes, 200); assert.equal(totals.nes, 300);
  assert.equal(totals.unclassified, 1500); assert.equal(result.total, 2100);
  assert.equal(result.categories[0].id, 'unclassified');
  const reassigned = summarizeStorage(files, games.filter(game => game.system !== 'nds'));
  assert.equal(sizes(reassigned).nes, 900);
});

test('empty storage retains the four separate file groups without invalid shares or invalid sizes', () => {
  const result = summarizeStorage([file('x', 'rom', NaN), file('y', 'rom', -1)], []);
  assert.equal(result.total, 0); assert.equal(result.count, 0);
  assert.deepEqual(result.categories.map(group => group.id), ['thumbnail', 'bios', 'patch', 'unclassified']);
  const zero = summarizeStorage([file('empty.nes', 'rom', 0)], []);
  assert.equal(zero.total, 0); assert.equal(zero.count, 1);
  assert.equal(sizes(zero).nes, 0);
});
