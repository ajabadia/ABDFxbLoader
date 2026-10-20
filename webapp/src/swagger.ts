import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

/** Documento OpenAPI servido en `/docs` y exportado a `openapi.json`. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const configuredPort = Number(process.env['PORT']);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3210;
  const config = new DocumentBuilder()
    .setTitle('fxbLoader web')
    .setDescription(
      'API local para configurar `fxbLoader.config` y administrar una librería VFX. ' +
        'Todas las rutas escriben en el disco del usuario: el servidor solo escucha en loopback. ' +
        'La escritura de configuración es atómica y usa `mtimeMs` como control optimista.',
    )
    .setVersion('0.1.0')
    .addServer(`http://127.0.0.1:${port}`, 'Instancia local')
    .addTag('fxb-config', 'Lectura y escritura de fxbLoader.config')
    .addTag(
      'library',
      'Escaneo de la librería, instalación y desinstalación del cargador e importación de bancos',
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}
