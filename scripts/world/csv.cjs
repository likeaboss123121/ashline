function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const parseLine = line => {
    const values = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const character = line[i];
      if (character === '"') {
        if (quoted && line[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (character === ',' && !quoted) {
        values.push(value);
        value = '';
      } else {
        value += character;
      }
    }
    if (quoted) throw new Error('Unclosed CSV quote: ' + line);
    values.push(value);
    return values;
  };
  const headings = parseLine(lines.shift());
  return lines.filter(Boolean).map((line, index) => {
    const values = parseLine(line);
    if (values.length !== headings.length) throw new Error('Bad CSV column count on row ' + (index + 2));
    return Object.fromEntries(headings.map((heading, column) => [heading, values[column]]));
  });
}

module.exports = { parseCsv };
