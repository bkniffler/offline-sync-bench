import { fixtureTasks } from '../contracts/screens.ts';
import type { SeedOptions } from '../types.ts';

export const attachmentSeed: Required<SeedOptions> = { resetFirst: true, orgCount: 1, projectsPerOrg: 1, usersPerOrg: 2, tasksPerProject: 50, membershipsPerProject: 2 };
export const attachmentProject = 'org-1-project-1';
export const attachmentWriter = 'org-1-user-1';
export const attachmentReader = 'org-1-user-2';
export const attachmentTask = String(fixtureTasks(attachmentSeed)[0]!.id);
export const attachmentBytes = 2 * 1024 * 1024;
export const interruptionBytes = 64 * 1024;
export function attachmentPayload(variant: 0 | 1): Uint8Array {
  const bytes = new Uint8Array(attachmentBytes);
  let state = variant === 0 ? 0x6d2b79f5 : 0x1b873593;
  for (let i = 0; i < bytes.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[i] = state & 255; }
  return bytes;
}
// Fixed expected hashes keep validation independent of the generator and avoid
// generating multi-MiB payloads while unrelated client workers initialize.
export const attachmentDigests = [
  '09eaf37b8a729d9bd093f4f57874b18401088cc18ba3906a32b37f137ec5eb05',
  '9c1e875c0df452c86ab6ff63cf16648e3c94eef0738a0af5add2a4fe579c5e76',
];
export const attachmentRef = (variant: 0 | 1) => ({ blobId: `sha256:${attachmentDigests[variant]}`, byteLength: attachmentBytes, mediaType: 'application/octet-stream' });
export const attachmentEntry = (variant: 0 | 1) => ({ id: `attachment-${variant}`, project_id: attachmentProject, task_id: attachmentTask, blob: JSON.stringify(attachmentRef(variant)), created_at_ms: 1_700_000_000_000 + variant });
