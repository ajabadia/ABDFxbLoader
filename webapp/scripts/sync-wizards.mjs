#!/usr/bin/env node
/**
 * Sincroniza y re-empaqueta el catálogo JSON de wizards (wizards-catalog.json)
 * escaneando las carpetas en _banks/wizards.
 *
 * Uso:
 *   npm run sync:wizards
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distServicePath = path.join(root, 'dist-test', 'src', 'wizard', 'wizard.service.js');

if (!existsSync(distServicePath)) {
  console.error('Debes compilar antes: tsc -p tsconfig.test.json');
  process.exit(1);
}

const { WizardService } = await import(`file://${distServicePath.replace(/\\/g, '/')}`);
const service = new WizardService({});

console.log('Escaneando _banks/wizards en disco...');
const count = await service.initIndex({ forceScanDisk: true });
console.log(`Indexados ${count} wizards desde disco.`);

const outPath = path.join(root, 'src', 'wizard', 'wizards-catalog.json');
await service.dumpCatalog(outPath);
console.log(`Catálogo guardado en: ${outPath} (${count} registros).`);
