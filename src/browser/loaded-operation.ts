export interface DiagnosticBrowser {
  call(method: string, params: unknown): Promise<any>;
}

export interface LoadedOperation {
  iteration: number;
  taskId: string;
  title: string;
  controller: { startedAtMs: number; finishedAtMs: number; armMs: number; writerMs: number; readerMs: number; totalMs: number };
  writer: { startedAtMs: number; finishedAtMs: number };
  reader: { browserAtMs: number; row: Record<string, unknown> };
}

// Both experiment conditions use this identical completion path. Live binding
// events are deliberately absent from this interface and cannot settle it.
// This diagnostic span is not the canonical collaboration visibility metric.
export async function measureLoadedOperation(
  writer: DiagnosticBrowser,
  reader: DiagnosticBrowser,
  operation: { iteration: number; taskId: string; title: string },
  timeoutMs = 30_000,
): Promise<LoadedOperation> {
  if (!Number.isSafeInteger(operation.iteration) || !operation.taskId || !operation.title
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid loaded browser operation');
  const startedAtMs = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Loaded browser operation timed out')), timeoutMs);
  });
  const work = async (): Promise<LoadedOperation> => {
    const armed = await reader.call('diagnostic-arm', operation);
    if (armed?.title !== operation.title || armed.armed !== true) throw new Error('Loaded reader arm mismatch');
    const armMs = performance.now() - startedAtMs;
    // Register the native subscription wait before dispatching the write.
    // Completion responses still use CDP in both modes; that common cost is
    // outside the intervention being estimated.
    const visible = reader.call('diagnostic-wait', operation).then(value => ({ value, atMs: performance.now() - startedAtMs }));
    const settled = writer.call('diagnostic-write', operation).then(value => ({ value, atMs: performance.now() - startedAtMs }));
    const [read, write] = await Promise.all([visible, settled]);
    const finishedAtMs = performance.now();
    const matches = (value: any) => value?.taskId === operation.taskId && value.title === operation.title;
    if (!matches(read.value) || read.value.row?.id !== operation.taskId || read.value.row.title !== operation.title
      || !matches(write.value)) throw new Error('Loaded browser completion identity mismatch');
    for (const value of [read.value.browserAtMs, write.value.startedAtMs, write.value.finishedAtMs]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Loaded browser clock missing');
    }
    if (write.value.finishedAtMs < write.value.startedAtMs) throw new Error('Loaded writer clock is not monotonic');
    return {
      ...operation,
      controller: { startedAtMs, finishedAtMs, armMs, writerMs: write.atMs, readerMs: read.atMs, totalMs: finishedAtMs - startedAtMs },
      writer: { startedAtMs: write.value.startedAtMs, finishedAtMs: write.value.finishedAtMs },
      reader: { browserAtMs: read.value.browserAtMs, row: read.value.row },
    };
  };
  try { return await Promise.race([work(), deadline]); }
  finally { clearTimeout(timer); }
}
