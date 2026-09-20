const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const compiler = process.env.TWEEGO || (process.platform === 'win32'
  ? path.join(root, 'tweego-2.1.1-windows-x64', 'tweego.exe')
  : 'tweego');
const args = ['-f', 'sugarcube-2', '-o', 'index.html', 'source'];
if (process.argv.includes('--watch')) args.unshift('--watch');
const result = spawnSync(compiler, args, { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
