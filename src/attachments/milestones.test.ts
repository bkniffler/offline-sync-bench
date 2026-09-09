import { expect, test } from 'bun:test';
import { measureAttachmentSync } from './milestones.ts';
test('attachment visibility is captured before a slower writer acknowledgment and after observation is armed', async () => {
  let armed = false;
  const result = await measureAttachmentSync(async ready => { armed = true; ready(); await Bun.sleep(20); return [{ id: 'attachment-0' }]; }, async uploaded => {
    expect(armed).toBe(true); uploaded({ route: 'presigned', byteLength: 2_097_152 }); await Bun.sleep(100); return { applied: ['commit'] };
  });
  expect(result.metadataVisibleMs).toBeLessThan(result.serverAcceptedMs / 2);
  expect(result.uploadMs).toBeLessThan(result.serverAcceptedMs);
  expect(result.rows).toEqual([{ id: 'attachment-0' }]);
});
