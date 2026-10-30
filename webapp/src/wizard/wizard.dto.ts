import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  WizardInstallPluginInput,
  WizardInstallPluginResult,
  WizardRecord,
} from './wizard.types';

export class WizardErrorDto {
  @ApiProperty({
    description: 'Descripción legible del error',
    example: 'Wizard no encontrado con ID: 9999',
  })
  message!: string;
}

export class WizardSummaryDto {
  @ApiProperty({ description: 'Identificador único VST del plugin', example: '1398231096' })
  id!: string;

  @ApiProperty({ description: 'Nombre del plugin en el wizard', example: 'SuperWave P8' })
  name!: string;

  @ApiProperty({ description: 'Fabricante del plugin', example: 'Superwave' })
  vendor!: string;

  @ApiProperty({ description: 'Categoría o género', example: 'Synth' })
  genre!: string;

  @ApiProperty({ description: 'Abreviatura para pantalla LCD', example: 'P8' })
  nameAbbreviation!: string;

  @ApiProperty({ description: 'Indica si es un sintetizador/instrumento', example: true })
  isSynth!: boolean;

  @ApiProperty({ description: 'Ruta relativa del DLL', example: 'SuperWave P8/P8.dll' })
  dllName!: string;

  @ApiProperty({ description: 'Indica si incluye claves de registro de Windows', example: true })
  hasRegistryKeys!: boolean;

  @ApiProperty({ description: 'Indica si especifica archivos a copiar', example: false })
  hasFilesToCopy!: boolean;

  @ApiProperty({ description: 'Indica si especifica directorios a copiar', example: false })
  hasDirsToCopy!: boolean;

  @ApiProperty({ description: 'Indica si dispone de archivo de instrucciones readme.txt', example: false })
  hasReadme!: boolean;

  @ApiProperty({
    description: 'Ruta relativa de origen dentro del repositorio',
    example: 'SuperWave P8_1398231096_Ver 1.6/SuperWave P8_1398231096_Ver 1.6.vfxwizard',
  })
  sourcePath!: string;
}

export class WizardListResponseDto {
  @ApiProperty({ description: 'Número total de wizards que coinciden con el filtro', example: 1 })
  total!: number;

  @ApiProperty({ description: 'Desplazamiento aplicado', example: 0 })
  offset!: number;

  @ApiProperty({ description: 'Límite de resultados', example: 20 })
  limit!: number;

  @ApiProperty({ description: 'Lista de resúmenes de wizards', type: [WizardSummaryDto] })
  items!: WizardSummaryDto[];
}

export class WizardRecordDto extends WizardSummaryDto {
  @ApiProperty({ description: 'Versión del wizard', example: '1' })
  version!: string;

  @ApiProperty({ description: 'Versión del DLL', example: '1.6' })
  dllVersion!: string;

  @ApiProperty({ description: 'Dispone de editor gráfico propio', example: true })
  hasEditor!: boolean;

  @ApiProperty({ description: 'Número de parámetros del VST', example: 89 })
  parameterCount!: number;

  @ApiProperty({ description: 'Número de programas/presets del VST', example: 64 })
  programCount!: number;

  @ApiProperty({ description: 'Ancho del editor en píxeles', example: 800 })
  editorWidth!: number;

  @ApiProperty({ description: 'Alto del editor en píxeles', example: 529 })
  editorHeight!: number;

  @ApiProperty({ description: 'URL del fabricante', example: 'http://www.superwavesynths.co.uk' })
  vendorUrl!: string;

  @ApiProperty({ description: 'Tipo de distribución (Free, Commercial, etc.)', example: 'Free' })
  vendorType!: string;

  @ApiProperty({ description: 'Notas de uso, rendimiento y problemas conocidos', example: 'Known Issues: None' })
  notes!: string;

  @ApiProperty({ description: 'Notas descriptivas del fabricante', example: 'SuperWave P8 synthesizer' })
  vendorNotes!: string;

  @ApiProperty({ description: 'Fecha de creación del wizard', example: '2010-11-12' })
  created!: string;

  @ApiProperty({ description: 'Lista de archivos a copiar', type: [String], example: [] })
  filesToCopy!: string[];

  @ApiProperty({ description: 'Lista de directorios a copiar', type: [String], example: [] })
  dirsToCopy!: string[];

  @ApiProperty({
    description: 'Archivos de configuración a crear (nombre -> contenido)',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: {},
  })
  filesToCreate!: Record<string, string>;

  @ApiProperty({ description: 'Enlaces simbólicos requeridos', type: [String], example: [] })
  symlinks!: string[];

  @ApiProperty({
    description: 'Bloque REGEDIT4 con las claves de registro',
    example: 'REGEDIT4\r\n\r\n[HKEY_CURRENT_USER\\Software\\Superwave]\r\n',
  })
  registryKeys!: string;

  @ApiProperty({
    description: 'Banderas técnicas adicionales del wizard',
    type: 'object',
    additionalProperties: true,
    example: {},
  })
  flags!: Record<string, string | boolean>;

  @ApiProperty({ description: 'Instrucciones del archivo readme.txt si existe', type: String, nullable: true, example: null })
  readme!: string | null;
}

export class WizardMatchQueryDto {
  @ApiPropertyOptional({ description: 'ID VST del plugin', example: '1398231096' })
  id?: string;

  @ApiPropertyOptional({ description: 'Nombre del plugin', example: 'SuperWave P8' })
  name?: string;

  @ApiPropertyOptional({ description: 'Ruta o nombre del DLL', example: 'P8.dll' })
  dllName?: string;
}

export class WizardApplyMetaDto {
  @ApiProperty({ description: 'Directorio absoluto del plugin en plugs\\', example: 'C:\\VFX\\plugs\\SuperWave P8' })
  pluginDir!: string;

  @ApiPropertyOptional({
    description: 'ID VST del wizard a aplicar. Si se omite, se deduce automáticamente.',
    example: '1398231096',
  })
  wizardId?: string;

  @ApiPropertyOptional({
    description: 'Si es true, sobrescribe las notas existentes en el catálogo',
    default: false,
    example: false,
  })
  overwriteNotes?: boolean;
}

export class WizardCreateVfxinfoDto {
  @ApiProperty({ description: 'Directorio absoluto del plugin en plugs\\', example: 'C:\\VFX\\plugs\\SuperWave P8' })
  pluginDir!: string;

  @ApiPropertyOptional({
    description: 'ID VST del wizard a usar. Si se omite, se deduce automáticamente.',
    example: '1398231096',
  })
  wizardId?: string;

  @ApiPropertyOptional({
    description: 'Si es true y vfxinfo.txt ya existe, crea respaldo vfxinfo.tx_ y lo sobrescribe',
    default: false,
    example: false,
  })
  force?: boolean;
}

export class WizardCreateVfxinfoResultDto {
  @ApiProperty({
    description: 'Ruta del archivo vfxinfo.txt creado o existente',
    example: 'C:\\VFX\\plugs\\SuperWave P8\\vfxinfo.txt',
  })
  path!: string;

  @ApiProperty({ description: 'Indica si el archivo fue creado en esta llamada', example: true })
  created!: boolean;

  @ApiProperty({ description: 'Indica si se creó un respaldo vfxinfo.tx_', example: false })
  backedUp!: boolean;
}

export class WizardCreateFromPluginDto {
  @ApiProperty({
    description:
      'Directorio absoluto del plugin en la librería (la carpeta que contiene `vfxinfo.txt`). El DLL se busca dentro de ella.',
    example: 'D:\\_banks\\storage\\plugs\\FSynthz-15',
  })
  pluginDir!: string;

  @ApiPropertyOptional({
    description: 'Si es true y el `.vfxwizard` ya existe en el catálogo local, lo sobrescribe',
    example: false,
  })
  overwrite?: boolean;
}

export class WizardCreateFromPluginResultDto {
  @ApiProperty({ description: 'Indica si el wizard se escribió en el catálogo local', example: true })
  created!: boolean;

  @ApiProperty({
    description: 'Ruta absoluta del archivo .vfxwizard generado',
    example: 'D:\\_banks\\wizards\\custom\\15 - SynthEdit.vfxwizard',
  })
  wizardPath!: string;

  @ApiProperty({ description: 'Registro indexado a partir de la carpeta del plugin', type: WizardRecordDto })
  record!: WizardRecord;

  @ApiProperty({
    description: 'Avisos sobre el DLL (arquitectura, entrypoint VST) o datos incompletos',
    type: [String],
    example: [],
  })
  warnings!: string[];
}

export class WizardInstallPluginDto implements WizardInstallPluginInput {
  @ApiProperty({ description: 'ID VST del wizard oficial a instalar', example: '1398231096' })
  wizardId!: string;

  @ApiProperty({ description: 'Ruta absoluta a la librería de destino', example: 'D:\\_banks\\storage' })
  libraryRoot!: string;

  @ApiProperty({ description: 'Ruta absoluta al binario .dll original del usuario', example: 'C:\\Downloads\\P8.dll' })
  dllSourcePath!: string;

  @ApiPropertyOptional({
    description: 'Nombre de la subcarpeta del plugin dentro de plugs\\. Si se omite, se usa el nombre del wizard.',
    example: 'SuperWave P8',
  })
  pluginFolderName?: string;

  @ApiPropertyOptional({
    description: 'Si es true y la carpeta del plugin ya existe, sobrescribe los archivos',
    default: false,
    example: false,
  })
  overwrite?: boolean;

  @ApiPropertyOptional({
    description: 'Si es true, inicializa la subcarpeta presets\\ para bancos FXB',
    default: true,
    example: true,
  })
  initializeBank?: boolean;

  @ApiPropertyOptional({
    description: 'Carpeta con archivos extra para copiar según filesToCopy/dirsToCopy',
  })
  sourceFilesRoot?: string;

  @ApiPropertyOptional({
    description: 'Importar automáticamente el .reg generado (Windows)',
    default: false,
  })
  autoImportRegistry?: boolean;
}

export class WizardInstallPluginResponseDto implements WizardInstallPluginResult {
  @ApiProperty({ description: 'Nombre del plugin instalado', example: 'SuperWave P8' })
  pluginName!: string;

  @ApiProperty({ description: 'Ruta absoluta de la carpeta creada para el plugin', example: 'D:\\_banks\\storage\\plugs\\SuperWave P8' })
  pluginDir!: string;

  @ApiProperty({ description: 'Nombre o ruta relativa del DLL según el wizard', example: 'SuperWave P8/P8.dll' })
  dllName!: string;

  @ApiProperty({ description: 'Ruta absoluta donde se copió el DLL', example: 'D:\\_banks\\storage\\plugs\\SuperWave P8\\SuperWave P8\\P8.dll' })
  dllPath!: string;

  @ApiProperty({ description: 'Indica si el binario DLL es un ejecutable PE32 i386 válido de 32 bits', example: true })
  isCompatible32Bit!: boolean;

  @ApiProperty({ description: 'Indica si se generó vfxinfo.txt certificado', example: true })
  vfxinfoCreated!: boolean;

  @ApiProperty({ description: 'Indica si se creó fxbLoader.meta.json con metadatos del wizard', example: true })
  metaCreated!: boolean;

  @ApiProperty({ description: 'Indica si se generó el archivo registry_keys.reg con claves de Windows', example: true })
  registryFileCreated!: boolean;

  @ApiProperty({
    description: 'Ruta del archivo registry_keys.reg creado si el wizard incluye claves de registro',
    type: String,
    nullable: true,
    example: 'D:\\_banks\\storage\\plugs\\SuperWave P8\\registry_keys.reg',
  })
  registryFilePath!: string | null;

  @ApiProperty({ description: 'Lista de archivos adicionales requeridos según el wizard', type: [String], example: [] })
  requiredFiles!: string[];

  @ApiProperty({ description: 'Lista de carpetas adicionales requeridas según el wizard', type: [String], example: [] })
  requiredDirs!: string[];

  @ApiProperty({ description: 'Lista de avisos o advertencias sobre el binario o dependencias', type: [String], example: [] })
  warnings!: string[];

  @ApiProperty({
    description: 'Instrucciones adicionales del archivo readme.txt si las incluye el wizard',
    type: String,
    nullable: true,
    example: null,
  })
  readme!: string | null;
}

export const WIZARD_SUMMARY_EXAMPLE: WizardSummaryDto = {
  id: '1398231096',
  name: 'SuperWave P8',
  vendor: 'Superwave',
  genre: 'Synth',
  nameAbbreviation: 'P8',
  isSynth: true,
  dllName: 'SuperWave P8/P8.dll',
  hasRegistryKeys: true,
  hasFilesToCopy: false,
  hasDirsToCopy: false,
  hasReadme: false,
  sourcePath: 'SuperWave P8_1398231096_Ver 1.6/SuperWave P8_1398231096_Ver 1.6.vfxwizard',
};

export const WIZARD_LIST_RESPONSE_EXAMPLE: WizardListResponseDto = {
  total: 1,
  offset: 0,
  limit: 20,
  items: [WIZARD_SUMMARY_EXAMPLE],
};

export const WIZARD_RECORD_EXAMPLE: WizardRecordDto = {
  ...WIZARD_SUMMARY_EXAMPLE,
  version: '1',
  dllVersion: '1.6',
  hasEditor: true,
  parameterCount: 89,
  programCount: 64,
  editorWidth: 800,
  editorHeight: 529,
  vendorUrl: 'http://www.superwavesynths.co.uk',
  vendorType: 'Free',
  notes: 'Known Issues: None',
  vendorNotes: 'SuperWave P8 synthesizer',
  created: '2010-11-12',
  filesToCopy: [],
  dirsToCopy: [],
  filesToCreate: {},
  symlinks: [],
  registryKeys: 'REGEDIT4\r\n\r\n[HKEY_CURRENT_USER\\Software\\Superwave]\r\n',
  flags: {},
  readme: null,
};

export const WIZARD_APPLY_META_EXAMPLE: WizardApplyMetaDto = {
  pluginDir: 'C:\\VFX\\plugs\\SuperWave P8',
  wizardId: '1398231096',
  overwriteNotes: false,
};

export const WIZARD_CREATE_VFXINFO_EXAMPLE: WizardCreateVfxinfoDto = {
  pluginDir: 'C:\\VFX\\plugs\\SuperWave P8',
  wizardId: '1398231096',
  force: true,
};

export const WIZARD_CREATE_VFXINFO_RESULT_EXAMPLE: WizardCreateVfxinfoResultDto = {
  path: 'C:\\VFX\\plugs\\SuperWave P8\\vfxinfo.txt',
  created: true,
  backedUp: false,
};

export const WIZARD_CREATE_FROM_PLUGIN_EXAMPLE: WizardCreateFromPluginDto = {
  pluginDir: 'D:\\_banks\\storage\\plugs\\FSynthz-15',
  overwrite: false,
};

export const WIZARD_CREATE_FROM_PLUGIN_RESPONSE_EXAMPLE: WizardCreateFromPluginResultDto = {
  created: true,
  wizardPath: 'D:\\_banks\\wizards\\custom\\15 - SynthEdit.vfxwizard',
  record: {
    ...WIZARD_RECORD_EXAMPLE,
    id: '1177630041',
    name: '15 - SynthEdit',
    nameAbbreviation: '15',
    dllName: '15.dll',
    vendor: 'SynthEdit',
    genre: 'Synth',
    parameterCount: 16,
    editorWidth: 273,
    editorHeight: 167,
    sourcePath: 'custom\\15 - SynthEdit.vfxwizard',
  },
  warnings: [],
};

export const WIZARD_INSTALL_PLUGIN_EXAMPLE: WizardInstallPluginDto = {
  wizardId: '1398231096',
  libraryRoot: 'D:\\_banks\\storage',
  dllSourcePath: 'C:\\Downloads\\P8.dll',
  pluginFolderName: 'SuperWave P8',
  overwrite: false,
  initializeBank: true,
};

export const WIZARD_INSTALL_PLUGIN_RESPONSE_EXAMPLE: WizardInstallPluginResponseDto = {
  pluginName: 'SuperWave P8',
  pluginDir: 'D:\\_banks\\storage\\plugs\\SuperWave P8',
  dllName: 'SuperWave P8/P8.dll',
  dllPath: 'D:\\_banks\\storage\\plugs\\SuperWave P8\\SuperWave P8\\P8.dll',
  isCompatible32Bit: true,
  vfxinfoCreated: true,
  metaCreated: true,
  registryFileCreated: true,
  registryFilePath: 'D:\\_banks\\storage\\plugs\\SuperWave P8\\registry_keys.reg',
  requiredFiles: [],
  requiredDirs: [],
  warnings: [],
  readme: null,
};

export const WIZARD_ERROR_EXAMPLE: WizardErrorDto = {
  message: 'Wizard no encontrado con ID: 9999',
};

