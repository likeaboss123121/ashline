// Runs a world build script so that it cannot take the machine down with it, and so that it finishes even when it is
// killed part way.
//
// - Memory: the script gets a hard ceiling. On Linux with systemd it runs in its own scope with MemoryMax and no swap,
//   so running out of memory kills the build, never the machine or the SSH session; everywhere else Node's heap is
//   capped. The ceiling is ASHLINE_WORLD_MEMORY_MB, or --memory <MB>, or by default what the machine has free less a
//   gigabyte, and never more than all of it less two gigabytes (a build left at the default on this server got 3.2 GB).
// - Priority: it runs at the lowest CPU and disk priority, so the machine stays usable while it works.
// - Hang-ups: a closed terminal or a dropped SSH connection does not stop it. The log goes to the terminal and to a
//   file (under ASHLINE_DEM_CACHE/logs, or --log <file>); when the terminal goes away, the file keeps it.
// - Crashes: if the script is killed (out of memory, or by a signal), it is started again, up to --retries times
//   (default 3). build-network.cjs keeps a checkpoint after each slow stage and its elevation and terrain routes as
//   it goes, so a restart carries on from where the last one stopped.
//
// Usage: node scripts/world/run-limited.cjs [--memory MB] [--retries N] [--log file] <script> [arguments...]
// To stop a build: Ctrl+C in its terminal, or (on systemd) systemctl --user stop <the unit it names at the start>.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { defaultCache } = require('./dem.cjs');

function memoryAvailableMb() {
  try {
    const match = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
    if (match) return Math.floor(Number(match[1]) / 1024);
  } catch (error) {
    // Not Linux: fall back to what Node reports.
  }
  return Math.floor(os.freemem() / 1048576);
}

function hasSystemdScope() {
  if (process.platform !== 'linux') return false;
  const result = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore' });
  return result.status === 0;
}

function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf('--' + name); return index >= 0 ? args.splice(index, 2)[1] : null; };
  const totalMb = Math.floor(os.totalmem() / 1048576);
  const memoryMb = Number(option('memory') || process.env.ASHLINE_WORLD_MEMORY_MB)
    || Math.max(1024, Math.min(memoryAvailableMb() - 1024, totalMb - 2048));
  const retries = Number(option('retries') ?? 3);
  const script = args[0];
  if (!script) throw new Error('Usage: run-limited.cjs [--memory MB] [--retries N] [--log file] <script> [arguments...]');
  const name = path.basename(script, '.cjs') + (args.includes('--scope') ? '-' + args[args.indexOf('--scope') + 1] : '');
  const logFile = option('log') || path.join(defaultCache(), 'logs', name + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  // Node's own heap is most of what the build holds; the rest (GDAL's warps, buffers) fits in what is left over.
  const heapMb = Math.floor(memoryMb * 0.8);
  const scoped = hasSystemdScope();
  const unit = 'ashline-' + name + '-' + process.pid;
  const env = { ...process.env, GDAL_CACHEMAX: process.env.GDAL_CACHEMAX || '64' };
  const nodeArgs = ['--max-old-space-size=' + heapMb, ...args];
  const command = scoped
    ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit=' + unit, '-p', 'MemoryMax=' + memoryMb + 'M',
        '-p', 'MemorySwapMax=0', 'nice', '-n', '19', 'ionice', '-c3', process.execPath, ...nodeArgs]]
    : [process.execPath, nodeArgs];

  let terminal = true;
  const say = text => {
    logStream.write(text);
    if (!terminal) return;
    try { process.stderr.write(text); } catch (error) { terminal = false; }
  };
  process.stderr.on('error', () => { terminal = false; });
  process.stdout.on('error', () => { terminal = false; });
  // A closed terminal sends a hang-up; the build carries on, writing to its log file.
  process.on('SIGHUP', () => { terminal = false; });

  let child = null, stopping = false;
  ['SIGINT', 'SIGTERM'].forEach(signal => process.on(signal, () => {
    stopping = true;
    say('[run-limited] stopping the build\n');
    if (scoped) spawnSync('systemctl', ['--user', 'stop', unit + '.scope'], { stdio: 'ignore' });
    if (child) { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { child.kill('SIGTERM'); } }
  }));

  const attempt = number => {
    say('[run-limited] ' + new Date().toISOString() + ' run ' + number + ' of ' + (retries + 1) + ': ' + script + ' with at most '
      + memoryMb + ' MB (heap ' + heapMb + ' MB)' + (scoped ? ' in systemd unit ' + unit + '.scope' : '') + '; log in ' + logFile + '\n');
    // In its own process group, so a hang-up sent to the terminal's group does not reach it.
    child = spawn(command[0], command[1], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!scoped) try { os.setPriority(child.pid, 19); } catch (error) { /* not permitted: run at normal priority */ }
    child.stdout.on('data', data => say(data.toString()));
    child.stderr.on('data', data => say(data.toString()));
    child.on('exit', (code, signal) => {
      // Killed by the kernel for memory or by a signal, or aborted by Node on reaching its heap limit; an error in the
      // script itself (exit 1) is not worth running again.
      const killed = !!signal || code === 134 || code === 137 || code === 143;
      if (code === 0) {
        say('[run-limited] ' + new Date().toISOString() + ' finished\n');
        logStream.end(() => process.exit(0));
      } else if (killed && !stopping && number <= retries) {
        say('[run-limited] killed (' + (signal || 'exit ' + code) + '); starting again from the last checkpoint\n');
        attempt(number + 1);
      } else {
        say('[run-limited] ' + new Date().toISOString() + ' failed (' + (signal || 'exit ' + code) + ')\n');
        logStream.end(() => process.exit(code || 1));
      }
    });
  };
  attempt(1);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
