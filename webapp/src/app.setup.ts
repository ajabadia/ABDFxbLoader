import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
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

/**
 * Hashes de los `<script>` en línea de `index.html`: hoy es el import map que
 * resuelve `@abdsynths/shared` en el navegador. Se calculan al arrancar para que
 * una política estricta no dependa de copiar el hash a mano: si el import map
 * cambia, el hash cambia con él.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const body = match[1] ?? '';
    if (body.trim() === '') continue;
    // El parser de HTML normaliza CRLF (y CR) a LF antes de extraer el texto del
    // script: el hash se calcula sobre lo que ve el navegador, no sobre los
    // bytes del fichero. Con el fichero en CRLF, hashear el original da otro
    // valor y el navegador bloquea el import map (la app no arranca).
    const normalized = body.split('\r\n').join('\n').split('\r').join('\n');
    hashes.push(`'sha256-${createHash('sha256').update(normalized, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/**
 * Cabeceras de seguridad para la vista local. La CSP es estricta salvo donde el
 * marcado la obliga: el import map va en línea (de ahí los hashes) y los estilos
 * en línea los usa el navegador al pintar celdas y arrastres.
 *
 * Swagger UI (`/docs`) queda fuera: swagger-ui-express inyecta scripts y estilos
 * propios que no se pueden firmar sin copiar su bundle.
 */
export function configureSecurityHeaders(app: NestExpressApplication): void {
  const htmlPath = path.join(resolvePublicDir(), 'index.html');
  let hashes: string[] = [];
  try {
    hashes = inlineScriptHashes(readFileSync(htmlPath, 'utf8'));
  } catch {
    // Sin `index.html` no hay nada que servir: el 404 explicará el resto.
    hashes = [];
  }

  const policy = [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const docs =
      req.path === '/docs' || req.path.startsWith('/docs/') || req.path.startsWith('/docs-json');
    if (!docs) res.setHeader('Content-Security-Policy', policy);
    next();
  });
}
