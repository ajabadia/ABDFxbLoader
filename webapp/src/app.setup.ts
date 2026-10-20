import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * `public/` está en la raíz de `webapp/`; el mismo helper se usa desde
 * `dist/`, `dist-test/` y el árbol de fuentes.
 */
export function resolvePublicDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'public'),
    path.resolve(__dirname, '..', '..', 'public'),
    path.resolve(process.cwd(), 'public'),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? candidates[0]!;
}

export function configureStaticAssets(app: NestExpressApplication): void {
  app.useStaticAssets(resolvePublicDir(), { index: 'index.html' });
}
