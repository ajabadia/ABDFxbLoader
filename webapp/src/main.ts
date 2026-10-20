import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureStaticAssets } from './app.setup';
import { buildOpenApiDocument } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureStaticAssets(app);

  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { displayRequestDuration: true },
  });

  // Solo loopback: escribe en el disco del usuario, no es un servicio público.
  const port = Number(process.env['PORT'] ?? 3210);
  await app.listen(port, '127.0.0.1');

  console.log(`fxbLoader web en http://127.0.0.1:${port}`);
  console.log(`OpenAPI en http://127.0.0.1:${port}/docs (JSON: /docs-json)`);
}

void bootstrap();
