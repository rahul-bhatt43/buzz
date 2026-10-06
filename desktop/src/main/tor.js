// Runs the bundled Tor client for "private windows with Tor". Tor is started
// when the first Tor window opens and stopped when the last one closes.
const { app } = require('electron');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

// Packaged builds carry Tor in resources/tor; from source it is in desktop/vendor/tor.
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'tor') : path.join(__dirname, '../../vendor/tor');
const EXE = path.join(ROOT, 'tor', process.platform === 'win32' ? 'tor.exe' : 'tor');

const events = new EventEmitter(); // 'change'
let child = null;
let port = 0;
let users = 0;
let starting = null; // in-flight start, so two windows opening together share one Tor
// state: off | starting | ready | failed
let status = { state: 'off', progress: 0, message: '' };

function setStatus(next) {
  status = { ...status, ...next };
  events.emit('change', status);
}

function available() {
  return fs.existsSync(EXE);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const chosen = server.address().port;
      server.close(() => resolve(chosen));
    });
  });
}

// Tor reports start-up as lines like "Bootstrapped 45% (requesting_descriptors): Asking for relay descriptors".
function readLog(text) {
  for (const line of text.split(/\r?\n/)) {
    const boot = line.match(/Bootstrapped (\d+)%[^:]*: (.+)$/);
    if (boot) {
      const progress = Number(boot[1]);
      setStatus({ state: progress >= 100 ? 'ready' : 'starting', progress, message: boot[2].trim() });
    } else if (/\[err\]/.test(line)) {
      setStatus({ message: line.replace(/^.*\[err\]\s*/, '').trim() });
    }
  }
}

/**
 * Register a Tor window. Starts Tor if needed and returns the local SOCKS port
 * its traffic must go through. The port is known before Tor has connected, so a
 * window can be locked to it from the start and simply fails to load until Tor is up.
 */
function acquire() {
  users++;
  if (child) return Promise.resolve(port);
  if (!starting) {
    starting = start().finally(() => {
      starting = null;
    });
  }
  return starting;
}

async function start() {
  port = await freePort();
  const dataDir = path.join(app.getPath('userData'), 'tor');
  fs.mkdirSync(dataDir, { recursive: true });
  setStatus({ state: 'starting', progress: 0, message: 'Starting Tor' });

  const started = spawn(
    EXE,
    [
      '--SocksPort', `127.0.0.1:${port}`,
      '--DataDirectory', dataDir,
      '--GeoIPFile', path.join(ROOT, 'data', 'geoip'),
      '--GeoIPv6File', path.join(ROOT, 'data', 'geoip6'),
      '--ClientOnly', '1',
      '--Log', 'notice stdout',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child = started;
  started.stdout.on('data', (chunk) => readLog(chunk.toString()));
  started.stderr.on('data', (chunk) => readLog(chunk.toString()));
  started.on('error', (err) => {
    if (child === started) child = null;
    setStatus({ state: 'failed', message: err.message });
  });
  started.on('exit', () => {
    if (child !== started) return;
    child = null;
    // Still wanted but gone: Tor crashed or could not start.
    setStatus(users > 0 ? { state: 'failed', message: status.message || 'Tor stopped unexpectedly' } : { state: 'off', progress: 0, message: '' });
  });
  return port;
}

/** A Tor window closed. Stops Tor once none are left. */
function release() {
  users = Math.max(0, users - 1);
  if (users === 0) stop();
}

function stop() {
  const running = child;
  child = null;
  users = 0;
  if (running) running.kill();
  setStatus({ state: 'off', progress: 0, message: '' });
}

module.exports = { events, available, acquire, release, stop, status: () => status };
