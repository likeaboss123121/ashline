const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { compile: compileText } = require('./build-text-catalogue.cjs');
const worldCompiler = spawnSync(process.execPath, [path.join(root, 'scripts', 'world', 'compile-world.cjs')], {
  cwd: root, stdio: 'inherit', windowsHide: true
});
if (worldCompiler.error) console.error(worldCompiler.error.message);
if (worldCompiler.status !== 0) {
  process.exitCode = worldCompiler.status ?? 1;
  return;
}
const compiler = process.env.TWEEGO || (process.platform === 'win32'
  ? path.join(root, 'tweego-2.1.1-windows-x64', 'tweego.exe')
  : 'tweego');
const args = ['-f', 'sugarcube-2', '-o', 'index.html', 'source'];
compileText(root);
if (process.argv.includes('--watch')) {
  args.unshift('--watch');
  let timer;
  const watcher = fs.watch(path.join(root, 'source'), { recursive: true }, (_, filename) => {
    if (!filename || path.basename(filename) === 'text-catalogue.js') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { compileText(root); } catch (error) { console.error('Text catalogue:', error.message); }
    }, 200);
  });
  const child = spawn(compiler, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  function close() { clearTimeout(timer); watcher.close(); }
  child.on('error', error => { console.error(error.message); close(); process.exitCode = 1; });
  child.on('exit', code => { close(); process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { close(); child.kill(signal); });
} else {
  const result = spawnSync(compiler, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
