import { validateServerStoragePair } from '../server-storage.ts';
import { validateTursoPhysicalState } from './turso-physical.ts';
import { arrayScreenQuery, assertRows, ContractError, fixtureTask, fixtureTasks, hash, taskRecord, type Row } from './screens.ts';
import type { BenchmarkResult, JsonObject, SeedOptions } from '../types.ts';

export const STARTUP_CONTRACT = 'initial-startup-v1';
export const startupSizes = [1_000, 10_000, 100_000];
export const startupScaleCatalog = [...startupSizes, 500_000, 1_000_000];
export function validateStartupSizes(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.some((count, i) => !Number.isSafeInteger(count) || !startupScaleCatalog.includes(count) || i > 0 && count <= value[i - 1])) throw new ContractError('Startup sizes must be distinct ascending entries from the declared scale catalog');
  return [...value];
}
export function configuredStartupSizes(): number[] {
  const encoded = process.env.BENCH_STARTUP_SIZES;
  return validateStartupSizes(encoded ? encoded.split(',').map(Number) : startupSizes);
}
export const startupConditions = ['process-cold', 'warm'] as const;
export const startupObservationPolicy = {
  version: 3, screenPollDelayMs: 5, progressCountDelayMs: 5_000, timeoutMs: 90_000,
  fullDataTrigger: 'single-native-completion-and-first-screen-candidates-or-complete-progress-count',
  screen: 'query-until-first-correct-screen',
} as const;
export const startupProfile = {
  client: 'fresh-process-and-new-product-file',
  server: ['process-cold:sync-service-restarted-and-healthy', 'warm:second-client-after-complete-validated-cold-bootstrap'],
  persistentServerStorage: 'retained', osCaches: 'not-cleared',
  observation: 'parent-monotonic-event-receipt; native screen queries during sync; throttled progress counts and candidate snapshots after native completion and first correct screen',
  observationPolicy: startupObservationPolicy,
  resources: 'client descendants only; controller and sampler excluded',
  materialization: 'full local snapshot read, then exact full-dataset validation outside timing',
};
export const startupMemoryProfile = { ...startupProfile,
  client: 'fresh-process-and-new-memory-cache', persistence: 'none; no process durability claim',
  initialization: 'product client and native read state constructed; sync may begin during construction',
  observation: 'parent-monotonic-event-receipt; declared local screen queries over SDK memory cache; throttled progress counts and candidate snapshots after native completion and first correct screen',
};
export const startupSeed = (count: number): Required<SeedOptions> => ({ resetFirst: true, orgCount: 1, projectsPerOrg: 1, usersPerOrg: 2, tasksPerProject: count, membershipsPerProject: 2 });
// The descending list's 50 matches fit within the final 150 fixture rows.
// Avoid retaining a 100k-row reference corpus during resource measurement.
export const startupScreen = (count: number) => arrayScreenQuery('list', { tasks: Array.from({ length: Math.min(count, 150) }, (_, i) => fixtureTask(startupSeed(count), 0, Math.max(0, count - 150) + i)) });
export const startupFixture = startupSizes.map(startupSeed);
export const startupTaskRows = (count: number) => fixtureTasks(startupSeed(count)).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
export const startupKey = (condition: string, count: number) => `startup_${condition.replaceAll('-', '_')}_${count}`;

/** Full materialization is a set of records. Normalize enumeration order only
 * after the captured snapshot leaves the timed window; screen order is strict. */
export function validateStartupSnapshot(snapshot: Row[], count: number): string {
  const normalized = snapshot.map(taskRecord).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  return assertRows('initial startup dataset', normalized, startupTaskRows(count));
}

export function validateStartupResult(result: Pick<BenchmarkResult, 'scenarioId' | 'metadata' | 'metrics'> & Partial<Pick<BenchmarkResult, 'stackId'>>) {
  const { metadata, metrics } = result;
  const sizes = validateStartupSizes(metadata.startupSizes ?? startupSizes);
  const memory = hash(metadata.startupProfile) === hash(startupMemoryProfile);
  if (result.scenarioId !== 'bootstrap' || metadata.workloadContract !== STARTUP_CONTRACT || hash(metadata.fixture) !== hash(sizes.map(startupSeed)) || !memory && hash(metadata.startupProfile) !== hash(startupProfile)) throw new ContractError('Initial startup contract mismatch');
  const cases = metadata.cases as JsonObject[];
  if (!Array.isArray(cases) || cases.length !== sizes.length * 2) throw new ContractError('Initial startup cases missing');
  const pids = new Set<number>(), stores = new Set<string>(), caches = new Set<string>(), nativeClients = new Set<string>();
  for (const [i, count] of sizes.entries()) {
    const expected = startupTaskRows(count), screen = arrayScreenQuery('list', { tasks: expected });
    const dataDigest = assertRows('expected startup data', expected, expected), screenDigest = assertRows('expected startup screen', screen, screen);
    for (const [j, condition] of startupConditions.entries()) {
      const item = cases[i * 2 + j];
      if (item.count !== count || item.condition !== condition) throw new ContractError('Startup cases reordered or duplicated');
      const validation = item.validation as JsonObject;
      if (validation?.dataDigest !== dataDigest || validation.screenDigest !== screenDigest || validation.taskCount !== count || validation.pending !== 0 || validation.rejected !== null && validation.rejected !== 0 || validation.conflicts !== null && validation.conflicts !== 0) throw new ContractError('Startup full-data or screen validation missing');
      if (!Number.isSafeInteger(item.pid) || Number(item.pid) < 1 || pids.has(Number(item.pid))) throw new ContractError('Startup requires a fresh process');
      pids.add(Number(item.pid));
      if (memory) {
        const cache = item.cache as JsonObject, diagnostics = item.diagnostics as JsonObject;
        if (item.store !== null || item.storeAbsentBeforeLaunch !== null || !cache || typeof cache.id !== 'string' || !cache.id || caches.has(cache.id) || cache.kind !== 'memory' || cache.rows !== 0 || cache.clientConstructed !== true || hash(cache) !== hash(diagnostics?.initialCache) || diagnostics?.persistence !== startupMemoryProfile.persistence) throw new ContractError('Memory startup requires a distinct empty constructed SDK cache and cannot claim a product file');
        caches.add(cache.id);
        const storage = diagnostics.localStorage;
        if (result.stackId && (result.stackId === 'electric' ? storage !== 'electric-shape-memory' : result.stackId === 'zero' ? storage !== 'zero-memory' : true)) throw new ContractError('Startup memory storage does not match the adapter');
        if (storage === 'electric-shape-memory') {
          if (cache.syncStarted !== true) throw new ContractError('Electric startup requires its SDK stream to be constructed');
        } else if (storage === 'zero-memory') {
          const views = item.views as JsonObject;
          if (cache.kvStore !== 'mem' || cache.storageKey !== cache.id || cache.screenRows !== 0 || typeof cache.nativeClientId !== 'string' || !cache.nativeClientId || nativeClients.has(cache.nativeClientId)) throw new ContractError('Zero startup requires distinct native clients and empty memory views');
          nativeClients.add(cache.nativeClientId);
          if (views?.all !== 'complete' || views.screen !== 'complete' || views.nativeClientId !== cache.nativeClientId) throw new ContractError('Zero startup requires both native queries to complete');
        } else throw new ContractError('Unknown startup memory storage');
      } else {
        if (typeof item.store !== 'string' || !item.store || stores.has(item.store) || item.storeAbsentBeforeLaunch !== true) throw new ContractError('Startup requires a fresh product store');
        stores.add(item.store);
      }
      if (result.stackId === 'electric-tanstack' || (item.diagnostics as JsonObject)?.localStorage === 'tanstack-node-sqlite-cache') {
        const persistence = item.persistence as JsonObject, initial = persistence?.initial as JsonObject, snapshot = persistence?.snapshot as JsonObject;
        if (memory || !initial || !snapshot || typeof initial.collectionId !== 'string' || !initial.collectionId || caches.has(initial.collectionId) || initial.store !== item.store || initial.activeRows !== 0 || initial.persistedRows !== 0 || hash(initial) !== hash((item.diagnostics as JsonObject)?.initialCache)) throw new ContractError('TanStack startup initial persistence proof missing');
        caches.add(initial.collectionId);
        if (snapshot.method !== 'native-sqlite-adapter-scanRows' || snapshot.collectionId !== initial.collectionId || snapshot.store !== item.store || snapshot.activeRows !== count || snapshot.persistedRows !== count || !Number.isSafeInteger(snapshot.scans) || Number(snapshot.scans) < 1 || persistence.storeExists !== true || typeof persistence.storeBytes !== 'number' || persistence.storeBytes <= 0 || validation.activeDataDigest !== dataDigest || validation.persistedDataDigest !== dataDigest) throw new ContractError('TanStack startup must validate the complete persisted and active datasets');
      }
      if (result.stackId === 'jazz-v2' || (item.diagnostics as JsonObject)?.localStorage === 'jazz-napi-sqlite-file') {
        const seed = item.seeding as JsonObject, diagnostics = item.diagnostics as JsonObject, reader = diagnostics?.reader as JsonObject;
        const query = item.nativeQuery as JsonObject, file = item.file as JsonObject;
        if (memory || !seed || !reader || diagnostics.localStorage !== 'jazz-napi-sqlite-file' || seed.taskCount !== count || seed.tasksDigest !== dataDigest || seed.edgeDurable !== true || seed.productVersion !== diagnostics.productVersion || !seed.productVersion) throw new ContractError('Jazz startup requires a complete independently seeded fixture');
        if (!Number.isSafeInteger(seed.pid) || Number(seed.pid) < 2 || seed.pid === item.pid || seed.store === item.store || typeof seed.store !== 'string' || !seed.store || reader.pid !== item.pid || reader.store !== item.store || reader.datasetId !== seed.datasetId || typeof seed.datasetId !== 'string' || !seed.datasetId.startsWith('startup-') || reader.initialRows !== 0 || reader.transportConnected !== false) throw new ContractError('Jazz startup reader must begin in a distinct empty product store');
        if (!Number.isSafeInteger(seed.parentPid) || Number(seed.parentPid) < 2 || seed.parentPid !== reader.parentPid || seed.parentPid === seed.pid || seed.exitCode !== 0 || seed.exitSignal !== null || seed.exitObservedBeforeReaderSpawn !== true) throw new ContractError('Jazz startup seeder must exit before reader launch');
        const times = [seed.completedAt, seed.exitedAt, reader.startedAt].map(value => Date.parse(String(value)));
        if (times.some(time => !Number.isFinite(time)) || times[0] > times[1] || times[1] > times[2]) throw new ContractError('Jazz startup seeder/reader lifecycle order differs');
        if (condition === 'warm' && hash(seed) !== hash(cases[i * 2].seeding) || condition === 'process-cold' && cases.slice(0, i * 2).some(previous => (previous.seeding as JsonObject)?.datasetId === seed.datasetId)) throw new ContractError('Jazz startup must share the cold/warm fixture and isolate each scale');
        if (query?.edgeComplete !== true || query.edgeRows !== count || file?.exists !== true || typeof file.bytes !== 'number' || file.bytes <= 0) throw new ContractError('Jazz startup native query completion or product file evidence missing');
        const subscription = item.screenSubscription as JsonObject, initialScreen = diagnostics.screenObservation as JsonObject;
        if (subscription?.method !== 'native-sdk-subscription-manager-v1' || subscription.initialScreenRows !== 0 || subscription.initialQueries !== 1 || subscription.subscriptions !== 1 || !Number.isSafeInteger(subscription.updates) || Number(subscription.updates) < 1 || !Number.isSafeInteger(subscription.screenReads) || Number(subscription.screenReads) < Number((item.observation as JsonObject)?.screenQueries) || subscription.rows !== 50 || subscription.managerRows !== 50 || initialScreen?.method !== subscription.method || initialScreen.initialScreenRows !== 0 || initialScreen.initialQueries !== 1 || initialScreen.subscriptions !== 1) throw new ContractError('Jazz startup native screen subscription evidence missing');
        const resources = item.resources as JsonObject, samples = resources?.samples as JsonObject[];
        if (resources?.rootPid !== reader.parentPid || !Array.isArray(samples) || !samples.some(sample => (sample.processes as JsonObject[])?.some(p => p.pid === reader.pid)) || samples.some(sample => !Array.isArray(sample.processes) || (sample.processes as JsonObject[]).some(p => p.pid === seed.pid || p.pid === reader.parentPid))) throw new ContractError('Jazz startup resources must exclude its seeder and controller');
      }
      const service = item.service as JsonObject, before = service?.before as JsonObject, ready = service?.ready as JsonObject, after = service?.after as JsonObject;
      if (hash(ready) !== hash(after)) throw new ContractError('Startup service restarted or became unhealthy during client startup');
      if (!before?.containerId || before.containerId !== after?.containerId || after.running !== true || after.health !== 'healthy' || !Number.isFinite(Date.parse(String(after.startedAt)))) throw new ContractError('Startup service state missing');
      if (condition === 'process-cold' ? before.startedAt === after.startedAt : before.startedAt !== after.startedAt || before.startedAt !== ((cases[i * 2].service as JsonObject).after as JsonObject).startedAt) throw new ContractError('Startup cold/warm server sequence invalid');
      if (item.serverStorage && result.stackId) validateServerStoragePair(item.serverStorage as JsonObject, result.stackId, 'startup-client');
      if (result.stackId === 'turso') validateTursoPhysicalState(item.physicalState as JsonObject, after.containerId);
      const resources = item.resources as JsonObject;
      if (resources?.includeRoot !== false || resources?.method !== 'external-ps-process-tree-v1' || !Array.isArray(resources.samples) || !resources.samples.length) throw new ContractError('Startup resource samples missing');
      const key = startupKey(condition, count);
      for (const milestone of ['initialized', 'first_screen', 'full_data']) if (typeof metrics[`${key}_${milestone}_ms`] !== 'number' || !Number.isFinite(metrics[`${key}_${milestone}_ms`]) || metrics[`${key}_${milestone}_ms`]! < 0) throw new ContractError('Startup milestone missing');
      if (metrics[`${key}_initialized_ms`]! > metrics[`${key}_first_screen_ms`]! || metrics[`${key}_initialized_ms`]! > metrics[`${key}_full_data_ms`]!) throw new ContractError('Startup milestone precedes initialization');
      const observation = item.observation as JsonObject;
      if (observation?.syncFinished !== true || !Number.isSafeInteger(observation.polls) || Number(observation.polls) < 1 || !Array.isArray(observation.observations) || !observation.observations.some(o => o && typeof o === 'object' && !Array.isArray(o) && o.rows === count && o.screenCorrect === true)) throw new ContractError('Startup observation evidence missing');
      const full = observation.fullSnapshot as JsonObject, counts = observation.countQueries as JsonObject[], candidates = observation.candidateSnapshots as JsonObject[];
      const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      if (hash(observation.policy) !== hash(startupObservationPolicy) || !Number.isSafeInteger(observation.screenQueries) || Number(observation.screenQueries) < 1 || !nonnegative(observation.syncCompletedAtMs) || !Array.isArray(counts) || !full || !nonnegative(full.startMs) || !nonnegative(full.durationMs) || full.rows !== count || !['sync-complete', 'first-screen', 'progress-count'].includes(String(full.trigger))) throw new ContractError('Startup observation policy or native completion evidence missing');
      if (Number(observation.syncCompletedAtMs) > startupObservationPolicy.timeoutMs || Number(full.startMs) + Number(full.durationMs) > startupObservationPolicy.timeoutMs) throw new ContractError('Startup observation exceeded its declared deadline');
      for (const [index, query] of counts.entries()) {
        if (!nonnegative(query.startMs) || !nonnegative(query.durationMs) || !Number.isSafeInteger(query.rows) || Number(query.rows) < 0 || Number(query.rows) > count || Number(query.startMs) + Number(query.durationMs) > Number(full.startMs)) throw new ContractError('Startup progress count evidence invalid');
        if (index && Number(query.startMs) < Number(counts[index - 1].startMs) + Number(counts[index - 1].durationMs) + startupObservationPolicy.progressCountDelayMs - 1) throw new ContractError('Startup progress counts violate the declared interval');
      }
      if (!Array.isArray(candidates) || !candidates.length || hash(candidates.at(-1)) !== hash(full)) throw new ContractError('Startup candidate snapshots missing or inconsistent');
      const hints = new Set<string>();
      for (const [index, candidate] of candidates.entries()) {
        if (!nonnegative(candidate.startMs) || !nonnegative(candidate.durationMs) || !Number.isSafeInteger(candidate.rows) || Number(candidate.rows) < 0 || Number(candidate.rows) > count || Number(candidate.startMs) + Number(candidate.durationMs) > startupObservationPolicy.timeoutMs || index < candidates.length - 1 && candidate.rows === count || index > 0 && Number(candidate.startMs) < Number(candidates[index - 1].startMs) + Number(candidates[index - 1].durationMs)) throw new ContractError('Startup candidate snapshot trace invalid');
        if (candidate.trigger === 'progress-count') {
          if (candidate.rows !== count || counts.at(-1)?.rows !== count || Number(counts.at(-1)?.startMs) + Number(counts.at(-1)?.durationMs) > Number(candidate.startMs)) throw new ContractError('Startup full snapshot count trigger is not established');
        } else if (candidate.trigger === 'sync-complete' || candidate.trigger === 'first-screen') {
          if (hints.has(candidate.trigger)) throw new ContractError('Startup snapshot hint repeated');
          hints.add(candidate.trigger);
          const triggerTime = candidate.trigger === 'sync-complete' ? observation.syncCompletedAtMs : (observation.observations as JsonObject[]).find(o => o.kind === 'first-screen' && o.screenCorrect === true)?.atMs;
          if (!nonnegative(triggerTime) || triggerTime > Number(candidate.startMs)) throw new ContractError('Startup snapshot hint is not established');
        } else throw new ContractError('Startup snapshot trigger unknown');
      }

    }
  }
  if ((metadata.resources as JsonObject)?.includeRoot !== false || (metadata.resources as JsonObject)?.method !== 'external-ps-process-tree-v1') throw new ContractError('Startup resource scope missing');
}
