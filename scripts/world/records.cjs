// Reads the world pipeline's JSON files a line at a time. Every import and network file is written with each record
// of its long arrays on a line of its own (writeNormalizedJson, the place and station extractors, writeNetwork), so it
// can be read back the same way: a continent's railways or hamlets make a file larger than one string can hold, which
// JSON.parse of the whole file cannot read.
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

const ARRAY_START = /^\s*("(?:[^"\\]|\\.)*")\s*:\s*\[\s*$/;

// The whole file as one value, as JSON.parse would give it. Each array opened at the end of a line ("key": [) must
// hold one record per line and close on a line of its own; everything else is parsed as it stands.
function readRecords(file) {
  const descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(64 << 20), arrays = new Map();
  let rest = '', header = '', key = null, records = null, line = 0;
  const take = text => {
    line++;
    if (records) {
      const trimmed = text.trim();
      if (trimmed.startsWith(']')) {
        arrays.set(key, records);
        header += JSON.stringify('$records:' + key) + trimmed.slice(1) + '\n';
        records = null;
        return;
      }
      if (!trimmed) return;
      try {
        records.push(JSON.parse(trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed));
      } catch (error) {
        throw new Error(file + ', line ' + line + ': not one record to a line (' + error.message + ')');
      }
      return;
    }
    const match = text.match(ARRAY_START);
    if (match) {
      key = JSON.parse(match[1]);
      records = [];
      header += match[1] + ': ';
      return;
    }
    header += text + '\n';
  };
  // A character split between two reads is held back until the next.
  const decoder = new StringDecoder('utf8');
  try {
    let read;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      const lines = (rest + decoder.write(buffer.subarray(0, read))).split('\n');
      rest = lines.pop();
      lines.forEach(take);
    }
    rest += decoder.end();
    if (rest) take(rest);
  } finally {
    fs.closeSync(descriptor);
  }
  if (records) throw new Error(file + ': the array ' + key + ' is never closed');
  return JSON.parse(header, (name, value) => typeof value === 'string' && value.startsWith('$records:')
    && arrays.has(value.slice(9)) ? arrays.get(value.slice(9)) : value);
}

module.exports = { readRecords };
