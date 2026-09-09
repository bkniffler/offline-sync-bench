/** Sequential release wait, validation, and the user-requested bounded restart.
 * Does not publish reports, push commits, retry failed publication attempts,
 * or combine old/new results. Status and logs live under .tmp/tuned-v017-run.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dir, '..');
const dir = join(root, '.tmp/tuned-v017-run');
await mkdir(dir, { recursive: true });
const packages = ['client', 'core', 'server', 'server-hono'];
const state: Record<string, unknown> = { pid: process.pid, startedAt: new Date().toISOString(), requestedVersion: '0.17.0', trials: 3 };
async function save(status: string, extra: Record<string, unknown> = {}) {
  Object.assign(state, { status, updatedAt: new Date().toISOString() }, extra);
  await writeFile(join(dir, 'STATUS.json'), JSON.stringify(state, null, 2) + '\n');
  console.log(status);
}
async function command(name: string, args: string[]) {
  // Share one descriptor so stdout/stderr cannot truncate one another.
  const fd = openSync(join(dir, `${name}.log`), 'w');
  let child;
  try { child = Bun.spawn(args, { cwd: root, stdout: fd, stderr: fd }); }
  finally { closeSync(fd); }
  await save(name, { childPid: child.pid, command: args });
  const code = await child.exited;
  await save(`${name}-finished`, { childPid: null, exitCode: code });
  return code;
}
async function campaign(name: string, configPath: string, smoke: boolean) {
  const config = JSON.parse(await readFile(join(root, configPath), 'utf8'));
  if (config.trials !== (smoke ? 1 : 3)) throw new Error(`${configPath}: unexpected trial count`);
  const code = await command(name, [process.execPath, 'src/campaign.ts', '--config', configPath]);
  const log = await readFile(join(dir, `${name}.log`), 'utf8');
  const manifestPath = log.match(/^campaign=(.+)$/m)?.[1];
  if (!manifestPath) throw new Error(`${name} did not create a manifest; inspect log`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expected = config.stacks.length * config.scenarios.length * config.trials;
  if (manifest.status !== 'complete' || manifest.attempts.length !== expected) throw new Error(`${name} ended incomplete or invalid: ${manifest.error ?? 'see manifest'} (${manifestPath})`);
  if (smoke && (code !== 0 || manifest.attempts.some((a: any) => a.result.status !== 'completed'))) throw new Error('Screen preflight failed; do not launch publication');
  // A fully collected publication can exit 1 because attempts failed. Keep all
  // those outcomes and proceed to the separately declared remaining campaign.
  await save(`${name}-verified`, { [name]: { manifestPath, attempts: expected, exitCode: code } });
}
try {
  await save('waiting-for-npm-0.17.0');
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (true) {
    const availability = await Promise.all(packages.map(async name => {
      const url = `https://registry.npmjs.org/@syncular%2f${name}/0.17.0`;
      try { const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!response.ok) return false;
        const data = await response.json() as { version?: string; dist?: { tarball?: string } };
        if (data.version !== '0.17.0' || !data.dist?.tarball) return false;
        const artifact = await fetch(data.dist.tarball, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        return artifact.ok;
      } catch { return false; }
    }));
    if (availability.every(Boolean)) break;
    if (Date.now() >= deadline) throw new Error('Npm release wait exceeded two hours; no new benchmark launched');
    await Bun.sleep(60000);
  }
  if (await command('install', [process.execPath, 'install', '--no-cache']) !== 0) throw new Error('Dependency installation failed');
  for (const name of packages) {
    const pkg = JSON.parse(await readFile(join(root, 'node_modules/@syncular', name, 'package.json'), 'utf8'));
    if (pkg.version !== '0.17.0') throw new Error(`Installed ${name} is not 0.17.0`);
  }
  const lock = await readFile(join(root, 'drivers/syncular-rust/Cargo.lock'), 'utf8');
  for (const name of ['syncular-client', 'syncular-command', 'syncular-ffi']) {
    if (!lock.includes(`name = "${name}"\nversion = "0.17.0"`)) throw new Error(`Rust lock does not pin ${name} 0.17.0`);
  }
  if (await command('typecheck', [process.execPath, 'run', 'typecheck']) !== 0) throw new Error('Typecheck failed on 0.17.0');
  if (await command('tests', [process.execPath, 'test', 'src/contracts/screens.test.ts', 'src/contracts/screen-indexes.test.ts', 'src/campaign.test.ts', 'src/campaign-report.test.ts']) !== 0) throw new Error('Regression tests failed on 0.17.0');
  await campaign('screens-preflight', 'campaigns/index-tuning-smoke.json', true);
  await campaign('publication-sql', 'campaigns/publication-tuned-sql.json', false);
  await campaign('publication-zero', 'campaigns/publication-tuned-zero.json', false);
  await save('collection-complete-review-required');
} catch (error) {
  await save('stopped-needs-attention', { error: String(error), childPid: null });
  process.exitCode = 1;
}
