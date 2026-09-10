export type NativeFileStack = 'powersync' | 'jazz-v2';
export interface NativeFileConfig {
  stackId: NativeFileStack; phase: 'writer' | 'fresh' | 'interrupted'; store: string;
  datasetId: string; serverUrl: string; appUrl?: string; variant?: 0 | 1;
  objects?: Array<{ id: string; key: string; put: string; get: string }>;
}
