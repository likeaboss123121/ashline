// Read-only authoring reference. Never evaluate source code to discover its text.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const {encode,plansFor} = require('./text-expressions.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = 'source/text-catalogue.js';

function scriptEntries(code, file) {
  const entries = [], consumed = new Set();
  const tree = acorn.parse(code, { ecmaVersion: 'latest', locations: true });
  function add(node, text, bindings=[]) {
    if (text.trim()) entries.push(['scripts', file, node.loc.start.line, '', text,
      /\[NEEDS WRITING PASS\]/.test(code.slice(node.start,node.end)), bindings]);
  }
  function variable(node, bindings) {
    const index=bindings.length, expression=code.slice(node.start,node.end);
    bindings.push({expression,plan:encode(node),kind:/setup\.stats\.|\b(health|hunger|thirst|sanity|immunity|fatigue)\b/.test(expression)?'STAT':'VALUE'});
    return '\uE000'+index+'\uE001';
  }
  function pieces(node, bindings) {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      consumed.add(node); return node.value;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') return pieces(node.left,bindings) + pieces(node.right,bindings);
    if (node.type === 'TemplateLiteral') {
      consumed.add(node);
      return node.quasis.map((q, i) => (q.value.cooked ?? q.value.raw) +
        (node.expressions[i] ? variable(node.expressions[i],bindings) : '')).join('');
    }
    return variable(node,bindings);
  }
  function hasText(node) {
    return node.type === 'Literal' && typeof node.value === 'string' || node.type === 'TemplateLiteral' ||
      node.type === 'BinaryExpression' && node.operator === '+' && (hasText(node.left) || hasText(node.right));
  }
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (!consumed.has(node)) {
      if (node.type === 'BinaryExpression' && node.operator === '+' && hasText(node)) {
        const bindings=[]; add(node, pieces(node,bindings),bindings);
        // Children still contain labels in conditionals/calls; keep those too.
        function mark(n) {
          if (n.type === 'BinaryExpression' && n.operator === '+') { consumed.add(n); mark(n.left); mark(n.right); }
        }
        mark(node);
      } else if (node.type === 'TemplateLiteral') { const bindings=[]; add(node, pieces(node,bindings),bindings); }
      else if (node.type === 'Literal' && typeof node.value === 'string') add(node, node.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  return entries;
}

// Where things are defined, for the wiki's pointers and the editor: each custom macro (Macro.add, with whether it
// takes a closing tag and the comment above it) and each setup member (setup.name = ..., and the members of an object
// assigned to it), as { name: { file, line, container?, comment? } } with macros under "macro:name".
function definitionsIn(code, file) {
  const found = {}, tree = acorn.parse(code, { ecmaVersion: 'latest', locations: true });
  const lines = code.split('\n');
  const commentAbove = line => {
    const text = [];
    for (let at = line - 2; at >= 0 && /^\s*\/\//.test(lines[at]); at--) text.unshift(lines[at].replace(/^\s*\/\/\s?/, '').trim());
    return text.join(' ');
  };
  const source = node => code.slice(node.start, node.end);
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && source(node.callee) === 'Macro.add' && node.arguments[0]
      && node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string') {
      const options = node.arguments[1], line = node.loc.start.line;
      const container = !!(options && options.type === 'ObjectExpression'
        && options.properties.some(property => property.key && (property.key.name || property.key.value) === 'tags'));
      found['macro:' + node.arguments[0].value] = { file, line, container, comment: commentAbove(line) };
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && /^setup\.[\w.]+$/.test(source(node.left))) {
      const name = source(node.left);
      found[name] = { file, line: node.loc.start.line };
      if (node.right.type === 'ObjectExpression') {
        node.right.properties.forEach(property => {
          const key = property.key && (property.key.name || property.key.value);
          if (typeof key === 'string') found[name + '.' + key] = { file, line: property.loc.start.line };
        });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object' && value !== node.loc) visit(value);
    }
  }
  visit(tree);
  return found;
}

function buildDefinitions(root = ROOT) {
  const found = {};
  for (const name of fs.readdirSync(path.join(root, 'source')).sort()) {
    const file = 'source/' + name;
    if (!/\.js$/.test(name) || file === OUTPUT || file === 'source/world-data.js') continue;
    Object.assign(found, definitionsIn(fs.readFileSync(path.join(root, file), 'utf8'), file));
  }
  return found;
}

// The custom macros for the Twee 3 Language Tools editor extension, which otherwise flags every one as undefined:
// each with whether it takes a closing tag, and on hover where it is defined and the comment above it.
const EDITOR_CONFIG = 'ashline.twee-config.yaml';
function editorConfig(definitions) {
  const macros = Object.keys(definitions).filter(key => key.startsWith('macro:')).sort((a, b) => a.localeCompare(b));
  return '# Generated by scripts/build-text-catalogue.cjs from the Macro.add calls in source/. Do not edit.\n'
    + '# Custom macro definitions for the Twee 3 Language Tools extension (T3LT), so it knows the game\'s own macros.\n'
    + 'sugarcube-2:\n  macros:\n' + macros.map(key => {
      const macro = definitions[key], name = key.slice(6);
      const description = 'Defined in `' + macro.file + ':' + macro.line + '`.' + (macro.comment ? ' ' + macro.comment : '');
      return '    ' + name + ':\n      container: ' + macro.container + '\n      description: ' + JSON.stringify(description) + '\n';
    }).join('');
}

function passageEntries(code, file) {
  const headers = [...code.matchAll(/^::\s+([^\r\n]+)\r?\n/gm)];
  return headers.map((match, i) => /\[[^\]]*\b(?:script|stylesheet)\b[^\]]*\]/.test(match[1]) ? null : ['passages', file,
    code.slice(0, match.index).split('\n').length + 1,
    match[1].replace(/\s+(?:\[|\{).*$/, '').trim(),
    code.slice(match.index + match[0].length, headers[i+1]?.index ?? code.length).trim()])
    .filter(row => row && !/^(StoryData|StoryInit)$/.test(row[3]));
}

function buildCatalogue(root = ROOT) {
  const entries = [];
  function scan(dir) {
    for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = dir + '/' + item.name;
      if (item.isDirectory()) { scan(file); continue; }
      // Geographic strings are read lazily from the already-shipped dataset in the browser.
      if (file === OUTPUT || file === 'source/world-data.js') continue;
      if (!/\.(?:js|tw|twee|css|svg)$/.test(file)) continue;
      const code = fs.readFileSync(path.join(root, file), 'utf8');
      if (/\.js$/.test(file)) entries.push(...scriptEntries(code, file));
      else if (/\.(tw|twee)$/.test(file)) entries.push(...passageEntries(code, file));
      else {
        const pattern = /\.svg$/.test(file)
          ? /<(?:title|desc|text)\b[^>]*>([\s\S]*?)<\/(?:title|desc|text)>|\b(?:aria-label|title)="([^"]*)"/gi
          : /\bcontent\s*:\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))/g;
        for (const match of code.matchAll(pattern)) {
          entries.push([/\.svg$/.test(file) ? 'graphics' : 'styles', file,
            code.slice(0,match.index).split('\n').length, '', match[1] ?? match[2]]);
        }
      }
    }
  }
  scan('source');
  return entries.sort((a,b) => (a[0] === 'passages' ? 0 : 1) - (b[0] === 'passages' ? 0 : 1));
}

function writeIfChanged(root, relative, output) {
  const target = path.join(root, relative);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === output) return;
  const temporary = path.join(root, 'scripts', '.text-catalogue-' + process.pid + '.tmp');
  fs.writeFileSync(temporary, output);
  fs.renameSync(temporary, target);
}

function compile(root = ROOT) {
  const entries = buildCatalogue(root);
  const definitions = buildDefinitions(root);
  const marker = '[' + 'NEEDS WRITING PASS' + ']';
  const pending = entries.filter(row => typeof row[5] === 'boolean' ? row[5] : row[4].includes(marker)).length;
  // Store one inert JSON string: parsing and search indexing wait until the text folder opens.
  const output = '// Generated by scripts/build-text-catalogue.cjs. Do not edit.\nsetup.textCatalogueSource = ' +
    JSON.stringify(JSON.stringify(entries)).replace(/</g, '\\u003c') + ';\nsetup.textExpressionPlans = ' +
    JSON.stringify(plansFor(entries)).replace(/</g,'\\u003c') + ';\nsetup.textWritingPendingCount = ' + pending + ';\n'
    // Where each macro and setup member is defined, for the wiki's pointers: name -> "file:line".
    + 'setup.textDefinitions = ' + JSON.stringify(Object.fromEntries(Object.keys(definitions).sort().map(key =>
      [key, definitions[key].file.replace(/^source\//, '') + ':' + definitions[key].line]))).replace(/</g, '\\u003c') + ';\n';
  writeIfChanged(root, OUTPUT, output);
  writeIfChanged(root, EDITOR_CONFIG, editorConfig(definitions));
  return entries;
}
if (require.main === module) compile();
module.exports = { scriptEntries, passageEntries, buildCatalogue, definitionsIn, buildDefinitions, editorConfig, compile };
