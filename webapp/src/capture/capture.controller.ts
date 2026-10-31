import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CaptureService } from './capture.service';
import {
  CAPTURE_DIFF_EXAMPLE,
  CAPTURE_FINALIZE_RESULT_EXAMPLE,
  CAPTURE_FINISH_REQUEST_EXAMPLE,
  CAPTURE_NOT_FOUND_DIFF_EXAMPLE,
  CAPTURE_NOT_FOUND_SNAPSHOT_BEFORE_EXAMPLE,
  CAPTURE_NOT_FOUND_SNAPSHOT_EXAMPLE,
  CAPTURE_NOT_FOUND_STAGING_EXAMPLE,
  CAPTURE_NOT_FOUND_STAGING_FILE_EXAMPLE,
  CAPTURE_NOT_FOUND_TASK_EXAMPLE,
  CAPTURE_OK_EXAMPLE,
  CAPTURE_PACKAGE_REQUEST_EXAMPLE,
  CAPTURE_PACKAGE_RESULT_EXAMPLE,
  CAPTURE_PRE_EXISTING_EXAMPLE,
  CAPTURE_PRE_EXISTING_REVEAL_EXAMPLE,
  CAPTURE_SNAPSHOT_EXAMPLE,
  CAPTURE_STAGING_EXAMPLE,
  CAPTURE_STAGING_RESTORE_EXAMPLE,
  CAPTURE_STAGING_REVEAL_EXAMPLE,
  CAPTURE_START_REQUEST_EXAMPLE,
  CAPTURE_TASK_EXAMPLE,
  CAPTURE_TASK_FINISHED_EXAMPLE,
  CAPTURE_VMACHINE_REQUEST_EXAMPLE,
  CAPTURE_VMACHINE_RESULT_EXAMPLE,
  CaptureDiffDto,
  CaptureErrorDto,
  CaptureFinalizeResultDto,
  CaptureOkDto,
  CapturePackageResultDto,
  CapturePreExistingDto,
  CaptureRevealPreExistingDto,
  CaptureRevealStagingDto,
  CaptureSnapshotDto,
  CaptureStagingListDto,
  CaptureStagingRestoreDto,
  CaptureTaskDto,
  CaptureVMachineResultDto,
  FinishCaptureDto,
  PackageDiffDto,
  StartSnapshotDto,
  VMachineRequestDto,
} from './capture.dto';

@ApiTags('capture')
@Controller('capture')
export class CaptureController {
  constructor(private readonly service: CaptureService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Iniciar snapshot del sistema (archivos y registro)',
    description:
      'Arranca una tarea en segundo plano y devuelve su estado inicial. El progreso se ' +
      'consulta con `GET /capture/tasks/:taskId` hasta que `status` sea terminal.',
  })
  @ApiBody({ type: StartSnapshotDto, examples: { estandar: { value: CAPTURE_START_REQUEST_EXAMPLE } } })
  @ApiOkResponse({
    description: 'Tarea creada; el snapshot queda disponible cuando la tarea termina.',
    type: CaptureTaskDto,
    example: CAPTURE_TASK_EXAMPLE,
  })
  start(@Body() dto: StartSnapshotDto) {
    return this.service.beginSnapshotTask(dto);
  }

  @Get('tasks/:taskId')
  @ApiOperation({
    summary: 'Consultar estado y progreso de una captura',
    description:
      'Devuelve el estado vivo de la tarea. Al terminar, `result` resume el snapshot o el ' +
      'diff producidos.',
  })
  @ApiParam({ name: 'taskId', description: 'ID devuelto por `POST /capture/start` o `/capture/finish`.', example: CAPTURE_TASK_EXAMPLE.taskId })
  @ApiOkResponse({
    description: 'Estado de la tarea.',
    type: CaptureTaskDto,
    examples: {
      enCurso: { summary: 'Captura recorriendo archivos', value: CAPTURE_TASK_EXAMPLE },
      terminada: { summary: 'Tarea de fin de captura completada', value: CAPTURE_TASK_FINISHED_EXAMPLE },
    },
  })
  @ApiNotFoundResponse({
    description: 'No existe ninguna tarea con ese ID (p. ej. tras reiniciar el servidor).',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_TASK_EXAMPLE,
  })
  getTask(@Param('taskId') taskId: string) {
    const task = this.service.getTask(taskId);
    if (!task) throw new NotFoundException({ message: `No existe la tarea de captura "${taskId}".` });
    return task;
  }

  @Post('tasks/:taskId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Detener una captura en curso',
    description: 'Marca la tarea como `cancelling`; no se guarda un snapshot parcial.',
  })
  @ApiParam({ name: 'taskId', description: 'ID de la tarea que se quiere detener.', example: CAPTURE_TASK_EXAMPLE.taskId })
  @ApiOkResponse({
    description: 'Tarea con el estado de cancelación ya aplicado.',
    type: CaptureTaskDto,
    example: { ...CAPTURE_TASK_EXAMPLE, status: 'cancelled', phase: 'cancelled', message: 'Captura detenida.' },
  })
  @ApiNotFoundResponse({
    description: 'No existe ninguna tarea con ese ID.',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_TASK_EXAMPLE,
  })
  cancelTask(@Param('taskId') taskId: string) {
    const task = this.service.cancelTask(taskId);
    if (!task) throw new NotFoundException({ message: `No existe la tarea de captura "${taskId}".` });
    return task;
  }

  @Post('finish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finalizar captura: tomar snapshot y calcular diferencias',
    description:
      'Toma un segundo snapshot y lo compara con el de partida. Cuando la tarea termina, ' +
      '`result.diffId` es el que se pasa a `/capture/package`.',
  })
  @ApiBody({ type: FinishCaptureDto, examples: { estandar: { value: CAPTURE_FINISH_REQUEST_EXAMPLE } } })
  @ApiOkResponse({
    description: 'Tarea de cierre creada; el diff aparece en `result` al terminar.',
    type: CaptureTaskDto,
    example: CAPTURE_TASK_FINISHED_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'El `snapshotIdBefore` no existe, así que no se crea ninguna tarea de cierre.',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_SNAPSHOT_BEFORE_EXAMPLE,
  })
  finish(@Body() dto: FinishCaptureDto) {
    // La tarea corre en segundo plano: sin esta comprobación, un snapshot
    // inexistente se aceptaría con 201 y solo fallaría dentro de la tarea.
    if (!this.service.getSnapshot(dto.snapshotIdBefore)) {
      throw new NotFoundException({
        message: `No existe el snapshot inicial "${dto.snapshotIdBefore}" para cerrar la captura.`,
      });
    }
    return this.service.beginFinishTask(dto);
  }

  @Get('snapshots/:id')
  @ApiOperation({ summary: 'Obtener el contenido completo de un snapshot' })
  @ApiParam({ name: 'id', description: 'ID del snapshot.', example: CAPTURE_SNAPSHOT_EXAMPLE.id })
  @ApiOkResponse({
    description: 'Snapshot con todos los archivos y valores de registro.',
    type: CaptureSnapshotDto,
    example: CAPTURE_SNAPSHOT_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'No existe ningún snapshot con ese ID.',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_SNAPSHOT_EXAMPLE,
  })
  getSnapshot(@Param('id') id: string) {
    const snapshot = this.service.getSnapshot(id);
    if (!snapshot) throw new NotFoundException({ message: `No existe el snapshot "${id}".` });
    return snapshot;
  }

  @Get('diff/:id')
  @ApiOperation({ summary: 'Obtener diff por ID' })
  @ApiParam({ name: 'id', description: 'ID del diff calculado al finalizar la captura.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  @ApiOkResponse({
    description: 'Diff completo entre los dos snapshots.',
    type: CaptureDiffDto,
    example: CAPTURE_DIFF_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'No existe ningún diff con ese ID.',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_DIFF_EXAMPLE,
  })
  async getDiff(@Param('id') id: string) {
    const diff = this.service.getDiff(id);
    if (!diff) {
      throw new NotFoundException({ message: `No existe el diff "${id}".` });
    }
    return diff;
  }

  @Post('package')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Copiar diff a zona de staging para revisar/editar',
    description:
      'Prepara los archivos y el registro del diff en una carpeta de staging propia; el ' +
      'destino final no se toca hasta `/capture/finalize`. Incluye además los archivos del ' +
      'plugin que ya existían antes de la captura (`preExistingFiles`), recuperados del snapshot ' +
      'inicial y acotados al tallo del DLL y a las carpetas donde la captura puso archivos para ' +
      'no arrastrar otros plugins de la misma carpeta. Al ser staging, `GET /capture/staging/:diffId` ' +
      'los lista y `DELETE /capture/staging/:diffId?path=` permite quitarlos antes de empaquetar: ' +
      'lo que se quite no llega ni a `/capture/finalize` ni a `/capture/vmachine/:diffId`.',
  })
  @ApiBody({ type: PackageDiffDto, examples: { estandar: { value: CAPTURE_PACKAGE_REQUEST_EXAMPLE } } })
  @ApiOkResponse({
    description: 'Staging creado, con el recuento de lo preparado.',
    type: CapturePackageResultDto,
    example: CAPTURE_PACKAGE_RESULT_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'No existe ningún diff con ese `diffId` para empaquetar.',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_DIFF_EXAMPLE,
  })
  async package(@Body() dto: PackageDiffDto) {
    return this.service.packageDiff(dto.diffId, dto.targetDir, dto.packageName);
  }

  @Get('pre-existing/:diffId')
  @ApiOperation({
    summary: 'Contar los archivos previos a la captura que se incluirían',
    description:
      'Consulta el snapshot inicial sin copiar nada: devuelve cuántos archivos del plugin ya ' +
      'existían antes de la captura y se sumarían al paquete con «incluir los archivos previos». ' +
      'Es la misma selección que hace `/capture/package`, acotada al tallo del DLL y a las ' +
      'carpetas donde la captura puso archivos. Si el staging ya existe, solo cuenta los que ' +
      'siguen en él, porque son los que `/capture/vmachine/:diffId` empaquetaría de verdad. ' +
      '`restorableFiles` lista los que se quitaron y todavía se pueden devolver de uno en uno.',
  })
  @ApiParam({ name: 'diffId', description: 'ID del diff calculado al finalizar la captura.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  @ApiOkResponse({
    description: 'Recuento y rutas relativas de los archivos previos que entrarían.',
    type: CapturePreExistingDto,
    example: CAPTURE_PRE_EXISTING_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'No existe ningún diff con ese `diffId`.',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_DIFF_EXAMPLE,
  })
  async listPreExisting(@Param('diffId') diffId: string) {
    return this.service.listPreExisting(diffId);
  }

  @Post('pre-existing/:diffId/reveal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abrir en el Explorador de Windows un archivo previo del paso 4',
    description:
      'Abre la carpeta del Explorador con ese archivo resaltado, para comprobar qué es antes ' +
      'de generar el banco. El `path` se valida contra la misma selección que hace ' +
      '`GET /capture/pre-existing/:diffId`: una ruta que no sea de los previos de ese diff, o ' +
      'un previo que ya no está en el disco, es un 404 y no se abre ninguna ventana. El ' +
      'servidor tiene que correr en Windows; en otro sistema es un 501.',
  })
  @ApiParam({ name: 'diffId', description: 'ID del diff calculado al finalizar la captura.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  @ApiQuery({
    name: 'path',
    required: true,
    description:
      'Ruta del previo tal como la devuelve `GET /capture/pre-existing/:diffId` en `files`. ' +
      'Se compara sin distinguir mayúsculas ni separadores.',
    example: CAPTURE_PRE_EXISTING_EXAMPLE.files[0],
  })
  @ApiOkResponse({
    description: 'Archivo mostrado en el Explorador.',
    type: CaptureRevealPreExistingDto,
    example: CAPTURE_PRE_EXISTING_REVEAL_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Falta el parámetro `path`.',
    type: CaptureErrorDto,
    example: { message: 'path requerido' },
  })
  @ApiNotFoundResponse({
    description:
      'No existe el diff, o el `path` no es uno de sus archivos previos: también cuando ese ' +
      'previo existía al listarlo pero ya se borró del disco.',
    schema: { $ref: getSchemaPath(CaptureErrorDto) },
    examples: {
      sinDiff: { summary: 'El diff ya no está cargado', value: CAPTURE_NOT_FOUND_DIFF_EXAMPLE },
      noEsPrevio: {
        summary: 'La ruta no es de los archivos previos, o el previo ya no está',
        value: {
          message:
            '"otro.dll" no es uno de los archivos previos del diff "5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f" ' +
            'o ya no está en el disco.',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_IMPLEMENTED,
    description: 'El servidor no corre en Windows: no hay Explorador que abrir.',
    type: CaptureErrorDto,
    example: { message: 'Abrir en el Explorador solo está disponible en Windows' },
  })
  async revealPreExisting(@Param('diffId') diffId: string, @Query('path') filePath: string) {
    if (!filePath) throw new BadRequestException('path requerido');
    return this.service.revealPreExisting(diffId, filePath);
  }

  @Post('staging/:diffId/reveal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abrir en el Explorador de Windows un archivo del staging',
    description:
      'Abre la carpeta del Explorador con ese archivo del staging resaltado, para comprobar qué se ' +
      'va a empaquetar. El `path` se resuelve dentro de la carpeta del staging del `diffId`: una ruta ' +
      'absoluta, con `..`, de una carpeta o de un archivo que ya no está es un 404 y no se abre nada. ' +
      'El servidor tiene que correr en Windows; en otro sistema es un 501.',
  })
  @ApiParam({ name: 'diffId', description: 'ID del diff empaquetado.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  @ApiQuery({
    name: 'path',
    required: true,
    description: 'Ruta del archivo tal como la devuelve `GET /capture/staging/:diffId` en `files`.',
    example: CAPTURE_STAGING_REVEAL_EXAMPLE.file,
  })
  @ApiOkResponse({
    description: 'Archivo del staging mostrado en el Explorador.',
    type: CaptureRevealStagingDto,
    example: CAPTURE_STAGING_REVEAL_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Falta el parámetro `path`.',
    type: CaptureErrorDto,
    example: { message: 'path requerido' },
  })
  @ApiNotFoundResponse({
    description:
      'No existe el staging del diff, o el `path` no apunta a un archivo que siga dentro de él.',
    schema: { $ref: getSchemaPath(CaptureErrorDto) },
    examples: {
      sinStaging: { summary: 'El staging no está preparado', value: CAPTURE_NOT_FOUND_STAGING_EXAMPLE },
      sinArchivo: {
        summary: 'La ruta no es del staging o el archivo ya no está',
        value: CAPTURE_NOT_FOUND_STAGING_FILE_EXAMPLE,
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_IMPLEMENTED,
    description: 'El servidor no corre en Windows: no hay Explorador que abrir.',
    type: CaptureErrorDto,
    example: { message: 'Abrir en el Explorador solo está disponible en Windows' },
  })
  async revealStaging(@Param('diffId') diffId: string, @Query('path') filePath: string) {
    if (!filePath) throw new BadRequestException('path requerido');
    return this.service.revealStagingFile(diffId, filePath);
  }

  @Get('staging/:diffId')
  @ApiOperation({ summary: 'Listar archivos en staging' })
  @ApiParam({ name: 'diffId', description: 'ID del diff empaquetado.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  @ApiOkResponse({
    description: 'Carpeta de staging y rutas relativas de sus archivos.',
    type: CaptureStagingListDto,
    example: CAPTURE_STAGING_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description:
      'No hay staging para ese diff: no se ha empaquetado con `/capture/package` o se ' +
      'limpió con `DELETE /capture/staging/:diffId/clean`.',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_STAGING_EXAMPLE,
  })
  async listStaging(@Param('diffId') diffId: string) {
    return this.service.listStaging(diffId);
  }

  @Delete('staging/:diffId')
  @ApiOperation({ summary: 'Eliminar archivo del staging' })
  @ApiParam({ name: 'diffId', description: 'ID del diff empaquetado.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  @ApiQuery({
    name: 'path',
    description: 'Ruta relativa dentro del staging.',
    required: true,
    example: CAPTURE_STAGING_EXAMPLE.files[0],
  })
  @ApiOkResponse({
    description: 'Archivo retirado del staging.',
    type: CaptureOkDto,
    example: CAPTURE_OK_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Falta el parámetro `path`, o la ruta se sale del staging.',
    type: CaptureErrorDto,
    example: { message: 'path requerido' },
  })
  @ApiNotFoundResponse({
    description:
      'No hay staging para ese diff, o el archivo indicado en `path` ya no está en él. ' +
      'Una ruta inexistente no se responde con 200: no se ha borrado nada.',
    schema: { $ref: getSchemaPath(CaptureErrorDto) },
    examples: {
      sinStaging: { summary: 'El diff no se ha empaquetado', value: CAPTURE_NOT_FOUND_STAGING_EXAMPLE },
      sinArchivo: { summary: 'El archivo no está en el staging', value: CAPTURE_NOT_FOUND_STAGING_FILE_EXAMPLE },
    },
  })
  async removeFromStaging(@Param('diffId') diffId: string, @Query('path') filePath: string) {
    if (!filePath) throw new BadRequestException('path requerido');
    await this.service.removeFromStaging(diffId, filePath);
    return { ok: true };
  }

  @Post('staging/:diffId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recuperar en el staging los archivos previos que se quitaron',
    description:
      'Vuelve a copiar desde el snapshot inicial los archivos que `POST /capture/package` marcó ' +
      'como anteriores a la captura y que ya no están en el staging. No repite el empaquetado: ' +
      'los archivos de la captura, el `.reg` y el manifiesto se quedan como están. Los que el ' +
      'manifiesto declara pero cuyo origen ya no existe se devuelven en `missing`, no como error. ' +
      'Con `path` devuelve solo ese archivo —el botón de una fila quitada del staging—; sin ' +
      '`path` los devuelve todos. Repetirlo sin nada que devolver es un 200 con `restored: 0`.',
  })
  @ApiParam({ name: 'diffId', description: 'ID del diff empaquetado.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  @ApiQuery({
    name: 'path',
    required: false,
    description:
      'Ruta relativa del único previo que se quiere devolver, tal como aparece en `restorableFiles` ' +
      'de `GET /capture/pre-existing/:diffId`. Si no es uno de los previos que el manifiesto marca, ' +
      'la respuesta es 404 y no se copia nada.',
    example: CAPTURE_STAGING_RESTORE_EXAMPLE.files[0],
  })
  @ApiOkResponse({
    description: 'Archivos previos devueltos al staging, y los que ya no se pueden recuperar.',
    type: CaptureStagingRestoreDto,
    example: CAPTURE_STAGING_RESTORE_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description:
      'No hay staging para ese diff, el diff ya no está cargado (por ejemplo, tras reiniciar el ' +
      'servidor) —sin snapshot inicial no hay de dónde copiar los previos—, o el `path` pedido no ' +
      'es uno de los archivos previos del manifiesto.',
    schema: { $ref: getSchemaPath(CaptureErrorDto) },
    examples: {
      sinStaging: { summary: 'El diff no se ha empaquetado', value: CAPTURE_NOT_FOUND_STAGING_EXAMPLE },
      sinDiff: { summary: 'El diff ya no está cargado', value: CAPTURE_NOT_FOUND_DIFF_EXAMPLE },
    },
  })
  async restoreStaging(@Param('diffId') diffId: string, @Query('path') filePath?: string) {
    return this.service.restoreStagingPreExisting(diffId, filePath || undefined);
  }

  @Delete('staging/:diffId/clean')
  @ApiOperation({ summary: 'Limpiar zona de staging' })
  @ApiParam({ name: 'diffId', description: 'ID del diff empaquetado.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  @ApiOkResponse({
    description: 'Staging vaciado.',
    type: CaptureOkDto,
    example: CAPTURE_OK_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'No hay staging para ese diff, así que no hay nada que limpiar.',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_STAGING_EXAMPLE,
  })
  async cleanStaging(@Param('diffId') diffId: string) {
    await this.service.cleanStaging(diffId);
    return { ok: true };
  }

  @Post('finalize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finalizar y copiar staging al destino final',
    description: 'Copia el staging revisado a la carpeta de destino indicada.',
  })
  @ApiBody({ type: PackageDiffDto, examples: { estandar: { value: CAPTURE_PACKAGE_REQUEST_EXAMPLE } } })
  @ApiOkResponse({
    description: 'Paquete copiado al destino final.',
    type: CaptureFinalizeResultDto,
    example: CAPTURE_FINALIZE_RESULT_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description:
      'No existe ningún diff con ese `diffId`, o su staging ya no está en disco ' +
      '(hay que volver a ejecutar `/capture/package`).',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_DIFF_EXAMPLE,
  })
  async finalize(@Body() dto: PackageDiffDto) {
    return this.service.finalizePackage(dto.diffId, dto.targetDir, dto.packageName);
  }

  @Post('vmachine/:diffId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generar paquete de plugin para v-machine y/o wizard reutilizable',
    description:
      'Construye `plugs\\<pluginName>\\` a partir del staging de `/capture/package`: recorta la ruta ' +
      'relativa a la unidad, deja el DLL en la raíz del plugin, escribe `vfxinfo.txt` con un `dll_name` ' +
      'relativo y crea `presets\\`, de modo que la carpeta se puede escanear e importar como una librería ' +
      'real. El staging es la única fuente: lo que se haya quitado al revisarlo no se empaqueta. Con ' +
      '`includePreExisting: false` se dejan fuera los archivos que ya existían antes de la captura y que ' +
      '`/capture/package` marcó como previos en el manifiesto del staging; por defecto (`true`) se ' +
      'empaqueta todo el staging. Regenerar sobre la misma carpeta parte de cero: si ' +
      '`plugs\\<pluginName>\\` ya tiene una generación anterior (su `vfxinfo.txt`), se borra antes de ' +
      'escribir para no dejar archivos obsoletos. Opcionalmente escribe el `.vfxwizard` junto al paquete. ' +
      'Los avisos no abortan la generación.',
  })
  @ApiParam({ name: 'diffId', description: 'ID del diff empaquetado.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  @ApiBody({ type: VMachineRequestDto, examples: { estandar: { value: CAPTURE_VMACHINE_REQUEST_EXAMPLE } } })
  @ApiOkResponse({
    description: 'Rutas generadas y avisos.',
    type: CaptureVMachineResultDto,
    example: CAPTURE_VMACHINE_RESULT_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description:
      'No existe ningún diff con ese `diffId`, o su staging ya no está en disco ' +
      '(hay que volver a ejecutar `/capture/package`).',
    type: CaptureErrorDto,
    example: CAPTURE_NOT_FOUND_DIFF_EXAMPLE,
  })
  async generateVMachine(@Param('diffId') diffId: string, @Body() body: VMachineRequestDto) {
    return this.service.generateForVMachine(diffId, body);
  }
}
