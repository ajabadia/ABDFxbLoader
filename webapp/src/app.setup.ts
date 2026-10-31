import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * `public/` está en la raíz de `webapp/`; el mismo helper se usa desde
 * `dist/`, `dist-test/` y el árbol de fuentes.
 */
export function resolvePublicDir(): string {
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.resolve(exeDir, 'public'),
    path.resolve(__dirname, '..', 'public'),
    path.resolve(__dirname, '..', '..', 'public'),
    path.resolve(process.cwd(), 'public'),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? candidates[0]!;
}

/**
 * El motor de i18n vive en `@abdsynths/shared` (instalado como
 * `file:../../ABDShared`). Sin bundler el navegador no resuelve paquetes, así
 * que `index.html` declara un import map hacia `/vendor/abdsynths/` y aquí se
 * sirve el contenido real del paquete.
 */
export function resolveSharedComponentsDir(): string | null {
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.resolve(exeDir, 'public', 'vendor', 'abdsynths', 'i18n'),
    path.resolve(exeDir, 'vendor', 'abdsynths', 'i18n'),
    path.resolve(__dirname, '..', 'node_modules', '@abdsynths', 'i18n'),
    path.resolve(__dirname, '..', 'node_modules', '@abdsynths', 'shared', 'Components'),
    path.resolve(__dirname, '..', '..', 'node_modules', '@abdsynths', 'i18n'),
    path.resolve(__dirname, '..', '..', 'node_modules', '@abdsynths', 'shared', 'Components'),
    path.resolve(process.cwd(), 'node_modules', '@abdsynths', 'i18n'),
    path.resolve(process.cwd(), 'node_modules', '@abdsynths', 'shared', 'Components'),
  ];
  return (
    candidates.find(
      (dir) => existsSync(path.join(dir, 'index.js')) || existsSync(path.join(dir, 'i18n.js')),
    ) ?? null
  );
}

export function configureStaticAssets(app: NestExpressApplication): void {
  app.useStaticAssets(resolvePublicDir(), { index: 'index.html' });

  const shared = resolveSharedComponentsDir();
  if (shared !== null) {
    app.useStaticAssets(shared, { prefix: '/vendor/abdsynths/' });
  }
}

export function configureCors(app: NestExpressApplication): void {
  app.enableCors({
    origin: [
      /^http:\/\/localhost(:\d+)?$/,
      /^http:\/\/127\.0\.0\.1(:\d+)?$/,
      /^https:\/\/.*\.vercel\.app$/,
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  });
}
