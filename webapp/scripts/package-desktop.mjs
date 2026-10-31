import { execSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(rootDir, 'dist-desktop');

console.log('[package-desktop] 1. Preparando directorio de salida...');
mkdirSync(outDir, { recursive: true });

console.log('[package-desktop] 2. Bundling con @vercel/ncc...');
const entryFile = path.resolve(rootDir, 'dist', 'desktop.js');
if (!existsSync(entryFile)) {
  console.log('[package-desktop] Compilando TypeScript primero...');
  execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
}

// Empaquetar todo el backend y node_modules en dist-desktop/index.js
execSync(
  'npx @vercel/ncc build dist/desktop.js -o dist-desktop -e "@nestjs/microservices" -e "@nestjs/websockets" -e "class-transformer" -e "class-validator"',
  { cwd: rootDir, stdio: 'inherit' },
);

// Corregir bug de hoisting en ncc al reescribir import.meta.url en @nestjs/swagger
const bundleFile = path.resolve(outDir, 'index.js');
let bundleCode = readFileSync(bundleFile, 'utf8');
bundleCode = bundleCode.replaceAll(/(\w+_require)\("url"\)/g, 'require("node:url")');
writeFileSync(bundleFile, bundleCode, 'utf8');

console.log('[package-desktop] 3. Generando blob Node SEA...');
const seaConfigPath = path.resolve(outDir, 'sea-config.json');
const seaBlobPath = path.resolve(outDir, 'sea-prep.blob');

writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: path.resolve(outDir, 'index.js'),
      output: seaBlobPath,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
  'utf8',
);

execSync(`node --experimental-sea-config "${seaConfigPath}"`, {
  cwd: rootDir,
  stdio: 'inherit',
});

console.log('[package-desktop] 4. Creando binario base ABDfxbloader.exe...');
const targetExe = path.resolve(outDir, 'ABDfxbloader.exe');
copyFileSync(process.execPath, targetExe);

console.log('[package-desktop] 5. Inyectando blob SEA con postject...');
execSync(
  `npx postject "${targetExe}" NODE_SEA_BLOB "${seaBlobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { cwd: rootDir, stdio: 'inherit' },
);

console.log('[package-desktop] 6. Copiando activos web (public/ y vendor/)...');
const publicSrc = path.resolve(rootDir, 'public');
const publicDest = path.resolve(outDir, 'public');
cpSync(publicSrc, publicDest, { recursive: true });

// Copiar @abdsynths/i18n para resolución del import map
const i18nSrc = path.resolve(rootDir, '..', 'ABDShared', 'Components', 'I18n');
const i18nDest = path.resolve(publicDest, 'vendor', 'abdsynths', 'i18n');
mkdirSync(i18nDest, { recursive: true });
if (existsSync(i18nSrc)) {
  cpSync(i18nSrc, i18nDest, { recursive: true });
}

console.log('[package-desktop] ¡Éxito! Ejecutable standalone generado en:');
console.log(targetExe);
