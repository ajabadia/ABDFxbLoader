import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webappDir = path.resolve(__dirname, '..');

const candidateDirs = [
  path.resolve(webappDir, 'node_modules', '@abdsynths', 'shared', 'Components', 'I18n'),
  path.resolve(webappDir, '..', 'node_modules', '@abdsynths', 'shared', 'Components', 'I18n'),
  path.resolve(webappDir, '..', '..', 'ABDShared', 'Components', 'I18n'),
];

let sourceDir = null;
for (const dir of candidateDirs) {
  if (fs.existsSync(path.join(dir, 'index.js'))) {
    sourceDir = dir;
    break;
  }
}

if (!sourceDir) {
  console.warn('[copy-vendor] Warning: @abdsynths/shared/Components/I18n source not found. Skipping vendor sync.');
  process.exit(0);
}

const targetDir = path.resolve(webappDir, 'public', 'vendor', 'abdsynths');
fs.mkdirSync(targetDir, { recursive: true });

// Copiar index.js y locales
fs.copyFileSync(path.join(sourceDir, 'index.js'), path.join(targetDir, 'index.js'));
const srcLocales = path.join(sourceDir, 'locales');
const dstLocales = path.join(targetDir, 'locales');
if (fs.existsSync(srcLocales)) {
  fs.cpSync(srcLocales, dstLocales, { recursive: true });
}

console.log(`[copy-vendor] Copied vendor i18n assets from ${sourceDir} to ${targetDir}`);
