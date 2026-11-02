#!/usr/bin/env node
/**
 * Comprueba que `src/wizard/wizards-catalog.json` no se ha quedado atrás.
 *
 * El catálogo se regenera a mano (`npm run sync:wizards`) y es fácil olvidarlo:
 * así pasó que la vista decía 268 wizards cuando en disco había 305. Este check
 * escanea el disco igual que el catálogo y compara las dos listas de rutas.
 *
 * Si `_banks/wizards` no existe (un clon sin datos), no es un fallo: se avisa y
 * se sale con 0.
 *
 * Uso:
 *   npm run check:wizards
 */
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..');
const wizardsRoot = path.join(repo, '_banks', 'wizards');
const catalogPath = path.join(root, 'src', 'wizard', 'wizards-catalog.json');
const servicePath = path.join(root, 'dist-test', 'src', 'wizard', 'wizard.service.js');

if (!existsSync(wizardsRoot)) {
  console.log(`check:wizards: no está ${wizardsRoot}, nada que comparar.`);
  process.exit(0);
}

if (!existsSync(servicePath)) {
  console.error('Debes compilar antes: tsc -p tsconfig.test.json');
  process.exit(1);
}

const { WizardService } = await import(pathToFileURL(servicePath).href);
const service = new WizardService({});

const scanned = await service.initIndex({ forceScanDisk: true });

const tempPath = path.join(tmpdir(), `fxb-wizards-check-${process.pid}.json`);
await service.dumpCatalog(tempPath);
const fromDisk = JSON.parse(await readFile(tempPath, 'utf8'));
await rm(tempPath, { force: true });

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));

const paths = (records) =>
  records.map((record) => String(record.sourcePath ?? '').replace(/\\/g, '/').toLowerCase());

const diskPaths = new Set(paths(fromDisk));
const catalogPaths = new Set(paths(catalog));

const missing = [...diskPaths].filter((entry) => !catalogPaths.has(entry));
const extra = [...catalogPaths].filter((entry) => !diskPaths.has(entry));

if (missing.length === 0 && extra.length === 0) {
  console.log(`check:wizards: ${catalog.length} registros, catálogo al día.`);
  process.exit(0);
}

const sample = (list) => list.slice(0, 5).join('\n  ');

console.error(
  [
    'check:wizards: el catálogo no coincide con el disco.',
    `  escaneados en disco: ${scanned}`,
    `  registros en catálogo: ${catalog.length}`,
    `  en disco y no en el catálogo (${missing.length}):\n  ${sample(missing)}`,
    `  en el catálogo y no en disco (${extra.length}):\n  ${sample(extra)}`,
    '',
    'Ejecuta `npm run sync:wizards` y commitea el JSON.',
  ].join('\n'),
);
process.exit(1);
