// Downloads the official Tor Expert Bundle that Buzz ships for its "private
// window with Tor", checks it against a pinned SHA-256, and unpacks it into
// desktop/vendor/tor. Run with: npm run fetch-tor
//
// To move to a newer Tor: take the version and checksum from
// https://dist.torproject.org/torbrowser/<version>/sha256sums-signed-build.txt
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '15.0.24';
const SHA256 = 'e9dc6ccc93cd6afa507193f4de284d6424233ff5102155cd2c94b259e8a22b65';
const FILE = `tor-expert-bundle-windows-x86_64-${VERSION}.tar.gz`;
// Current releases live on dist; older ones move to the archive.
const SOURCES = [
  `https://dist.torproject.org/torbrowser/${VERSION}/${FILE}`,
  `https://archive.torproject.org/tor-package-archive/torbrowser/${VERSION}/${FILE}`,
];

const VENDOR = path.join(__dirname, '../vendor/tor');
const STAMP = path.join(VENDOR, 'VERSION');
// --optional: used by postinstall, where a failed download must not break `npm install`.
const optional = process.argv.includes('--optional');

async function download() {
  let lastError = null;
  for (const url of SOURCES) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} from ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('fetch-tor: Tor is only bundled for Windows builds; skipping.');
    return;
  }
  if (fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === VERSION && fs.existsSync(path.join(VENDOR, 'tor/tor.exe'))) {
    console.log(`fetch-tor: Tor ${VERSION} is already in place.`);
    return;
  }

  console.log(`fetch-tor: downloading Tor Expert Bundle ${VERSION}…`);
  const archive = await download();
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  if (digest !== SHA256) throw new Error(`checksum mismatch: expected ${SHA256}, got ${digest}`);

  fs.rmSync(VENDOR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR, { recursive: true });
  const tarball = path.join(VENDOR, FILE);
  fs.writeFileSync(tarball, archive);
  // tar ships with Windows 10 and later.
  execFileSync('tar', ['-xzf', FILE], { cwd: VENDOR, stdio: 'inherit' });
  fs.rmSync(tarball);
  if (!fs.existsSync(path.join(VENDOR, 'tor/tor.exe'))) throw new Error('tor.exe was not found in the bundle');
  fs.writeFileSync(STAMP, VERSION + '\n');
  console.log(`fetch-tor: Tor ${VERSION} verified and unpacked into vendor/tor.`);
}

main().catch((err) => {
  console.error(`fetch-tor: ${err.message}`);
  if (optional) console.error('fetch-tor: continuing without Tor. Run "npm run fetch-tor" later to add it.');
  else process.exit(1);
});
