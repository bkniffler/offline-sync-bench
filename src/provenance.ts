import { execFileSync } from 'node:child_process';
import { cpus, hostname, totalmem, release } from 'node:os';
import { readSourceFiles, sha256 } from './source-snapshot.ts';
import { benchmarkRoot } from './paths.ts';
import { stacks } from './stacks.ts';
import type { JsonObject, StackId } from './types.ts';
const command = (program: string, args: string[]) => execFileSync(program, args, { cwd: benchmarkRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function sourceIdentity(): JsonObject {
  const files = [...new Set(command('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0'))]
    .filter(file => /^(src\/|services\/|stacks\/|drivers\/syncular-rust\/(src\/|Cargo\.)|package\.json$|bun\.lock$|tsconfig\.json$)/.test(file)).sort();
  const { files: fileHashes } = readSourceFiles(benchmarkRoot, files);
  return { version: 2, revision: command('git', ['rev-parse', 'HEAD']), dirty: command('git', ['status', '--porcelain']).length > 0, sourceHash: sha256(JSON.stringify(fileHashes)), files: fileHashes };

}
export function machineIdentity(): JsonObject {
  const docker = JSON.parse(command('docker', ['info', '--format', '{{json .}}']));
  return { hostname: hostname(), platform: process.platform, release: release(), arch: process.arch,
    cpuModel: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length, memoryBytes: totalmem(),
    bunVersion: command('bun', ['--version']), nodeVersion: command('node', ['--version']),
    docker: { version: docker.ServerVersion, architecture: docker.Architecture, operatingSystem: docker.OperatingSystem, kernel: docker.KernelVersion, cpuCount: docker.NCPU, memoryBytes: docker.MemTotal, storageDriver: docker.Driver },
  };
}
export function imageIdentity(stackIds: StackId[]): JsonObject {
  const output: JsonObject = {};
  for (const id of stackIds) {
    const stack = stacks.find(s => s.id === id)!;
    const ids = command('docker', ['compose', '-f', stack.composeFile, 'ps', '-q']).split(/\s+/).filter(Boolean);
    if (!ids.length) throw new Error(`No running images found for ${id}`);
    const inspected = JSON.parse(command('docker', ['inspect', ...ids])) as Array<{ Name: string; Image: string; Config: { Image: string }; HostConfig: { NanoCpus: number; Memory: number } }>;
    output[id] = inspected.map(container => ({ name: container.Name, imageId: container.Image, imageReference: container.Config.Image, cpuLimit: container.HostConfig.NanoCpus, memoryLimit: container.HostConfig.Memory }));
  }
  return output;
}
