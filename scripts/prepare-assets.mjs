import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.retrovault/public');
const allowed = new Set(['.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf']);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
async function copy(relative) {
  const source = join(root, relative);
  const destination = join(output, relative);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source));
}
async function walk(relative) {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not allowed in public assets.');
    if (entry.isDirectory()) await walk(path);
    else if (allowed.has(extname(entry.name).toLowerCase())) await copy(path);
  }
}
// ROMs, BIOS files, game databases, server code, and secrets are never copied.
for (const folder of ['assets', 'pages', 'admin']) await walk(folder);
for (const file of ['index.html', 'version.txt', '_headers']) await copy(file);
console.log('Prepared public interface assets. ROM and BIOS directories are excluded.');
