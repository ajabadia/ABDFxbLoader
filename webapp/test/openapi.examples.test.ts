import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { findMissingExamples, validateOpenApiExamples } from './helpers/openapi-examples';

// `dist-test/test` → raíz de webapp.
const OPENAPI_PATH = path.resolve(__dirname, '..', '..', 'openapi.json');

type JsonObject = Record<string, unknown>;

async function versionedDocument(): Promise<JsonObject> {
  return JSON.parse(await readFile(OPENAPI_PATH, 'utf8')) as JsonObject;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function failureText(failures: { pointer: string; errors: string[] }[]): string {
  return failures
    .map((failure) => `${failure.pointer}\n  ${failure.errors.join('\n  ')}`)
    .join('\n');
}

test('cada ejemplo de openapi.json cumple el esquema que documenta', async () => {
  const report = validateOpenApiExamples(await versionedDocument());

  // Sin este mínimo, un cambio en el documento podría dejar el test en verde
  // sin validar nada.
  assert.ok(report.checked >= 150, `solo se validaron ${report.checked} ejemplos`);
  assert.equal(report.failures.length, 0, failureText(report.failures));
});

test('cada operación y cada código de respuesta documentan al menos un ejemplo', async () => {
  const coverage = findMissingExamples(await versionedDocument());

  // Sin estos mínimos, un documento vacío o a medio generar pasaría el test.
  assert.ok(coverage.checked.operations >= 10, `solo hay ${coverage.checked.operations} operaciones`);
  assert.ok(coverage.checked.responses >= 30, `solo hay ${coverage.checked.responses} respuestas`);

  assert.deepEqual(
    coverage.operations,
    [],
    `sin ningún ejemplo: ${coverage.operations.join(', ')}`,
  );
  assert.deepEqual(
    coverage.responses,
    [],
    `sin ningún ejemplo: ${coverage.responses.join(', ')}`,
  );
});

test('la cobertura de ejemplos detecta operaciones y respuestas sin ejemplo', () => {
  const coverage = findMissingExamples({
    openapi: '3.0.0',
    paths: {
      '/sin-ejemplo': {
        post: {
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Cuerpo' } } },
          },
          responses: {
            200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Cuerpo' } } } },
            // Un `examples` basta;
            // aquí el ejemplo está en el media type, no en el esquema.
            400: {
              content: {
                'application/json': {
                  schema: { type: 'object' },
                  examples: { ruta: { value: { message: 'ruta inválida' } } },
                },
              },
            },
          },
        },
      },
      '/sin-nada': {
        post: {
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Cuerpo' } } } },
          responses: {
            200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Cuerpo' } } } },
          },
        },
      },
      '/con-ejemplo': {
        get: {
          responses: {
            // El ejemplo viene del esquema referenciado.
            200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ConEjemplo' } } } },
          },
        },
      },
    },
    components: {
      schemas: {
        Cuerpo: { type: 'object', properties: { message: { type: 'string' } } },
        ConEjemplo: { type: 'object', example: { ok: true } },
      },
    },
  });

  // `POST /sin-ejemplo` documenta un ejemplo (el del 400), así que la operación
  // pasa; solo le falta el del 200. `POST /sin-nada` no tiene ninguno.
  assert.deepEqual(coverage.operations, ['POST /sin-nada']);
  assert.deepEqual(coverage.responses, ['POST /sin-ejemplo → 200', 'POST /sin-nada → 200']);
  assert.deepEqual(coverage.checked, { operations: 3, responses: 4 });
});

test('todos los DTO cierran su cuerpo con additionalProperties: false', async () => {
  const document = await versionedDocument();
  const schemas = asObject(asObject(document['components'])?.['schemas']);
  assert.ok(schemas, 'el documento no tiene components.schemas');

  const names = Object.keys(schemas).sort();
  // Sin este mínimo, un documento recortado pasaría sin revisar nada.
  assert.ok(names.length >= 36, `solo hay ${names.length} esquemas`);

  for (const name of names) {
    const schema = asObject(schemas[name]);
    assert.ok(schema && asObject(schema['properties']), `${name} debería declarar propiedades`);
    // Un mapa explícito (`additionalProperties: {…}`) es una decisión tomada;
    // lo que falla es el cuerpo sin `additionalProperties`, que acepta de todo.
    const extra = schema['additionalProperties'];
    assert.ok(
      extra === false || asObject(extra) !== null,
      `${name} debe declarar additionalProperties: false (o un mapa explícito)`,
    );
  }
});

const REF_PREFIX = '#/components/schemas/';

/** `$ref` del esquema de un cuerpo JSON (`$ref` o `anyOf` de `$ref`). */
function bodyRefs(schema: unknown): string[] {
  const node = asObject(schema);
  if (node === null) return [];
  if (typeof node['$ref'] === 'string') return [node['$ref']];

  const branches = node['anyOf'];
  if (!Array.isArray(branches)) return [];
  return branches.flatMap((branch) => {
    const ref = asObject(branch)?.['$ref'];
    return typeof ref === 'string' ? [ref] : [];
  });
}

/**
 * Cerrar los componentes cierra todas las peticiones y respuestas solo si cada
 * cuerpo JSON apunta a un DTO: un esquema incrustado en la ruta se quedaría
 * abierto aunque `swagger.ts` recorra todos los componentes.
 */
test('cada cuerpo JSON referencia un DTO de components.schemas', async () => {
  const document = await versionedDocument();
  const schemas = asObject(asObject(document['components'])?.['schemas']);
  assert.ok(schemas, 'el documento no tiene components.schemas');

  const literals: string[] = [];
  const missing: string[] = [];
  const open: string[] = [];
  let bodies = 0;

  const inspect = (holder: unknown, label: string): void => {
    const content = asObject(asObject(holder)?.['content']);
    if (content === null) return;

    for (const [mediaType, media] of Object.entries(content)) {
      if (!/json/i.test(mediaType)) continue;
      const schema = asObject(media)?.['schema'];
      // El flujo NDJSON se documenta como cadena, no como DTO.
      if (asObject(schema)?.['type'] === 'string') continue;

      bodies += 1;
      const refs = bodyRefs(schema);
      if (refs.length === 0) {
        literals.push(`${label} (${mediaType})`);
        continue;
      }
      for (const ref of refs) {
        const name = ref.slice(REF_PREFIX.length);
        const target = schemas[name];
        if (!ref.startsWith(REF_PREFIX) || target === undefined) {
          missing.push(ref);
        } else if (asObject(target)?.['additionalProperties'] !== false) {
          open.push(name);
        }
      }
    }
  };

  for (const [route, item] of Object.entries(asObject(document['paths']) ?? {})) {
    for (const [method, operation] of Object.entries(asObject(item) ?? {})) {
      const label = `${method.toUpperCase()} ${route}`;
      inspect(asObject(operation)?.['requestBody'], `${label} → petición`);
      const responses = asObject(asObject(operation)?.['responses']) ?? {};
      for (const [status, response] of Object.entries(responses)) {
        inspect(response, `${label} → ${status}`);
      }
    }
  }

  assert.ok(bodies >= 40, `solo se revisaron ${bodies} cuerpos`);
  assert.deepEqual(literals, [], `cuerpos con el esquema incrustado: ${literals.join(', ')}`);
  assert.deepEqual(missing, [], `$ref rotos: ${missing.join(', ')}`);
  assert.deepEqual(open, [], `cuerpos que apuntan a un DTO abierto: ${open.join(', ')}`);
});

interface ExampleCase {
  label: string;
  route: string;
  method: string;
  status: string;
  /** Clave de `examples`; sin ella se usa el `example` del media type. */
  example?: string;
  mutate: (value: JsonObject) => void;
}

/** Media type JSON de una respuesta con su ejemplo ya seleccionado. */
async function responseExample(
  route: string,
  method: string,
  status: string,
  example?: string,
): Promise<{ document: JsonObject; value: JsonObject }> {
  const document = await versionedDocument();
  const operation = asObject(asObject(asObject(document['paths'])?.[route])?.[method]);
  const response = asObject(asObject(operation?.['responses'])?.[status]);
  const media = asObject(asObject(asObject(response)?.['content'])?.['application/json']);
  assert.ok(media, `falta el media type de ${method.toUpperCase()} ${route} ${status}`);

  const value =
    example === undefined
      ? asObject(media['example'])
      : asObject(asObject(asObject(media['examples'])?.[example])?.['value']);
  assert.ok(
    value,
    `falta el ejemplo ${example ?? '(example)'} de ${method.toUpperCase()} ${route} ${status}`,
  );
  return { document, value };
}

function field(value: JsonObject, key: string): JsonObject {
  const node = asObject(value[key]);
  assert.ok(node, `el ejemplo no tiene ${key}`);
  return node;
}

function firstOf(value: JsonObject, key: string): JsonObject {
  const list = value[key];
  const node = Array.isArray(list) ? asObject(list[0]) : null;
  assert.ok(node, `el ejemplo no tiene ${key}[0]`);
  return node;
}

/**
 * Un campo que ningún DTO declara, en cada uno de los niveles anidados que
 * antes quedaban abiertos: el `current` del 409, su `config`, el `plugin` de la
 * importación, los elementos de `results`, la `config` de la lista de bancos y
 * el `backup` de una restauración.
 */
const NESTED_MUTATIONS: ExampleCase[] = [
  {
    label: 'current del 409 de /fxb-config',
    route: '/fxb-config',
    method: 'put',
    status: '409',
    mutate: (value) => {
      field(value, 'current')['campoDeMás'] = true;
    },
  },
  {
    label: 'config dentro del current del 409',
    route: '/fxb-config',
    method: 'put',
    status: '409',
    mutate: (value) => {
      field(field(value, 'current'), 'config')['campoDeMás'] = true;
    },
  },
  {
    label: 'current del 409 de /library/install',
    route: '/library/install',
    method: 'post',
    status: '409',
    example: 'configCambiada',
    mutate: (value) => {
      field(value, 'current')['campoDeMás'] = true;
    },
  },
  {
    label: 'plugin del 422 de /library/banks/import',
    route: '/library/banks/import',
    method: 'post',
    status: '422',
    mutate: (value) => {
      field(value, 'plugin')['campoDeMás'] = true;
    },
  },
  {
    label: 'resultado dentro de results del 422',
    route: '/library/banks/import',
    method: 'post',
    status: '422',
    mutate: (value) => {
      firstOf(value, 'results')['campoDeMás'] = true;
    },
  },
  {
    label: 'banco dentro de results del 422',
    route: '/library/banks/import',
    method: 'post',
    status: '422',
    mutate: (value) => {
      field(firstOf(value, 'results'), 'bank')['campoDeMás'] = true;
    },
  },
  {
    label: 'config del 200 de /library/banks/list',
    route: '/library/banks/list',
    method: 'post',
    status: '200',
    mutate: (value) => {
      field(value, 'config')['campoDeMás'] = true;
    },
  },
  {
    label: 'backup del 200 de /library/banks/restore',
    route: '/library/banks/restore',
    method: 'post',
    status: '200',
    example: 'restaurado',
    mutate: (value) => {
      field(value, 'backup')['campoDeMás'] = true;
    },
  },
];

test('un campo sobrante en un DTO anidado falla la validación', async () => {
  assert.ok(NESTED_MUTATIONS.length >= 8, 'faltan mutaciones anidadas');

  for (const { label, route, method, status, example, mutate } of NESTED_MUTATIONS) {
    const { document, value } = await responseExample(route, method, status, example);
    mutate(value);

    const report = validateOpenApiExamples(document);
    assert.equal(report.failures.length, 1, `${label}: ${failureText(report.failures)}`);
    assert.match(failureText(report.failures), /additional properties/, label);
  }
});

/** Añade `campoDeMás` a cada ejemplo de objeto de un media type JSON. */
function mutateMediaExamples(media: JsonObject, label: string, mutated: string[]): void {
  const single = asObject(media['example']);
  if (single !== null) {
    media['example'] = { ...single, campoDeMás: true };
    mutated.push(label);
  }

  const examples = asObject(media['examples']);
  if (examples === null) return;
  for (const [key, example] of Object.entries(examples)) {
    const holder = asObject(example);
    const value = asObject(holder?.['value']);
    if (holder === null || value === null) continue;
    holder['value'] = { ...value, campoDeMás: true };
    mutated.push(`${label}#${key}`);
  }
}

test('un campo sobrante en cualquier ejemplo de respuesta falla la validación', async () => {
  const document = await versionedDocument();
  const mutated: string[] = [];

  for (const [route, item] of Object.entries(asObject(document['paths']) ?? {})) {
    for (const [method, operation] of Object.entries(asObject(item) ?? {})) {
      const responses = asObject(asObject(operation)?.['responses']) ?? {};
      for (const [status, response] of Object.entries(responses)) {
        const media = asObject(asObject(asObject(response)?.['content'])?.['application/json']);
        if (media === null) continue;
        mutateMediaExamples(media, `${method.toUpperCase()} ${route} ${status}`, mutated);
      }
    }
  }

  // El cierre no puede limitarse a los errores: hay ejemplos de los dos tipos.
  assert.ok(mutated.some((label) => / 2\d\d/.test(label)), 'faltan respuestas correctas');
  assert.ok(mutated.some((label) => / 4\d\d/.test(label)), 'faltan respuestas de error');
  assert.ok(mutated.length >= 25, `solo se mutaron ${mutated.length} ejemplos de respuesta`);

  const report = validateOpenApiExamples(document);
  assert.equal(report.failures.length, mutated.length, failureText(report.failures));
  assert.match(failureText(report.failures), /additional properties/);
});

test('un campo sobrante en un ejemplo de petición falla la validación', async () => {
  const document = await versionedDocument();
  const mutated: string[] = [];

  for (const [route, item] of Object.entries(asObject(document['paths']) ?? {})) {
    for (const [method, operation] of Object.entries(asObject(item) ?? {})) {
      const body = asObject(asObject(operation)?.['requestBody']);
      const media = asObject(asObject(body?.['content'])?.['application/json']);
      if (media === null) continue;
      mutateMediaExamples(media, `${method.toUpperCase()} ${route} (petición)`, mutated);
    }
  }

  assert.ok(mutated.length >= 10, `solo se mutaron ${mutated.length} peticiones`);

  const report = validateOpenApiExamples(document);
  assert.equal(report.failures.length, mutated.length, failureText(report.failures));
  assert.match(failureText(report.failures), /additional properties/);
});

test('el validador rechaza un ejemplo que no cumple su esquema', () => {
  const report = validateOpenApiExamples({
    openapi: '3.0.0',
    paths: {
      '/x': {
        post: {
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name', 'count'],
                    properties: { name: { type: 'string' }, count: { type: 'integer' } },
                  },
                  example: { name: 'ok', count: 'muchos' },
                },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(report.checked, 1);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0]!.pointer, /\/responses\/200\/content\/application~1json\/schema/);
  assert.match(report.failures[0]!.errors.join(' '), /count/);
});

test('el validador respeta nullable al traducir OpenAPI 3.0', () => {
  const document = (example: unknown): JsonObject => ({
    openapi: '3.0.0',
    paths: {
      '/x': {
        post: {
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['value'],
                    properties: { value: { type: 'string', nullable: true } },
                  },
                  example,
                },
              },
            },
          },
        },
      },
    },
  });

  assert.deepEqual(validateOpenApiExamples(document({ value: null })).failures, []);
  assert.deepEqual(validateOpenApiExamples(document({ value: 'texto' })).failures, []);
  assert.equal(validateOpenApiExamples(document({ value: 3 })).failures.length, 1);
});

test('el validador revisa también los ejemplos de cada propiedad', () => {
  const report = validateOpenApiExamples({
    openapi: '3.0.0',
    components: {
      schemas: {
        ThrottleDto: {
          type: 'object',
          properties: {
            percent: { type: 'integer', minimum: 0, maximum: 100, example: 150 },
            label: { type: 'string', example: 'ok' },
          },
        },
      },
    },
  });

  assert.equal(report.checked, 2);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0]!.pointer, /ThrottleDto\/properties\/percent$/);
  assert.match(report.failures[0]!.errors.join(' '), /<= 100/);
});

test('acepta un ejemplo null bajo nullable y no toca los datos del ejemplo', () => {
  const report = validateOpenApiExamples({
    openapi: '3.0.0',
    components: {
      schemas: {
        Thing: {
          type: 'object',
          properties: {
            note: { type: 'string', nullable: true, example: null },
            payload: {
              type: 'object',
              properties: { type: { type: 'string' }, nullable: { type: 'boolean' } },
              example: { type: 'a', nullable: true },
            },
          },
          // `type` y `nullable` son claves del dato, no del esquema.
          example: { type: 'a', nullable: true },
        },
      },
    },
  });

  assert.equal(report.failures.length, 0, failureText(report.failures));
  assert.equal(report.checked, 3);
});

test('un $ref roto falla en vez de omitirse', () => {
  assert.throws(
    () =>
      validateOpenApiExamples({
        openapi: '3.0.0',
        paths: {
          '/x': {
            post: {
              responses: {
                200: {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/NoExiste' },
                      example: {},
                    },
                  },
                },
              },
            },
          },
        },
        components: { schemas: {} },
      }),
    /NoExiste/,
  );
});
