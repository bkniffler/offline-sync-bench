import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

export const benchmarkRoot = resolve(srcDir, '..');
export const resultsRoot = join(benchmarkRoot, '.results');
export const tempRoot = join(benchmarkRoot, '.tmp');
export const catalogPath = join(resultsRoot, 'catalog.sqlite');

function normalizeRelativePath(path: string): string {
  return path.split('\\').join('/');
}

export function toBenchmarkRelativePath(path: string): string {
  const relativePath = relative(benchmarkRoot, path);
  return relativePath.length === 0 ? '.' : normalizeRelativePath(relativePath);
}

export function toMarkdownPath(path: string): string {
  const relativePath = toBenchmarkRelativePath(path);
  return relativePath === '.' ? './' : `./${relativePath}`;
}
