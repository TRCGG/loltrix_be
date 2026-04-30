import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = process.cwd();
const distDir = join(rootDir, 'dist');

mkdirSync(distDir, { recursive: true });

const copyTargets = [
  ['src/loltrix', 'loltrix'],
  ['src/swagger-output.json', 'swagger-output.json'],
  ['package.json', 'package.json'],
];

for (const [source, target] of copyTargets) {
  const sourcePath = join(rootDir, source);

  if (!existsSync(sourcePath)) {
    throw new Error(`Build asset not found: ${source}`);
  }

  cpSync(sourcePath, join(distDir, target), { recursive: true });
}
