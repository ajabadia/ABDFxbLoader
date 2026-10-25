import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { uniqueIdToText } from './fxb-bank';

export const VFX_CHUNK_MAGIC = '!VFXCHUNKMAGIC!\0';
export const VFX_CHUNK_MAGIC_BUFFER = Buffer.from(VFX_CHUNK_MAGIC, 'utf8');

export interface VfxBankDeficiency {
  code:
    | 'MISSING_DESCRIPTOR'
    | 'MISSING_CHUNK'
    | 'CHUNK_MAGIC_INVALID'
    | 'CHUNK_ID_MISMATCH'
    | 'DESCRIPTOR_ID_MISMATCH'
    | 'INCOHERENT_PRESET_SLOT'
    | 'CORRUPT_DESCRIPTOR';
  severity: 'error' | 'warning' | 'info';
  message: string;
  presetName?: string;
  filePath?: string;
}

export interface VfxPresetInfo {
  folderName: string;
  presetPath: string;
  descriptorExists: boolean;
  descriptorPluginId: number | null;
  descriptorPluginName: string | null;
  descriptorShortName: string | null;
  chunkExists: boolean;
  chunkFileName: string | null;
  chunkFilenamePluginId: number | null;
  chunkBinaryPluginId: number | null;
  channelIndex: number;
  slotLetter: string;
}

export interface VfxBankDiagnostics {
  bankName: string;
  bankDir: string;
  presetCount: number;
  validPresetCount: number;
  primaryPluginId: number | null;
  primaryPluginFourCc: string | null;
  primaryPluginName: string | null;
  allDetectedPluginIds: number[];
  isConcordant: boolean;
  canRepair: boolean;
  deficiencies: VfxBankDeficiency[];
  matchedWizard?: {
    id: string;
    name: string;
    vendor: string;
    isSynth: boolean;
  } | null;
}

export interface VfxBankDiagnoseOptions {
  expectedPluginId?: number | null;
  expectedPluginName?: string | null;
  wizardLookup?: (id: string) => { id: string; name: string; vendor: string; isSynth: boolean } | null;
}

export interface VfxBankRepairOptions {
  targetPluginId: number;
  targetPluginName: string;
  targetShortName?: string;
  backup?: boolean;
}

export interface VfxBankRepairResult {
  bankDir: string;
  repairedPresets: number;
  renamedChunks: number;
  patchedChunkHeaders: number;
  updatedDescriptors: number;
  createdDescriptors: number;
}

const CHUNK_REGEX = /^channel_(\d+)_slot_([a-z])_(\d+)\.chunk$/i;

/**
 * Lee y analiza un archivo `.chunk` de VFX.
 * Extrae el FourCC en uint32le desde el offset 40 si la cabecera es `!VFXCHUNKMAGIC!`.
 */
export async function readVfxChunkHeader(chunkPath: string): Promise<{
  isValidMagic: boolean;
  pluginId: number | null;
  fourCc: string | null;
}> {
  try {
    const handle = await fs.open(chunkPath, 'r');
    try {
      const buffer = Buffer.alloc(48);
      const { bytesRead } = await handle.read(buffer, 0, 48, 0);
      if (bytesRead < 44) {
        return { isValidMagic: false, pluginId: null, fourCc: null };
      }

      const magic = buffer.subarray(0, 16);
      const isValidMagic = magic.equals(VFX_CHUNK_MAGIC_BUFFER);
      if (!isValidMagic) {
        return { isValidMagic: false, pluginId: null, fourCc: null };
      }

      const pluginId = buffer.readUInt32LE(40);
      const fourCc = uniqueIdToText(pluginId);
      return { isValidMagic: true, pluginId, fourCc };
    } finally {
      await handle.close();
    }
  } catch {
    return { isValidMagic: false, pluginId: null, fourCc: null };
  }
}

/**
 * Parchea el FourCC en el offset 40 de un archivo `.chunk`.
 */
export async function patchVfxChunkHeader(chunkPath: string, newPluginId: number): Promise<boolean> {
  try {
    const handle = await fs.open(chunkPath, 'r+');
    try {
      const magicBuffer = Buffer.alloc(16);
      await handle.read(magicBuffer, 0, 16, 0);
      if (!magicBuffer.equals(VFX_CHUNK_MAGIC_BUFFER)) {
        return false;
      }
      const idBuffer = Buffer.alloc(4);
      idBuffer.writeUInt32LE(newPluginId, 0);
      await handle.write(idBuffer, 0, 4, 40);
      return true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Lee el descriptor `preset.vfx` y extrae el ID y nombres de plugin.
 */
export function parsePresetVfxContent(content: string): {
  pluginId: number | null;
  pluginName: string | null;
  shortName: string | null;
  channelIndex: number;
} {
  const pluginMatch = content.match(/plugin:\s*(\d+)/i);
  const nameMatch = content.match(/name:\s*(.+)/i);
  const shortMatch = content.match(/short_name:\s*(.+)/i);
  const channelMatch = content.match(/channel:\s*(\d+)/i);

  return {
    pluginId: pluginMatch ? Number.parseInt(pluginMatch[1]!, 10) : null,
    pluginName: nameMatch ? nameMatch[1]!.trim() : null,
    shortName: shortMatch ? shortMatch[1]!.trim() : null,
    channelIndex: channelMatch ? Number.parseInt(channelMatch[1]!, 10) : 0,
  };
}

/**
 * Genera el descriptor estándar `preset.vfx` para un preset dado.
 */
export function generatePresetVfxContent(params: {
  presetName: string;
  pluginId: number;
  pluginName: string;
  shortName?: string;
  channel?: number;
}): string {
  const shortName = params.shortName || uniqueIdToText(params.pluginId);
  const channel = params.channel ?? 0;

  return `preset: ${params.presetName}
    version: 3
    tempo_bpm: 120
    time_signature_num: 4
    time_signature_den: 4
    tempo_bpm_midi: 0
    mixer_midi_channel: 0
    audio_buffer_size: 0

    channel: ${channel}
        plugin: ${params.pluginId}
            name: ${params.pluginName}
            short_name: ${shortName}
            midi_channel: 0
            midi_note_min: 0
            midi_note_max: 0
            midi_transpose: 0
            midi_from_computer: 1
            chained_midi: 0
            midi_thru: 0
            program_midi: 0
            parameter_count: 0
            selected_program: 0

        plugin:

        plugin:

        volume: 255
        pan: 128
        left_in: 0
        right_in: 0
        mute: 0
        solo: 0
        mute_others_midi: 0
        toggle_mute_midi: 0
        toggle_solo_midi: 0
        volume_midi: 0
        pan_midi: 0
        mute_midi: 0
        solo_midi: 0

        send: 0
            gain: 0
            is_pre: 0
            gain_midi: 0
            is_pre_midi: 0

        send: 1
            gain: 0
            is_pre: 0
            gain_midi: 0
            is_pre_midi: 0

    master:
        plugin:

        plugin:

        plugin:

        volume: 255
        pan: 128
        left_in: 0
        right_in: 0
        mute: 0
        solo: 0
        mute_others_midi: 0
        toggle_mute_midi: 0
        toggle_solo_midi: 0
        volume_midi: 0
        pan_midi: 0
        mute_midi: 0
        solo_midi: 0
`;
}

/**
 * Diagnostica un banco `.vfxbank`, evaluando la integridad de sus presets,
 * chunks binarios, consistencia de IDs y emparejamiento con el wizard o plugin esperado.
 */
export async function diagnoseVfxBank(
  bankDir: string,
  options: VfxBankDiagnoseOptions = {},
): Promise<VfxBankDiagnostics> {
  const bankName = path.basename(bankDir);
  const deficiencies: VfxBankDeficiency[] = [];
  const detectedPluginIds = new Set<number>();
  const detectedPluginNames = new Set<string>();

  let subEntries: import('node:fs').Dirent[] = [];
  try {
    subEntries = await fs.readdir(bankDir, { withFileTypes: true });
  } catch (err) {
    return {
      bankName,
      bankDir,
      presetCount: 0,
      validPresetCount: 0,
      primaryPluginId: null,
      primaryPluginFourCc: null,
      primaryPluginName: null,
      allDetectedPluginIds: [],
      isConcordant: false,
      canRepair: false,
      deficiencies: [
        {
          code: 'MISSING_DESCRIPTOR',
          severity: 'error',
          message: `No se pudo acceder a la carpeta del banco: ${String(err)}`,
        },
      ],
    };
  }

  const presetDirs = subEntries
    .filter((e) => e.isDirectory() && e.name.toLowerCase().endsWith('.vfxpreset'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  let validPresetCount = 0;

  for (const presetEntry of presetDirs) {
    const presetPath = path.join(bankDir, presetEntry.name);
    let files: import('node:fs').Dirent[] = [];
    try {
      files = await fs.readdir(presetPath, { withFileTypes: true });
    } catch {
      deficiencies.push({
        code: 'MISSING_DESCRIPTOR',
        severity: 'error',
        message: `No se pudo leer el contenido del preset ${presetEntry.name}.`,
        presetName: presetEntry.name,
      });
      continue;
    }

    const descriptorEntry = files.find((f) => f.isFile() && f.name.toLowerCase() === 'preset.vfx');
    let descriptorPluginId: number | null = null;
    let descriptorPluginName: string | null = null;

    if (descriptorEntry) {
      try {
        const text = await fs.readFile(path.join(presetPath, descriptorEntry.name), 'utf8');
        const parsed = parsePresetVfxContent(text);
        descriptorPluginId = parsed.pluginId;
        descriptorPluginName = parsed.pluginName;
        if (descriptorPluginId !== null) {
          detectedPluginIds.add(descriptorPluginId);
        }
        if (descriptorPluginName) {
          detectedPluginNames.add(descriptorPluginName);
        }
      } catch {
        deficiencies.push({
          code: 'CORRUPT_DESCRIPTOR',
          severity: 'warning',
          message: `El archivo preset.vfx en ${presetEntry.name} no se pudo analizar correctamente.`,
          presetName: presetEntry.name,
        });
      }
    } else {
      deficiencies.push({
        code: 'MISSING_DESCRIPTOR',
        severity: 'warning',
        message: `El preset ${presetEntry.name} no tiene archivo descriptor preset.vfx.`,
        presetName: presetEntry.name,
      });
    }

    // Buscar chunk
    const chunkFile = files.find((f) => f.isFile() && f.name.toLowerCase().endsWith('.chunk'));
    if (!chunkFile) {
      deficiencies.push({
        code: 'MISSING_CHUNK',
        severity: 'error',
        message: `El preset ${presetEntry.name} no contiene ningún archivo .chunk.`,
        presetName: presetEntry.name,
      });
      continue;
    }

    const chunkPath = path.join(presetPath, chunkFile.name);
    const chunkHeader = await readVfxChunkHeader(chunkPath);
    if (!chunkHeader.isValidMagic) {
      deficiencies.push({
        code: 'CHUNK_MAGIC_INVALID',
        severity: 'error',
        message: `El archivo ${chunkFile.name} no tiene la cabecera estándar !VFXCHUNKMAGIC!.`,
        presetName: presetEntry.name,
        filePath: chunkPath,
      });
    }

    const matchName = chunkFile.name.match(CHUNK_REGEX);
    let chunkFilenameId: number | null = null;
    if (matchName) {
      chunkFilenameId = Number.parseInt(matchName[3]!, 10);
      detectedPluginIds.add(chunkFilenameId);
    }

    if (chunkHeader.pluginId !== null) {
      detectedPluginIds.add(chunkHeader.pluginId);
    }

    // Incoherencia entre ID del nombre de archivo y binario
    if (chunkFilenameId !== null && chunkHeader.pluginId !== null && chunkFilenameId !== chunkHeader.pluginId) {
      deficiencies.push({
        code: 'CHUNK_ID_MISMATCH',
        severity: 'warning',
        message: `El ID en el nombre (${chunkFilenameId}) difiere del ID en la cabecera binaria (${chunkHeader.pluginId}) en ${presetEntry.name}.`,
        presetName: presetEntry.name,
      });
    }

    // Incoherencia entre descriptor y chunk
    if (descriptorPluginId !== null && chunkFilenameId !== null && descriptorPluginId !== chunkFilenameId) {
      deficiencies.push({
        code: 'DESCRIPTOR_ID_MISMATCH',
        severity: 'warning',
        message: `El descriptor indica plugin ${descriptorPluginId} pero el chunk es ${chunkFilenameId} en ${presetEntry.name}.`,
        presetName: presetEntry.name,
      });
    }

    // Si tiene descriptor y chunk válido
    if (descriptorEntry && chunkHeader.isValidMagic) {
      validPresetCount += 1;
    }
  }

  const allDetectedPluginIds = Array.from(detectedPluginIds);
  const primaryPluginId = allDetectedPluginIds[0] ?? null;
  const primaryPluginFourCc = primaryPluginId !== null ? uniqueIdToText(primaryPluginId) : null;
  const primaryPluginName = Array.from(detectedPluginNames)[0] ?? null;

  // Comparar con el esperado si se proveyó
  if (options.expectedPluginId && primaryPluginId !== null && options.expectedPluginId !== primaryPluginId) {
    deficiencies.push({
      code: 'CHUNK_ID_MISMATCH',
      severity: 'warning',
      message: `El ID del banco (${primaryPluginId} - ${primaryPluginFourCc}) no coincide con el plugin esperado (${options.expectedPluginId} - ${uniqueIdToText(options.expectedPluginId)}).`,
    });
  }

  // Matchear contra Wizard oficial si está disponible
  let matchedWizard: VfxBankDiagnostics['matchedWizard'] = null;
  if (options.wizardLookup && primaryPluginId !== null) {
    matchedWizard = options.wizardLookup(primaryPluginId.toString());
  }

  const isConcordant = deficiencies.length === 0;
  const canRepair =
    presetDirs.length > 0 &&
    deficiencies.every((d) => d.code !== 'CHUNK_MAGIC_INVALID' && d.code !== 'MISSING_CHUNK');

  return {
    bankName,
    bankDir,
    presetCount: presetDirs.length,
    validPresetCount,
    primaryPluginId,
    primaryPluginFourCc,
    primaryPluginName,
    allDetectedPluginIds,
    isConcordant,
    canRepair,
    deficiencies,
    matchedWizard,
  };
}

/**
 * Repara y armoniza un banco `.vfxbank`:
 * - Renombra los archivos .chunk desalineados al nuevo targetPluginId
 * - Parchea el FourCC en offset 40 de la cabecera binaria del chunk
 * - Actualiza o regenera los descriptores `preset.vfx`
 */
export async function repairVfxBank(
  bankDir: string,
  options: VfxBankRepairOptions,
): Promise<VfxBankRepairResult> {
  let subEntries: import('node:fs').Dirent[] = [];
  try {
    subEntries = await fs.readdir(bankDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`No se pudo acceder a la carpeta del banco para reparar: ${String(err)}`);
  }

  const presetDirs = subEntries
    .filter((e) => e.isDirectory() && e.name.toLowerCase().endsWith('.vfxpreset'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  let repairedPresets = 0;
  let renamedChunks = 0;
  let patchedChunkHeaders = 0;
  let updatedDescriptors = 0;
  let createdDescriptors = 0;

  for (const presetEntry of presetDirs) {
    const presetPath = path.join(bankDir, presetEntry.name);
    const files = await fs.readdir(presetPath, { withFileTypes: true });

    let presetWasModified = false;

    // 1. Procesar archivo .chunk
    const chunkFile = files.find((f) => f.isFile() && f.name.toLowerCase().endsWith('.chunk'));
    if (chunkFile) {
      const chunkPath = path.join(presetPath, chunkFile.name);
      const match = chunkFile.name.match(CHUNK_REGEX);
      const channelIndex = match ? match[1]! : '1';
      const slotLetter = match ? match[2]!.toLowerCase() : 'a';
      const expectedChunkName = `channel_${channelIndex}_slot_${slotLetter}_${options.targetPluginId}.chunk`;

      let activeChunkPath = chunkPath;

      // Renombrar si el nombre no coincide
      if (chunkFile.name.toLowerCase() !== expectedChunkName.toLowerCase()) {
        const targetChunkPath = path.join(presetPath, expectedChunkName);
        await fs.rename(chunkPath, targetChunkPath);
        activeChunkPath = targetChunkPath;
        renamedChunks += 1;
        presetWasModified = true;
      }

      // Parchear cabecera binaria
      const patched = await patchVfxChunkHeader(activeChunkPath, options.targetPluginId);
      if (patched) {
        patchedChunkHeaders += 1;
        presetWasModified = true;
      }
    }

    // 2. Procesar descriptor preset.vfx
    const descriptorFile = files.find((f) => f.isFile() && f.name.toLowerCase() === 'preset.vfx');
    const cleanPresetTitle = presetEntry.name
      .replace(/\.vfxpreset$/i, '')
      .replace(/^\d+[_-\s]*/, '')
      .trim();

    if (descriptorFile) {
      const descriptorPath = path.join(presetPath, descriptorFile.name);
      try {
        let content = await fs.readFile(descriptorPath, 'utf8');
        let descriptorChanged = false;

        // Reemplazar plugin: <id>
        if (content.match(/plugin:\s*\d+/i)) {
          const newContent = content.replace(/plugin:\s*\d+/i, `plugin: ${options.targetPluginId}`);
          if (newContent !== content) {
            content = newContent;
            descriptorChanged = true;
          }
        }

        // Reemplazar o asegurar name:
        if (content.match(/name:\s*.+/i)) {
          const newContent = content.replace(/name:\s*.+/i, `name: ${options.targetPluginName}`);
          if (newContent !== content) {
            content = newContent;
            descriptorChanged = true;
          }
        }

        if (descriptorChanged) {
          await fs.writeFile(descriptorPath, content, 'utf8');
          updatedDescriptors += 1;
          presetWasModified = true;
        }
      } catch {
        // ignore
      }
    } else {
      // Crear descriptor ausente
      const newDescriptor = generatePresetVfxContent({
        presetName: cleanPresetTitle || 'Preset',
        pluginId: options.targetPluginId,
        pluginName: options.targetPluginName,
        shortName: options.targetShortName,
      });
      await fs.writeFile(path.join(presetPath, 'preset.vfx'), newDescriptor, 'utf8');
      createdDescriptors += 1;
      presetWasModified = true;
    }

    if (presetWasModified) {
      repairedPresets += 1;
    }
  }

  return {
    bankDir,
    repairedPresets,
    renamedChunks,
    patchedChunkHeaders,
    updatedDescriptors,
    createdDescriptors,
  };
}
