import { prepareBrowser, assertBrowserUnchanged, validateBrowserIdentity, readCampaignBrowser, validateTrialBrowser, validateClientRuntime, type ClientRuntime, type BrowserIdentity } from './browser/provenance.ts';
import { defaultRecoveryOutageMs, recoveryPolicy } from './contracts/recovery-policy.ts';
import { captureServerStorage, serverStoragePolicy, validateServerStoragePair } from './server-storage.ts';
import { startupSizes, validateStartupSizes, startupSeed } from './contracts/startup.ts';
import { assertConfigurationUnchanged, captureConfiguration, writeConfiguration, type ConfigurationIdentity } from './configuration.ts';
import { writeDependencies, assertDependenciesUnchanged, type DependencyIdentity } from './dependencies.ts';
import { prepareExecutables, assertExecutablesUnchanged, executableEnvironment, validateExecutableProvenance, validateTrialExecutable } from './executables.ts';
import { writeSourceSnapshot } from './source-snapshot.ts';
import { spawn } from 'node:child_process';
import { createWriteStream, statfsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { adapterMethods, isFailed, validateResult } from './execution.ts';
import { sourceIdentity, machineIdentity, imageIdentity } from './provenance.ts';
import { benchmarkRoot, resultsRoot } from './paths.ts';
import { resultProfile } from './profiles.ts';
import { shuffled } from './statistics.ts';
import { stacks } from './stacks.ts';
import { ensureStackUp } from './stack-manager.ts';
import type { BenchmarkResult, JsonObject, ScenarioId, StackId } from './types.ts';
import { networkTrialEnvironment, validateNetworkProfile, withTrialNetwork } from './network/campaign.ts';

export interface CampaignConfig { version: 1; purpose: 'smoke' | 'publication' | 'diagnostic'; seed: number; trials: number; trialTimeoutMs: number; stacks: StackId[]; scenarios: ScenarioId[]; network: JsonObject; stoppingRule: string; runtime?: ClientRuntime; parameters?: { clientCounts?: number[]; startupSizes?: number[]; recoveryOutageMs?: number } }
export function validateCampaign(config: CampaignConfig): void {
  if (config.version !== 1 || !['smoke', 'publication', 'diagnostic'].includes(config.purpose)) throw new Error('Invalid campaign version or purpose');
  for (const [label, value] of [['seed', config.seed], ['trials', config.trials], ['trialTimeoutMs', config.trialTimeoutMs]] as const) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}`);
  if (config.purpose === 'publication' && config.trials < 3) throw new Error('Publication requires at least three independent trials');
  if (!config.stoppingRule?.trim()) throw new Error('Campaign requires a predeclared stopping rule');
  if (!config.stacks?.length || new Set(config.stacks).size !== config.stacks.length || config.stacks.some(id => !stacks.some(s => s.id === id))) throw new Error('Invalid or duplicate stacks');
  if (!config.scenarios?.length || new Set(config.scenarios).size !== config.scenarios.length || config.scenarios.some(id => !(id in adapterMethods))) throw new Error('Invalid or duplicate scenarios');
  const counts = config.parameters?.clientCounts;
  if (config.parameters && Object.keys(config.parameters).some(key => !['clientCounts', 'startupSizes', 'recoveryOutageMs'].includes(key)) || counts !== undefined && (!Array.isArray(counts) || !counts.length || new Set(counts).size !== counts.length || counts.some(n => !Number.isSafeInteger(n) || n < 2 || n > 1000))) throw new Error('Invalid campaign client-count parameters');
  if (config.parameters?.startupSizes !== undefined) validateStartupSizes(config.parameters.startupSizes);
  if (config.parameters?.recoveryOutageMs !== undefined) recoveryPolicy(config.parameters.recoveryOutageMs);
  validateClientRuntime(config.runtime);
  validateNetworkProfile(config.network, config.scenarios);
  if (config.runtime?.kind === 'chromium' && config.network.id !== 'local-loopback') throw new Error('Browser packet-network profiles are not implemented');
}
export function planCampaign(config: CampaignConfig) {
  validateCampaign(config);
  const cases = config.stacks.flatMap(stackId => config.scenarios.map(scenarioId => ({ stackId, scenarioId })));
  return Array.from({ length: config.trials }, (_, trial) => shuffled(cases, config.seed + trial).map(entry => ({ ...entry, trial: trial + 1 }))).flat();
}
export function validateConfiguredParameters(result: BenchmarkResult, parameters?: CampaignConfig['parameters']): void {
  if (result.metadata.workloadContract === 'offline-recovery-v2' && JSON.stringify(result.metadata.outagePolicy) !== JSON.stringify(recoveryPolicy(parameters?.recoveryOutageMs ?? defaultRecoveryOutageMs))) throw new Error('Result recovery outage policy differs from campaign parameters');
  if (result.metadata.workloadContract === 'initial-startup-v1') {
    const expected = parameters?.startupSizes ?? startupSizes;
    if (JSON.stringify(result.metadata.startupSizes ?? startupSizes) !== JSON.stringify(expected) || JSON.stringify(result.metadata.fixture) !== JSON.stringify(expected.map(startupSeed))) throw new Error('Result startup sizes do not match campaign parameters');
  }
  if (result.metadata.workloadContract === 'client-fanout-recovery-v1' && JSON.stringify((result.metadata.fixture as JsonObject)?.clientCounts) !== JSON.stringify(parameters?.clientCounts ?? [5, 25])) throw new Error('Result client counts do not match campaign parameters');
}
export interface CampaignAttempt { trial: number; stackId: StackId; scenarioId: ScenarioId; resultFile: string; result: BenchmarkResult }
export interface CampaignManifest { version: 1; id: string; status: 'running' | 'complete' | 'invalid'; config: CampaignConfig; source: JsonObject; machine: JsonObject; images: JsonObject; executables?: JsonObject; browser?: BrowserIdentity; dependencies?: DependencyIdentity; configuration?: ConfigurationIdentity; serverStoragePolicy?: JsonObject; plan: ReturnType<typeof planCampaign>; attempts: CampaignAttempt[]; startedAt: string; finishedAt?: string; annotations: unknown[]; report?: { findingIds: string[] }; error?: string }
function trialEnvironment(parameters: CampaignConfig['parameters'], executables: JsonObject, runtime?: ClientRuntime, browser?: BrowserIdentity, directory = ''): NodeJS.ProcessEnv {
  return { ...process.env, ...executableEnvironment(executables), BENCH_CAMPAIGN_RUNTIME: JSON.stringify(runtime ?? { kind: 'native-host' }), BENCH_BROWSER_IDENTITY: browser ? JSON.stringify(browser) : '', BENCH_BROWSER_BUNDLE: browser ? join(directory, browser.bundlePath) : '', BENCH_CLIENT_ENDPOINTS: '', BENCH_RECOVERY_OUTAGE_MS: String(parameters?.recoveryOutageMs ?? defaultRecoveryOutageMs), BENCH_CLIENT_COUNTS: parameters?.clientCounts?.join(',') ?? '', BENCH_STARTUP_SIZES: parameters?.startupSizes?.join(',') ?? '' };
}
async function runTrial(path: string, campaignId: string, entry: ReturnType<typeof planCampaign>[number], timeoutMs: number, parameters?: CampaignConfig['parameters'], executables: JsonObject = {}, routing = '', runtime?: ClientRuntime, browser?: BrowserIdentity, directory = ''): Promise<BenchmarkResult> {
  const startedAt = new Date().toISOString(), started = performance.now();
  const log = createWriteStream(`${path}.log`);
  const child = spawn(process.execPath, ['src/trial.ts', path, campaignId, entry.stackId, entry.scenarioId], { cwd: benchmarkRoot, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: networkTrialEnvironment(trialEnvironment(parameters, executables, runtime, browser, directory), routing) });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const childPid = child.pid;
  let killIssued = false;
  let timedOut = false;
  const killGroup = () => { if (!killIssued && childPid && childPid > 1) { killIssued = true; try { process.kill(-childPid, 'SIGKILL'); } catch {} } };
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
  let spawnError: Error | undefined;
  const code = await new Promise<number | null>(resolve => { child.on('error', error => { spawnError = error; resolve(null); }); child.on('close', resolve); });
  clearTimeout(timer); log.end(); killGroup();
  if (!timedOut && !spawnError) {
    try {
      const result = JSON.parse(await readFile(path, 'utf8')) as BenchmarkResult;
      if (result.runId !== campaignId || result.stackId !== entry.stackId || result.scenarioId !== entry.scenarioId) throw new Error('Trial result identity mismatch');
      validateTrialExecutable(result, executables);
      validateTrialBrowser(result, runtime, browser);
      validateResult(result);
      validateConfiguredParameters(result, parameters);
      if (code !== 0 && !isFailed(result.status)) throw new Error(`Trial exited ${code} despite a success result`);
      return result;
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error(String(error));
    }
  }
  return { runId: campaignId, resultId: randomUUID(), stackId: entry.stackId, scenarioId: entry.scenarioId, startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - started,
    status: timedOut ? 'timed-out' : 'invalid', metrics: {}, notes: [timedOut ? `Trial exceeded ${timeoutMs}ms; child process group terminated. See log.` : `Trial failed to produce a valid result: ${spawnError?.message}. See log.`], metadata: runtime?.kind === 'chromium' ? { clientRuntime: 'chromium' } : {} };
}

function assertDiskHeadroom(): void {
  const fs = statfsSync(benchmarkRoot);
  const available = fs.bavail * fs.bsize;
  if (available < 2 * 1024 ** 3) throw new Error(`Insufficient disk headroom: ${(available / 1024 ** 3).toFixed(2)} GiB available; require at least 2 GiB before another attempt. No trial was launched.`);
}

export async function runCampaign(config: CampaignConfig): Promise<string> {
  assertDiskHeadroom();
  const plan = planCampaign(config);
  for (const id of config.stacks) await ensureStackUp(id);
  const nativeStacks = config.runtime?.kind === 'chromium' ? [] : config.stacks;
  const id = `campaign-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = join(resultsRoot, id);
  await mkdir(dir, { recursive: true });
  if (nativeStacks.includes('syncular-rust')) console.log(`preparing-rust-build=${dir}`);
  const executables = prepareExecutables(nativeStacks, dir);
  validateExecutableProvenance(executables, nativeStacks, config.purpose === 'publication', sourceIdentity());
  const manifest: CampaignManifest = { version: 1, id, status: 'running', config, source: sourceIdentity(), machine: machineIdentity(), images: imageIdentity(config.stacks), executables, serverStoragePolicy, plan, attempts: [], startedAt: new Date().toISOString(), annotations: [] };
  await writeSourceSnapshot(benchmarkRoot, dir, manifest.source);
  const packageManifests = Object.keys(manifest.source.files as JsonObject).filter(path => path === 'package.json' || path.endsWith('/package.json'));
  manifest.dependencies = await writeDependencies(benchmarkRoot, dir, packageManifests);
  if (config.runtime?.kind === 'chromium') {
    manifest.browser = await prepareBrowser(dir, config.runtime, manifest.source, manifest.dependencies);
    await readCampaignBrowser(dir, manifest.browser, config.runtime, manifest.source, manifest.dependencies, JSON.parse(await readFile(join(dir, manifest.dependencies.path), 'utf8')));
  }
  validateBrowserIdentity(manifest.browser, config.runtime, manifest.source, manifest.dependencies);
  const checkBrowser = async () => {
    if (config.runtime?.kind !== 'chromium') return;
    assertBrowserUnchanged(config.runtime, manifest.browser!);
    await readCampaignBrowser(dir, manifest.browser!, config.runtime, manifest.source, manifest.dependencies!);
  };
  manifest.configuration = await writeConfiguration(dir, captureConfiguration(config.stacks, manifest.source, trialEnvironment(config.parameters, executables, config.runtime, manifest.browser, dir)));
  const path = join(dir, 'CAMPAIGN.json');
  const save = () => writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  await save();
  console.log(`campaign=${path}`);
  try {
    for (const [index, entry] of plan.entries()) {
      assertDiskHeadroom();
      if (sourceIdentity().sourceHash !== manifest.source.sourceHash) throw new Error('Benchmark source changed during campaign; refusing to mix implementations');
      assertExecutablesUnchanged(executables);
      await checkBrowser();
      assertDependenciesUnchanged(benchmarkRoot, manifest.dependencies!, packageManifests);
      assertConfigurationUnchanged(config.stacks, manifest.source, manifest.configuration!, trialEnvironment(config.parameters, executables, config.runtime, manifest.browser, dir));
      const resultFile = `${String(index + 1).padStart(4, '0')}-${entry.stackId}-${entry.scenarioId}.json`;
      console.log(`[${index + 1}/${plan.length}] ${entry.stackId}/${entry.scenarioId} trial=${entry.trial}`);
      const storageBefore = captureServerStorage(entry.stackId, 'before-trial');
      const result = await withTrialNetwork(config.network, { runId: id, stackId: entry.stackId, scenarioId: entry.scenarioId }, routing => runTrial(join(dir, resultFile), id, entry, config.trialTimeoutMs, config.parameters, executables, routing, config.runtime, manifest.browser, dir));
      result.metadata.serverStorage = { policy: serverStoragePolicy, before: storageBefore as unknown as JsonObject, after: null, window: { startedAt: result.startedAt, finishedAt: result.finishedAt } };
      try { (result.metadata.serverStorage as JsonObject).after = captureServerStorage(entry.stackId, 'after-trial') as unknown as JsonObject; }
      catch (error) { (result.metadata.serverStorage as JsonObject).captureError = String(error); }
      result.metadata.profile = resultProfile(result, { ...manifest, network: config.network });
      manifest.attempts.push({ ...entry, resultFile, result });
      await writeFile(join(dir, resultFile), `${JSON.stringify(result, null, 2)}\n`);
      await save();
      validateServerStoragePair(result.metadata.serverStorage as JsonObject, entry.stackId, 'trial');
      assertExecutablesUnchanged(executables);
      await checkBrowser();
      assertDependenciesUnchanged(benchmarkRoot, manifest.dependencies!, packageManifests);
      assertConfigurationUnchanged(config.stacks, manifest.source, manifest.configuration!, trialEnvironment(config.parameters, executables, config.runtime, manifest.browser, dir));
      console.log(`status=${result.status}`);
    }
    if (sourceIdentity().sourceHash !== manifest.source.sourceHash) throw new Error('Benchmark source changed during campaign');
    if (JSON.stringify(imageIdentity(config.stacks)) !== JSON.stringify(manifest.images)) throw new Error('Container images or resource limits changed during campaign');
    assertExecutablesUnchanged(executables);
    await checkBrowser();
    assertDependenciesUnchanged(benchmarkRoot, manifest.dependencies!, packageManifests);
    assertConfigurationUnchanged(config.stacks, manifest.source, manifest.configuration!, trialEnvironment(config.parameters, executables, config.runtime, manifest.browser, dir));
    manifest.status = 'complete';
  } catch (error) { manifest.status = 'invalid'; manifest.error = error instanceof Error ? error.message : String(error); }
  manifest.finishedAt = new Date().toISOString(); await save();
  if (manifest.status !== 'complete' || manifest.attempts.some(a => isFailed(a.result.status))) process.exitCode = 1;
  return path;
}
if (import.meta.main) {
  const flag = process.argv.indexOf('--config');
  if (flag < 0 || !process.argv[flag + 1]) throw new Error('Use --config campaigns/smoke.json or an explicit campaign file');
  const config = JSON.parse(await readFile(resolve(process.argv[flag + 1]), 'utf8')) as CampaignConfig;
  if (process.argv.includes('--plan')) console.log(JSON.stringify(planCampaign(config), null, 2));
  else await runCampaign(config);
  process.exit(process.exitCode ?? 0);
}
