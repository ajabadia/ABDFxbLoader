import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

/**
 * Valida cada ejemplo del documento OpenAPI contra el esquema que lo acompaña.
 *
 * Los esquemas son OpenAPI 3.0 (JSON Schema draft-07 + `nullable`), así que se
 * traducen antes de compilar: `nullable: true` pasa a una unión con `null`.
 * Se revisan los ejemplos de medios (`application/json`), los de parámetros y
 * los de cada propiedad de los esquemas, que también son contrato.
 */

type JsonObject = Record<string, unknown>;

export interface ExampleFailure {
  /** Puntero JSON del esquema que el ejemplo debería cumplir. */
  pointer: string;
  errors: string[];
}

export interface ExampleValidation {
  checked: number;
  failures: ExampleFailure[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escapa un segmento para un JSON pointer (`~0`, `~1`). */
function esc(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Claves cuyos valores son datos, no esquemas: no se traducen. */
const DATA_KEYS = new Set(['example', 'examples', 'default', 'enum', 'const']);

function translate(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(translate);
  if (!isObject(node)) return node;

  const out: JsonObject = {};
  let nullable = false;
  let example: unknown;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'nullable') {
      nullable = value === true;
      continue;
    }
    if (key === 'example') {
      example = value;
      continue;
    }
    // Los ejemplos y los `enum` son datos: deben conservarse byte a byte.
    out[key] = DATA_KEYS.has(key) ? value : translate(value);
  }

  if (!nullable) {
    if (example !== undefined) out['example'] = example;
    return out;
  }

  // `nullable` significa «este valor o null», también cuando el esquema es un
  // `allOf` con `$ref` (donde una unión de `type` no bastaría). El ejemplo
  // queda en el envoltorio para que un `null` se valide contra la rama null.
  const wrapped: JsonObject = { anyOf: [out, { type: 'null' }] };
  if (example !== undefined) wrapped['example'] = example;
  return wrapped;
}

const SCHEMA_MAP_KEYS = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
] as const;

const SCHEMA_ARRAY_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

const SCHEMA_CHILD_KEYS = [
  'items',
  'not',
  'if',
  'then',
  'else',
  'additionalProperties',
  'propertyNames',
  'contains',
  'unevaluatedProperties',
  'unevaluatedItems',
] as const;

function formatErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const at = error.instancePath === '' ? '/' : error.instancePath;
    const detail = error.params === undefined ? '' : ` (${JSON.stringify(error.params)})`;
    return `${at}: ${error.message ?? 'no cumple el esquema'}${detail}`;
  });
}

export function validateOpenApiExamples(document: JsonObject): ExampleValidation {
  // Se trabaja sobre la copia traducida: los punteros de los ejemplos y los
  // `$ref` internos apuntan a ese mismo árbol.
  const source = translate(document) as JsonObject;

  const checks: { pointer: string; value: unknown }[] = [];
  const seen = new Set<string>();

  const add = (pointer: string, value: unknown): void => {
    const key = `${pointer}\u0000${JSON.stringify(value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    checks.push({ pointer, value });
  };

  /** Recorre un esquema y valida los `example` de cada nivel contra sí mismo. */
  function walkSchema(schema: unknown, pointer: string): void {
    if (!isObject(schema)) return;

    if (schema['example'] !== undefined) add(pointer, schema['example']);

    for (const key of SCHEMA_MAP_KEYS) {
      const map = schema[key];
      if (!isObject(map)) continue;
      for (const [name, child] of Object.entries(map)) {
        walkSchema(child, `${pointer}/${esc(key)}/${esc(name)}`);
      }
    }

    for (const key of SCHEMA_ARRAY_KEYS) {
      const value = schema[key];
      if (Array.isArray(value)) {
        value.forEach((child, index) => walkSchema(child, `${pointer}/${esc(key)}/${index}`));
      } else {
        walkSchema(value, `${pointer}/${esc(key)}`);
      }
    }

    for (const key of SCHEMA_CHILD_KEYS) {
      const value = schema[key];
      if (Array.isArray(value)) {
        value.forEach((child, index) => walkSchema(child, `${pointer}/${esc(key)}/${index}`));
      } else {
        walkSchema(value, `${pointer}/${esc(key)}`);
      }
    }
  }

  /** Ejemplos de un `content` (cuerpos de petición y respuestas). */
  function checkContent(body: unknown, pointer: string): void {
    if (!isObject(body) || !isObject(body['content'])) return;
    const content = body['content'];

    for (const [mediaType, media] of Object.entries(content)) {
      if (!isObject(media) || !/json/i.test(mediaType)) continue;
      const schemaPointer = `${pointer}/content/${esc(mediaType)}/schema`;
      walkSchema(media['schema'], schemaPointer);

      if (media['example'] !== undefined) add(schemaPointer, media['example']);

      const examples = media['examples'];
      if (isObject(examples)) {
        for (const example of Object.values(examples)) {
          if (isObject(example) && example['value'] !== undefined) {
            add(schemaPointer, example['value']);
          }
        }
      }
    }
  }

  function checkParameter(parameter: unknown, pointer: string): void {
    if (!isObject(parameter)) return;
    walkSchema(parameter['schema'], `${pointer}/schema`);
    if (parameter['example'] !== undefined) {
      add(`${pointer}/schema`, parameter['example']);
    }
  }

  function checkParameters(parameters: unknown, pointer: string): void {
    if (!Array.isArray(parameters)) return;
    parameters.forEach((parameter, index) => {
      checkParameter(parameter, `${pointer}/${index}`);
    });
  }

  function checkResponses(responses: unknown, pointer: string): void {
    if (!isObject(responses)) return;
    for (const [status, response] of Object.entries(responses)) {
      if (!isObject(response)) continue;
      const responsePointer = `${pointer}/${esc(status)}`;
      checkContent(response, responsePointer);
      if (isObject(response['headers'])) {
        for (const [name, header] of Object.entries(response['headers'])) {
          if (!isObject(header)) continue;
          const headerPointer = `${responsePointer}/headers/${esc(name)}`;
          walkSchema(header['schema'], `${headerPointer}/schema`);
          if (header['example'] !== undefined) add(`${headerPointer}/schema`, header['example']);
        }
      }
    }
  }

  const paths = source['paths'];
  if (isObject(paths)) {
    for (const [route, item] of Object.entries(paths)) {
      if (!isObject(item)) continue;
      const itemPointer = `/paths/${esc(route)}`;
      checkParameters(item['parameters'], `${itemPointer}/parameters`);

      for (const [method, operation] of Object.entries(item)) {
        if (!isObject(operation)) continue;
        const operationPointer = `${itemPointer}/${esc(method)}`;
        checkParameters(operation['parameters'], `${operationPointer}/parameters`);
        checkContent(operation['requestBody'], `${operationPointer}/requestBody`);
        checkResponses(operation['responses'], `${operationPointer}/responses`);
      }
    }
  }

  const components = source['components'];
  if (isObject(components)) {
    const schemas = components['schemas'];
    if (isObject(schemas)) {
      for (const [name, schema] of Object.entries(schemas)) {
        walkSchema(schema, `/components/schemas/${esc(name)}`);
      }
    }
    if (isObject(components['requestBodies'])) {
      for (const [name, body] of Object.entries(components['requestBodies'])) {
        checkContent(body, `/components/requestBodies/${esc(name)}`);
      }
    }
    if (isObject(components['responses'])) {
      for (const [name, response] of Object.entries(components['responses'])) {
        checkResponses({ [name]: response }, '/components/responses');
      }
    }
    if (isObject(components['parameters'])) {
      for (const [name, parameter] of Object.entries(components['parameters'])) {
        checkParameter(parameter, `/components/parameters/${esc(name)}`);
      }
    }
  }

  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    // `format` de OpenAPI (`int32`, `int64`, `binary`…) no es JSON Schema.
    validateFormats: false,
    allowUnionTypes: true,
    logger: false,
  });
  ajv.addSchema(source, 'openapi');

  const cache = new Map<string, ValidateFunction>();
  const failures: ExampleFailure[] = [];

  for (const { pointer, value } of checks) {
    let validate = cache.get(pointer);
    if (validate === undefined) {
      validate = ajv.compile({ $ref: `openapi#${pointer}` });
      cache.set(pointer, validate);
    }
    if (!validate(value)) {
      failures.push({ pointer, errors: formatErrors(validate.errors) });
    }
  }

  return { checked: checks.length, failures };
}

/** Cobertura de ejemplos: qué operaciones y códigos documentan alguno. */
export interface ExampleCoverage {
  /** Sin ningún ejemplo, con la forma `POST /library/scan`. */
  operations: string[];
  /** Sin ningún ejemplo, con la forma `POST /library/scan → 422`. */
  responses: string[];
  checked: { operations: number; responses: number };
}

interface MediaObject {
  example?: unknown;
  examples?: Record<string, unknown>;
  schema?: unknown;
}

interface OperationObject {
  requestBody?: { content?: Record<string, MediaObject> };
  responses?: Record<string, { content?: Record<string, MediaObject> }>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/**
 * Un ejemplo cuenta si está en el media type (`example` o `examples`) o si el
 * esquema lo trae (incluidos `$ref`, `oneOf`/`anyOf`/`allOf` e `items`).
 */
function mediaHasExample(media: MediaObject, document: JsonObject): boolean {
  if (media.example !== undefined) return true;
  if (media.examples !== undefined && Object.keys(media.examples).length > 0) return true;
  return schemaHasExample(media.schema, document, new Set());
}

function schemaHasExample(
  schema: unknown,
  document: JsonObject,
  seen: Set<string>,
): boolean {
  const node = isObject(schema) ? schema : null;
  if (node === null) return false;
  if (node['example'] !== undefined) return true;

  const ref = node['$ref'];
  if (typeof ref === 'string') {
    if (seen.has(ref)) return false;
    seen.add(ref);
    const name = ref.replace(/^#\/components\/schemas\//, '');
    const schemas = isObject(document['components']) ? document['components']['schemas'] : null;
    return schemaHasExample(isObject(schemas) ? schemas[name] : undefined, document, seen);
  }

  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const branches = node[key];
    if (Array.isArray(branches) && branches.some((child) => schemaHasExample(child, document, seen))) {
      return true;
    }
  }

  return schemaHasExample(node['items'], document, seen);
}

function holdersOf(operation: OperationObject): (OperationObject['requestBody'] | { content?: Record<string, MediaObject> })[] {
  return [operation.requestBody, ...Object.values(operation.responses ?? {})];
}

/**
 * Recorre el documento y devuelve las operaciones y los códigos de respuesta
 * que no documentan ningún ejemplo. Cada operación se revisa también como
 * conjunto: basta un ejemplo en su petición o en cualquiera de sus respuestas.
 */
export function findMissingExamples(document: JsonObject): ExampleCoverage {
  const operations: string[] = [];
  const responses: string[] = [];
  const checked = { operations: 0, responses: 0 };

  const paths = isObject(document['paths']) ? document['paths'] : {};
  for (const [route, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;

    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const label = `${method.toUpperCase()} ${route}`;
      checked.operations += 1;

      const typed = operation as OperationObject;
      const hasAny = holdersOf(typed).some(
        (holder) =>
          holder?.content !== undefined &&
          Object.values(holder.content).some((media) => mediaHasExample(media, document)),
      );
      if (!hasAny) operations.push(label);

      for (const [status, response] of Object.entries(typed.responses ?? {})) {
        checked.responses += 1;
        const documented =
          isObject(response) &&
          isObject(response['content']) &&
          Object.values(response['content'] as Record<string, MediaObject>).some((media) =>
            mediaHasExample(media, document),
          );
        if (!documented) responses.push(`${label} → ${status}`);
      }
    }
  }

  return { operations, responses, checked };
}
