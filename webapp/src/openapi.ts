import 'reflect-metadata';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './swagger';

/**
 * Genera `openapi.json` en la raíz de `webapp/` sin abrir ningún puerto.
 * Uso: `npm run openapi`.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  try {
    const document = buildOpenApiDocument(app);
    const target = path.resolve(__dirname, '..', 'openapi.json');
    await fs.writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    console.log(`OpenAPI escrito en ${target}`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
