import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CaptureService } from '../src/capture/capture.service';
import {
  CAPTURE_NOT_FOUND_DIFF_EXAMPLE,
  CAPTURE_NOT_FOUND_SNAPSHOT_BEFORE_EXAMPLE,
  CAPTURE_NOT_FOUND_SNAPSHOT_EXAMPLE,
  CAPTURE_NOT_FOUND_TASK_EXAMPLE,
} from '../src/capture/capture.dto';

/**
 * Los 404 documentados de la captura: snapshot, diff, tarea y el snapshot
 * inicial de `/capture/finish`. Las tareas, los diffs y los snapshots sin
 * volcar a disco viven en memoria, así que un ID que nunca existió es el caso
 * normal tras reiniciar el servidor; lo que se fija aquí es que la respuesta
 * sea el 404 con el mensaje que publica el OpenAPI y no un 500 ni un 200 vacío.
 */

async function makeApp(t: TestContext) {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  t.after(async () => {
    await app.close();
  });
  return { http: () => request(app.getHttpServer()), service: app.get(CaptureService) };
}

/** Cuerpo del error sin el sobre de Nest, como el resto de la API. */
function assertBareError(body: unknown): void {
  assert.equal(Object.hasOwn(body as object, 'statusCode'), false);
  assert.equal(Object.hasOwn(body as object, 'error'), false);
}

test('GET /capture/snapshots/:id inexistente devuelve el 404 documentado', async (t) => {
  const { http } = await makeApp(t);
  const id = randomUUID();

  const response = await http().get(`/capture/snapshots/${id}`).expect(404);

  assert.deepEqual(response.body, { message: `No existe el snapshot "${id}".` });
  assert.equal(
    response.body.message,
    CAPTURE_NOT_FOUND_SNAPSHOT_EXAMPLE.message.replace(
      '"6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11"',
      `"${id}"`,
    ),
  );
  assertBareError(response.body);
});

test('GET /capture/diff/:id inexistente devuelve el 404 documentado', async (t) => {
  const { http } = await makeApp(t);
  const id = randomUUID();

  const response = await http().get(`/capture/diff/${id}`).expect(404);

  assert.deepEqual(response.body, { message: `No existe el diff "${id}".` });
  assert.equal(
    response.body.message,
    CAPTURE_NOT_FOUND_DIFF_EXAMPLE.message.replace(
      '"5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f"',
      `"${id}"`,
    ),
  );
  assertBareError(response.body);
});

test('GET /capture/pre-existing/:diffId inexistente devuelve el 404 documentado', async (t) => {
  const { http } = await makeApp(t);
  const id = randomUUID();

  const response = await http().get(`/capture/pre-existing/${id}`).expect(404);

  // La comilla se escapa una sola vez: el mensaje lleva `"<id>"`, no `\"<id>\"`.
  assert.deepEqual(response.body, { message: `No existe el diff "${id}".` });
  assert.equal(
    response.body.message,
    CAPTURE_NOT_FOUND_DIFF_EXAMPLE.message.replace('5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f', id),
  );
  assertBareError(response.body);
});

test('las rutas de tarea devuelven el 404 documentado', async (t) => {
  const { http } = await makeApp(t);
  const taskId = randomUUID();
  const expected = CAPTURE_NOT_FOUND_TASK_EXAMPLE.message.replace(
    '"6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11"',
    `"${taskId}"`,
  );

  const status = await http().get(`/capture/tasks/${taskId}`).expect(404);
  assert.deepEqual(status.body, { message: `No existe la tarea de captura "${taskId}".` });
  assert.equal(status.body.message, expected);
  assertBareError(status.body);

  const cancel = await http().post(`/capture/tasks/${taskId}/cancel`).expect(404);
  assert.deepEqual(cancel.body, status.body);
});

/**
 * `/capture/finish` comprueba el snapshot inicial antes de arrancar la tarea:
 * sin esa guarda el cierre se aceptaría con 200 y una tarea condenada a fallar
 * dentro. Además del cuerpo, se comprueba que no queda ninguna tarea creada.
 */
test('POST /capture/finish con un snapshot inicial inexistente devuelve el 404 documentado', async (t) => {
  const { http, service } = await makeApp(t);
  const snapshotIdBefore = randomUUID();
  const { tasks } = service as unknown as { tasks: Map<string, unknown> };

  const response = await http().post('/capture/finish').send({ snapshotIdBefore }).expect(404);

  assert.deepEqual(response.body, {
    message: `No existe el snapshot inicial "${snapshotIdBefore}" para cerrar la captura.`,
  });
  assert.equal(
    response.body.message,
    CAPTURE_NOT_FOUND_SNAPSHOT_BEFORE_EXAMPLE.message.replace(
      '"6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11"',
      `"${snapshotIdBefore}"`,
    ),
  );
  assert.equal(
    Object.hasOwn(response.body as object, 'taskId'),
    false,
    'un snapshot inexistente no puede devolver una tarea de cierre',
  );
  assertBareError(response.body);
  assert.equal(tasks.size, 0, 'no se crea ninguna tarea de cierre para un snapshot que no existe');
});
