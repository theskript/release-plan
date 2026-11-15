import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE = '.release';
const UPLOAD = new Set(['NEW', 'CHANGED']);
const USAGE = `usage: node release.mjs <build-dir> <target-dir> plan|apply|verify|rollback|log
         [--config file] [--manifest file] [--plan id] [--delete-new]`;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fileSha = (file) => (fs.existsSync(file) ? sha(fs.readFileSync(file)) : null);
const stateDir = (targetDir, ...parts) => path.join(targetDir, STATE, ...parts);
const targetName = (targetDir) => path.basename(path.resolve(targetDir));

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function assertDir(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${label} is not a folder: ${dir}`);
}

function checkId(id) {
  if (!/^[0-9a-f]{12}$/.test(id ?? '')) throw new Error('a plan id (12 hex characters) is required');
  return id;
}

export function loadConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function globToRegex(pattern) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*');
  // A pattern without a slash matches the file name at any depth.
  return new RegExp(`^${pattern.includes('/') ? '' : '(?:.*/)?'}${body}$`);
}

function rules(config) {
  const cfg = typeof config === 'string' ? loadConfig(config) : (config ?? {});
  return {
    deny: (cfg.deny ?? []).map(globToRegex),
    noise: (cfg.noise ?? []).map((p) => new RegExp(p, 'g')),
    cherryPickOnly: cfg.cherryPickOnly ?? [],
  };
}

function walk(root, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === STATE) continue;
    const next = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, next));
    else if (entry.isFile()) out.push(next);
  }
  return out.sort();
}

function readManifest(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = (Array.isArray(data) ? data : data.files)?.map((f) => path.posix.normalize(String(f)));
  if (!list || list.length === 0) throw new Error('manifest must list at least one file');
  const twice = list.find((f, i) => list.indexOf(f) !== i);
  if (twice) throw new Error(`manifest lists a file twice: ${twice}`);
  return list;
}

function candidates(buildDir, manifest) {
  const all = walk(buildDir);
  if (!manifest) return all;
  const listed = readManifest(manifest);
  const unknown = listed.find((f) => !all.includes(f));
  if (unknown) throw new Error(`manifest lists a file that is not in the build: ${unknown}`);
  return listed.sort();
}

// Noise is removed by pattern, not by line, so a noisy line cannot hide a real change beside it.
function onlyNoise(a, b, noise) {
  if (noise.length === 0 || a.includes(0) || b.includes(0)) return false;
  const strip = (buf) => noise.reduce((text, re) => text.replace(re, ''), buf.toString('utf8'));
  return strip(a) === strip(b);
}

function buildPlan(buildDir, targetDir, { config, manifest } = {}) {
  assertDir(buildDir, 'build');
  assertDir(targetDir, 'target');
  const { deny, noise } = rules(config);
  const rows = candidates(buildDir, manifest).map((rel) => {
    const built = fs.readFileSync(path.join(buildDir, rel));
    const row = { path: rel, status: 'NEW', checksum: sha(built), targetChecksum: null };
    if (deny.some((re) => re.test(rel))) return { ...row, status: 'DENIED' };
    const targetFile = path.join(targetDir, rel);
    if (!fs.existsSync(targetFile)) return row;
    const current = fs.readFileSync(targetFile);
    row.targetChecksum = sha(current);
    if (row.targetChecksum === row.checksum) row.status = 'IDENTICAL';
    else row.status = onlyNoise(built, current, noise) ? 'NOISE-ONLY' : 'CHANGED';
    return row;
  });
  const mode = manifest ? path.basename(manifest) : 'full';
  const target = targetName(targetDir);
  const shape = rows.map((r) => [r.status, r.path, r.checksum, r.targetChecksum]);
  return { id: sha(JSON.stringify([target, mode, shape])).slice(0, 12), target, mode, rows };
}

export function plan(buildDir, targetDir, opts = {}) {
  const result = { ...buildPlan(buildDir, targetDir, opts), createdAt: new Date().toISOString() };
  const file = stateDir(targetDir, 'plans', `${result.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function readPlan(targetDir, planId) {
  const file = stateDir(targetDir, 'plans', `${checkId(planId)}.json`);
  if (!fs.existsSync(file)) throw new Error(`no saved plan ${planId}; run plan first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appendLedger(targetDir, line) {
  const file = stateDir(targetDir, 'ledger.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = fs.existsSync(file) ? '' : '# Release ledger (append-only)\n\n';
  fs.appendFileSync(file, `${header}- ${new Date().toISOString()} ${line}\n`);
}

export function readLedger(targetDir) {
  const file = stateDir(targetDir, 'ledger.md');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('- '));
}

export function verify(buildDir, targetDir, thePlan) {
  const results = thePlan.rows
    .filter((r) => UPLOAD.has(r.status))
    .map((r) => {
      const want = fileSha(path.join(buildDir, r.path));
      const got = fileSha(path.join(targetDir, r.path));
      const confirmed = got !== null && got === want && want === r.checksum;
      return { path: r.path, result: got === null ? 'missing' : confirmed ? 'confirmed' : 'mismatch' };
    });
  const count = (kind) => results.filter((r) => r.result === kind).length;
  return {
    ok: results.every((r) => r.result === 'confirmed'),
    confirmed: count('confirmed'),
    mismatch: count('mismatch'),
    missing: count('missing'),
    results,
  };
}

export function apply(buildDir, targetDir, { planId, config, manifest } = {}) {
  checkId(planId);
  const { deny, cherryPickOnly } = rules(config);
  if (cherryPickOnly.includes(targetName(targetDir)) && !manifest) {
    throw new Error(`target ${targetName(targetDir)} is cherry-pick only: a full apply is refused, pass a manifest`);
  }
  const current = buildPlan(buildDir, targetDir, { config, manifest });
  if (current.id !== planId) {
    throw new Error(`stale plan: reviewed ${planId} but the build and target now give ${current.id}; plan again and review`);
  }
  const upload = current.rows.filter((r) => UPLOAD.has(r.status));
  // Invariant: status and upload set are derived apart, so a DENIED path must never be in it.
  const denied = upload.filter((r) => deny.some((re) => re.test(r.path)));
  if (denied.length > 0) throw new Error(`DENIED files in the upload set: ${denied.map((r) => r.path).join(', ')}`);

  const backupDir = stateDir(targetDir, 'backups', planId);
  const backedUp = upload.filter((r) => r.status === 'CHANGED').map((r) => r.path);
  for (const rel of backedUp) {
    const saved = path.join(backupDir, rel);
    copy(path.join(targetDir, rel), saved);
    const original = current.rows.find((r) => r.path === rel).targetChecksum;
    if (fileSha(saved) !== original) throw new Error(`backup of ${rel} does not match the original; nothing was written`);
  }
  for (const r of upload) copy(path.join(buildDir, r.path), path.join(targetDir, r.path));

  const record = stateDir(targetDir, 'applied', `${planId}.json`);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, `${JSON.stringify({ planId, appliedAt: new Date().toISOString(), files: upload }, null, 2)}\n`);

  const verification = verify(buildDir, targetDir, current);
  appendLedger(
    targetDir,
    `apply plan=${planId} mode=${current.mode} uploaded=${upload.length} confirmed=${verification.confirmed} ` +
      `mismatch=${verification.mismatch} missing=${verification.missing} result=${verification.ok ? 'ok' : 'verify-failed'}`,
  );
  return { planId, uploaded: upload.map((r) => r.path), backedUp, verification };
}

export function rollback(targetDir, planId, { deleteNew = false } = {}) {
  const record = stateDir(targetDir, 'applied', `${checkId(planId)}.json`);
  if (!fs.existsSync(record)) throw new Error(`no applied record for plan ${planId}`);
  const { files } = JSON.parse(fs.readFileSync(record, 'utf8'));
  const backupDir = stateDir(targetDir, 'backups', planId);

  const drifted = files.filter((f) => fileSha(path.join(targetDir, f.path)) !== f.checksum);
  if (drifted.length > 0) throw new Error(`rollback refused: changed since apply: ${drifted.map((f) => f.path).join(', ')}`);
  const lost = files.filter((f) => f.status === 'CHANGED' && fileSha(path.join(backupDir, f.path)) !== f.targetChecksum);
  if (lost.length > 0) throw new Error(`rollback refused: backup missing or altered: ${lost.map((f) => f.path).join(', ')}`);

  const restored = [];
  const removed = [];
  const kept = [];
  for (const f of files) {
    const live = path.join(targetDir, f.path);
    if (f.status === 'CHANGED') {
      copy(path.join(backupDir, f.path), live);
      restored.push(f.path);
    } else if (deleteNew) {
      fs.rmSync(live);
      removed.push(f.path);
    } else {
      kept.push(f.path);
    }
  }
  appendLedger(targetDir, `rollback plan=${planId} restored=${restored.length} removed=${removed.length} kept=${kept.length}`);
  return { restored, removed, kept };
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--delete-new') flags.deleteNew = true;
    else if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, flags };
}

function printPlan(p) {
  console.log(`plan ${p.id}  target=${p.target}  mode=${p.mode}`);
  const counts = {};
  for (const r of p.rows) {
    console.log(`  ${r.status.padEnd(10)} ${r.path}`);
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }
  console.log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
}

function report(v) {
  for (const r of v.results.filter((x) => x.result !== 'confirmed')) console.log(`  ${r.result.toUpperCase()} ${r.path}`);
  console.log(`verify: confirmed=${v.confirmed} mismatch=${v.mismatch} missing=${v.missing}`);
  return v.ok ? 0 : 2;
}

function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const [buildDir, targetDir, cmd] = pos;
  if (!buildDir || !targetDir || !cmd) {
    console.error(USAGE);
    return 1;
  }
  const config = flags.config ?? (fs.existsSync('release.config.json') ? 'release.config.json' : undefined);
  const opts = { config, manifest: flags.manifest };
  try {
    if (cmd === 'plan') {
      printPlan(plan(buildDir, targetDir, opts));
      return 0;
    }
    if (cmd === 'apply') {
      const r = apply(buildDir, targetDir, { ...opts, planId: flags.plan });
      console.log(`applied ${r.planId}: uploaded=${r.uploaded.length} backed-up=${r.backedUp.length}`);
      return report(r.verification);
    }
    if (cmd === 'verify') return report(verify(buildDir, targetDir, readPlan(targetDir, flags.plan)));
    if (cmd === 'rollback') {
      const r = rollback(targetDir, flags.plan, { deleteNew: flags.deleteNew });
      console.log(`rolled back: restored=${r.restored.length} removed=${r.removed.length} kept=${r.kept.length}`);
      return 0;
    }
    if (cmd === 'log') {
      for (const line of readLedger(targetDir)) console.log(line);
      return 0;
    }
    console.error(USAGE);
    return 1;
  } catch (error) {
    console.error(`refused: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
