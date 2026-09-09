import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { planLoadedCampaign, type LoadedConfig } from './loaded-plan.ts';
import { runLoadedChild } from './loaded-child.ts';
import { prepareBrowser, assertBrowserUnchanged, readCampaignBrowser } from './provenance.ts';
import { sourceIdentity, machineIdentity, imageIdentity } from '../provenance.ts';
import { writeSourceSnapshot, sha256 } from '../source-snapshot.ts';
import { writeDependencies, assertDependenciesUnchanged } from '../dependencies.ts';
import { captureConfiguration, writeConfiguration, assertConfigurationUnchanged } from '../configuration.ts';
import { captureServerStorage, serverStoragePolicy, validateServerStoragePair } from '../server-storage.ts';
import { ensureStackUp } from '../stack-manager.ts';
import { benchmarkRoot, resultsRoot } from '../paths.ts';
import { hash } from '../contracts/screens.ts';
import { browserProcessTable } from './process.ts';
import { validateLoadedProcessGroup, processIdentityKey } from './loaded-process.ts';

export async function runLoadedCampaign(config: LoadedConfig): Promise<string> {
  const plan = planLoadedCampaign(config);
  const id = `browser-loaded-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = join(resultsRoot, id); await mkdir(dir, { recursive: true });
  const path = join(dir, 'EXPERIMENT.json');
  const manifest: any = { version: 1, method: config.method, id, status: 'preparing', config, plan,
    startedAt: new Date().toISOString(), attempts: [], serverStoragePolicy };
  const save = () => writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  await save();
  try {
    for (const stackId of config.stacks) await ensureStackUp(stackId);
    manifest.source = sourceIdentity(); manifest.machine = machineIdentity(); manifest.images = imageIdentity(config.stacks);
    await writeSourceSnapshot(benchmarkRoot, dir, manifest.source);
    const packageManifests = Object.keys(manifest.source.files).filter(name => name === 'package.json' || name.endsWith('/package.json'));
    manifest.dependencies = await writeDependencies(benchmarkRoot, dir, packageManifests);
    manifest.browser = await prepareBrowser(dir, config.runtime, manifest.source, manifest.dependencies);
    await readCampaignBrowser(dir, manifest.browser, config.runtime, manifest.source, manifest.dependencies,
      JSON.parse(await readFile(join(dir, manifest.dependencies.path), 'utf8')));
    const environment = { ...process.env, BENCH_CLIENT_ENDPOINTS: '',
      BENCH_CAMPAIGN_RUNTIME: JSON.stringify(config.runtime), BENCH_BROWSER_IDENTITY: JSON.stringify(manifest.browser),
      BENCH_BROWSER_BUNDLE: join(dir, manifest.browser.bundlePath) };
    manifest.configuration = await writeConfiguration(dir, captureConfiguration(config.stacks, manifest.source, environment));
    manifest.controller = (await browserProcessTable()).find(row => row.pid === process.pid);
    if (!manifest.controller) throw new Error('Loaded campaign controller identity missing');
    const guard = async () => {
      if (sourceIdentity().sourceHash !== manifest.source.sourceHash) throw new Error('Loaded experiment source changed');
      assertDependenciesUnchanged(benchmarkRoot, manifest.dependencies, packageManifests);
      assertBrowserUnchanged(config.runtime, manifest.browser);
      await readCampaignBrowser(dir, manifest.browser, config.runtime, manifest.source, manifest.dependencies);
      assertConfigurationUnchanged(config.stacks, manifest.source, manifest.configuration, environment);
    };
    await guard();
    const declaration = {
      version: 1, id, declaredAt: new Date().toISOString(), config, plan,
      analysisMethod: 'browser-forwarding-paired-median-v1',
      sourceHash: manifest.source.sourceHash, dependencies: manifest.dependencies.fingerprint,
      configuration: manifest.configuration.fingerprint, browser: manifest.browser.fingerprint,
      machine: manifest.machine, images: manifest.images, controller: manifest.controller, serverStoragePolicy,
    };
    const declarationBytes = Buffer.from(JSON.stringify(declaration, null, 2) + '\n');
    await writeFile(join(dir, 'DECLARATION.json'), declarationBytes);
    manifest.declarationSha256 = sha256(declarationBytes); manifest.declaredAt = declaration.declaredAt;
    manifest.status = 'running'; await save();
    console.log(`experiment=${path}`);
    const processes = new Set<string>();
    for (const [index, entry] of plan.entries()) {
      await guard();
      const resultFile = `${String(index + 1).padStart(4, '0')}-${entry.stackId}-pair-${entry.pair}-${entry.mode}.json`;
      console.log(`[${index + 1}/${plan.length}] ${entry.stackId} pair=${entry.pair} mode=${entry.mode}`);
      const before = captureServerStorage(entry.stackId, 'before-trial');
      const result = await runLoadedChild(join(dir, resultFile), {
        runId: id, entry, runtime: config.runtime, browser: manifest.browser, bundlePath: join(dir, manifest.browser.bundlePath),
      }, environment, config.trialTimeoutMs);
      const storage: any = { policy: serverStoragePolicy, before, after: null,
        window: { startedAt: result.startedAt, finishedAt: result.finishedAt } };
      try { storage.after = captureServerStorage(entry.stackId, 'after-trial'); }
      catch (error) { storage.captureError = String(error); }
      const stored = { ...result, serverStorage: storage };
      await writeFile(join(dir, resultFile), JSON.stringify(stored, null, 2) + '\n');
      manifest.attempts.push({ ...entry, resultFile, logFile: `${resultFile}.log`, inputFile: `${resultFile}.input.json`,
        workerResultFile: result.workerResultAvailable ? `${resultFile}.worker.json` : null, result: stored });
      await save();
      validateServerStoragePair(storage, entry.stackId, 'trial');
      if (result.processGroup.emptyVerified !== true) throw new Error('Loaded experiment cannot continue with an unverified trial group');
      for (const identity of validateLoadedProcessGroup(manifest.controller, stored)) {
        const key = processIdentityKey(identity);
        if (processes.has(key)) throw new Error('Loaded experiment reused a process identity across conditions');
        processes.add(key);
      }
      await guard();
      console.log(`status=${result.status}`);
    }
    await guard();
    if (hash(imageIdentity(config.stacks)) !== hash(manifest.images)) throw new Error('Loaded experiment container images changed');
    manifest.status = 'complete';
  } catch (error) {
    manifest.status = 'invalid'; manifest.error = String(error);
  }
  manifest.finishedAt = new Date().toISOString(); await save();
  if (manifest.status !== 'complete' || manifest.attempts.some((a: any) => a.result.status !== 'completed')) process.exitCode = 1;
  return path;
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--config');
  if (flag < 0 || !process.argv[flag + 1]) throw new Error('Use loaded-campaign.ts --config explicit-diagnostic.json');
  const config = JSON.parse(await readFile(resolve(process.argv[flag + 1]), 'utf8')) as LoadedConfig;
  if (process.argv.includes('--plan')) console.log(JSON.stringify(planLoadedCampaign(config), null, 2));
  else await runLoadedCampaign(config);
  process.exit(process.exitCode ?? 0);
}
