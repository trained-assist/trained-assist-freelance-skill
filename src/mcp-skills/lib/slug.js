'use strict';
// Best-effort Cyrillic → Latin transliteration for folder-safe slugs.
// Project *names* stay in whatever language the client used; slugs are
// ASCII/kebab-case so they're safe across SSH, exports, and filenames.

const MAP = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'e', ж:'zh', з:'z', и:'i', й:'y',
  к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f',
  х:'h', ц:'ts', ч:'ch', ш:'sh', щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
};

function transliterate(s) {
  return s.toLowerCase().split('').map(ch => (ch in MAP ? MAP[ch] : ch)).join('');
}

function slugify(name, { maxWords = 6 } = {}) {
  const words = transliterate(String(name || ''))
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);
  const slug = words.join('-').replace(/-+/g, '-').slice(0, 60);
  return slug || `project-${Date.now().toString(36)}`;
}

module.exports = { slugify, transliterate };
