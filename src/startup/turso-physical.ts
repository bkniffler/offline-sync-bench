import { execFileSync } from 'node:child_process';
import { resolveServiceContainerId } from '../stack-manager.ts';

/** File sizes are physical input evidence, not a count of live rows or an
 * accounting of which WAL frames crossed the client transport. Read outside timing. */
export function captureTursoPhysicalFiles() {
  const containerId = resolveServiceContainerId('turso', 'sync');
  const output = execFileSync('docker', ['exec', containerId, 'sh', '-c',
    'for bench_file in server.db server.db-wal; do if [ -f "/data/$bench_file" ]; then stat -c "%n %s" "/data/$bench_file"; else printf "/data/%s absent\\n" "$bench_file"; fi; done'], { encoding: 'utf8', timeout: 10_000 });
  const files = Object.fromEntries(output.trim().split('\n').map(line => {
    const match = /^\/data\/(server\.db(?:-wal)?) (\d+|absent)$/.exec(line);
    if (!match) throw new Error('Cannot read Turso server file sizes');
    return [match[1], { exists: match[2] !== 'absent', bytes: match[2] === 'absent' ? 0 : Number(match[2]) }];
  }));
  return { method: 'server-main-and-wal-file-stat-v1', containerId, files };
}
