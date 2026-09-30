// The name a player reads for a place or a station, from its OpenStreetMap tags, always in the Latin alphabet, and the
// name the place gives itself beside it.
//
// Names are English inside the game (Likea, 2026-09-30: every name anglicised, as the development is done in English):
// the English name where one is mapped (Munich, Warsaw, Moscow); otherwise the local name where it is already written in
// Latin letters (Bogotá), the international one, or an official romanisation (pinyin, Japanese and Korean romaji); and
// only when a place has none of those, its name transliterated letter by letter (any-ascii), which reads well for
// Cyrillic and Greek and less well for scripts that leave vowels unwritten. The extractors record which of these each
// name came from, so the transliterated ones can be counted and reviewed.
//
// The local name, in its own script (München, Москва, 北京市), is kept beside it where it differs, so the game can show
// both, as a map in English shows Moscow with Москва.
const { default: anyAscii } = require('any-ascii');

// Latin letters with their marks, digits, punctuation and spaces.
const LATIN = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u;
const ROMANISED = ['int_name', 'name:zh_pinyin', 'name:zh-Latn-pinyin', 'name:ja-Latn', 'name:ja_rm',
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

// { name, from, local }: the name to show, where it came from ('name:en', 'name', a romanised tag's key, or
// 'transliterated'), and the local name when it is not the same. Null when the feature has no name at all.
function displayName(tags) {
  if (!tags || !tags.name) return null;
  const local = tags.name.trim();
  const withLocal = (name, from) => name === local ? { name, from } : { name, from, local };
  if (isLatin(tags['name:en'])) return withLocal(tags['name:en'].trim(), 'name:en');
  if (isLatin(local)) return withLocal(local, 'name');
  for (const key of ROMANISED) if (isLatin(tags[key])) return withLocal(tags[key].trim(), key);
  const name = transliterate(local);
  return name ? withLocal(name, 'transliterated') : null;
}

module.exports = { displayName, isLatin, transliterate };
