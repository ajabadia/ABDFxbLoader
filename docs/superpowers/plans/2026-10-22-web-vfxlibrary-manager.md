# Web vfxLibrary Manager — Implementation Plan

> **Para trabajadores agenticos:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una aplicación web (NestJS + Express + React) que gestione una librería VFX tipo vfxMachine/vWizard en disco — plugins, bancos `.fxb`, `vfxinfo.txt`, `fxbLoader.config` — con las rutas ya definidas en el código y un catálogo de metadatos extendidos por plugin, sin tocar la convención existente del `vfxinfo.txt`.

**Architecture:** Tres fuentes de verdad separadas por plugin: (1) `vfxinfo.txt`, fuente de los campos rígidos (`id`, `dll_name`, `name`…); (2) un archivo propio de la app, dentro de la carpeta del plugin, con estado gestionado por la web y catálogo extendido; (3) los `.fxb` en `presets/`. La app lee `vfxinfo.txt`, lo respeta y lo parchea solo donde el cargador lo exige; sobre él construye su propio archivo y su propio registro. El parser `.fxb` ya existe y es fuente documentable (`vstfxstore.h` de Steinberg).

**Tech Stack:** TypeScript/ESM, NestJS (API), Express (HTTP), React en cliente, `fxb-bank.ts` ya existente para `.fxb`, `vfxinfo.ts` ya existente para `vfxinfo.txt`, `fxb-config.service.ts` ya existente para `fxbLoader.config`. Esquema propio de metadatos en JSON con validación por schema; archivo de log por plugin con rotación por tamaño.

**Spec / plano de partida:** Esta conversación, con el wizard de VMachine (`downloads/pdf/wizard.pdf`) y `compat.html` como convención real de `vfxinfo.txt`, y con el catálogo `compat.html` como ejemplo de lo extendable.

## Restricciones globales

- La app **no sustituye y no valida igual que valida el cargador** el `vfxinfo.txt`: es fuente, no contrato de carga.
- El archivo propio de la app va **dentro de la carpeta del plugin**, no en `presets/`.
- Los metadatos extendidos son **comunes + opcionales**: campos comunes más campos arbitrarios por plugin sin romper el esquema.
- El historial es **un archivo por plugin** con rotación por tamaño; no un archivo por operación.

## Decisiones explícitas

- **Formato del archivo propio:** JSON casi con schema validado, no texto libre. El archivo vive en `<plugin>/fxbLoader.meta.json` y su esquema/código de validación vive junto al servicio que lo lee/escriba.
- **Log rotatorio:** por tamaño. Por plugin: `<plugin>/fxbLoader.log`, y cuando exceda un tope se rota en `<plugin>/fxbLoader.log.1`, `.log.2`, … hasta un número finito de archivos. No se divide por sesión ni por fecha; un plugin pequeño tiene un solo archivo y se abre/cierra en cada escritura.

## Reseña de enfoque para revisión

- **Qué pasa si `vfxinfo.txt` y el archivo propio están desincronizados:** `vfxinfo.txt` manda en campos rígidos del plugin; el archivo propio manda en todo lo demás. Un campo presente en los dos va al esquema propio solo si la app lo maneja.
- **Qué hace la app cuando `vfxinfo.txt` falta o está truncado:** `install` ya responde 422 si no hay `dll_name`. El catálogo/snapshot solo se añade con los campos que la app puede leer/pedir; la app no exige `vfxinfo.txt` para mostrar un plugin instalado en la lista.
- **Qué pasa con `uniqueID` en el catálogo:** `id` del `vfxinfo.txt` es identidad del plugin para el catálogo; la app no inventa un id universal. Si la app lleva su propia clave, es secundaria y local al plugin.
- **Qué pasa si el archivo propio es corrupto:** lectura defensiva con fallo explícito y modo degradado (sin perder `vfxinfo.txt` ni los bancos).
- **Qué pasa con la edición del `vfxinfo.txt` desde la web más allá de `dll_name`:** la app se queda en lo que el cargador exige en la instalación; el catálogo queda en su propio archivo.

---

### Task 1: Esquema y archivo propio por plugin

**Files:**
- Create: `webapp/src/plugin-metadata/plugin-metadata.types.ts`
- Create: `webapp/src/plugin-metadata/plugin-metadata.schema.ts`
- Create: `webapp/src/plugin-metadata/plugin-metadata.service.ts`
- Modify: `webapp/src/app.module.ts`
- Test: `webapp/test/plugin-metadata.service.test.ts`

**Interfaces:**
- Consumes: `readVfxinfo`/`analyzeVfxinfo` de `src/library/vfxinfo.ts`, `pluginDir` desde `LibraryService.describe`.
- Produces: `PluginMetadata` (snapshot del archivo propio), `PluginMetadataWriteInput`, lectura/escritura atómica por `pluginDir`.

- [ ] **Step 1: Write the failing test** con un plugin que tiene `vfxinfo.txt` y un archivo propio inexistente; la app debe devolver el catálogo por defecto (solo lo que puede leer de `vfxinfo.txt` en campos comunes) y `exists: false`.

- [ ] **Step 2: Run test to verify it fails.**

- [ ] **Step 3: Implement the schema and read/write service** del archivo propio. El archivo se lee/escribe atómicamente dentro de `pluginDir`. Los campos comunes se copian desde `vfxinfo.txt` cuando está disponible (`id`, `vendor`, `vendor_url`, `genre`, `name_abbreviation`, `notes` si los interpreta); los demás son opcionales. El esquema es JSON con validación por schema; lo común es los campos interpretados del wizard, lo opcional es cualquier par clave/valor que no rompa el esquema.

- [ ] **Step 4: Run test to verify it passes.**

- [ ] **Step 5: Commit** de `plugin-metadata`.

---

### Task 2: Catálogo por plugin en la vista de lista y detalle

**Files:**
- Create: `webapp/src/plugin-metadata/plugin-metadata.controller.ts`
- Create: `webapp/src/plugin-metadata/plugin-metadata.dto.ts`
- Modify: `webapp/src/library/` o el controlador de escaneo para exponer, por plugin, si hay archivo propio y su snapshot (solo existe/no existe al escanear; el snapshot completo va en endpoint propio).
- Modify: `webapp/src/ui/browser/main.ts` para que la fila/plugin muestre los campos comunes y permita abrir catálogo/editar.
- Test: `webapp/test/plugin-metadata.controller.test.ts` y, si aplica, integración estilo `vfx-library.integration.test.ts`.

**Interfaces:**
- Consumes: `PluginMetadataSnapshot` del servicio de la Task 1, `PluginEntry` del escaneo.
- Produces: endpoint `GET /plugin-metadata/:plugin` y `PUT /plugin-metadata/:plugin`, plus `hasMetadata` en el escaneo sin abrir el archivo.

- [ ] **Step 1: Write the failing test** para listar plugins y ver cuál tiene catálogo, y para leer/escribir el catálogo de un plugin sin tocar `vfxinfo.txt`.

- [ ] **Step 2: Run test to verify it fails.**

- [ ] **Step 3: Implement the controller and DTO** con control optimista sobre el archivo propio (= `mtimeMs` de lectura antes de escribir, igual que hace `fxbLoader.config` hoy). La vista de detalle pinta los campos comunes más los extendidos; la vista de lista pinta pocos campos para no saturar.

- [ ] **Step 4: Run tests to verify they pass.**

- [ ] **Step 5: Commit.**

---

### Task 3: Log por plugin rotado por tamaño

**Files:**
- Create: `webapp/src/plugin-log/plugin-log.types.ts`
- Create: `webapp/src/plugin-log/plugin-log.service.ts`
- Create: `webapp/src/plugin-log/plugin-log.controller.ts` (opcional: consulta, rotación manual, limpieza; si no, queda como servicio interno usado por operaciones).
- Modify: `webapp/src/app.module.ts`
- Test: `webapp/test/plugin-log.service.test.ts`

**Interfaces:**
- Consumes: plugin dir, acción, resumen de operación, resultados relevantes.
- Produces: uno o varios archivos `<plugin>/fxbLoader.log[.N]`; escritura en uno activo, rotación al exceder un tope de tamaño, retención limitada de archivos rotados.

- [ ] **Step 1: Write the failing test** para registrar una operación y consultar el histórico de un plugin, y para que un log vacío no falle al instalar el primer plugin.

- [ ] **Step 2: Run test to verify it fails.**

- [ ] **Step 3: Implement the per-plugin log service with rotation by size**: umbral de rotación, número máximo de archivos rotados, lectura concatenada de los archivos activos para consulta. Cada entrada lleva marca de tiempo y resumen; no log exhaustivo de cada paso interno. La operación degrada si el log no escribe, pero no interrumpe la operación del cargador.

- [ ] **Step 4: Run test to verify it passes.**

- [ ] **Step 5: Commit.**

- [ ] **Step 6: Commit los datos de umbrales en decisión de rotación** (`docs/superpowers/decisions/2026-10-22-fxbLoader-plugin-log-rotation.md`), luego volver a verificar.

---

### Task 4: Puntos de registro en las operaciones existentes

**Files:**
- Modify: `webapp/src/library/library.service.ts` (install, uninstall, importBanks, convertDefaultBank, restoreDefaultBank, discardDefaultBankBackup, exportBank) y controles que ya existen.
- Test: `webapp/test/library.service.test.ts` y `webapp/test/fxb-config.service.test.ts` deben seguir pasando; añadir casos que verifiquen que el log se escribe en los puntos clave, y que una operación correcta no depende del log.
- Test/verificación de integración: tocar `webapp/test/vfx-library.integration.test.ts` solo si la operación con registro sigue siendo la misma contra disco.

**Interfaces:**
- Consumes: `PluginLogService` de la Task 3.
- Produces: cada operación pública escribe una entrada al final, con resumen legible y sin repetir todo el árbol de `actions` si es muy largo.

- [ ] **Step 1: Write the failing test** para una operación concreta (por ejemplo instalación) que confirme que queda una entrada de log y que la operación sigue válida si el log falla.

- [ ] **Step 2: Run test to verify it fails.**

- [ ] **Step 3: Embed logging in the operations** con política de degradación definida en el paso.

- [ ] **Step 4: Run tests to verify they pass.**

- [ ] **Step 5: Commit.**

---

### Task 5: Vistas de la app que corresponden a qué dato en disco

**Files:**
- Modify: `webapp/src/ui/browser/main.ts` (añadir consulta del catálogo y último trazo del log para la fila/plugin que se abre; si la app crece hacia un panel de detalle, ese panel vive aquí o en un componente cercano, no en un archivo nuevo al azar).
- Modify: `webapp/src/client/` según haga falta (tipos derivados del OpenAPI; cambio de endpoint se refleja ahí y en la generación de tipos; si el proyecto regenera clientes, queda como paso mecánico).
- Test/verificación: procedimiento de verificación en navegador y, si la vista se puede ejercer sin DOM real, prueba de selección de plugin/catálogo.

**Interfaces:**
- Consumes: `PluginMetadata` de Task 1/2, resumen de log de Task 3, `PluginEntry` del escaneo existente.
- Produces: cuando la vista abre un plugin, muestra: (1) lo rígido que puede leer de `vfxinfo.txt`; (2) el catálogo editable por la app; (3) los bancos del plugin; (4) el `fxbLoader.config` que ya se edita hoy; (5) el último trazo del log del plugin.

- [ ] **Step 1: Write the failing verification** sobre la vista real (no solo tests unitarios) usando un plugin de prueba con `vfxinfo.txt`, un archivo propio y un log, y comprobar que la vista muestra: campos rígidos del `vfxinfo.txt`, catálogo extendido editable/sin editar, bancos y banco por defecto, y que tras una operación (instalar, importar banco, convertir banco) aparece una entrada legible en el log del plugin.

- [ ] **Step 2: Run the verification against the real app.** Puede hacerse con la app en ejecución contra una librería de prueba, o con el procedimiento de UI/`webapp-testing` (Playwright) si se decide automatizarlo.

- [ ] **Step 3: Commit** de la integración de vistas y cualquier ajuste de tipos derivado.

---

## Review Focus

- **Qué pasa si `vfxinfo.txt` y el archivo propio están desincronizados:** decidido: fuente vs. catálogo, sin sobreescribir el binario.
- **Qué pasa cuando `vfxinfo.txt` falta o está truncado:** conservar 422 donde hoy lo hace, catálogo degradado donde aplica.
- **Qué pasa con `uniqueID` en el catálogo:** `id` del `vfxinfo.txt` es identidad del plugin para el catálogo, no un id inventado por la app.
- **Qué pasa si el archivo propio es corrupto:** lectura defensiva con fallo explícito y modo degradado.
- **Qué pasa con la edición del `vfxinfo.txt` más allá de `dll_name`:** restringida a lo que el cargador exige en la instalación.

## Files under this plan

- New: `webapp/src/plugin-metadata/plugin-metadata.types.ts`
- New: `webapp/src/plugin-metadata/plugin-metadata.schema.ts`
- New: `webapp/src/plugin-metadata/plugin-metadata.service.ts`
- New: `webapp/src/plugin-metadata/plugin-metadata.controller.ts`
- New: `webapp/src/plugin-metadata/plugin-metadata.dto.ts`
- New: `webapp/src/plugin-log/plugin-log.types.ts`
- New: `webapp/src/plugin-log/plugin-log.service.ts`
- New: `webapp/src/plugin-log/plugin-log.controller.ts`
- New: `webapp/test/plugin-metadata.service.test.ts`
- New: `webapp/test/plugin-metadata.controller.test.ts`
- New: `webapp/test/plugin-log.service.test.ts`
- Modify: `webapp/src/app.module.ts`
- Modify: `webapp/src/library/library.service.ts`
- Modify: `webapp/src/library/library.controller.ts` (if scan needs `hasMetadata`)
- Modify: `webapp/src/ui/browser/main.ts`
- Modify: `webapp/src/client/` (openapi/types, as needed)
- Modify: `webapp/test/library.service.test.ts`
- Modify: `webapp/test/fxb-config.service.test.ts`
- Modify: `webapp/test/vfx-library.integration.test.ts` (if applicable)

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-10-22-web-vfxlibrary-manager.md`.

Please review the plan. Does it capture what you want?

For this plan I recommend **native** execution, because the tasks are small, they reuse the existing module boundaries (`library`, `fxb-config`), and the open decisions are now explicit in the plan (JSON schema file, rotation by size). If you want a second reviewer before each task, choose subagent-driven instead.

Which execution approach should we use: native or subagent-driven?
