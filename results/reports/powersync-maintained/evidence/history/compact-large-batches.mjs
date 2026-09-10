// One-time backlog repair using the pinned service's own compactor.
// Run inside /app/service in the PowerSync 1.25.0 container. The setup mirrors
// its compact CLI; only native clearBatchLimit is increased (5,000 -> 250,000).
import { container } from '@powersync/lib-services-framework';
import * as core from '@powersync/service-core';
import { CoreModule } from '@powersync/service-module-core';
import { DYNAMIC_MODULES } from './lib/util/modules.js';
container.registerDefaults();
const manager = new core.modules.ModuleManager();
manager.register([new CoreModule()]);
manager.registerDynamicModules(DYNAMIC_MODULES);
container.register(core.ModuleManager, manager);
container.register(core.utils.CompoundConfigCollector, new core.utils.CompoundConfigCollector());
const configuration = await core.utils.loadConfig({ config_path: '/config/service.yaml' });
const context = new core.system.ServiceContextContainer({ serviceMode: core.system.ServiceContextMode.COMPACT, configuration });
await manager.initialize(context);
await context.lifeCycleEngine.start();
try {
  const active = (await context.storageEngine.activeBucketStorage.getActiveSyncConfig())?.storage;
  if (!active) throw new Error('No active sync configuration');
  console.log(JSON.stringify({ event: 'start', at: new Date().toISOString(), clearBatchLimit: 250000 }));
  if (!process.argv.includes('--check')) await active.compact({ memoryLimitMB: 1024, clearBatchLimit: 250000, compactParameterData: true });
  console.log(JSON.stringify({ event: 'complete', at: new Date().toISOString() }));
} finally { await context.lifeCycleEngine.stop(); }
