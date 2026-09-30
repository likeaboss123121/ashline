const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGame() {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, process.env.ASHLINE_SOURCE || 'source/main.tw'), 'utf8');
  const embedded = source.match(/^:: Story JavaScript \[script\]\s*\r?\n([\s\S]*?)(?=^:: )/m);
  const code = embedded ? embedded[1] : fs.readFileSync(path.join(root, 'source/scripts.js'), 'utf8');
  const macros = {};
  const context = vm.createContext({
    setup: {}, State: { variables: {}, passage: 'Railyard' },
    Macro: { add: (name, definition) => { macros[name] = definition; } },
    document: { querySelector() { return null; } }, jQuery: () => ({ one() {}, on() {} }),
    Save: { onLoad: { add() {} } }, console,
    Wikifier: function (output, text) { if (output) output.push(text); }
  });
  vm.runInContext(code, context, { filename: embedded ? 'main.tw script' : 'scripts.js' });
  for (const name of ['stock-catalogue', 'stock-variety', 'vegetation-data']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'source/' + name + '.js'), 'utf8'), context, { filename: name + '.js' });
  }
  vm.runInContext(fs.readFileSync(path.join(root, 'source/locales.js'), 'utf8'), context, { filename: 'locales.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/world-data.js'), 'utf8'), context, { filename: 'world-data.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/worldmap.js'), 'utf8'), context, { filename: 'worldmap.js' });
	vm.runInContext(fs.readFileSync(path.join(root, 'source/world-pilot.js'), 'utf8'), context, { filename: 'world-pilot.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/yards.js'), 'utf8'), context, { filename: 'yards.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/yard-types.js'), 'utf8'), context, { filename: 'yard-types.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/stats.js'), 'utf8'), context, { filename: 'stats.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/items.js'), 'utf8'), context, { filename: 'items.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/fuel.js'), 'utf8'), context, { filename: 'fuel.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/daylight.js'), 'utf8'), context, { filename: 'daylight.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/effects.js'), 'utf8'), context, { filename: 'effects.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/condition.js'), 'utf8'), context, { filename: 'condition.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/tutorial.js'), 'utf8'), context, { filename: 'tutorial.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/units.js'), 'utf8'), context, { filename: 'units.js' });
  ['yard-actions', 'yard-generation', 'bug-report', 'food', 'campfire', 'recovery', 'journal', 'save-legacy', 'save-migrations', 'saves', 'wayfinding', 'station-buildings'].forEach(name => {
    vm.runInContext(fs.readFileSync(path.join(root, 'source/' + name + '.js'), 'utf8'), context, { filename: name + '.js' });
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/onfoot.js'), 'utf8'), context, { filename: 'onfoot.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/refuel.js'), 'utf8'), context, { filename: 'refuel.js' });
  // Yard geometry reads the junction length out of the generated template data, so the tests need it too.
  vm.runInContext(fs.readFileSync(path.join(root, 'source/railyard-templates.js'), 'utf8'), context,
    { filename: 'railyard-templates.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/driving-templates.js'), 'utf8'), context,
    { filename: 'driving-templates.js' });
  return { ...context, macros };
}

// A run of stations one after another on a plain stretch of line: each has a line at both ends and leaves by its exit
// line, running forward, straight to the next. The network is rebuilt from map data, so tests about a plain run of line
// find one rather than pinning station numbers. Returns { stations, legs }: the stations in order, and each one's exit
// leg but the last's.
function stationRun(setup, length = 3) {
  const pilot = setup.realWorldPilot, count = pilot.getGridRoute().corridor.stations.length;
  for (let first = 2; first + length - 1 <= count; first++) {
    const stations = [], legs = [];
    let ok = true;
    for (let i = 0; i < length && ok; i++) {
      const id = first + i, lines = pilot.getStationLines(id);
      const exit = lines.find(line => line.side === 'exit'), entry = lines.find(line => line.side === 'entry');
      if (!exit || !entry) ok = false;
      else if (i < length - 1) {
        if (exit.destination !== id + 1 || !exit.forward) ok = false;
        else legs.push(exit.legIndex);
      }
      stations.push(id);
    }
    if (ok) return { stations, legs };
  }
  throw new Error('No run of ' + length + ' stations on the network');
}

module.exports = { loadGame, stationRun };
