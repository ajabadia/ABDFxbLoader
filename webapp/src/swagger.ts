import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Todos los cuerpos se publican cerrados: `additionalProperties: false` en cada
 * DTO —peticiones y respuestas, correctas o de error— y también en los que
 * lleva dentro (el `current` del 409, `plugin`, `reference`, los `results` de la
 * importación de bancos, el `bank` de un respaldo…), para que un campo de más
 * en cualquier nivel deje de validar.
 *
 * `@nestjs/swagger` no emite esa palabra clave (no hay decorador para ella), y
 * sin ella un ejemplo con un campo de más valida igual y el contrato deja de
 * detectar cuerpos que crecen. Se aplica aquí, sobre el documento generado,
 * para que `/docs`, `openapi.json` y los tests de ejemplos coincidan. Los
 * cuerpos JSON de las rutas apuntan siempre a un DTO de `components.schemas`
 * (`$ref` o `anyOf` de `$ref`), así que cerrar los componentes cierra todas las
 * peticiones y respuestas; un test lo comprueba.
 */

const SCHEMA_PROPERTY_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];
const SCHEMA_CHILDREN = [
  'items',
  'contains',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
];

function closeSchemas(document: OpenAPIObject): void {
  const schemas = document.components?.schemas ?? {};
  // Los DTO se comparten entre respuestas, así que cada nodo se visita una vez.
  const visited = new Set<object>();
  for (const schema of Object.values(schemas)) closeNestedSchemas(schema, schemas, visited);
}

/**
 * Cierra un esquema y todos los DTO anidados que alcanza, siguiendo `$ref`
 * dentro de `components.schemas`.
 */
function closeNestedSchemas(
  schema: unknown,
  schemas: Record<string, unknown>,
  visited: Set<object>,
): void {
  if (!isRecord(schema) || visited.has(schema)) return;
  visited.add(schema);

  // Solo se cierra un objeto con propiedades declaradas: un `allOf: [$ref]`
  // (la forma en que Swagger envuelve un DTO anidado) no las tiene, y cerrarlo
  // rechazaría todos sus campos. Un `additionalProperties` explícito manda.
  if (
    isRecord(schema['properties']) &&
    Object.keys(schema['properties']).length > 0 &&
    schema['additionalProperties'] === undefined
  ) {
    schema['additionalProperties'] = false;
  }

  for (const key of SCHEMA_PROPERTY_MAPS) {
    const map = schema[key];
    if (!isRecord(map)) continue;
    for (const child of Object.values(map)) closeNestedSchemas(child, schemas, visited);
  }

  for (const key of SCHEMA_CHILDREN) {
    const value = schema[key];
    if (Array.isArray(value)) {
      for (const child of value) closeNestedSchemas(child, schemas, visited);
    } else {
      closeNestedSchemas(value, schemas, visited);
    }
  }

  const ref = schema['$ref'];
  if (typeof ref !== 'string') return;
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) return;
  const target = schemas[ref.slice(prefix.length)];
  if (target !== undefined) closeNestedSchemas(target, schemas, visited);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Documento OpenAPI servido en `/docs` y exportado a `openapi.json`. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const configuredPort = Number(process.env['PORT']);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3210;
  const config = new DocumentBuilder()
    .setTitle('fxbLoader web')
    .setDescription(
      'API local para configurar `fxbLoader.config` y administrar una librería VFX. ' +
        'Todas las rutas escriben en el disco del usuario: el servidor solo escucha en loopback. ' +
        'La escritura de configuración es atómica y usa `mtimeMs` como control optimista.',
    )
    .setVersion('0.1.0')
    .addServer(`http://127.0.0.1:${port}`, 'Instancia local')
    .addTag('fxb-config', 'Lectura y escritura de fxbLoader.config')
    .addTag(
      'library',
      'Escaneo de la librería, instalación y desinstalación del cargador e importación de bancos',
    )
    .addTag(
      'system',
      'Diálogos nativos y comprobación de rutas de la máquina donde corre el servidor',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  closeSchemas(document);
  return document;
}
