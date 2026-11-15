import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plan, apply, verify, rollback, readLedger, loadConfig } from '../release.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
  temps.push(dir);
  fs.cpSync(path.join(root, 'sample'), dir, { recursive: true });
  fs.rmSync(path.join(dir, 'server', '.release'), { recursive: true, force: true });
  const config = loadConfig(path.join(dir, 'release.config.json'));
  return { dir, build: path.join(dir, 'build'), server: path.join(dir, 'server'), config };
}

function snapshot(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const abs = path.join(dir, rel);
    if (rel.split(path.sep)[0] === '.release' || fs.statSync(abs).isDirectory()) continue;
    out[rel] = fs.readFileSync(abs);
  }
  return out;
}

const statuses = (p) => Object.fromEntries(p.rows.map((r) => [r.path, r.status]));
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

test('classifies every file as NEW, CHANGED, IDENTICAL, DENIED or NOISE-ONLY', () => {
  const { build, server, config } = setup();
  assert.deepEqual(statuses(plan(build, server, { config })), {
    '.htaccess': 'DENIED',
    'about.html': 'IDENTICAL',
    'config/settings.json': 'DENIED',
    'css/site.css': 'NEW',
    'index.html': 'NOISE-ONLY',
    'menu.html': 'CHANGED',
  });
});

test('gives the same plan id for the same inputs and a different one when a byte changes', () => {
  const { build, server, config } = setup();
  const first = plan(build, server, { config });
  assert.equal(plan(build, server, { config }).id, first.id);

  fs.appendFileSync(path.join(build, 'css', 'site.css'), ' ');
  const afterBuild = plan(build, server, { config });
  assert.notEqual(afterBuild.id, first.id);

  fs.appendFileSync(path.join(server, 'menu.html'), ' ');
  assert.notEqual(plan(build, server, { config }).id, afterBuild.id);
});

test('plan changes nothing outside the state folder', () => {
  const { build, server, config } = setup();
  const before = { build: snapshot(build), server: snapshot(server) };
  const p = plan(build, server, { config });
  assert.deepEqual({ build: snapshot(build), server: snapshot(server) }, before);
  assert.ok(fs.existsSync(path.join(server, '.release', 'plans', `${p.id}.json`)));
});

test('refuses when the target changed after the plan was made', () => {
  const { build, server, config } = setup();
  const p = plan(build, server, { config });
  fs.writeFileSync(path.join(server, 'menu.html'), 'edited on the server after the plan\n');
  assert.throws(() => apply(build, server, { planId: p.id, config }), /stale plan/);
  assert.ok(!fs.existsSync(path.join(server, 'css', 'site.css')));
});

test('refuses a stale plan id', () => {
  const { build, server, config } = setup();
  const p = plan(build, server, { config });
  assert.throws(() => apply(build, server, { planId: '000000000000', config }), /stale plan/);
  fs.appendFileSync(path.join(build, 'menu.html'), '<!-- later edit -->\n');
  assert.throws(() => apply(build, server, { planId: p.id, config }), /stale plan/);
  assert.throws(() => apply(build, server, { planId: 'not-an-id', config }), /plan id/);
});

test('never writes or counts denied files', () => {
  const { build, server, config } = setup();
  const before = snapshot(server);
  const p = plan(build, server, { config });
  assert.deepEqual(p.rows.filter((r) => r.status === 'DENIED').map((r) => r.path), ['.htaccess', 'config/settings.json']);

  const result = apply(build, server, { planId: p.id, config });
  assert.deepEqual(result.uploaded, ['css/site.css', 'menu.html']);
  const after = snapshot(server);
  assert.deepEqual(after['.htaccess'], before['.htaccess']);
  assert.deepEqual(after[path.join('config', 'settings.json')], before[path.join('config', 'settings.json')]);
  assert.match(readLedger(server)[0], /uploaded=2 /);
});

test('backs up every overwritten file', () => {
  const { build, server, config } = setup();
  const original = fs.readFileSync(path.join(server, 'menu.html'));
  const p = plan(build, server, { config });
  const result = apply(build, server, { planId: p.id, config });

  assert.deepEqual(result.backedUp, ['menu.html']);
  const backups = path.join(server, '.release', 'backups', p.id);
  assert.deepEqual(fs.readFileSync(path.join(backups, 'menu.html')), original);
  assert.ok(!fs.existsSync(path.join(backups, 'css', 'site.css')));
});

test('verify confirms every uploaded file after a clean apply', () => {
  const { build, server, config } = setup();
  const p = plan(build, server, { config });
  const result = apply(build, server, { planId: p.id, config });
  assert.equal(result.verification.ok, true);
  assert.equal(result.verification.confirmed, 2);
  assert.equal(result.verification.mismatch + result.verification.missing, 0);

  const again = verify(build, server, p);
  assert.deepEqual(again.results.map((r) => r.result), ['confirmed', 'confirmed']);
});

test('verify reports a mismatch when a file is altered afterwards', () => {
  const { build, server, config } = setup();
  const p = plan(build, server, { config });
  apply(build, server, { planId: p.id, config });

  fs.writeFileSync(path.join(server, 'menu.html'), 'not found\n');
  const altered = verify(build, server, p);
  assert.equal(altered.ok, false);
  assert.deepEqual(altered.results.find((r) => r.path === 'menu.html'), { path: 'menu.html', result: 'mismatch' });

  fs.rmSync(path.join(server, 'css', 'site.css'));
  const missing = verify(build, server, p);
  assert.deepEqual(missing.results.find((r) => r.path === 'css/site.css'), { path: 'css/site.css', result: 'missing' });
  assert.equal(missing.mismatch + missing.missing, 2);
});

test('rollback restores the originals byte for byte', () => {
  const { build, server, config } = setup();
  const before = snapshot(server);
  const p = plan(build, server, { config });
  apply(build, server, { planId: p.id, config });
  assert.notDeepEqual(snapshot(server), before);

  const result = rollback(server, p.id, { deleteNew: true });
  assert.deepEqual(result.restored, ['menu.html']);
  assert.deepEqual(result.removed, ['css/site.css']);
  assert.deepEqual(snapshot(server), before);
});

test('rollback keeps new files unless deleteNew is set', () => {
  const { build, server, config } = setup();
  const p = plan(build, server, { config });
  apply(build, server, { planId: p.id, config });
  const result = rollback(server, p.id);
  assert.deepEqual(result.kept, ['css/site.css']);
  assert.ok(fs.existsSync(path.join(server, 'css', 'site.css')));
});

test('refuses rollback when a file changed after apply', () => {
  const { build, server, config } = setup();
  const p = plan(build, server, { config });
  apply(build, server, { planId: p.id, config });
  fs.appendFileSync(path.join(server, 'menu.html'), '<!-- edited after the release -->\n');

  assert.throws(() => rollback(server, p.id, { deleteNew: true }), /changed since apply: menu\.html/);
  assert.match(read(server, 'menu.html'), /edited after the release/);
  assert.ok(fs.existsSync(path.join(server, 'css', 'site.css')));
});

test('does not upload noise-only files', () => {
  const { build, server, config } = setup();
  const p = plan(build, server, { config });
  const result = apply(build, server, { planId: p.id, config });
  assert.ok(!result.uploaded.includes('index.html'));
  assert.match(read(server, 'index.html'), /data-build-id="3c9a02"/);
  assert.equal(statuses(plan(build, server, { config }))['index.html'], 'NOISE-ONLY');
});

test('the ledger gains one line per apply and is never truncated', () => {
  const { build, server, config } = setup();
  const ledger = path.join(server, '.release', 'ledger.md');
  assert.deepEqual(readLedger(server), []);

  apply(build, server, { planId: plan(build, server, { config }).id, config });
  assert.equal(readLedger(server).length, 1);
  const first = fs.readFileSync(ledger, 'utf8');

  fs.writeFileSync(path.join(build, 'contact.html'), '<p>Come in.</p>\n');
  apply(build, server, { planId: plan(build, server, { config }).id, config });
  assert.equal(readLedger(server).length, 2);
  assert.ok(fs.readFileSync(ledger, 'utf8').startsWith(first));
});

test('manifest mode only touches listed files', () => {
  const { dir, build, server, config } = setup();
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ files: ['menu.html'] }));
  const before = snapshot(server);

  const p = plan(build, server, { config, manifest });
  assert.equal(p.mode, 'manifest.json');
  assert.deepEqual(p.rows.map((r) => r.path), ['menu.html']);

  const result = apply(build, server, { planId: p.id, config, manifest });
  assert.deepEqual(result.uploaded, ['menu.html']);
  const after = snapshot(server);
  assert.notDeepEqual(after['menu.html'], before['menu.html']);
  assert.ok(!('css/site.css' in after));
  assert.deepEqual({ ...after, 'menu.html': null }, { ...before, 'menu.html': null });
});

test('a cherry-pick-only target refuses a full apply', () => {
  const { dir, build, server, config } = setup();
  const strict = { ...config, cherryPickOnly: ['server'] };
  const full = plan(build, server, { config: strict });
  assert.throws(() => apply(build, server, { planId: full.id, config: strict }), /cherry-pick only/);
  assert.ok(!fs.existsSync(path.join(server, 'css', 'site.css')));

  const manifest = path.join(dir, 'picked.json');
  fs.writeFileSync(manifest, JSON.stringify(['css/site.css']));
  const picked = plan(build, server, { config: strict, manifest });
  assert.equal(apply(build, server, { planId: picked.id, config: strict, manifest }).verification.ok, true);
});

test('refuses an ambiguous manifest', () => {
  const { dir, build, server, config } = setup();
  const bad = {
    empty: [],
    duplicate: ['menu.html', 'menu.html'],
    unknown: ['no-such-file.html'],
  };
  for (const [name, files] of Object.entries(bad)) {
    const manifest = path.join(dir, `${name}.json`);
    fs.writeFileSync(manifest, JSON.stringify(files));
    assert.throws(() => plan(build, server, { config, manifest }), /manifest/, name);
  }
});
