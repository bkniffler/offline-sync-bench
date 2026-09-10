(globalThis as any).sizeProbe = async (phase: string) => {
 const worker = new Worker('/syncular-worker.js', { type: 'module' });
 try { return await new Promise((resolve, reject) => { worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data); worker.onerror = reject; worker.postMessage(phase); }); }
 finally { worker.terminate(); }
};
