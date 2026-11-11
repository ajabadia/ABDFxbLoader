import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VfxMidiMapDto {
  @ApiProperty({ description: 'Número de controlador continuo MIDI CC (1..127)', example: 74 })
  cc!: number;

  @ApiProperty({ description: 'Índice de parámetro VST mapeado', example: 12 })
  param!: number;
}

export class VfxPluginSlotDescriptorDto {
  @ApiProperty({ description: 'ID VST numérico del plugin', example: 1316377392 })
  pluginId!: number;

  @ApiProperty({ description: 'Nombre descriptivo del plugin', example: 'V-Station Demo' })
  name!: string;

  @ApiProperty({ description: 'Nombre corto LCD (máx. 6 chars)', example: 'VStat' })
  shortName!: string;

  @ApiProperty({ description: 'Canal MIDI (0=Omni, 1..16)', example: 0 })
  midiChannel!: number;

  @ApiProperty({ description: 'Nota mínima MIDI (0..127)', example: 0 })
  midiNoteMin!: number;

  @ApiProperty({ description: 'Nota máxima MIDI (0..127)', example: 127 })
  midiNoteMax!: number;

  @ApiProperty({ description: 'Transposición en semitonos (-48..+48)', example: 0 })
  midiTranspose!: number;

  @ApiProperty({ description: 'Habilita entrada MIDI desde ordenador (0/1)', example: 1 })
  midiFromComputer!: number;

  @ApiProperty({ description: 'Encadena MIDI al siguiente plugin (0/1)', example: 0 })
  chainedMidi!: number;

  @ApiProperty({ description: 'Paso directo MIDI Thru (0/1)', example: 0 })
  midiThru!: number;

  @ApiProperty({ description: 'Recepción de cambio de programa MIDI (0/1)', example: 0 })
  programMidi!: number;

  @ApiProperty({ description: 'Número de parámetros VST expuestos', example: 160 })
  parameterCount!: number;

  @ApiProperty({ description: 'Programa activo en el plugin', example: 0 })
  selectedProgram!: number;

  @ApiPropertyOptional({ description: 'Mapeos MIDI CC a parámetros VST', type: [VfxMidiMapDto] })
  midiMaps?: VfxMidiMapDto[];

  @ApiPropertyOptional({ description: 'Parámetros prioritarios en LCD', type: [Number], example: [] })
  priorityParameters?: number[];

  @ApiPropertyOptional({ description: 'Líneas adicionales preservadas', type: [String], example: [] })
  extraLines?: string[];
}

export class VfxSendConfigDto {
  @ApiProperty({ description: 'Nivel de ganancia de envío (0..255)', example: 0 })
  gain!: number;

  @ApiProperty({ description: 'Envío pre-fader (0/1)', example: 0 })
  isPre!: number;

  @ApiProperty({ description: 'Control de ganancia por MIDI (0/1)', example: 0 })
  gainMidi!: number;

  @ApiProperty({ description: 'Control pre-fader por MIDI (0/1)', example: 0 })
  isPreMidi!: number;
}

export class VfxMixerStripDescriptorDto {
  @ApiProperty({ description: 'Tipo de bus', enum: ['channel', 'aux', 'master'], example: 'channel' })
  kind!: 'channel' | 'aux' | 'master';

  @ApiProperty({ description: 'Índice de bus (0..3 para canales 1..4, 0..1 para aux)', example: 0 })
  index!: number;

  @ApiPropertyOptional({
    description: 'Slot A (Instrumento principal)',
    type: () => VfxPluginSlotDescriptorDto,
    nullable: true,
  })
  slotA?: VfxPluginSlotDescriptorDto | null;

  @ApiPropertyOptional({
    description: 'Slot B (Efecto de inserción 1)',
    type: () => VfxPluginSlotDescriptorDto,
    nullable: true,
  })
  slotB?: VfxPluginSlotDescriptorDto | null;

  @ApiPropertyOptional({
    description: 'Slot C (Efecto de inserción 2)',
    type: () => VfxPluginSlotDescriptorDto,
    nullable: true,
  })
  slotC?: VfxPluginSlotDescriptorDto | null;

  @ApiProperty({ description: 'Nivel de volumen (0..255)', example: 206 })
  volume!: number;

  @ApiProperty({ description: 'Panorama estéreo (0..255, 128=Centro)', example: 128 })
  pan!: number;

  @ApiProperty({ description: 'Entrada izquierda activada (0/1)', example: 0 })
  leftIn!: number;

  @ApiProperty({ description: 'Entrada derecha activada (0/1)', example: 0 })
  rightIn!: number;

  @ApiProperty({ description: 'Canal silenciado (0/1)', example: 0 })
  mute!: number;

  @ApiProperty({ description: 'Canal en solo (0/1)', example: 0 })
  solo!: number;

  @ApiProperty({ description: 'Silenciar otros por MIDI', example: 0 })
  muteOthersMidi!: number;

  @ApiProperty({ description: 'Conmutar silencio por MIDI', example: 0 })
  toggleMuteMidi!: number;

  @ApiProperty({ description: 'Conmutar solo por MIDI', example: 0 })
  toggleSoloMidi!: number;

  @ApiProperty({ description: 'Volumen por MIDI', example: 0 })
  volumeMidi!: number;

  @ApiProperty({ description: 'Panorama por MIDI', example: 0 })
  panMidi!: number;

  @ApiProperty({ description: 'Silencio por MIDI', example: 0 })
  muteMidi!: number;

  @ApiProperty({ description: 'Solo por MIDI', example: 0 })
  soloMidi!: number;

  @ApiProperty({ description: 'Envíos a buses auxiliares', type: [VfxSendConfigDto] })
  sends!: VfxSendConfigDto[];
}

export class VfxPresetDescriptorDto {
  @ApiProperty({ description: 'Nombre de la escena o preset', example: 'Bass 1' })
  name!: string;

  @ApiProperty({ description: 'Versión del formato preset.vfx (3)', example: 3 })
  version!: number;

  @ApiProperty({ description: 'Tempo BPM', example: 120 })
  tempoBpm!: number;

  @ApiProperty({ description: 'Numerador de compás', example: 4 })
  timeSignatureNum!: number;

  @ApiProperty({ description: 'Denominador de compás', example: 4 })
  timeSignatureDen!: number;

  @ApiProperty({ description: 'Sincronización de tempo por MIDI', example: 0 })
  tempoBpmMidi!: number;

  @ApiProperty({ description: 'Canal MIDI del mezclador', example: 0 })
  mixerMidiChannel!: number;

  @ApiProperty({ description: 'Tamaño del buffer de audio', example: 0 })
  audioBufferSize!: number;

  @ApiProperty({ description: 'Los 4 canales de instrumento principales', type: [VfxMixerStripDescriptorDto] })
  channels!: VfxMixerStripDescriptorDto[];

  @ApiProperty({ description: 'Los 2 buses de envío auxiliares', type: [VfxMixerStripDescriptorDto] })
  aux!: VfxMixerStripDescriptorDto[];

  @ApiProperty({ description: 'El bus maestro principal', type: VfxMixerStripDescriptorDto })
  master!: VfxMixerStripDescriptorDto;
}

export const VFX_BANKS_LIST_REQUEST_EXAMPLE = {
  libraryRoot: 'C:/fxbLoader/storage',
};

export const VFX_BANK_SUMMARY_EXAMPLE = {
  folder: '000_Novation V-Station demo.vfxbank',
  index: 0,
  name: 'Novation V-Station demo',
  isCanonicalSuffix: true,
  presetCount: 12,
  totalBytes: 1048576,
  mtimeMs: 1731280000000,
  referencedPlugins: [
    {
      id: 1316377392,
      name: 'V-Station Demo',
      installedFolder: 'Novation V-Station demo',
      isSynth: true,
    },
  ],
  missingPluginIds: [],
  health: 'valid' as const,
  issuesCount: 0,
};

export const VFX_BANKS_LIST_RESPONSE_EXAMPLE = {
  banks: [VFX_BANK_SUMMARY_EXAMPLE],
  total: 1,
};

export const VFX_PRESET_SUMMARY_EXAMPLE = {
  folder: '000_Bass 1.vfxpreset',
  index: 0,
  name: 'Bass 1',
  tempoBpm: 120,
  channels: [
    {
      channelIndex: 0,
      volume: 206,
      pan: 128,
      isMuted: false,
      isSolo: false,
      slotA: {
        pluginId: 1316377392,
        name: 'V-Station Demo',
        shortName: 'VStat',
        midiChannel: 0,
        midiNoteMin: 0,
        midiNoteMax: 127,
        midiTranspose: 0,
        parameterCount: 160,
        selectedProgram: 0,
      },
      slotB: null,
      slotC: null,
    },
    {
      channelIndex: 1,
      volume: 0,
      pan: 128,
      isMuted: false,
      isSolo: false,
      slotA: null,
      slotB: null,
      slotC: null,
    },
    {
      channelIndex: 2,
      volume: 0,
      pan: 128,
      isMuted: false,
      isSolo: false,
      slotA: null,
      slotB: null,
      slotC: null,
    },
    {
      channelIndex: 3,
      volume: 0,
      pan: 128,
      isMuted: false,
      isSolo: false,
      slotA: null,
      slotB: null,
      slotC: null,
    },
  ],
  hasAuxEffects: false,
  hasMasterEffects: false,
  chunkFiles: ['channel_1_slot_a_1316377392.chunk'],
};

export const VFX_BANK_INSPECT_REQUEST_EXAMPLE = {
  libraryRoot: 'C:/fxbLoader/storage',
  bankFolder: '000_Novation V-Station demo.vfxbank',
};

export const VFX_BANK_INSPECT_RESPONSE_EXAMPLE = {
  bank: VFX_BANK_SUMMARY_EXAMPLE,
  presets: [VFX_PRESET_SUMMARY_EXAMPLE],
};

export const VFX_BANK_CREATE_REQUEST_EXAMPLE = {
  libraryRoot: 'C:/fxbLoader/storage',
  name: 'Directo 2026',
  index: 1,
};

export const VFX_PRESET_READ_REQUEST_EXAMPLE = {
  libraryRoot: 'C:/fxbLoader/storage',
  bankFolder: '000_Novation V-Station demo.vfxbank',
  presetFolder: '000_Bass 1.vfxpreset',
};

export const VFX_PRESET_DESCRIPTOR_EXAMPLE: VfxPresetDescriptorDto = {
  name: 'Bass 1',
  version: 3,
  tempoBpm: 120,
  timeSignatureNum: 4,
  timeSignatureDen: 4,
  tempoBpmMidi: 0,
  mixerMidiChannel: 0,
  audioBufferSize: 0,
  channels: [
    {
      kind: 'channel',
      index: 0,
      slotA: {
        pluginId: 1316377392,
        name: 'V-Station Demo',
        shortName: 'VStat',
        midiChannel: 0,
        midiNoteMin: 0,
        midiNoteMax: 127,
        midiTranspose: 0,
        midiFromComputer: 1,
        chainedMidi: 0,
        midiThru: 0,
        programMidi: 0,
        parameterCount: 160,
        selectedProgram: 0,
        midiMaps: [],
        priorityParameters: [],
        extraLines: [],
      },
      slotB: null,
      slotC: null,
      volume: 206,
      pan: 128,
      leftIn: 0,
      rightIn: 0,
      mute: 0,
      solo: 0,
      muteOthersMidi: 0,
      toggleMuteMidi: 0,
      toggleSoloMidi: 0,
      volumeMidi: 0,
      panMidi: 0,
      muteMidi: 0,
      soloMidi: 0,
      sends: [
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
      ],
    },
    {
      kind: 'channel',
      index: 1,
      slotA: null,
      slotB: null,
      slotC: null,
      volume: 0,
      pan: 128,
      leftIn: 0,
      rightIn: 0,
      mute: 0,
      solo: 0,
      muteOthersMidi: 0,
      toggleMuteMidi: 0,
      toggleSoloMidi: 0,
      volumeMidi: 0,
      panMidi: 0,
      muteMidi: 0,
      soloMidi: 0,
      sends: [
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
      ],
    },
    {
      kind: 'channel',
      index: 2,
      slotA: null,
      slotB: null,
      slotC: null,
      volume: 0,
      pan: 128,
      leftIn: 0,
      rightIn: 0,
      mute: 0,
      solo: 0,
      muteOthersMidi: 0,
      toggleMuteMidi: 0,
      toggleSoloMidi: 0,
      volumeMidi: 0,
      panMidi: 0,
      muteMidi: 0,
      soloMidi: 0,
      sends: [
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
      ],
    },
    {
      kind: 'channel',
      index: 3,
      slotA: null,
      slotB: null,
      slotC: null,
      volume: 0,
      pan: 128,
      leftIn: 0,
      rightIn: 0,
      mute: 0,
      solo: 0,
      muteOthersMidi: 0,
      toggleMuteMidi: 0,
      toggleSoloMidi: 0,
      volumeMidi: 0,
      panMidi: 0,
      muteMidi: 0,
      soloMidi: 0,
      sends: [
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
      ],
    },
  ],
  aux: [
    {
      kind: 'aux',
      index: 0,
      slotA: null,
      slotB: null,
      slotC: null,
      volume: 0,
      pan: 128,
      leftIn: 0,
      rightIn: 0,
      mute: 0,
      solo: 0,
      muteOthersMidi: 0,
      toggleMuteMidi: 0,
      toggleSoloMidi: 0,
      volumeMidi: 0,
      panMidi: 0,
      muteMidi: 0,
      soloMidi: 0,
      sends: [
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
      ],
    },
    {
      kind: 'aux',
      index: 1,
      slotA: null,
      slotB: null,
      slotC: null,
      volume: 0,
      pan: 128,
      leftIn: 0,
      rightIn: 0,
      mute: 0,
      solo: 0,
      muteOthersMidi: 0,
      toggleMuteMidi: 0,
      toggleSoloMidi: 0,
      volumeMidi: 0,
      panMidi: 0,
      muteMidi: 0,
      soloMidi: 0,
      sends: [
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
      ],
    },
  ],
  master: {
    kind: 'master',
    index: 0,
    slotA: null,
    slotB: null,
    slotC: null,
    volume: 206,
    pan: 128,
    leftIn: 0,
    rightIn: 0,
    mute: 0,
    solo: 0,
    muteOthersMidi: 0,
    toggleMuteMidi: 0,
    toggleSoloMidi: 0,
    volumeMidi: 0,
    panMidi: 0,
    muteMidi: 0,
    soloMidi: 0,
    sends: [
      { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
      { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
    ],
  },
};

export const VFX_PRESET_SAVE_REQUEST_EXAMPLE = {
  libraryRoot: 'C:/fxbLoader/storage',
  bankFolder: '000_Novation V-Station demo.vfxbank',
  presetFolder: '000_Bass 1.vfxpreset',
  index: 0,
  preset: VFX_PRESET_DESCRIPTOR_EXAMPLE,
};

export const VFX_PRESET_SAVE_RESPONSE_EXAMPLE = {
  folder: '000_Bass 1.vfxpreset',
  preset: VFX_PRESET_DESCRIPTOR_EXAMPLE,
};

export class VfxBankPluginRefDto {
  @ApiProperty({ description: 'ID VST numérico del plugin', example: 1316377392 })
  id!: number;

  @ApiProperty({ description: 'Nombre descriptivo del plugin o FourCC', example: 'V-Station Demo' })
  name!: string;

  @ApiPropertyOptional({
    type: String,
    description: 'Carpeta de la librería local plugs/ donde está instalado, o null si falta',
    example: 'Novation V-Station demo',
    nullable: true,
  })
  installedFolder!: string | null;

  @ApiProperty({ description: 'Indica si el plugin es un sintetizador/instrumento o un efecto', example: true })
  isSynth!: boolean;
}

export class VfxBankSummaryDto {
  @ApiProperty({ description: 'Nombre de la carpeta del banco en banks/', example: '000_Novation V-Station demo.vfxbank' })
  folder!: string;

  @ApiProperty({ description: 'Índice numérico asignado para el LCD de la V-Machine (0..127)', example: 0 })
  index!: number;

  @ApiProperty({ description: 'Nombre visual del banco sin índice ni extensión', example: 'Novation V-Station demo' })
  name!: string;

  @ApiProperty({ description: 'Indica si el nombre de carpeta usa el sufijo canónico .vfxbank', example: true })
  isCanonicalSuffix!: boolean;

  @ApiProperty({ description: 'Número de escenas o presets .vfxpreset contenidos en el banco (0..128)', example: 12 })
  presetCount!: number;

  @ApiProperty({ description: 'Tamaño total del banco en bytes', example: 1048576 })
  totalBytes!: number;

  @ApiProperty({ description: 'Fecha de modificación en milisegundos', example: 1731280000000 })
  mtimeMs!: number;

  @ApiProperty({ description: 'Plugins referenciados por las escenas del banco', type: [VfxBankPluginRefDto] })
  referencedPlugins!: VfxBankPluginRefDto[];

  @ApiProperty({ description: 'IDs de plugins referenciados que no están instalados en plugs/', type: [Number], example: [] })
  missingPluginIds!: number[];

  @ApiProperty({ description: 'Estado de salud e integridad técnica del banco', enum: ['valid', 'repairable', 'broken'], example: 'valid' })
  health!: 'valid' | 'repairable' | 'broken';

  @ApiProperty({ description: 'Número de incidencias o desalineaciones detectadas', example: 0 })
  issuesCount!: number;
}

export class VfxBanksListRequestDto {
  @ApiPropertyOptional({ description: 'Ruta absoluta de la librería de plugins (libraryRoot)', example: 'C:/fxbLoader/storage' })
  libraryRoot?: string;
}

export class VfxBanksListResponseDto {
  @ApiProperty({ description: 'Lista de bancos nativos encontrados en banks/', type: [VfxBankSummaryDto] })
  banks!: VfxBankSummaryDto[];

  @ApiProperty({ description: 'Total de bancos encontrados', example: 1 })
  total!: number;
}

export class VfxPresetSlotSummaryDto {
  @ApiPropertyOptional({
    type: Number,
    description: 'ID VST del plugin asignado al slot, o null si está vacío',
    example: 1316377392,
    nullable: true,
  })
  pluginId!: number | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Nombre del plugin asignado al slot',
    example: 'V-Station Demo',
    nullable: true,
  })
  name!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Nombre corto LCD (máx. 6 chars)',
    example: 'VStat',
    nullable: true,
  })
  shortName!: string | null;

  @ApiProperty({ description: 'Canal MIDI (0=Omni, 1..16)', example: 0 })
  midiChannel!: number;

  @ApiProperty({ description: 'Nota mínima MIDI (0..127)', example: 0 })
  midiNoteMin!: number;

  @ApiProperty({ description: 'Nota máxima MIDI (0..127)', example: 127 })
  midiNoteMax!: number;

  @ApiProperty({ description: 'Transposición en semitonos (-48..+48)', example: 0 })
  midiTranspose!: number;

  @ApiProperty({ description: 'Número de parámetros que expone el plugin', example: 160 })
  parameterCount!: number;

  @ApiProperty({ description: 'Programa seleccionado en el plugin', example: 0 })
  selectedProgram!: number;
}

export class VfxPresetChannelSummaryDto {
  @ApiProperty({ description: 'Índice de canal (0..3 para canales 1..4)', example: 0 })
  channelIndex!: number;

  @ApiProperty({ description: 'Nivel de volumen del canal (0..255)', example: 206 })
  volume!: number;

  @ApiProperty({ description: 'Panorama estéreo del canal (0..255, 128=Centro)', example: 128 })
  pan!: number;

  @ApiProperty({ description: 'Indica si el canal está silenciado', example: false })
  isMuted!: boolean;

  @ApiProperty({ description: 'Indica si el canal está en solo', example: false })
  isSolo!: boolean;

  @ApiPropertyOptional({
    type: () => VfxPresetSlotSummaryDto,
    description: 'Slot A (Instrumento principal)',
    nullable: true,
  })
  slotA!: VfxPresetSlotSummaryDto | null;

  @ApiPropertyOptional({
    type: () => VfxPresetSlotSummaryDto,
    description: 'Slot B (Efecto de inserción 1)',
    nullable: true,
  })
  slotB!: VfxPresetSlotSummaryDto | null;

  @ApiPropertyOptional({
    type: () => VfxPresetSlotSummaryDto,
    description: 'Slot C (Efecto de inserción 2)',
    nullable: true,
  })
  slotC!: VfxPresetSlotSummaryDto | null;
}

export class VfxPresetSummaryDto {
  @ApiProperty({ description: 'Nombre de la carpeta del preset en el banco', example: '000_Bass 1.vfxpreset' })
  folder!: string;

  @ApiProperty({ description: 'Índice numérico de programa LCD (0..127)', example: 0 })
  index!: number;

  @ApiProperty({ description: 'Nombre de la escena o preset', example: 'Bass 1' })
  name!: string;

  @ApiProperty({ description: 'Tempo BPM configurado', example: 120 })
  tempoBpm!: number;

  @ApiProperty({ description: 'Resumen de los 4 canales de instrumento', type: [VfxPresetChannelSummaryDto] })
  channels!: VfxPresetChannelSummaryDto[];

  @ApiProperty({ description: 'Indica si los buses auxiliares tienen efectos cargados', example: false })
  hasAuxEffects!: boolean;

  @ApiProperty({ description: 'Indica si el bus master tiene efectos de inserción cargados', example: false })
  hasMasterEffects!: boolean;

  @ApiProperty({ description: 'Archivos .chunk presentes en la carpeta del preset', type: [String], example: ['channel_1_slot_a_1316377392.chunk'] })
  chunkFiles!: string[];
}

export class VfxBankInspectRequestDto {
  @ApiPropertyOptional({ description: 'Ruta de la librería', example: 'C:/fxbLoader/storage' })
  libraryRoot?: string;

  @ApiProperty({ description: 'Carpeta del banco dentro de banks/', example: '000_Novation V-Station demo.vfxbank' })
  bankFolder!: string;
}

export class VfxBankInspectResponseDto {
  @ApiProperty({ description: 'Resumen general del banco', type: VfxBankSummaryDto })
  bank!: VfxBankSummaryDto;

  @ApiProperty({ description: 'Lista ordenada de escenas o presets contenidos (0..128)', type: [VfxPresetSummaryDto] })
  presets!: VfxPresetSummaryDto[];
}

export class VfxBankCreateRequestDto {
  @ApiPropertyOptional({ description: 'Ruta de la librería', example: 'C:/fxbLoader/storage' })
  libraryRoot?: string;

  @ApiProperty({ description: 'Nombre del banco (máx. 30 caracteres)', example: 'Directo 2026' })
  name!: string;

  @ApiPropertyOptional({ description: 'Índice de banco deseado (0..127). Si se omite, se asigna el primero libre', example: 1 })
  index?: number;
}

export class VfxPresetReadRequestDto {
  @ApiPropertyOptional({ description: 'Ruta de la librería', example: 'C:/fxbLoader/storage' })
  libraryRoot?: string;

  @ApiProperty({ description: 'Carpeta del banco', example: '000_Novation V-Station demo.vfxbank' })
  bankFolder!: string;

  @ApiProperty({ description: 'Carpeta de la escena o preset', example: '000_Bass 1.vfxpreset' })
  presetFolder!: string;
}

export class VfxPresetSaveResponseDto {
  @ApiProperty({ description: 'Carpeta donde se guardó el preset', example: '000_Bass 1.vfxpreset' })
  folder!: string;

  @ApiProperty({ description: 'Descriptor de preset guardado', type: VfxPresetDescriptorDto })
  preset!: VfxPresetDescriptorDto;
}

export class VfxPresetSaveRequestDto {
  @ApiPropertyOptional({ description: 'Ruta de la librería', example: 'C:/fxbLoader/storage' })
  libraryRoot?: string;

  @ApiProperty({ description: 'Carpeta del banco', example: '000_Novation V-Station demo.vfxbank' })
  bankFolder!: string;

  @ApiPropertyOptional({ description: 'Carpeta del preset si se está editando uno existente', example: '000_Bass 1.vfxpreset' })
  presetFolder?: string;

  @ApiPropertyOptional({ description: 'Índice de programa LCD deseado (0..127) al crear nuevo preset', example: 0 })
  index?: number;

  @ApiProperty({ description: 'Descriptor completo de la escena de 4 canales', type: VfxPresetDescriptorDto })
  preset!: VfxPresetDescriptorDto;
}
