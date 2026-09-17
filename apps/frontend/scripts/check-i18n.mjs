#!/usr/bin/env node
/**
 * check-i18n.mjs — dependency-free i18n consistency checker.
 *
 * Run from apps/frontend:  node scripts/check-i18n.mjs
 *
 * Checks:
 *   1. es.json is the base dictionary (source language). Every other *.json in
 *      src/i18n/ must have the identical key set and the same key order, and
 *      for every key the {{param}} names must match es.json's.
 *   2. Every i18n key used in src/app (all .ts/.html files) + src/index.html
 *      is defined in es.json (FAIL otherwise). Defined-but-unused keys are WARN.
 *
 * Usage detection (two passes):
 *   - call usages:  t('key')            → regex /(?:^|[^\w])t\(\s*'([^']+)'/g
 *     plus a window scan of the full t(...) argument list so ternaries like
 *     t(cond ? 'a.b' : 'c.d') are caught.
 *   - pipe usages:  'key' | t / (expr) | t  → for each `| t` occurrence, take
 *     the expression window before it (from the matching opening paren if
 *     present, else back to the preceding `{{` or line start) and extract all
 *     quoted strings in that window. Catches (cond ? 'a.b' : 'c.d') | t.
 * Only key-shaped strings are kept: /^[a-z][a-zA-Z]*(\.[a-zA-Z0-9_]+)+$/
 *
 * Exit code: 0 = clean, 1 = at least one failure.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..');
const SRC = join(FRONTEND, 'src');

const failures = [];
const warnings = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);

// ---------------------------------------------------------------------------
// 1. Parse data files
// ---------------------------------------------------------------------------

const I18N_DIR = join(SRC, 'i18n');

/** Load a flat {key: template} JSON locale file. */
function loadLocale(file) {
  const templates = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string') fail(`${file}: value for '${k}' is not a string`);
      templates[k] = String(v);
    }
  } catch (e) {
    fail(`${file}: parse error: ${e.message}`);
  }
  return templates;
}

/** Base dictionary: es.json (source language). */
const esTemplates = loadLocale(join(I18N_DIR, 'es.json'));
const esKeysArr = Object.keys(esTemplates);
const esKeys = new Set(esKeysArr);

/** Every other locale in src/i18n/ (name without .json → templates). */
const locales = {};
for (const f of readdirSync(I18N_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'es.json')
  .sort()) {
  locales[f.replace(/\.json$/, '')] = loadLocale(join(I18N_DIR, f));
}

// ---------------------------------------------------------------------------
// 2. Key-set / order diff per locale
// ---------------------------------------------------------------------------

for (const [name, templates] of Object.entries(locales)) {
  const file = `${name}.json`;
  const keysArr = Object.keys(templates);
  const keySet = new Set(keysArr);
  for (const k of [...esKeys].sort()) {
    if (!keySet.has(k)) fail(`key defined in es.json but missing from ${file}: '${k}'`);
  }
  for (const k of [...keySet].sort()) {
    if (!esKeys.has(k)) fail(`key defined in ${file} but missing from es.json: '${k}'`);
  }
  // Order check only makes sense when the key sets are identical.
  if (keysArr.length === esKeysArr.length && [...esKeys].every((k) => keySet.has(k))) {
    for (let i = 0; i < esKeysArr.length; i++) {
      if (esKeysArr[i] !== keysArr[i]) {
        fail(`key order differs from es.json in ${file} at index ${i}: '${keysArr[i]}' (expected '${esKeysArr[i]}')`);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. {{param}} diff per key, per locale
// ---------------------------------------------------------------------------

const paramsOf = (s) => {
  const set = new Set();
  for (const m of s.matchAll(/\{\{(\w+)\}\}/g)) set.add(m[1]);
  return set;
};
for (const [name, templates] of Object.entries(locales)) {
  for (const k of [...esKeys].filter((k) => k in templates).sort()) {
    const pe = paramsOf(esTemplates[k]);
    const pn = paramsOf(templates[k]);
    if (pe.size !== pn.size || [...pe].some((p) => !pn.has(p))) {
      fail(`param mismatch for '${k}': es=[${[...pe].join(', ')}] ${name}=[${[...pn].join(', ')}]`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Usage scan
// ---------------------------------------------------------------------------

const KEY_SHAPE = /^[a-z][a-zA-Z]*(\.[a-zA-Z0-9_]+)+$/;

/**
 * Remove TS comments (line and block) so doc-comment examples like
 * `{{ 'some.key' | t }}` are not counted as usages. String-aware: quoted
 * literals are left untouched, backtick template literals are treated as
 * opaque (nested quotes inside interpolations are ignored), and line numbers
 * are preserved (comment chars become spaces).
 */
function stripTsComments(text) {
  const n = text.length;
  const out = new Array(n);
  let i = 0;
  let state = 'code'; // 'code' | 'line' | 'block' | the quote char of a string
  while (i < n) {
    const c = text[i];
    if (state === 'code') {
      if (c === '/' && text[i + 1] === '/') {
        state = 'line';
        out[i] = ' ';
        i++;
      } else if (c === '/' && text[i + 1] === '*') {
        state = 'block';
        out[i] = ' ';
        i++;
      } else if (c === "'" || c === '"' || c === '`') {
        state = c;
        out[i] = c;
        i++;
      } else {
        out[i] = c;
        i++;
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out[i] = c;
        i++;
      } else {
        out[i] = ' ';
        i++;
      }
    } else if (state === 'block') {
      if (c === '*' && text[i + 1] === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        state = 'code';
      } else {
        out[i] = c === '\n' ? '\n' : ' ';
        i++;
      }
    } else {
      // inside a string literal (state is the quote char)
      if (c === '\\' && i + 1 < n) {
        out[i] = c;
        out[i + 1] = text[i + 1];
        i += 2;
      } else if (c === state) {
        state = 'code';
        out[i] = c;
        i++;
      } else {
        out[i] = c;
        i++;
      }
    }
  }
  return out.join('');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && /\.(ts|html)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = [...walk(join(SRC, 'app')), join(SRC, 'index.html')];

/** key → Set of "file:line" locations */
const used = new Map();
function record(key, fileRel, line) {
  if (!KEY_SHAPE.test(key)) return;
  if (!used.has(key)) used.set(key, new Set());
  used.get(key).add(`${fileRel}:${line}`);
}

const lineOf = (content, idx) => content.slice(0, idx).split('\n').length;

/** All single- and double-quoted string literals in text. */
function quotedStrings(text) {
  const out = [];
  for (const m of text.matchAll(/'([^']*)'|"([^"]*)"/g)) out.push(m[1] ?? m[2]);
  return out;
}

/** Index of the '(' matching the ')' at closeIdx, scanning left (quote-aware). -1 if none. */
function matchOpenParen(text, closeIdx) {
  let depth = 1;
  let i = closeIdx - 1;
  while (i >= 0) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      // skip back over the string literal
      let j = i - 1;
      while (j >= 0 && text[j] !== c) {
        if (text[j] === '\\') j--;
        j--;
      }
      i = j;
    } else if (c === ')') {
      depth++;
    } else if (c === '(') {
      depth--;
      if (depth === 0) return i;
    }
    i--;
  }
  return -1;
}

/** Index of the ')' matching the '(' at openIdx, scanning right (quote-aware). -1 if none. */
function matchCloseParen(text, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      i = j;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

for (const file of files) {
  let content = readFileSync(file, 'utf8');
  if (file.endsWith('.ts')) content = stripTsComments(content);
  const fileRel = relative(FRONTEND, file).replace(/\\/g, '/');

  // --- Pass 1: call usages t('key') ---
  for (const m of content.matchAll(/(?:^|[^\w])t\(\s*'([^']+)'/g)) {
    record(m[1], fileRel, lineOf(content, m.index));
  }
  // Window scan over the full t(...) argument list (catches ternaries in calls).
  for (const m of content.matchAll(/(?:^|[^\w])t\(/g)) {
    const open = m.index + m[0].length - 1; // index of '('
    const close = matchCloseParen(content, open);
    if (close < 0) continue;
    for (const s of quotedStrings(content.slice(open + 1, close))) {
      record(s, fileRel, lineOf(content, open));
    }
  }

  // --- Pass 2: pipe usages ... | t ---
  const pipeRe = /\)\s*\|\s*t(?![\w])|['"]\s*\|\s*t(?![\w])/g;
  for (const m of content.matchAll(pipeRe)) {
    const isParen = m[0].startsWith(')');
    const pipeIdx = m.index + m[0].lastIndexOf('|');
    let windowStart;
    if (isParen) {
      const openParen = matchOpenParen(content, m.index);
      windowStart = openParen >= 0 ? openParen : content.lastIndexOf('\n', m.index) + 1;
    } else {
      // back to the preceding `{{` or line start
      const lineStart = content.lastIndexOf('\n', m.index) + 1;
      const mustache = content.lastIndexOf('{{', m.index);
      windowStart = mustache >= lineStart ? mustache + 2 : lineStart;
    }
    for (const s of quotedStrings(content.slice(windowStart, pipeIdx))) {
      record(s, fileRel, lineOf(content, m.index));
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------

const missing = [...used.entries()]
  .filter(([key]) => !esKeys.has(key))
  .sort((a, b) => a[0].localeCompare(b[0]));
for (const [key, locs] of missing) {
  fail(`used but NOT defined in es.json: '${key}' (${[...locs].sort().join(', ')})`);
}

const unused = [...esKeys]
  .filter((k) => !used.has(k))
  .sort();
if (unused.length > 0) {
  for (const k of unused) warn(`defined but never used: '${k}'`);
}

const totalKeys = esKeys.size;
const localeCounts = [
  ['es.json (base)', totalKeys],
  ...Object.entries(locales).map(([n, t]) => [`${n}.json`, Object.keys(t).length]),
];
const labelW = Math.max(...localeCounts.map(([l]) => l.length));
console.log('i18n check');
for (const [label, count] of localeCounts) {
  console.log(`  ${label.padEnd(labelW)} : ${count} entries`);
}
console.log(`  files scanned          : ${files.length}`);
console.log(`  used keys              : ${used.size} / ${totalKeys}`);
console.log(`  unused keys (warn)     : ${unused.length}`);
console.log(`  missing usages (fail)  : ${missing.length}`);
if (warnings.length > 0) {
  console.log('');
  for (const w of warnings) console.log(`WARN  ${w}`);
}
if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log(`FAIL  ${f}`);
}
console.log('');
if (failures.length > 0) {
  console.log(`RESULT: FAILED (${failures.length} failure${failures.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);
  process.exit(1);
} else {
  console.log(`RESULT: OK (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);
  process.exit(0);
}
