# Web vfxLibrary Manager — Plan 2026-10-22

> Ejecución nativa, inline. El plano ya está guardado en `docs/superpowers/plans/2026-10-22-web-vfxlibrary-manager.md`; este roadmap es la cara ejecutable que le sigue.

## Objetivo

Añadir a la web de fxbLoader un **catálogo de metadatos extendido por plugin** y un **log por plugin**, sin tocar la convención existente de `vfxinfo.txt`, ni `fxbLoader.config`, ni el formato de los `.fxb`.

Los metadatos y el log viven **dentro de la carpeta del plugin**:

- `<plugin>/fxbLoader.meta.json` → catálogo extendido, esquema JSON con validación.
- `<plugin>/fxbLoader.log[.N]` → historial por plugin, rotado por tamaño.

`vfxinfo.txt` sigue siendo fuente de los campos rígidos del plugin; la app no lo valida igual que lo valida el cargador y no lo transforma salvo donde el cargador lo exige.

## Qué ya existe y qué aprovecha este plano

- `PluginEntry` de `POST /library/scan` ya lleva `name`, `path`, `installed`, `hasVfxinfo`, `pluginName`, warnings.
- `vfxinfo.ts` ya lee/parchea `vfxinfo.txt` y el respaldo `vfxinfo.tx_`.
- `fxb-config.service.ts` ya escribe atómicamente y hace control optimista con `mtimeMs`.
- `atomic-file.ts` ya tiene `writeFileAtomic` / `copyFileAtomic`.
- La UI (`src/ui/browser/main.ts`) ya tiene el panel de bancos y el panel de acciones por plugin. El trabajo de vista se reduce a exponer, en la misma sección de plugin, el catálogo y el log.
- El cliente tipado y OpenAPI ya son el puente; si salen endpoints nuevos, el cambio se refleja ahí y en `npm run client`.

## Decisiones explícitas firmadas

- **Formato del archivo propio:** JSON con esquema validado, no texto libre. El esquema vive junto al servicio que lo lee/escriba (`src/plugin-metadata/plugin-metadata.schema.ts`).
- **Contenido del catálogo:**
  - Campos comunes: los que la app sabe interpretar del `vfxinfo.txt` real (al menos `id`, `vendor`, `name`, y cualquier otro tema del wizard de VMachine que se decida interpretar como común).
  - Campos extendidos: cualquier par clave/valor complementario que no rompa el esquema, sin forzar una forma para cada plugin.
  - Identidad del plugin para el catálogo: `id` del `vfxinfo.txt`. La app no inventa un id universal.
- **Política del log:**
  - Log **por plugin**, un archivo activo por plugin: `<plugin>/fxbLoader.log`.
  - Rotación **por tamaño**, no por sesión, ni por fecha, ni por número de registros. Cuando el archivo activo excede el umbral, se rota a `fxbLoader.log.1`, `.log.2` ... hasta un número finito de rotados.
  - Umbrales canónicos adoptados en el propio documento de decisión (`docs/superpowers/decisions/2026-10-22-fxbLoader-plugin-log-rotation.md`): 1 MiB de rotación, máximo 7 archivos rotados (`fxbLoader.log.1` … `.log.7`), archivo activo `fxbLoader.log` dentro de `<plugin>/`, `.1` el más reciente, entradas con timestamp ISO-8601 + resumen truncado por la derecha si es largo.
  - Entradas con marca de tiempo y resumen de operación. Sin log exhaustivo de cada paso interno del cargador.
  - El log degrada si no escribe, pero no interrumpe la operación del cargador.
- **Compatibilidad con `vfxinfo.txt`:**
  - Si el archivo propio y `vfxinfo.txt` van desincronizados, `vfxinfo.txt` manda en campos rígidos; el catálogo manda en todo lo demás.
  - Si `vfxinfo.txt` falta o está truncado, la app sigue haciendo lo que hace hoy (422 en instalación cuando no hay `dll_name`), y el catálogo/snapshot se construye solo con lo que puede leer o pedir.
  - El catálogo puede leerse sin obligar a `vfxinfo.txt`; no es requisito para mostrar un plugin en la lista.

## Criterios de aceptación

Todos ellos son verificables por archivos reales y por la API, no solo por unittest aislado:

1. Un plugin con `vfxinfo.txt` pero sin `fxbLoader.meta.json` devuelve catálogo por defecto: campos comunes que la app puede leer, `exists: false`, y no crea archivo hasta que no se escribe explícitamente.
2. `PUT` de `fxbLoader.meta.json` escribe atómicamente dentro de `pluginDir` y es visible en `GET` inmediatamente después, con el mismo esquema que lo valida.
3. El esquema válida el JSON común + campos extendidos opcionales, y rechaza lo que rompe el esquema sin perder el archivo propio existente.
4. La instalación/acción registra una entrada en `<plugin>/fxbLoader.log` con marca de tiempo y resumen; la operación sigue siendo válida incluso si el log falla.
5. La rotación se activa al exceder el tamaño y conserva un número limitado de archivos rotados; un plugin nuevo o pequeño tiene un solo archivo de log.
6. La vista de plugin muestra, en el mismo contexto:
   - lo que puede leer de `vfxinfo.txt` en campos rígidos;
   - el catálogo extendido;
   - los bancos del plugin (ya existe hoy);
   - el `fxbLoader.config` que ya se edita hoy;
   - el último trazo del log del plugin.

## Scope explícito de este plano

- El esquema propio y su servicio de lectura/escritura atómica.
- Endpoint propio de catálogo por plugin (`GET/PUT fxbLoader.meta.json`), con control optimista estilo `fxbLoader.config`.
- Log por plugin rotado por tamaño, usado por los puntos de operación existentes.
- Integración en la vista del panel de plugin para mostrar catálogo + log.
- Cambios derivados en OpenAPI/cliente según se discutan los endpoints.

### Qué NO está en este plano

- Nueva estructura de carpetas propia de la app.
- Sustitución de `vfxinfo.txt` ni nuevo formato de `.fxb`.
- Un interactor de todos los plugins ni un banco de datos global.
- Editor del `vfxinfo.txt` más allá de lo que el cargador exige en la instalación.

## Archivos bajo este plano

Nuevos:

- `webapp/src/plugin-metadata/`
  - `plugin-metadata.types.ts`
  - `plugin-metadata.schema.ts`
  - `plugin-metadata.service.ts`
  - `plugin-metadata.controller.ts`
  - `plugin-metadata.dto.ts`
  - `index.ts`

- `webapp/src/plugin-log/`
  - `plugin-log.types.ts`
  - `plugin-log.service.ts`
  - `plugin-log.controller.ts` (si se decide exponer consulta/rotación; si no, queda como servicio interno)
  - `index.ts`

- `webapp/test/`
  - `plugin-metadata.service.test.ts`
  - `plugin-metadata.controller.test.ts`
  - `plugin-log.service.test.ts`
  - casos correspondientes en `library.service.test.ts` y, si aplica, integración estilo `vfx-library.integration.test.ts`

Modificados:

- `webapp/src/app.module.ts` → registrar módulos de metadatos y/o log.
- `webapp/src/library/library.service.ts` → puntos de registro en las operaciones públicas.
- `webapp/src/ui/browser/main.ts` → mostrar catálogo + log en el contexto del plugin.
- `webapp/src/client/` y `openapi.json` según los endpoints que se definan.
- `webapp/src/library/library.controller.ts` si el escaneo necesita `hasMetadata` sin abrir el archivo.

## Roadmap de tareas

### Tarea A — Esquema y archivo propio por plugin

- Escribir el test que falla: plugin con `vfxinfo.txt` y sin archivo propio → catálogo por defecto, `exists: false`.
- Implementar esquema + servicio de lectura/escritura atómica dentro de `pluginDir`.
- Verificar que pasa y que el esquema valida campo común + extendido sin romper nada.

### Tarea B — Catálogo por plugin en la API y en la vista

- Endpoint propio `GET/PUT` del archivo propio, con control optimista (`mtimeMs`) estilo `fxbLoader.config`.
- Exponer, si tiene sentido, `hasMetadata` desde el escaneo sin abrir el archivo.
- Vista: entrada del catálogo en el panel del plugin, mostrando campos comunes + extendidos, sin saturar la fila de lista.
- Actualizar OpenAPI + cliente si el contrato lo requiere.

### Tarea C — Log por plugin rotado por tamaño

- Servicio de log por plugin con los umbrales canónicos del documento de decisión de rotación: 1 MiB de rotación, máximo 7 archivos rotados, entrada truncada por la derecha, concatenación ordenada para consulta.
- Test propio: primera operación en plugin nuevo, rotación al exceder tamaño, política de degradación sin interrumpir la operación.

### Tarea D — Puntos de registro en las operaciones existentes

- Instalar/desinstalar, importar bancos, convertir/ restaurar/ descartar respaldo, exportar banco → entrada de log al final.
- Verificar que la operación sigue siendo válida si el log falla.
- Tests unitarios/integración que cubran los puntos clave.

### Tarea E — Verificación en la vista real

- Plugin de prueba con `vfxinfo.txt`, archivo propio y log.
- Verificar en la app (repo local o Playwright si se decide automatizar) que la vista muestra campos rígidos, catálogo extendido, bancos, `fxbLoader.config` y el último trazo del log.
- Ajustar tipos derivados si cambian los endpoints.

## Revisión

Antes de cada tarea, la pregunta de cierre es la misma: ¿esto es verificable por archivos reales y por la API, o solo por unittest? Si solo por unittest, el plano pide más anclaje.

La decisión pendiente del plano original —execución nativa vs. subagentes— queda resuelta aquí: **nativa, inline**, porque las tareas son pequeñas, los límites de módulo ya existen (`library`, `fxb-config`) y las decisiones abiertas ahora son explícitas en este documento.
