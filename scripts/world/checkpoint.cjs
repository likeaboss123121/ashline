// Checkpoints for the world build: what a stage of build-network.cjs leaves behind, kept on disk so that the next run
// starts from the last stage whose inputs have not changed, and a run that dies part way (a crash, the machine
// running out of memory, a reboot) picks up where it stopped.
//
// Each stage has a key: a hash of the key of the stage before it, the input files it reads, the constants it uses
// and the source of the code it runs. Change any of those and the stage and everything after it run again; change
// only what a later stage does (how stops are placed, say) and the expensive stages before it are read back in
// seconds. A checkpoint is one file per scope and stage, replaced whenever that stage runs again.
//
// The file is NDJSON, one line per record, so neither writing nor reading needs the whole state as one string: the
// first line is the header ({ stage, key, written }), then for each field a line [name, value], or for a long array
// [name, "$array", length] followed by one line per element. Sets and Maps are written as { $set: [...] } and
// { $map: [...] }; everything else as plain JSON. Map and Set order is kept, so a stage read back behaves exactly as
// the one that was written.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LONG_ARRAY = 1000;

// A short hash of anything: functions by their source, files (given as { file }) by their contents.
function hashOf(...parts) {
  const hash = crypto.createHash('sha256');
  parts.forEach(part => {
    if (typeof part === 'function') hash.update('fn:' + part.toString());
    else if (part && typeof part === 'object' && typeof part.file === 'string') hash.update('file:').update(fs.readFileSync(part.file));
    else hash.update('json:' + JSON.stringify(part === undefined ? null : part));
    hash.update('\0');
  });
  return hash.digest('hex').slice(0, 20);
}

// The SHA-256 of a file, read a megabyte at a time.
function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  let read;
  while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  fs.closeSync(descriptor);
  return hash.digest('hex');
}

function replacer(key, value) {
  if (value instanceof Set) return { $set: Array.from(value) };
  if (value instanceof Map) return { $map: Array.from(value.entries()) };
  return value;
}
function reviver(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value.$set) && Object.keys(value).length === 1) return new Set(value.$set);
    if (Array.isArray(value.$map) && Object.keys(value).length === 1) return new Map(value.$map);
  }
  return value;
}

function fileFor(dir, scope, stage) {
  return path.join(dir, scope + '-' + stage + '.ndjson');
}

// Writes a stage's state (a plain object of fields) atomically: to a .part file first, renamed into place when
// complete, so a checkpoint on disk is always a whole one.
function write(dir, scope, stage, key, state) {
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(dir, scope, stage), part = file + '.part';
  const descriptor = fs.openSync(part, 'w');
  let buffer = '';
  const out = line => {
    buffer += line + '\n';
    if (buffer.length > (1 << 20)) { fs.writeSync(descriptor, buffer); buffer = ''; }
  };
  out(JSON.stringify({ stage, key, written: new Date().toISOString() }));
  Object.entries(state).forEach(([name, value]) => {
    if (Array.isArray(value) && value.length > LONG_ARRAY) {
      out(JSON.stringify([name, '$array', value.length]));
      value.forEach(element => out(JSON.stringify(element, replacer)));
    } else {
      out(JSON.stringify([name, value], replacer));
    }
  });
  fs.writeSync(descriptor, buffer);
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  fs.renameSync(part, file);
  return fs.statSync(file).size;
}

// Reads a stage's state back, or null when there is none or it was written for a different key. A file that cannot
// be read whole is treated as missing: the stage just runs again.
function read(dir, scope, stage, key) {
  const file = fileFor(dir, scope, stage);
  if (!fs.existsSync(file)) return null;
  try {
    const descriptor = fs.openSync(file, 'r');
    const first = Buffer.alloc(512);
    const length = fs.readSync(descriptor, first, 0, first.length, 0);
    fs.closeSync(descriptor);
    const header = JSON.parse(first.subarray(0, length).toString('utf8').split('\n')[0]);
    if (header.key !== key) return null;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const state = {};
    for (let index = 1; index < lines.length; index++) {
      if (!lines[index]) continue;
      const [name, value, count] = JSON.parse(lines[index], reviver);
      if (value === '$array' && Number.isInteger(count)) {
        const array = new Array(count);
        for (let item = 0; item < count; item++) array[item] = JSON.parse(lines[index + 1 + item], reviver);
        index += count;
        state[name] = array;
      } else {
        state[name] = value;
      }
    }
    return state;
  } catch (error) {
    return null;
  }
}

module.exports = { hashOf, hashFile, write, read, fileFor };
