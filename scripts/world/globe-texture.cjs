// The texture the Map tab's globe is drawn from: one greyscale image of the whole Earth, 2:1 (longitude by latitude,
// equirectangular), where 0 is water and 1 to 255 is land shaded by its relief. The relief is Natural Earth's 1:50m
// shaded relief (SR_50M, public domain), averaged down; which texels are land comes from the same 1:50m land polygons
// as the debug map's land mask (land-mask.cjs), so coastlines agree everywhere.
//
// An offline build step: the shaded relief (58 MB) stays outside the repository, and only the small texture it makes
// is committed and embedded in the game by compile-world.cjs.
//
// Usage: node scripts/world/globe-texture.cjs --relief /path/to/SR_50M.tif [--width 2048]
// Needs GDAL (gdal_translate).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { rasterizeLand, isLand } = require('./land-mask.cjs');

const root = path.resolve(__dirname, '../..');
const OUTPUT = 'world/external/globe-texture.png';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' failed: ' + result.stderr);
}

function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf('--' + name); return index >= 0 ? args[index + 1] : null; };
  const relief = option('relief');
  if (!relief || !fs.existsSync(relief)) throw new Error('Usage: globe-texture.cjs --relief /path/to/SR_50M.tif [--width 2048]');
  const width = Number(option('width') || 2048), height = width / 2;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-globe-'));
  try {
    // The relief averaged down to the texture's size, as raw bytes.
    const raw = path.join(temporary, 'relief.bin');
    run('gdal_translate', ['-q', '-r', 'average', '-outsize', String(width), String(height), '-of', 'ENVI', relief, raw]);
    const shade = fs.readFileSync(raw);
    const land = rasterizeLand(JSON.parse(fs.readFileSync(path.join(root, 'world/external/natural-earth-50m-land.geojson'), 'utf8')));
    const texture = Buffer.alloc(width * height);
    for (let row = 0; row < height; row++) {
      const latitude = 90 - (row + 0.5) * 180 / height;
      for (let column = 0; column < width; column++) {
        const longitude = -180 + (column + 0.5) * 360 / width, at = row * width + column;
        texture[at] = isLand(land, [longitude, latitude]) ? Math.max(1, shade[at]) : 0;
      }
    }
    // Written as a greyscale PGM, then compressed to PNG.
    const pgm = path.join(temporary, 'globe.pgm');
    fs.writeFileSync(pgm, Buffer.concat([Buffer.from('P5\n' + width + ' ' + height + '\n255\n'), texture]));
    const target = path.join(root, OUTPUT);
    run('gdal_translate', ['-q', '-of', 'PNG', '-co', 'ZLEVEL=9', pgm, target]);
    fs.rmSync(target + '.aux.xml', { force: true });
    console.log('Wrote ' + OUTPUT + ' (' + width + ' by ' + height + ', ' + Math.round(fs.statSync(target).size / 1024) + ' KiB)');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
