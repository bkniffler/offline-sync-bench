import type { JsonObject, StackId } from '../types.ts';
import type { Row } from '../contracts/screens.ts';

export interface RecoveryClientConfig {
  stackId: StackId;
  clientId: string;
  actorId: string;
  projectId: string;
  projectIds?: string[];
  dbPath: string;
  syncBaseUrl: string;
  appBaseUrl?: string;
  deliveryMode?: boolean;
  fanout?: boolean;
  conflicts?: boolean;
  conflictRole?: 'writer' | 'peer' | 'observer';
  accessRefresh?: boolean;
  accessNative?: boolean;
  accessAdmin?: boolean;
  recovery?: boolean;
  startup?: boolean;
  reopen?: boolean;
  durableOutbox?: boolean;
  persistentZero?: boolean;
  datasetId?: string;
  attachments?: boolean;
  blobDownloadProxy?: import('../attachments/transfer-gate.ts').BlobDownloadProxy;
}
export interface RecoveryMutation { id: string; title: string; checkVersion?: boolean }
export interface RecoveryObservation { id: string; title: string | null; serverVersion?: number }
export interface RecoveryState { rows: Row[]; pending: number; rejected: number | null; conflicts: number | null; nativeState?: JsonObject }
export interface RecoveryDriver {
  attachments?: import('../attachments/driver.ts').AttachmentOperations;
  read(): Promise<RecoveryState>;
  rows(): Promise<Row[]>;
  firstScreen(): Promise<Row[]>;
  count(): Promise<number>;
  pending(): Promise<number>;
  write(mutations: RecoveryMutation[]): Promise<void>;
  remove(id: string): Promise<void>;
  sync(): Promise<void>;
  initialSync?(): Promise<void>;
  probeSync(): Promise<void>;
  connectDelivery?(): Promise<void>;
  pauseDelivery?(): Promise<void>;
  observeDelivery?(expected: RecoveryObservation[]): Promise<void>;
  fetchBlob?(ref: string): Promise<Uint8Array>;
  blobCacheCount?(): Promise<number>;
  close(): Promise<void>;
  diagnostics: JsonObject;
}
