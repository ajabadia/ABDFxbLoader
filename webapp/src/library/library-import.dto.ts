import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ImportCollisionPolicy,
  ImportPackageInput,
  ImportPackageResult,
  ImportPackageSkippedItem,
  InspectPackageInput,
  InspectPackageResult,
  PackageBankSummary,
  PackagePluginSummary,
} from './library-import.types';

export class InspectPackageDto implements InspectPackageInput {
  @ApiProperty({
    description: 'Ruta absoluta a la carpeta de la librería o paquete externo (.vfxlibrary)',
    example: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\Novation V-Station demo.vfxlibrary',
  })
  packagePath!: string;

  @ApiProperty({
    description: 'Ruta absoluta de la librería VFX activa (para comprobar si ya existen plugins homónimos)',
    example: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\storage',
  })
  targetLibraryRoot!: string;
}

export class PackagePluginSummaryDto implements PackagePluginSummary {
  @ApiProperty({ description: 'Nombre de la carpeta del plugin', example: 'V-Station Demo' })
  name!: string;

  @ApiProperty({
    description: 'Ruta absoluta de origen',
    example: 'D:\\_banks\\Novation V-Station demo.vfxlibrary\\plugs\\V-Station Demo',
  })
  sourceDir!: string;

  @ApiPropertyOptional({
    description: 'Subruta relativa o nombre del paquete contenedor de origen',
    example: 'Novation V-Station demo.vfxlibrary',
  })
  packageSource?: string;

  @ApiProperty({ type: String, description: 'Nombre del archivo DLL si existe', example: 'V-Station.dll', nullable: true })
  dllName!: string | null;

  @ApiProperty({ description: 'Indica si contiene archivo vfxinfo.txt', example: true })
  hasVfxinfo!: boolean;

  @ApiProperty({ type: Number, description: 'ID numérico VST leído de vfxinfo.txt', example: 1316377392, nullable: true })
  vfxinfoId!: number | null;

  @ApiProperty({ type: String, description: 'Nombre registrado en vfxinfo.txt', example: 'V-Station Demo', nullable: true })
  vfxinfoName!: string | null;

  @ApiProperty({ description: 'Número de archivos dentro de la carpeta', example: 2 })
  fileCount!: number;

  @ApiProperty({ description: 'Tamaño total en bytes', example: 6256046 })
  totalSizeBytes!: number;

  @ApiProperty({ description: 'Indica si ya existe un plugin homónimo en la librería destino', example: false })
  alreadyExistsInTarget!: boolean;

  @ApiPropertyOptional({
    description: 'Wizard oficial emparejado si existe en el catálogo',
    type: () => PackagePluginMatchedWizardDto,
  })
  matchedWizard?: PackagePluginMatchedWizardDto | null;
}

export class PackagePluginMatchedWizardDto {
  @ApiProperty({ description: 'ID VST canónico del wizard', example: '1316377392' })
  id!: string;

  @ApiProperty({ description: 'Nombre del plugin según el wizard', example: 'V-Station Demo' })
  name!: string;

  @ApiProperty({ description: 'Fabricante del plugin', example: 'Novation' })
  vendor!: string;

  @ApiProperty({ description: 'Indica si es un instrumento sintetizador', example: true })
  isSynth!: boolean;
}

export class PackageBankSummaryDto implements PackageBankSummary {
  @ApiProperty({
    description: 'Nombre de la carpeta del banco',
    example: '000_Novation V-Station demo.vfxbank',
  })
  name!: string;

  @ApiProperty({
    description: 'Ruta absoluta de origen del banco',
    example: 'D:\\_banks\\Novation V-Station demo.vfxlibrary\\banks\\000_Novation V-Station demo.vfxbank',
  })
  sourceDir!: string;

  @ApiPropertyOptional({
    description: 'Subruta relativa o nombre del paquete contenedor de origen',
    example: 'Novation V-Station demo.vfxlibrary',
  })
  packageSource?: string;

  @ApiProperty({ description: 'Cantidad de presets .vfxpreset dentro del banco', example: 6 })
  presetCount!: number;

  @ApiProperty({ description: 'Tamaño total en bytes del banco', example: 31362 })
  totalSizeBytes!: number;

  @ApiProperty({ description: 'Indica si ya existe este banco en la librería destino', example: false })
  alreadyExistsInTarget!: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'ID de plugin numérico detectado en los chunks del banco',
    example: 1316377392,
  })
  chunkPluginId?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'FourCC textual del plugin detectado en los chunks',
    example: 'NvS0',
  })
  chunkPluginFourCc?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Nombre del wizard oficial emparejado con los presets del banco',
    example: 'V-Station Demo',
  })
  matchedWizardName?: string | null;

  @ApiPropertyOptional({
    description: 'Indica si el banco es completamente concordante y no tiene carencias',
    example: true,
  })
  isConcordant?: boolean;

  @ApiPropertyOptional({
    description: 'Indica si las carencias del banco son reparables automáticamente',
    example: true,
  })
  canRepair?: boolean;

  @ApiPropertyOptional({
    description: 'Lista de carencias o advertencias detectadas en los presets',
    type: [String],
    example: [],
  })
  deficiencies?: string[];
}

export class InspectPackageResultDto implements InspectPackageResult {
  @ApiProperty({
    description: 'Ruta canónica resuelta del paquete',
    example: 'D:\\_banks\\Novation V-Station demo.vfxlibrary\\Novation V-Station demo.vfxlibrary',
  })
  sourcePath!: string;

  @ApiProperty({
    description: 'Tipo de estructura detectada',
    enum: ['vfxlibrary', 'plugin-folder'],
    example: 'vfxlibrary',
  })
  resolvedKind!: 'vfxlibrary' | 'plugin-folder';

  @ApiProperty({
    description: 'Plugins detectados listos para importar',
    type: [PackagePluginSummaryDto],
  })
  plugins!: PackagePluginSummaryDto[];

  @ApiProperty({
    description: 'Bancos detectados listos para importar',
    type: [PackageBankSummaryDto],
  })
  banks!: PackageBankSummaryDto[];
}

export class ImportPackageDto implements ImportPackageInput {
  @ApiProperty({
    description: 'Ruta absoluta al paquete o carpeta de origen',
    example: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\Novation V-Station demo.vfxlibrary',
  })
  packagePath!: string;

  @ApiProperty({
    description: 'Ruta absoluta a la librería de destino',
    example: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\storage',
  })
  targetLibraryRoot!: string;

  @ApiPropertyOptional({
    description: 'Nombres de los plugins seleccionados para importar (por defecto todos)',
    type: [String],
    example: ['V-Station Demo'],
  })
  selectedPlugins?: string[];

  @ApiPropertyOptional({
    description: 'Nombres de los bancos seleccionados para importar (por defecto todos)',
    type: [String],
    example: ['000_Novation V-Station demo.vfxbank'],
  })
  selectedBanks?: string[];

  @ApiPropertyOptional({
    description: 'Política en caso de que ya exista en destino',
    enum: ['skip', 'overwrite'],
    default: 'skip',
    example: 'skip',
  })
  collisionPolicy?: ImportCollisionPolicy;

  @ApiPropertyOptional({
    description: 'Si es true, repara y sincroniza automáticamente los IDs y descriptores del banco con el plugin destino al importar',
    example: true,
  })
  repairBanks?: boolean;
}

export class ImportPackageSkippedItemDto implements ImportPackageSkippedItem {
  @ApiProperty({ description: 'Nombre del elemento omitido', example: 'V-Station Demo' })
  name!: string;

  @ApiProperty({ description: 'Motivo por el que se omitió', example: 'Ya existe en destino' })
  reason!: string;
}

export class ImportPackageResultDto implements ImportPackageResult {
  @ApiProperty({
    description: 'Ruta de la librería de destino',
    example: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\storage',
  })
  targetLibraryRoot!: string;

  @ApiProperty({
    description: 'Nombres de los plugins importados exitosamente',
    type: [String],
    example: ['V-Station Demo'],
  })
  importedPlugins!: string[];

  @ApiProperty({
    description: 'Detalle de los plugins omitidos',
    type: [ImportPackageSkippedItemDto],
  })
  skippedPlugins!: ImportPackageSkippedItemDto[];

  @ApiProperty({
    description: 'Nombres de los bancos importados exitosamente',
    type: [String],
    example: ['000_Novation V-Station demo.vfxbank'],
  })
  importedBanks!: string[];

  @ApiProperty({
    description: 'Detalle de los bancos omitidos',
    type: [ImportPackageSkippedItemDto],
  })
  skippedBanks!: ImportPackageSkippedItemDto[];

  @ApiPropertyOptional({
    description: 'Nombres de los bancos que fueron reparados al importar',
    type: [String],
    example: ['000_Novation V-Station demo.vfxbank'],
  })
  repairedBanks?: string[];

  @ApiProperty({ description: 'Total de bytes copiados', example: 6287408 })
  totalCopiedBytes!: number;
}

export const INSPECT_PACKAGE_EXAMPLE: InspectPackageDto = {
  packagePath: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\Novation V-Station demo.vfxlibrary',
  targetLibraryRoot: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\storage',
};

export const INSPECT_PACKAGE_RESULT_EXAMPLE: InspectPackageResultDto = {
  sourcePath: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\Novation V-Station demo.vfxlibrary\\Novation V-Station demo.vfxlibrary',
  resolvedKind: 'vfxlibrary',
  plugins: [
    {
      name: 'V-Station Demo',
      sourceDir: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\Novation V-Station demo.vfxlibrary\\plugs\\V-Station Demo',
      dllName: 'V-Station.dll',
      hasVfxinfo: true,
      vfxinfoId: 1316377392,
      vfxinfoName: 'V-Station Demo',
      fileCount: 2,
      totalSizeBytes: 6256046,
      alreadyExistsInTarget: false,
      matchedWizard: {
        id: '1316377392',
        name: 'V-Station Demo',
        vendor: 'Novation',
        isSynth: true,
      },
    },
  ],
  banks: [
    {
      name: '000_Novation V-Station demo.vfxbank',
      sourceDir: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\Novation V-Station demo.vfxlibrary\\banks\\000_Novation V-Station demo.vfxbank',
      presetCount: 6,
      totalSizeBytes: 31362,
      alreadyExistsInTarget: false,
      chunkPluginId: 1316377392,
      chunkPluginFourCc: 'NvS0',
      matchedWizardName: 'V-Station Demo',
      isConcordant: true,
      canRepair: true,
      deficiencies: [],
    },
  ],
};

export const IMPORT_PACKAGE_EXAMPLE: ImportPackageDto = {
  packagePath: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\Novation V-Station demo.vfxlibrary',
  targetLibraryRoot: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\storage',
  selectedPlugins: ['V-Station Demo'],
  selectedBanks: ['000_Novation V-Station demo.vfxbank'],
  collisionPolicy: 'skip',
  repairBanks: true,
};

export const IMPORT_PACKAGE_RESULT_EXAMPLE: ImportPackageResultDto = {
  targetLibraryRoot: 'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\storage',
  importedPlugins: ['V-Station Demo'],
  skippedPlugins: [],
  importedBanks: ['000_Novation V-Station demo.vfxbank'],
  skippedBanks: [],
  repairedBanks: [],
  totalCopiedBytes: 6287408,
};
