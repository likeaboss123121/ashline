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
  vm.runInContext(fs.readFileSync(path.join(root, 'source/world-data.js'), 'utf8'), context, { filename: 'world-data.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/world-graph.js'), 'utf8'), context, { filename: 'world-graph.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'source/worldmap.js'), 'utf8'), context, { filename: 'worldmap.js' });
	vm.runInContext(fs.readFileSync(path.join(root, 'source/world-pilot.js'), 'utf8'), context, { filename: 'world-pilot.js' });
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

module.exports = { loadGame };
