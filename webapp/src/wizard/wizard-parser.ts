import type { WizardRecord, WizardSummary } from './wizard.types';

/**
 * Parsea el texto de un archivo `.vfxwizard` o `vfxinfo.txt`.
 * Soporta pares clave-valor y bloques multilínea delimitados por `...`.
 */
export function parseWizardText(
  text: string,
  sourcePath = '',
  readme: string | null = null,
): WizardRecord {
  const lines = text.split(/\r?\n/);

  const singleFields: Record<string, string> = {};
  const multiBlocks: Record<string, string> = {};

  let currentBlockKey: string | null = null;
  let currentBlockLines: string[] = [];
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    if (inBlock) {
      if (trimmed === '...') {
        // Cierre del bloque multilínea
        if (currentBlockKey !== null) {
          multiBlocks[currentBlockKey] = currentBlockLines.join('\n').trim();
        }
        inBlock = false;
        currentBlockKey = null;
        currentBlockLines = [];
        continue;
      }

      // Si el autor olvidó cerrar con '...' y empieza otro bloque (ej. "dirs_to_copy:\n...")
      const nextLine = lines[i + 1]?.trim();
      if (trimmed.endsWith(':') && nextLine === '...') {
        if (currentBlockKey !== null) {
          multiBlocks[currentBlockKey] = currentBlockLines.join('\n').trim();
        }
        const key = trimmed.slice(0, -1).trim();
        inBlock = true;
        currentBlockKey = key;
        currentBlockLines = [];
        i++; // saltar la línea de apertura '...'
        continue;
      }

      currentBlockLines.push(rawLine);
      continue;
    }

    // Líneas vacías o comentarios (#) fuera de bloque
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const colonIndex = rawLine.indexOf(':');
    if (colonIndex > 0) {
      const key = rawLine.slice(0, colonIndex).trim();
      const val = rawLine.slice(colonIndex + 1).trim();

      // Comprobar si la siguiente línea abre un bloque multilínea con '...'
      const nextLine = lines[i + 1]?.trim();
      if (val === '' && nextLine === '...') {
        inBlock = true;
        currentBlockKey = key;
        currentBlockLines = [];
        i++; // saltar la línea de apertura '...'
        continue;
      }

      // Si no es apertura de bloque, es un campo simple
      singleFields[key.toLowerCase()] = val;
    }
  }

  // Si el archivo terminó sin cerrar el último bloque multilínea con '...'
  if (inBlock && currentBlockKey !== null) {
    multiBlocks[currentBlockKey] = currentBlockLines.join('\n').trim();
  }

  // Parsear campos numéricos y booleanos con valores seguros
  const parseNum = (key: string, def = 0): number => {
    const raw = singleFields[key];
    if (raw === undefined || raw === '') return def;
    const num = Number.parseInt(raw, 10);
    return Number.isNaN(num) ? def : num;
  };

  const parseBool = (key: string, def = false): boolean => {
    const raw = singleFields[key];
    if (raw === undefined) return def;
    return raw === '1' || raw.toLowerCase() === 'true';
  };

  const parseList = (blockKey: string): string[] => {
    const content = multiBlocks[blockKey];
    if (!content) return [];
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && line !== '...');
  };

  // Separar archivos a crear (claves que contienen '/' o extensiones como '.ini', '.cfg', etc.)
  const filesToCreate: Record<string, string> = {};
  const knownMultiKeys = new Set([
    'notes',
    'vendor_notes',
    'dirs_to_copy',
    'files_to_copy',
    'symlinks',
    'registry_keys',
  ]);

  for (const [k, v] of Object.entries(multiBlocks)) {
    if (!knownMultiKeys.has(k)) {
      filesToCreate[k] = v;
    }
  }

  // Banderas adicionales que no son del esquema principal
  const flags: Record<string, string | boolean> = {};
  const standardSingleKeys = new Set([
    'id',
    'name',
    'name_abbreviation',
    'version',
    'dll_name',
    'dll_version',
    'is_synth',
    'has_editor',
    'parameter_count',
    'program_count',
    'editor_width',
    'editor_height',
    'vendor',
    'vendor_url',
    'vendor_type',
    'genre',
    'created',
  ]);

  for (const [k, v] of Object.entries(singleFields)) {
    if (!standardSingleKeys.has(k)) {
      flags[k] = v;
    }
  }

  return {
    id: singleFields['id'] ?? '',
    name: singleFields['name'] ?? '',
    nameAbbreviation: singleFields['name_abbreviation'] ?? '',
    version: singleFields['version'] ?? '1',
    dllName: singleFields['dll_name'] ?? '',
    dllVersion: singleFields['dll_version'] ?? '',
    isSynth: parseBool('is_synth', true),
    hasEditor: parseBool('has_editor', true),
    parameterCount: parseNum('parameter_count', 0),
    programCount: parseNum('program_count', 0),
    editorWidth: parseNum('editor_width', 0),
    editorHeight: parseNum('editor_height', 0),
    vendor: singleFields['vendor'] ?? '',
    vendorUrl: singleFields['vendor_url'] ?? '',
    vendorType: singleFields['vendor_type'] ?? '',
    genre: singleFields['genre'] ?? '',
    notes: multiBlocks['notes'] ?? '',
    vendorNotes: multiBlocks['vendor_notes'] ?? '',
    created: singleFields['created'] ?? '',
    filesToCopy: parseList('files_to_copy'),
    dirsToCopy: parseList('dirs_to_copy'),
    filesToCreate,
    symlinks: parseList('symlinks'),
    registryKeys: multiBlocks['registry_keys'] ?? '',
    flags,
    sourcePath,
    readme,
  };
}

/**
 * Convierte un WizardRecord en un resumen WizardSummary para listados y respuestas ligeras.
 */
export function toWizardSummary(record: WizardRecord): WizardSummary {
  return {
    id: record.id,
    name: record.name,
    vendor: record.vendor,
    genre: record.genre,
    nameAbbreviation: record.nameAbbreviation,
    isSynth: record.isSynth,
    dllName: record.dllName,
    hasRegistryKeys: record.registryKeys.trim().length > 0,
    hasFilesToCopy: record.filesToCopy.length > 0,
    hasDirsToCopy: record.dirsToCopy.length > 0,
    hasReadme: record.readme !== null && record.readme.trim().length > 0,
    sourcePath: record.sourcePath,
  };
}

/**
 * Serializa un WizardRecord a contenido oficial `vfxinfo.txt` con formato estándar.
 */
export function serializeWizardToVfxinfo(record: WizardRecord): string {
  const parts: string[] = [];

  if (record.id) parts.push(`id: ${record.id}`);
  if (record.name) parts.push(`name: ${record.name}`);
  if (record.nameAbbreviation) parts.push(`name_abbreviation: ${record.nameAbbreviation}`);
  if (record.dllName) parts.push(`dll_name: ${record.dllName}`);
  parts.push(`parameter_count: ${record.parameterCount}`);
  parts.push(`program_count: ${record.programCount}`);
  parts.push(`is_synth: ${record.isSynth ? '1' : '0'}`);
  parts.push(`has_editor: ${record.hasEditor ? '1' : '0'}`);
  if (record.editorWidth > 0) parts.push(`editor_width: ${record.editorWidth}`);
  if (record.editorHeight > 0) parts.push(`editor_height: ${record.editorHeight}`);

  if (record.filesToCopy.length > 0) {
    parts.push('');
    parts.push('files_to_copy:');
    parts.push('...');
    for (const f of record.filesToCopy) parts.push(f);
    parts.push('...');
  }

  if (record.dirsToCopy.length > 0) {
    parts.push('');
    parts.push('dirs_to_copy:');
    parts.push('...');
    for (const d of record.dirsToCopy) parts.push(d);
    parts.push('...');
  }

  if (record.symlinks.length > 0) {
    parts.push('');
    parts.push('symlinks:');
    parts.push('...');
    for (const s of record.symlinks) parts.push(s);
    parts.push('...');
  }

  if (record.registryKeys.trim().length > 0) {
    parts.push('');
    parts.push('registry_keys:');
    parts.push('...');
    parts.push(record.registryKeys.trim());
    parts.push('...');
  }

  return parts.join('\r\n') + '\r\n';
}
