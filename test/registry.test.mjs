import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function problems(doc) {
  const out = [];
  const rows = doc
    .split('\n')
    .filter((line) => /^\|\s*F\d+\s*\|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));

  rows.forEach((cells, i) => {
    const id = cells[0];
    if (id !== `F${String(i + 1).padStart(2, '0')}`) out.push(`${id}: ids are not sequential`);
    const guards = [...(cells[3] ?? '').matchAll(/`([^`:]+)::([^`]+)`/g)];
    if (guards.length === 0) out.push(`${id}: no guard`);
    for (const [, file, symbol] of guards) {
      const abs = path.resolve(root, file);
      if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) out.push(`${id}: ${file} does not exist`);
      else if (!fs.readFileSync(abs, 'utf8').includes(symbol)) out.push(`${id}: "${symbol}" not found in ${file}`);
    }
  });
  return out;
}

test('every failure mode has a guard that exists in the code or tests', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'FAILURE-MODES.md'), 'utf8');
  const rows = doc.split('\n').filter((line) => /^\|\s*F\d+\s*\|/.test(line));
  assert.ok(rows.length >= 8, 'the register lists at least eight failure modes');
  assert.deepEqual(problems(doc), []);
});

test('the register check catches a missing file, a missing symbol, no guard and a gap in the ids', () => {
  const doc = [
    '| ID | Failure | Cause | Guard |',
    '|----|---------|-------|-------|',
    '| F01 | a | b | `no-such-file.mjs::anything` |',
    '| F02 | a | b | `release.mjs::thisSymbolIsNotThere` |',
    '| F03 | a | b | nothing backticked |',
    '| F05 | a | b | `release.mjs::verify` |',
  ].join('\n');
  const found = problems(doc).join('\n');
  assert.match(found, /F01: no-such-file\.mjs does not exist/);
  assert.match(found, /F02: "thisSymbolIsNotThere" not found/);
  assert.match(found, /F03: no guard/);
  assert.match(found, /F05: ids are not sequential/);
});
