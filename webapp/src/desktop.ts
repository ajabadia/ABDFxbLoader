import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureCors, configureStaticAssets } from './app.setup';

function findEdgeBinary(): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find(existsSync) ?? 'msedge.exe';
}

function openFallback(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', url], { detached: true, stdio: 'ignore' });
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  }
}

export async function bootstrapDesktop(): Promise<void> {
  process.env['FXB_APP_MODE'] = 'desktop';

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(),
    {
      logger: ['error', 'warn'],
    },
  );
  configureCors(app);
  configureStaticAssets(app);

  // Escuchar en loopback (puerto efímero para evitar conflictos con otros servicios)
  const port = Number(process.env['PORT'] ?? 3210);
  await app.listen(port, '127.0.0.1');
  const url = `http://127.0.0.1:${port}`;

  console.log(`[ABDfxbloader Desktop] Servidor activo en ${url}`);

  if (process.env['FXB_DESKTOP_AUTORUN'] === 'false') {
    return;
  }

  const edge = findEdgeBinary();
  const profileDir = path.join(process.env['APPDATA'] ?? os.tmpdir(), 'ABDfxbloader', 'EdgeProfile');

  if (edge) {
    const child = spawn(
      edge,
      [
        `--app=${url}`,
        '--window-size=1280,850',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      {
        detached: false,
        stdio: 'ignore',
      },
    );

    child.on('exit', async () => {
      console.log('[ABDfxbloader Desktop] Ventana cerrada por el usuario. Deteniendo servidor...');
      await app.close();
      process.exit(0);
    });

    child.on('error', async (err) => {
      console.error('[ABDfxbloader Desktop] Fallo al iniciar Edge, abriendo navegador predeterminado:', err);
      openFallback(url);
    });
  } else {
    openFallback(url);
  }
}

void bootstrapDesktop();
