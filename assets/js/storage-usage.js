import { SYSTEMS, detectSystem } from './systems.js';

const knownSystem = value => SYSTEMS.find(system => system.id === value);
function gameSystem(game) {
  const explicit = knownSystem(game.system) || knownSystem(game.core);
  if (explicit) return explicit.id;
  const candidates = SYSTEMS.filter(system => system.cores.includes(game.core));
  return candidates.length === 1 ? candidates[0].id : null;
}

export function summarizeStorage(files, games) {
  const references = new Map();
  for (const game of games) {
    const system = gameSystem(game);
    if (!system) continue;
    for (const key of [game.rom, game.gameParent]) {
      if (!key) continue;
      if (!references.has(key)) references.set(key, new Set());
      references.get(key).add(system);
    }
  }
  const groups = new Map(SYSTEMS.map((system, index) => [system.id, {
    id: system.id, label: system.label, size: 0, count: 0,
    color: `hsl(${Math.round(index * 137.508) % 360} 78% 66%)`
  }]));
  for (const [id, labelKey, color] of [
    ['thumbnail', 'adminCategoryThumbnail', '#b69aff'],
    ['bios', 'adminCategoryBios', '#65d9bc'],
    ['patch', 'adminCategoryPatch', '#ffae70'],
    ['unclassified', 'adminStorageUnclassified', '#8c8da5']
  ]) groups.set(id, { id, labelKey, size: 0, count: 0, color });
  const seen = new Set();
  let total = 0, count = 0;
  for (const file of files) {
    if (file.status !== 'ready' || !file.key || seen.has(file.key) || !Number.isSafeInteger(file.size) || file.size < 0) continue;
    seen.add(file.key);
    let category = file.kind;
    if (file.kind === 'rom') {
      const systems = references.get(file.key);
      category = systems?.size > 1 ? 'unclassified'
        : systems?.size === 1 ? systems.values().next().value
        : detectSystem(file.name || file.key) || 'unclassified';
    }
    const group = groups.get(category);
    if (!group) continue;
    group.size += file.size; group.count++;
    total += file.size; count++;
  }
  const categories = [...groups.values()].filter(group => group.labelKey || group.count)
    .sort((a, b) => b.size - a.size);
  return { total, count, categories };
}
