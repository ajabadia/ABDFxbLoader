import assert from 'node:assert/strict';
import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { after, before, test } from 'node:test';
import request from 'supertest';
import {
  configureCors,
  configureSecurityHeaders,
  isAllowedOrigin,
  isLoopbackHost,
  isMutating,
  resolveAllowedOrigins,
} from '../src/app.setup';

/**
 * El agente local escribe en el disco de la persona y no tiene sesión: lo único
 * que separa una página cualquiera de la API es CORS. Estas pruebas fijan ese
 * límite, porque con `/^https:\/\/.*\.vercel\.app$/` cualquier despliegue
 * —gratis y sin verificación— podía leer las respuestas desde el navegador.
 */

const PRODUCCION = 'https://abd-vfx-manager.vercel.app';

@Controller('probe')
class ProbeController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true };
  }

  @Post()
  write(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

let app: NestExpressApplication;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureCors(app);
  configureSecurityHeaders(app);
  await app.init();
});

after(async () => {
  await app?.close();
});

test('solo el dominio de producción y loopback: ningún vercel.app suelto', () => {
  assert.deepEqual(resolveAllowedOrigins({}), [PRODUCCION]);
  assert.equal(isAllowedOrigin('https://evil-abc123.vercel.app'), false);
  assert.equal(isAllowedOrigin('https://evil-abc123.vercel.app', [PRODUCCION]), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3210'), true);
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(PRODUCCION), true);
});

test('FXB_ALLOWED_ORIGINS amplía la lista, sin comodines y sin barra final', () => {
  const allowed = resolveAllowedOrigins({
    FXB_ALLOWED_ORIGINS: ' https://a.example.com/ , https://b.example.com',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(allowed, [PRODUCCION, 'https://a.example.com', 'https://b.example.com']);
});

test('el preflight de un vercel.app cualquiera no lleva permiso', async () => {
  const res = await request(app.getHttpServer())
    .options('/probe')
    .set('Origin', 'https://evil-abc123.vercel.app')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('el preflight del dominio de producción sí, y sin credenciales', async () => {
  const res = await request(app.getHttpServer())
    .options('/probe')
    .set('Origin', PRODUCCION)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type');
  assert.equal(res.headers['access-control-allow-origin'], PRODUCCION);
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
});

test('escribir desde un origen ajeno se rechaza aunque el preflight no llegue', async () => {
  const res = await request(app.getHttpServer())
    .post('/probe')
    .set('Origin', 'https://evil.example.com')
    .send({});
  assert.equal(res.status, 403);
});

test('escribir desde loopback y desde producción sigue funcionando', async () => {
  const local = await request(app.getHttpServer())
    .post('/probe')
    .set('Origin', 'http://127.0.0.1:3210')
    .send({});
  assert.equal(local.status, 201);

  const remoto = await request(app.getHttpServer()).post('/probe').set('Origin', PRODUCCION).send({});
  assert.equal(remoto.status, 201);
});

test('un Host que no es loopback se rechaza (DNS rebinding)', async () => {
  const res = await request(app.getHttpServer()).get('/probe').set('Host', 'evil.example.com');
  assert.equal(res.status, 403);
  assert.match(String(res.body.message), /loopback/);
});

test('el Host loopback pasa', async () => {
  const res = await request(app.getHttpServer()).get('/probe');
  assert.equal(res.status, 200);
});

test('leer desde un origen ajeno responde, pero sin cabecera de permiso', async () => {
  const res = await request(app.getHttpServer()).get('/probe').set('Origin', 'https://evil.example.com');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('isMutating e isLoopbackHost', () => {
  assert.equal(isMutating('POST'), true);
  assert.equal(isMutating('delete'), true);
  assert.equal(isMutating('GET'), false);
  assert.equal(isLoopbackHost('127.0.0.1:3210'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('evil.example.com'), false);
  assert.equal(isLoopbackHost(undefined), false);
});
