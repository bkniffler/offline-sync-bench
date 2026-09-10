import { createJazzContext } from 'jazz-tools/backend';
import { deploy } from 'jazz-tools/dev';
import { app, appId, permissions, jazzSchemaMigration } from '../adapters/jazz-native.ts';
import { validateJazzDeployment } from '../contracts/jazz-deployment.ts';
export { app as fileApp } from '../adapters/jazz-native.ts';
export async function deployFileApp(serverUrl: string) {
  validateJazzDeployment(await deploy({ appId, adminSecret: 'jazz-admin', serverUrl, schema: app.wasmSchema, permissions, migration: jazzSchemaMigration }));
}
export function openFileDb(store: string, serverUrl: string) {
  const context = createJazzContext({ appId, app, permissions,
    serverUrl, backendSecret: 'jazz-backend', env: 'bench', userBranch: 'main', tier: 'local',
    driver: { type: 'persistent', dataPath: store } });
  return { context, db: context.asBackend() };
}
