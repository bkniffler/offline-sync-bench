export type StackId =
  | 'syncular'
  | 'electric'
  | 'zero'
  | 'powersync'
  | 'replicache'
  | 'livestore';
export type ScenarioId =
  | 'bootstrap'
  | 'online-propagation'
  | 'offline-replay'
  | 'reconnect-storm'
  | 'large-offline-queue'
  | 'local-query'
  | 'permission-change'
  | 'blob-flow';
export type SupportLevel = 'native' | 'emulated' | 'unsupported';
export type BenchmarkStatus = 'completed' | 'failed' | 'unsupported';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface BenchmarkScenario {
  id: ScenarioId;
  title: string;
  summary: string;
  primaryMetrics: string[];
  notes: string[];
}

export interface StackCapabilities {
  bootstrap: SupportLevel;
  onlinePropagation: SupportLevel;
  offlineReplay: SupportLevel;
  reconnectStorm: SupportLevel;
  largeOfflineQueue: SupportLevel;
  localQuery: SupportLevel;
  permissionChange: SupportLevel;
  blobFlow: SupportLevel;
}

export interface StackServices {
  sync: string;
  admin: string;
  postgres: string;
  app?: string;
  storage?: string;
}

export interface StackSpec {
  id: StackId;
  title: string;
  composeFile: string;
  composeProjectName: string;
  buildFingerprintPaths?: string[];
  databaseUrl?: string;
  adminBaseUrl: string;
  syncBaseUrl: string;
  syncRealtimeBaseUrl?: string;
  appBaseUrl?: string;
  services: StackServices;
  capabilities: StackCapabilities;
  notes: string[];
}

export interface SeedOptions {
  resetFirst?: boolean;
  orgCount: number;
  projectsPerOrg: number;
  usersPerOrg: number;
  tasksPerProject: number;
  membershipsPerProject: number;
}

export interface StackStats {
  stackId: string;
  organizations: number;
  projects: number;
  users: number;
  memberships: number;
  tasks: number;
}

export interface StackFixtures {
  stackId: string;
  sampleProjectId: string | null;
  sampleProjectIds: string[];
  sampleOrgId: string | null;
  sampleUserIds: string[];
  sampleTaskId: string | null;
}

export interface TaskRecord {
  id: string;
  orgId: string;
  projectId: string;
  ownerId: string;
  title: string;
  completed: boolean;
  serverVersion: number;
  updatedAt: string;
}

export interface BootstrapScaleResult {
  rowsTarget: number;
  timeToFirstQueryMs: number;
  rowsLoaded: number;
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  bytesTransferred: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  avgCpuPct: number;
  peakCpuPct: number;
  pullRequestMs?: number;
  snapshotFetchMs?: number;
  snapshotDecodeMs?: number;
  localApplyMs?: number;
}

export interface OnlinePropagationSample {
  iteration: number;
  writeAckMs: number;
  mirrorVisibleMs: number;
}

export interface BenchmarkResult {
  runId: string;
  resultId: string;
  stackId: StackId;
  scenarioId: ScenarioId;
  status: BenchmarkStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: JsonObject;
}

export interface BenchmarkRunContext {
  runId: string;
  runDir: string;
}

export interface BenchmarkAdapter {
  stack: StackSpec;
  runBootstrap(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }>;
  runOnlinePropagation(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }>;
  runOfflineReplay(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }>;
  runReconnectStorm(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }>;
  runLargeOfflineQueue(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }>;
  runLocalQuery(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }>;
  runPermissionChange(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }>;
  runBlobFlow(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }>;
}
