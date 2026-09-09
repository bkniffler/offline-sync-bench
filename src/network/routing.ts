import type { StackSpec } from '../types.ts';

export const routingVariable = 'BENCH_CLIENT_ENDPOINTS';
export const endpointFields = ['syncBaseUrl', 'syncRealtimeBaseUrl', 'appBaseUrl', 'mutationBaseUrl'] as const;
export interface ClientRouting { version: 1; stackId: string; networkId: string; endpoints: Record<string, string> }

export function clientEndpoints(stack: StackSpec): Record<string, string> {
  return Object.fromEntries(endpointFields.flatMap(field => stack[field] ? [[field, stack[field]!]] : []));
}
export function parseClientRouting(value: string): ClientRouting | null {
  if (!value) return null;
  const routing = JSON.parse(value) as ClientRouting;
  if (routing?.version !== 1 || typeof routing.stackId !== 'string' || !routing.stackId || !/^[a-f0-9-]{36}$/.test(routing.networkId) || !routing.endpoints || Array.isArray(routing.endpoints)
    || Object.keys(routing).sort().join(',') !== 'endpoints,networkId,stackId,version' || !Object.keys(routing.endpoints).length) throw new Error('Invalid client network routing receipt');
  for (const [name, value] of Object.entries(routing.endpoints)) {
    if (!endpointFields.includes(name as typeof endpointFields[number])) throw new Error('Undeclared client endpoint');
    const url = new URL(value);
    if (!['http:', 'ws:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) throw new Error('Invalid routed client URL');
  }
  return routing;
}
export function applyClientRouting(stack: StackSpec, value: string): StackSpec {
  const routing = parseClientRouting(value);
  if (!routing || routing.stackId !== stack.id) return stack;
  const endpoints = clientEndpoints(stack);
  if (Object.keys(endpoints).sort().join(',') !== Object.keys(routing.endpoints).sort().join(',')) throw new Error('Client endpoint coverage differs from stack configuration');
  for (const [name, original] of Object.entries(endpoints)) {
    const before = new URL(original), after = new URL(routing.endpoints[name]);
    if (before.protocol !== after.protocol || before.pathname.replace(/\/$/, '') !== after.pathname.replace(/\/$/, '')) throw new Error('Client routing changed endpoint protocol or path');
  }
  return { ...stack, ...routing.endpoints };
}
