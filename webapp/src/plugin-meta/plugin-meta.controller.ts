import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import { PluginMetaService } from './plugin-meta.service';
import type { PluginMetaSnapshot } from './plugin-meta.types';
import {
  COMMON_KEYS,
  PluginMetaConflictError,
  PluginMetaInvalidError,
} from './plugin-meta.types';

export interface CommonInput {
  name: string;
  id: string;
}

@Controller('plugins')
export class PluginMetaController {
  constructor(private readonly service: PluginMetaService) {}

  @Get(':id/meta')
  async readMeta(
    @Param('id', ParseIntPipe) _id: number,
    @Query('dir') dir: string | undefined,
  ): Promise<PluginMetaSnapshot> {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new BadRequestException('Se requiere el parámetro dir');
    }

    return this.service.read(dir);
  }

  @Post(':id/meta')
  async upsertMeta(
    @Param('id', ParseIntPipe) _id: number,
    @Query('dir') dir: string | undefined,
    @Query('mtimeMs') rawMtimeMs: string | undefined,
    @Query('name') rawName: string | undefined,
    @Query('id') rawId: string | undefined,
  ): Promise<PluginMetaSnapshot> {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new BadRequestException('Se requiere el parámetro dir');
    }

    const mtimeMs: number | null =
      rawMtimeMs === undefined
        ? null
        : rawMtimeMs === ''
          ? null
          : Number(rawMtimeMs);

    if (rawMtimeMs !== undefined && rawMtimeMs !== '' && !Number.isFinite(mtimeMs)) {
      throw new BadRequestException('mtimeMs debe ser un número o vacío');
    }

    const name: string =
      typeof rawName === 'string' && rawName.trim().length > 0
        ? rawName.trim()
        : 'plugin';

    const id: string =
      typeof rawId === 'string' && rawId.trim().length > 0
        ? rawId.trim()
        : 'plugin';

    if (!COMMON_KEYS.has('id')) {
      throw new BadRequestException('id no es un campo común admitido');
    }
    if (!COMMON_KEYS.has('name')) {
      throw new BadRequestException('name no es un campo común admitido');
    }

    try {
      return this.service.write({
        pluginDir: dir,
        expectedMtimeMs: mtimeMs,
        common: {
          name,
          id,
          vendor: '',
          vendor_url: '',
          genre: '',
          name_abbreviation: '',
          notes: '',
          created: '',
        },
        extended: {},
      });
    } catch (error) {
      if (error instanceof PluginMetaConflictError) {
        throw new BadRequestException({
          message: 'El archivo propio cambió en disco',
          current: error.current,
        });
      }
      if (error instanceof PluginMetaInvalidError) {
        throw new BadRequestException({
          message: 'Metadatos no válidos',
          issues: error.issues,
        });
      }
      throw error;
    }
  }
}
