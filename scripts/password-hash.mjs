import { pbkdf2Sync, randomBytes } from 'node:crypto';

async function password() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString().replace(/\r?\n$/, '');
  }
  process.stderr.write('Administrator password (at least 12 characters): ');
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const read = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') { finish(); reject(new Error('Cancelled')); return; }
        if (character === '\r' || character === '\n') { finish(); resolve(value); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    function finish() { process.stdin.removeListener('data', read); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); }
    process.stdin.on('data', read);
  });
}
try {
  const value = await password();
  if (value.length < 12 || value.length > 1024) throw new Error('Use a password between 12 and 1024 characters.');
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(value, salt, 100000, 32, 'sha256').toString('hex');
  console.log(`pbkdf2-sha256$100000$${salt}$${hash}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
