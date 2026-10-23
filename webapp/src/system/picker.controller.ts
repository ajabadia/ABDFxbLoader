import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  SYSTEM_PICK_BUSY_EXAMPLE,
  SYSTEM_PICK_CANCELLED_EXAMPLE,
  SYSTEM_PICK_FILE_EXAMPLE,
  SYSTEM_PICK_FILES_EXAMPLE,
  SYSTEM_PICK_FOLDER_EXAMPLE,
  SYSTEM_PICK_UNSUPPORTED_EXAMPLE,
  SystemPickErrorDto,
  SystemPickRequestDto,
  SystemPickResponseDto,
} from './picker.dto';
import { PickerService } from './picker.service';
import { PickerBusyError, PickerUnsupportedError } from './picker.types';
import type { PickInput, PickKind } from './picker.types';

const KINDS = ['folder', 'file', 'files'] as const;
const MAX_TITLE = 80;
const MAX_EXTENSIONS = 5;
/** Extensión sin punto: `fxb`, `dll`. */
const EXTENSION = /^[A-Za-z0-9]{1,16}$/;
/** Ruta absoluta de Windows (`C:\…`) o UNC (`\\servidor\…`). */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

const DEFAULT_TITLES: Record<PickKind, string> = {
  folder: 'Elige una carpeta',
  file: 'Elige un archivo',
  files: 'Elige los archivos',
};

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('El cuerpo debe ser un objeto JSON');
  }
  return body as Record<string, unknown>;
}

function readKind(record: Record<string, unknown>): PickKind {
  const value = record['kind'];
  if (typeof value !== 'string' || !(KINDS as readonly string[]).includes(value)) {
    throw new BadRequestException('kind debe ser "folder", "file" o "files"');
  }
  return value as PickKind;
}

function readTitle(record: Record<string, unknown>, kind: PickKind): string {
  const value = record['title'];
  if (value === undefined) return DEFAULT_TITLES[kind];
  if (typeof value !== 'string') {
    throw new BadRequestException('title debe ser una cadena');
  }
  const title = value.trim();
  if (title === '') return DEFAULT_TITLES[kind];
  if (title.length > MAX_TITLE) {
    throw new BadRequestException(`title no puede superar los ${MAX_TITLE} caracteres`);
  }
  return title;
}

function readExtensions(record: Record<string, unknown>): string[] {
  const value = record['extensions'];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException('extensions debe ser una lista de cadenas');
  }
  if (value.length > MAX_EXTENSIONS) {
    throw new BadRequestException(`extensions admite como máximo ${MAX_EXTENSIONS} entradas`);
  }

  const extensions = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !EXTENSION.test(entry)) {
      throw new BadRequestException(
        `extensions debe contener extensiones sin punto: ${JSON.stringify(entry)}`,
      );
    }
    extensions.add(entry.toLowerCase());
  }
  return [...extensions];
}

function readInitialDir(record: Record<string, unknown>): string | null {
  const value = record['initialDir'];
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('initialDir debe ser una cadena');
  }
  const target = value.trim();
  if (target === '') return null;
  if (!ABSOLUTE_PATH.test(target)) {
    throw new BadRequestException(
      `initialDir debe ser una ruta absoluta de Windows: ${JSON.stringify(target)}`,
    );
  }
  return target;
}

/** Valida el cuerpo como lo haría el diálogo: `kind`, título, extensiones y ruta. */
export function readPickInput(body: unknown): PickInput {
  const record = asRecord(body);
  const kind = readKind(record);
  return {
    kind,
    title: readTitle(record, kind),
    // Las extensiones no filtran carpetas: se ignoran en vez de rechazarlas.
    extensions: kind === 'folder' ? [] : readExtensions(record),
    initialDir: readInitialDir(record),
  };
}

function mapPickerError(error: unknown): never {
  if (error instanceof PickerBusyError) {
    throw new ConflictException({ message: error.message });
  }
  if (error instanceof PickerUnsupportedError) {
    throw new HttpException({ message: error.message }, HttpStatus.NOT_IMPLEMENTED);
  }
  throw error;
}

@ApiTags('system')
@ApiExtraModels(SystemPickErrorDto)
@Controller('system')
export class SystemController {
  constructor(private readonly picker: PickerService) {}

  @Post('pick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abre un diálogo nativo para elegir una carpeta o archivos',
    description:
      'Lo usa la vista para no tener que pegar rutas a mano. El diálogo lo abre el ' +
      'servidor en la máquina donde corre (PowerShell + `System.Windows.Forms`), porque ' +
      'el navegador no expone rutas absolutas. La petición queda abierta hasta que la ' +
      'persona elige o cancela; cancelar devuelve `paths: []`.',
  })
  @ApiBody({
    type: SystemPickRequestDto,
    examples: {
      carpeta: {
        summary: 'Elegir la carpeta de la librería',
        value: { kind: 'folder', title: 'Elige la carpeta de la librería VFX' },
      },
      archivos: {
        summary: 'Elegir varios bancos .fxb',
        value: {
          kind: 'files',
          title: 'Elige los bancos .fxb para importar',
          extensions: ['fxb'],
          initialDir: 'C:\\Bancos',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Rutas absolutas elegidas, o `paths: []` si se canceló el diálogo.',
    type: SystemPickResponseDto,
    examples: {
      carpeta: { summary: 'Una carpeta', value: SYSTEM_PICK_FOLDER_EXAMPLE },
      archivo: { summary: 'Un archivo', value: SYSTEM_PICK_FILE_EXAMPLE },
      archivos: { summary: 'Dos archivos', value: SYSTEM_PICK_FILES_EXAMPLE },
      cancelado: { summary: 'Cancelado', value: SYSTEM_PICK_CANCELLED_EXAMPLE },
    },
  })
  @ApiBadRequestResponse({
    description:
      '`kind` fuera de la lista, título de más de 80 caracteres, extensión con punto ' +
      'o `initialDir` que no es una ruta absoluta.',
    type: SystemPickErrorDto,
    examples: {
      kind: {
        summary: 'Tipo desconocido',
        value: { message: 'kind debe ser "folder", "file" o "files"' },
      },
      titulo: {
        summary: 'Título demasiado largo',
        value: { message: `title no puede superar los ${MAX_TITLE} caracteres` },
      },
      extension: {
        summary: 'Extensión con punto',
        value: { message: 'extensions debe contener extensiones sin punto: ".fxb"' },
      },
      ruta: {
        summary: 'Carpeta relativa',
        value: { message: 'initialDir debe ser una ruta absoluta de Windows: "Bancos"' },
      },
    },
  })
  @ApiConflictResponse({
    description: 'Ya hay un diálogo abierto (solo puede haber uno a la vez).',
    type: SystemPickErrorDto,
    example: SYSTEM_PICK_BUSY_EXAMPLE,
  })
  @ApiResponse({
    status: HttpStatus.NOT_IMPLEMENTED,
    description: 'El servidor no corre en Windows, así que no puede abrir el diálogo nativo.',
    type: SystemPickErrorDto,
    example: SYSTEM_PICK_UNSUPPORTED_EXAMPLE,
  })
  async pick(@Body() body: unknown): Promise<{ paths: string[] }> {
    const input = readPickInput(body);
    try {
      return { paths: await this.picker.pick(input) };
    } catch (error) {
      mapPickerError(error);
    }
  }
}
