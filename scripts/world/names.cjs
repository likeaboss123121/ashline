// The name a player reads for a place or a station, from its OpenStreetMap tags, always in the Latin alphabet.
//
// The local name where it is already written in Latin letters (München, Warszawa, Bogotá: as the Americas were named);
// otherwise the English name, the international one, or an official romanisation (pinyin, Japanese and Korean
// romaji); and only when a place has none of those, its name transliterated letter by letter (any-ascii), which reads
// well for Cyrillic and Greek and less well for scripts that leave vowels unwritten. The extractors record which of
// these each name came from, so the transliterated ones can be counted and reviewed.
const { default: anyAscii } = require('any-ascii');

// Latin letters with their marks, digits, punctuation and spaces.
const LATIN = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u;
const ROMANISED = ['name:en', 'int_name', 'name:zh_pinyin', 'name:zh-Latn-pinyin', 'name:ja-Latn', 'name:ja_rm',
  'name:ko-Latn', 'name:ru-Latn', 'name:uk-Latn', 'name:be-Latn', 'name:kk-Latn', 'name:mn-Latn', 'name:ka-Latn',
  'name:hy-Latn', 'name:el-Latn', 'name:ar-Latn', 'name:fa-Latn', 'name:he-Latn', 'name:th-Latn'];

const isLatin = value => typeof value === 'string' && value.trim() !== '' && LATIN.test(value.trim());

// A transliteration tidied into a name: no apostrophes for soft signs (Komsomol'sk), a word read syllable by syllable
// from Chinese written as one (BeiJing becomes Beijing), and every word starting with a capital.
function transliterate(name) {
  return anyAscii(name).replace(/['`"]/g, '').replace(/\s+/g, ' ').trim().split(' ').map(word => {
    if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(word)) word = word.charAt(0) + word.slice(1).toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

// { name, from }: the name to show, and where it came from ('name', a romanised tag's key, or 'transliterated').
// Null when the feature has no name at all.
function displayName(tags) {
  if (!tags || !tags.name) return null;
  if (isLatin(tags.name)) return { name: tags.name.trim(), from: 'name' };
  for (const key of ROMANISED) if (isLatin(tags[key])) return { name: tags[key].trim(), from: key };
  const name = transliterate(tags.name);
  return name ? { name, from: 'transliterated' } : null;
}

module.exports = { displayName, isLatin, transliterate };
