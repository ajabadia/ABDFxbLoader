import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { LibraryAuditService } from '../src/library/library-audit.service';
import type { LibraryAuditPlugin } from '../src/library/library-audit.types';
import { LibraryPathError, PluginNotFoundError } from '../src/library/library.types';
import { META_FILENAME } from '../src/plugin-meta/plugin-meta.constants';
import { PluginMetaService } from '../src/plugin-meta/plugin-meta.service';
import type { WizardService } from '../src/wizard/wizard.service';
import type { WizardRecord } from '../src/wizard/wizard.types';
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

test('apply escribe el meta propuesto y no respalda si el archivo no existía', async (t) => {
  const root = await library(t);
  const dir = await plugin(root, 'Lead');

  const result = await service.apply({ libraryRoot: root, plugin: 'Lead' });

  assert.equal(result.plugin, 'Lead');
  assert.deepEqual(
    result.applied.map(({ field, value }) => [field, value]),
    [
      ['meta.id', '1177630041'],
      ['meta.name', 'Lead'],
      ['meta.genre', 'Synth'],
      ['meta.name_abbreviation', 'LEAD'],
    ],
  );
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.backups, [], 'no había archivo que respaldar');
  assert.equal(result.vfxinfoPath, null);
  assert.equal(result.metaPath, path.join(dir, META_FILENAME));
  assert.deepEqual(result.warnings, []);

  const written = JSON.parse(await readFile(path.join(dir, META_FILENAME), 'utf8'));
  assert.deepEqual(written.common, {
    id: '1177630041',
    name: 'Lead',
    vendor: '',
    vendor_url: '',
    genre: 'Synth',
    name_abbreviation: 'LEAD',
    notes: '',
    created: '',
  });
  assert.deepEqual(written.extended, {});
  assert.deepEqual(written.source, { vfxinfo: false });

  // Lo aplicado ya no se vuelve a proponer.
  assert.deepEqual(find((await service.audit(root)).plugins, 'Lead').proposals, []);
});

test('apply rellena el encabezado del vfxinfo sin tocar bloques ni finales de línea', async (t) => {
  const root = await library(t);
  const vfxinfo = [
    'name: Lead',
    'id: 1177630041',
    'dll_name: Lead/Lead.dll',
    'is_synth: 1',
    'parameter_count: 12',
    'program_count: 128',
    'has_editor: 1',
    'editor_width: 640',
    'editor_height: 480',
    '',
    'files_to_copy:',
    '...',
    '/Program Files/Lead/extra.dat',
    '...',
    '',
    'notes:',
    '...',
    'version: esto es una nota, no un campo del encabezado',
    '...',
    '',
  ].join('\r\n');
  const dir = await plugin(root, 'Lead', { vfxinfo, meta: FULL_META });
  const file = path.join(dir, 'vfxinfo.txt');

  const result = await service.apply({ libraryRoot: root, plugin: 'Lead' });

  assert.deepEqual(result.applied, [{ field: 'vfxinfo.version', value: '1' }]);
  assert.deepEqual(result.backups, [`${file}.bak`]);
  const applied = await readFile(file, 'latin1');
  assert.match(applied, /^version: 1\r$/m);
  // La línea de la nota no es un campo: sigue igual y dentro de su bloque.
  assert.match(applied, /^version: esto es una nota, no un campo del encabezado\r$/m);
  assert.match(
    applied,
    /files_to_copy:\r\n\.\.\.\r\n\/Program Files\/Lead\/extra\.dat\r\n\.\.\./,
  );
  assert.equal(/[^\r]\n/.test(applied), false, 'no debe mezclar finales de línea');
  assert.equal(await readFile(`${file}.bak`, 'latin1'), vfxinfo);
});

test('apply sin vfxinfo no inventa el archivo y lo informa', async (t) => {
  const root = await library(t);
  await plugin(root, 'Huerfano', { vfxinfo: null, dll: null });

  const result = await service.apply({ libraryRoot: root, plugin: 'Huerfano' });

  assert.equal(result.vfxinfoPath, null);
  assert.deepEqual(result.skipped, [
    { field: 'vfxinfo.name', reason: 'no existe vfxinfo.txt' },
  ]);
  assert.deepEqual(result.applied, [{ field: 'meta.name_abbreviation', value: 'HUER' }]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /No se creó vfxinfo\.txt/);
});

test('apply solo escribe campos propuestos y valida el plugin', async (t) => {
  const root = await library(t);
  await plugin(root, 'Lead');

  const result = await service.apply({
    libraryRoot: root,
    plugin: 'Lead',
    fields: ['meta.vendor', 'dll.vst'],
  });

  assert.deepEqual(result.applied, []);
  assert.equal(result.metaPath, null);
  assert.deepEqual(
    result.skipped.map((item) => item.field).sort(),
    ['dll.vst', 'meta.vendor'],
  );
  assert.match(result.skipped[0]?.reason ?? '', /no propone/);

  await assert.rejects(
    () => service.apply({ libraryRoot: root, plugin: 'Ghost' }),
    PluginNotFoundError,
  );
  await assert.rejects(
    () => service.apply({ libraryRoot: root, plugin: path.join('..', 'Lead') }),
    LibraryPathError,
  );
  await assert.rejects(() => service.apply({ libraryRoot: root, plugin: '  ' }), LibraryPathError);
});

test('apply conserva el extended del meta, respalda y es idempotente', async (t) => {
  const root = await library(t);
  const dir = await plugin(root, 'Lead', {
    meta: {
      ...FULL_META,
      common: { ...FULL_META.common, id: '', name: '' },
      extended: { license: 'free', max_programs: 128 },
    },
  });
  const file = path.join(dir, META_FILENAME);
  const original = await readFile(file, 'utf8');

  const first = await service.apply({ libraryRoot: root, plugin: 'Lead' });

  assert.deepEqual(
    first.applied.map((item) => item.field),
    ['meta.id', 'meta.name'],
  );
  assert.deepEqual(first.backups, [`${file}.bak`]);
  assert.equal(await readFile(`${file}.bak`, 'utf8'), original);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.common.vendor, 'SynthEdit', 'lo que ya estaba no se pisa');
  assert.deepEqual(written.extended, { license: 'free', max_programs: 128 });

  const second = await service.apply({ libraryRoot: root, plugin: 'Lead' });
  assert.deepEqual(second.applied, []);
  assert.equal(second.metaPath, null);
  assert.equal(second.backups.length, 0);
  // Ya no hay propuestas: la auditoría no propone lo que está relleno.
  assert.deepEqual(second.skipped, []);
});

test('apply respeta los campos pedidos y no aplica el resto', async (t) => {
  const root = await library(t);
  await plugin(root, 'Lead');

  const result = await service.apply({
    libraryRoot: root,
    plugin: 'Lead',
    fields: ['meta.genre'],
  });

  assert.deepEqual(result.applied, [{ field: 'meta.genre', value: 'Synth' }]);
  const written = JSON.parse(await readFile(path.join(root, 'plugs', 'Lead', META_FILENAME), 'utf8'));
  assert.equal(written.common.genre, 'Synth');
  assert.equal(written.common.id, '', 'el id no se escribe si no se pidió');
});

/** `vfxinfo.txt` con identidad pero sin versión ni campos de ejecución. */
function sparseVfxinfo(name: string): string {
  return [
    `name: ${name}`,
    'id: 1177630041',
    `dll_name: ${name}/${name}.dll`,
    'is_synth: 1',
    '',
  ].join('\r\n');
}

/** Registro de wizard completo; cada prueba retoca solo lo que necesita. */
function wizardRecord(overrides: Partial<WizardRecord> = {}): WizardRecord {
  return {
    id: '1177630041',
    name: 'Lead',
    nameAbbreviation: 'LEAD',
    version: '2.4',
    dllName: 'Lead/Lead.dll',
    dllVersion: '',
    isSynth: true,
    hasEditor: true,
    parameterCount: 42,
    programCount: 128,
    editorWidth: 640,
    editorHeight: 480,
    vendor: 'SynthEdit',
    vendorUrl: 'https://www.synthedit.com',
    vendorType: 'Free',
    genre: 'Synth',
    notes: '*Known Issues*\r\nNo known issues.',
    vendorNotes: '',
    created: '2026-01-01',
    filesToCopy: [],
    dirsToCopy: [],
    filesToCreate: {},
    symlinks: [],
    registryKeys: '',
    flags: {},
    sourcePath: '_banks/wizards/Lead.vfxwizard',
    readme: null,
    ...overrides,
  };
}

/**
 * Auditoría con un catálogo de wizards simulado: de `WizardService` solo se usa
 * la búsqueda, así que no hace falta el catálogo real en disco. `seen` recoge
 * las consultas para poder comprobar con qué claves se busca.
 */
function auditWithCatalog(
  record: WizardRecord | null,
  seen: Array<{ id: string; name: string; dllName: string }> = [],
): LibraryAuditService {
  return new LibraryAuditService(new PluginMetaService(), {
    matchExact: (query: { id: string; name: string; dllName: string }) => {
      seen.push(query);
      return record;
    },
  } as unknown as WizardService);
}

test('el wizard del catálogo propone fabricante, URL, notas, versión y campos de ejecución', async (t) => {
  const root = await library(t);
  const dir = await plugin(root, 'Lead', { vfxinfo: sparseVfxinfo('Lead'), meta: null });
  const seen: Array<{ id: string; name: string; dllName: string }> = [];
  const service = auditWithCatalog(wizardRecord(), seen);

  const lead = find((await service.audit(root)).plugins, 'Lead');

  // La búsqueda usa la identidad del plugin: ID, nombre y DLL declarado.
  assert.deepEqual(seen, [{ id: '1177630041', name: 'Lead', dllName: 'Lead/Lead.dll' }]);

  const fromWizard = lead.proposals.filter((proposal) => proposal.source === 'wizard');
  assert.deepEqual(
    fromWizard.map(({ field, value }) => [field, value]),
    [
      ['vfxinfo.version', '2.4'],
      ['vfxinfo.parameter_count', '42'],
      ['vfxinfo.program_count', '128'],
      ['vfxinfo.has_editor', '1'],
      ['vfxinfo.editor_width', '640'],
      ['vfxinfo.editor_height', '480'],
      ['meta.vendor', 'SynthEdit'],
      ['meta.vendor_url', 'https://www.synthedit.com'],
      // Las notas de varias líneas se juntan en una, como al aplicar un wizard.
      ['meta.notes', '*Known Issues* · No known issues.'],
    ],
  );
  for (const proposal of fromWizard) {
    assert.equal(proposal.note, 'wizard del catálogo: Lead', `sin procedencia en ${proposal.field}`);
  }

  // Donde el wizard da el valor no hay hueco bloqueante; la versión es una nota.
  assert.deepEqual(fieldsOf(lead.issues), ['meta', 'vfxinfo.version']);
  assert.equal(lead.issues.find((issue) => issue.field === 'vfxinfo.version')?.severity, 'note');
  assert.match(lead.issues.find((issue) => issue.field === 'vfxinfo.version')?.message ?? '', /2\.4/);

  // Y lo propuesto se puede escribir: vfxinfo y catálogo.
  const applied = await service.apply({
    libraryRoot: root,
    plugin: 'Lead',
    fields: ['vfxinfo.version', 'vfxinfo.parameter_count', 'meta.vendor'],
  });
  assert.deepEqual(
    applied.applied.map(({ field, value }) => [field, value]),
    [
      ['vfxinfo.version', '2.4'],
      ['vfxinfo.parameter_count', '42'],
      ['meta.vendor', 'SynthEdit'],
    ],
  );
  const written = await readFile(path.join(dir, 'vfxinfo.txt'), 'latin1');
  assert.match(written, /^version: 2\.4\r$/m);
  assert.match(written, /^parameter_count: 42\r$/m);
  const meta = JSON.parse(await readFile(path.join(dir, META_FILENAME), 'utf8'));
  assert.equal(meta.common.vendor, 'SynthEdit');
});

test('sin wizard en el catálogo esos campos siguen siendo huecos', async (t) => {
  const root = await library(t);
  await plugin(root, 'Lead', { vfxinfo: sparseVfxinfo('Lead'), meta: null });
  const service = auditWithCatalog(null);

  const lead = find((await service.audit(root)).plugins, 'Lead');

  assert.deepEqual(fieldsOf(lead.issues), [
    'meta',
    'meta.notes',
    'meta.vendor',
    'meta.vendor_url',
    'vfxinfo.editor_height',
    'vfxinfo.editor_width',
    'vfxinfo.has_editor',
    'vfxinfo.parameter_count',
    'vfxinfo.program_count',
    'vfxinfo.version',
  ]);
  assert.deepEqual(
    lead.proposals.filter((proposal) => proposal.source !== 'wizard').map((proposal) => proposal.field),
    ['vfxinfo.version', 'meta.id', 'meta.name', 'meta.genre', 'meta.name_abbreviation'],
  );
  assert.equal(
    lead.proposals.find((proposal) => proposal.field === 'vfxinfo.version')?.value,
    '1',
    'sin wizard la versión sigue siendo la que asume el catálogo',
  );
});

test('un wizard sin contadores declarados no propone ceros inventados', async (t) => {
  const root = await library(t);
  await plugin(root, 'Lead', { vfxinfo: sparseVfxinfo('Lead'), meta: null });
  // Los contadores y el editor valen 0 cuando el wizard no los declara, y un 0
  // declarado no se distingue del ausente: no se proponen.
  const service = auditWithCatalog(
    wizardRecord({ parameterCount: 0, programCount: 0, editorWidth: 0, editorHeight: 0 }),
  );

  const lead = find((await service.audit(root)).plugins, 'Lead');

  assert.deepEqual(
    lead.proposals.filter((proposal) => proposal.source === 'wizard').map((proposal) => proposal.field),
    ['vfxinfo.version', 'vfxinfo.has_editor', 'meta.vendor', 'meta.vendor_url', 'meta.notes'],
  );
  assert.deepEqual(
    fieldsOf(lead.issues).filter((field) => field.startsWith('vfxinfo.')),
    ['vfxinfo.editor_height', 'vfxinfo.editor_width', 'vfxinfo.parameter_count', 'vfxinfo.program_count', 'vfxinfo.version'],
  );
});

test('el wizard no pisa lo que el plugin ya declara', async (t) => {
  const root = await library(t);
  await plugin(root, 'Lead', { meta: FULL_META });
  const service = auditWithCatalog(wizardRecord({ vendor: 'Otro fabricante', version: '9.9' }));

  const lead = find((await service.audit(root)).plugins, 'Lead');

  assert.deepEqual(lead.proposals, [], 'un plugin completo no recibe propuestas del wizard');
  assert.deepEqual(lead.issues, []);
});
