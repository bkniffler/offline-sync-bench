import { adapterMethods } from '../execution.ts';
import { getStack } from '../stacks.ts';
import { createUnsupportedScenarioResult } from '../unsupported.ts';
import type { BenchmarkAdapter, StackId } from '../types.ts';
import type { BrowserIdentity, ChromiumRuntime } from './provenance.ts';
import { runBrowserCollaboration } from './run.ts';

export function createBrowserAdapter(stackId: StackId, runtime: ChromiumRuntime, identity: BrowserIdentity, bundlePath: string): BenchmarkAdapter {
  const adapter: any = { stack: getStack(stackId) };
  for (const [scenario, method] of Object.entries(adapterMethods)) adapter[method] = async () => {
    const result = createUnsupportedScenarioResult({ implementation: 'browser-case-not-implemented', coverage: 'not-implemented', notes: [`${stackId}/${scenario} is not implemented in the Chromium runtime. Native-host coverage does not establish browser coverage.`] });
    result.metadata.clientRuntime = 'chromium'; return result;
  };
  if (stackId === 'electric' || stackId === 'zero') adapter.runOnlinePropagation = () => runBrowserCollaboration(stackId, runtime, identity, bundlePath);
  return adapter;
}
