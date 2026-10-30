import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { LibraryAuditService } from '../src/library/library-audit.service';
import type { LibraryAuditPlugin } from '../src/library/library-audit.types';
import { LibraryPathError } from '../src/library/library.types';
import { META_FILENAME } from '../src/plugin-meta/plugin-meta.constants';
import { PluginMetaService } from '../src/plugin-meta/plugin-meta.service';
import { peWithExportsDll } from './helpers/pe';

const service = new LibraryAuditService(new PluginMetaService());

/**
 * Todos los campos que `vfxinfo.txt` declara en una librería ya montada, con
 * `dll_name` relativo a `plugs\\` como en las librerías reales.
 */
function fullVfxinfo(name: string, dllName = `${name}/${name}.dll`): string {
  return [
    `name: ${name}`,
    'id: 1177630041',
    'version: 1.0',
    `dll_name: ${dllName}`,
    'is_synth: 1',
    'parameter_count: 12',
    'program_count: 128',
    'has_editor: 1',
    'editor_width: 640',
    'editor_height: 480',
    '',
  ].join('\r\n');
}

const FULL_META = {
  common: {
    id: '1177630041',
    name: 'Lead',
    vendor: 'SynthEdit',
    vendor_url: 'https://www.synthedit.com',
    genre: 'Synth',
    name_abbreviation: 'LEAD',
    notes: 'sin problemas conocidos',
    created: '2026-01-01',
  },
  extended: {},
  source: { vfxinfo: true },
  updated: '2026-01-01T00:00:00Z',
};

async function library(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-audit-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'plugs'), { recursive: true });
  return root;
}

interface PluginOptions {
  vfxinfo?: string | null;
  meta?: object | null;
  /** Ruta del DLL relativa a la carpeta del plugin; `null` no escribe ninguno. */
  dll?: string | null;
  dllBytes?: Buffer;
}

async function plugin(root: string, name: string, options: PluginOptions = {}): Promise<string> {
  const dir = path.join(root, 'plugs', name);
  await mkdir(dir, { recursive: true });

  const vfxinfo = options.vfxinfo === undefined ? fullVfxinfo(name) : options.vfxinfo;
  if (vfxinfo !== null) {
    await writeFile(path.join(dir, 'vfxinfo.txt'), Buffer.from(vfxinfo, 'latin1'));
  }

  if (options.meta !== null && options.meta !== undefined) {
    await writeFile(path.join(dir, META_FILENAME), `${JSON.stringify(options.meta, null, 2)}\n`);
  }

  // El DLL vive en la carpeta del plugin y `dll_name` lo nombra relativo a
  // `plugs\\`, como en las librerías ya montadas.
  const dll = options.dll === undefined ? `${name}.dll` : options.dll;
  if (dll !== null) {
    const file = path.join(dir, ...dll.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, options.dllBytes ?? peWithExportsDll(['main']));
  }

  return dir;
}

function find(plugins: readonly LibraryAuditPlugin[], name: string): LibraryAuditPlugin {
  const found = plugins.find((plugin) => plugin.name === name);
  assert.ok(found, `el plugin ${name} debería estar en la auditoría`);
  return found;
}

function fieldsOf(items: readonly { field: string }[]): string[] {
  return items.map((item) => item.field).sort();
}

test('un plugin con vfxinfo, meta y DLL completos no tiene huecos ni propuestas', async (t) => {
  const root = await library(t);
  await plugin(root, 'Lead', { meta: FULL_META });

  const result = await service.audit(root);

  assert.equal(result.total, 1);
  assert.equal(result.complete, 1);
  assert.equal(result.incomplete, 0);
  const lead = find(result.plugins, 'Lead');
  assert.deepEqual(lead.issues, []);
  assert.deepEqual(lead.proposals, []);
  assert.deepEqual(lead.dll, {
    declared: 'Lead/Lead.dll',
    resolved: 'Lead/Lead.dll',
    bitness: 32,
    vstEntrypoint: 'main',
  });
});

test('sin fxbLoader.meta.json propone identidad, género y abreviatura', async (t) => {
  const root = await library(t);
  await plugin(root, 'Lead');

  const result = await service.audit(root);
  const lead = find(result.plugins, 'Lead');

  assert.equal(result.complete, 0, 'la falta de meta deja el plugin incompleto');
  assert.equal(lead.hasMeta, false);
  assert.deepEqual(fieldsOf(lead.issues), ['meta', 'meta.notes', 'meta.vendor', 'meta.vendor_url']);
  assert.deepEqual(fieldsOf(lead.proposals), [
    'meta.genre',
    'meta.id',
    'meta.name',
    'meta.name_abbreviation',
  ]);
  assert.deepEqual(
    lead.proposals.map((proposal) => [proposal.field, proposal.value, proposal.source]),
    [
      ['meta.id', '1177630041', 'vfxinfo'],
      ['meta.name', 'Lead', 'vfxinfo'],
      ['meta.genre', 'Synth', 'derived'],
      ['meta.name_abbreviation', 'LEAD', 'derived'],
    ],
  );
});

test('un meta ya relleno no se vuelve a proponer', async (t) => {
  const root = await library(t);
  await plugin(root, 'Lead', { meta: { ...FULL_META, common: { ...FULL_META.common, id: '', name: '' } } });

  const lead = find((await service.audit(root)).plugins, 'Lead');

  assert.deepEqual(fieldsOf(lead.proposals), ['meta.id', 'meta.name']);
  assert.deepEqual(lead.issues, [], 'un meta vacío en id/name no es un hueco bloqueante');
});

test('detecta un dll_name que no existe y propone la ruta real del DLL', async (t) => {
  const root = await library(t);
  await plugin(root, 'Lead', { vfxinfo: fullVfxinfo('Lead', 'Lead/otro.dll') });

  const lead = find((await service.audit(root)).plugins, 'Lead');

  const issue = lead.issues.find((item) => item.field === 'vfxinfo.dll_name');
  assert.equal(issue?.severity, 'invalid');
  assert.match(issue?.message ?? '', /Lead\/otro\.dll/);
  assert.deepEqual(
    lead.proposals.find((proposal) => proposal.field === 'vfxinfo.dll_name'),
    { field: 'vfxinfo.dll_name', value: 'Lead/Lead.dll', source: 'dll', note: 'ruta relativa a plugs\\' },
  );
  assert.equal(lead.dll.resolved, 'Lead/Lead.dll');
});

test('acepta dll_name relativo a plugs\\ además de relativo al plugin', async (t) => {
  const root = await library(t);
  await plugin(root, 'StringSynth', { meta: FULL_META });

  const synth = find((await service.audit(root)).plugins, 'StringSynth');

  assert.deepEqual(synth.issues, []);
  assert.equal(synth.dll.resolved, 'StringSynth/StringSynth.dll');
});

test('marca un DLL de 64 bits y uno sin entrypoint VST', async (t) => {
  const root = await library(t);
  await plugin(root, 'Bits', { meta: FULL_META, dllBytes: peWithExportsDll(['main'], { bitness: 64 }) });
  await plugin(root, 'NoVst', {
    meta: FULL_META,
    dllBytes: peWithExportsDll(['CalculateSum', 'DoWork']),
  });

  const result = await service.audit(root);

  const bits = find(result.plugins, 'Bits');
  assert.equal(bits.dll.bitness, 64);
  assert.deepEqual(fieldsOf(bits.issues), ['dll.bitness']);
  assert.match(bits.issues[0]?.message ?? '', /64 bits/);

  const noVst = find(result.plugins, 'NoVst');
  assert.equal(noVst.dll.vstEntrypoint, null);
  assert.deepEqual(fieldsOf(noVst.issues), ['dll.vst']);
});

test('un plugin sin vfxinfo ni DLL reporta los huecos y no inventa valores', async (t) => {
  const root = await library(t);
  await plugin(root, 'Huerfano', { vfxinfo: null, dll: null });

  const result = await service.audit(root);
  const orphan = find(result.plugins, 'Huerfano');

  assert.equal(orphan.hasVfxinfo, false);
  assert.equal(orphan.hasMeta, false);
  assert.deepEqual(fieldsOf(orphan.issues), [
    'dll',
    'meta',
    'meta.genre',
    'meta.notes',
    'meta.vendor',
    'meta.vendor_url',
    'vfxinfo',
    'vfxinfo.dll_name',
  ]);
  assert.deepEqual(fieldsOf(orphan.proposals), ['meta.name_abbreviation', 'vfxinfo.name']);
  assert.equal(
    orphan.proposals.find((proposal) => proposal.field === 'vfxinfo.name')?.value,
    'Huerfano',
    'sin otra fuente, el nombre de la carpeta',
  );
  assert.equal(orphan.proposals.some((proposal) => proposal.field === 'vfxinfo.id'), false);
});

test('ordena por nombre y suma los totales de la librería', async (t) => {
  const root = await library(t);
  await plugin(root, 'zeta', { meta: FULL_META });
  await plugin(root, 'Alfa');
  await plugin(root, 'beta');

  const result = await service.audit(root);

  assert.deepEqual(
    result.plugins.map((plugin) => plugin.name),
    ['Alfa', 'beta', 'zeta'],
  );
  assert.equal(result.total, 3);
  assert.equal(result.complete, 1);
  assert.equal(result.incomplete, 2);
  assert.equal(
    result.issueCount,
    result.plugins.reduce((total, plugin) => total + plugin.issues.length, 0),
  );
  assert.equal(
    result.proposalCount,
    result.plugins.reduce((total, plugin) => total + plugin.proposals.length, 0),
  );
  assert.equal(result.plugsPath, path.join(root, 'plugs'));
  assert.equal(Number.isNaN(Date.parse(result.scannedAt)), false);
});

test('rechaza rutas relativas y librerías sin plugs\\', async (t) => {
  const root = await library(t);

  await assert.rejects(() => service.audit('libreria'), LibraryPathError);
  await assert.rejects(() => service.audit('   '), LibraryPathError);
  await assert.rejects(
    () => service.audit(path.join(root, 'NoExiste')),
    /no existe la carpeta plugs/,
  );

  const sinPlugs = await mkdtemp(path.join(tmpdir(), 'fxb-audit-vacia-'));
  t.after(async () => {
    await rm(sinPlugs, { recursive: true, force: true });
  });
  await assert.rejects(() => service.audit(sinPlugs), LibraryPathError);
});

test('una librería vacía se audita sin plugins', async (t) => {
  const root = await library(t);

  const result = await service.audit(root);

  assert.equal(result.total, 0);
  assert.equal(result.complete, 0);
  assert.equal(result.incomplete, 0);
  assert.deepEqual(result.plugins, []);
});
