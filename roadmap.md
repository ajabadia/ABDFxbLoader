# Web vfxLibrary Manager — Hoja de Ruta y Plan de Desarrollo

> Ejecución nativa, modular e incremental. Este documento recoge las fases completadas, los archivos creados y las próximas tareas planificadas para la gestión completa de librerías VFX, cargadores fxbLoader, metadatos, asistentes (wizards) e importación de paquetes.

## Resumen Ejecutivo de Fases

- **Fase I: Catálogo Extendido y Logging por Plugin [HECHO]**
  - Esquema y persistencia de `fxbLoader.meta.json` con control optimista (`mtimeMs`).
  - Historial `fxbLoader.log` rotado por tamaño (1 MiB, hasta 7 rotados) integrado en todas las operaciones.
- **Fase II: Mejoras de Usabilidad y Mantenimiento [HECHO]**
  - Filtrado en tiempo real con 4 ejes de 3 estados (instalación, bancos, wizard, compatibilidad).
  - Paginación embebida y selectores visuales de `defaultFxbName` y `loadFxbBank`.
- **Fase III.A: Repositorio e Indexación de Wizards Oficiales [HECHO]**
  - 268 wizards oficiales de SM Pro Audio / VFX indexados desde catálogo empaquetado `wizards-catalog.json`.
  - Drawer `#plugin-wizard`, generación de `vfxinfo.txt` con 1 clic, historial independiente `#log-drawer` y corrección de scroll.
- **Fase III.B: Importador de Instrumentos y Paquetes (.vfxlibrary) [HECHO]**
  - Servicio e interfaz deslizante `#import-package-drawer` para inspeccionar e importar paquetes externos hacia la librería activa (`_banks\storage`).
### Seguimiento acordado: edición DLL e historial de importación

**Fase III.E: Preferencia local de DLL por plugin [HECHO]**

- El catálogo de cada plugin expone la preferencia de DLL (`dll_name`): editable con **Guardar preferencia** / **Cancelar**, borrador visible (etiqueta y contorno) mientras hay cambios sin guardar.
- Guardar valida que la DLL exista dentro de la carpeta del plugin (422 si no), respalda el `vfxinfo.txt` original como `vfxinfo.tx_` solo la primera vez, reescribe solo la línea `dll_name` (CRLF del resto intacto) y deja entrada `[dll-preference]` en el log del plugin.
- Al abrir el importador con un borrador activo: aviso con «Continuar sin cambios» (descarta el borrador y usa la preferencia guardada) o «Cancelar» (conserva el borrador); **no se guarda desde el aviso**.
- `POST /library/plugin-dll-preference`, DTOs OpenAPI, cliente tipado y suite `plugin-dll-preference.test.ts` (539 unitarias/integración en verde).
- E2E de navegador contra el servidor real: borrador/estados del panel, guardado con `vfxinfo.tx_` intacto (el instalador ya crea el respaldo del original) y aviso al abrir el importador («Cancelar» conserva, «Continuar sin cambios» descarta).

**Fase III.F: Auditoría durable de asociaciones [COMPLETO]**

- Un solo almacén por librería, `<libraryRoot>/fxbLoader.audit.jsonl`: apéndice puro de una línea JSON por evento (`open` en modo `a` + `fsync`) que **nunca rota ni se trunca** y cruza plugins, frente al `fxbLoader.log` rotado que narra operaciones. El log sigue existiendo; la auditoría guarda el campo y su cambio.
- Entrada: `ts` ISO-8601, `kind` (`association-change`, `import`, `reimport`, `collision`), `plugin`, `libraryRoot`, `field`/`previousValue`/`newValue` y, en importaciones, `packageSource`, `collisionPolicy`, `collisionNames` y `repairedBanks`, que enlazan las líneas de una misma llamada.
- Escritura solo desde los servicios (`LibraryService` y `LibraryImportService`) a través de `AssociationAuditService.append`: `previousValue` se lee del disco y no del borrador de la UI, y un fallo degrada a `false` sin abortar la operación.
- `POST /library/association-audit/list` y `GET /library/association-audit/stream`: snapshot de solo lectura con `auditPath`, `exists`, `size`, `total` y `entries`, filtros opcionales `plugin`, `kind`, `from`, `to` y `limit` (200 por defecto, los últimos eventos en orden cronológico). Sin almacén, 200 con `exists: false` y lista vacía; `libraryRoot` inválido o filtro mal formado, 400.
- DTOs con dos ejemplos de 200 —`conEventos` con los tres tipos reales (`association-change`, `import` y `collision` enlazados por `packageSource`) y `sinAlmacen` vacío— y el 400, `openapi.json` y tipos del cliente regenerados, y suites `association-audit.service.test.ts` (apéndice con `fsync`, filtros, límite, líneas corruptas, snapshot vacío y HTTP) y `association-audit.docs.test.ts` (ejemplos contra la API real, incluida una importación con su colisión).
- Visor de auditoría en la UI: cajón modal «Auditoría durable de asociaciones» (`#audit-drawer`, botón **Auditoría** de la cabecera) con el snapshot montado sobre `mountTable`: orden por `ts`, filtros nativos de tipo (`multi-select` por `kind`) y rango de fechas (`from`/`to`), y filtro de texto por plugin que se manda al servidor (`plugin` del listado; el resumen del cajón marca «filtrado por X» cuando está activo). Con el cajón abierto se recarga solo cuando el almacén crece: sondeo de 2 s por huella `size:total` que recarga en silencio sin perder orden, filtros ni página. Cobertura en `ui.test.ts`, `client.test.ts` (filtro por plugin en el cuerpo del listado) y el e2e del visor (snapshot vacío, evento real, filtros, filtro por plugin y recarga sola).
- Pendiente: políticas de colisión nuevas más allá de las que registra la importación.

- **Fase III.C: Adquisición / Alta de Instrumentos desde Wizards Certificados [COMPLETO]**
- **Fase III.D: Asistente para Plugins Nuevos sin Wizard con Análisis de Binario [COMPLETO]**
- **Fase IV: Creación y Gestión Avanzada de Bancos (.fxb / .fxp) [EN MARCHA]**
- **Fase V: Distribución Híbrida — Standalone .exe, Web Local y Web Remota Zero-Fork [PLANIFICADA]**

## Objetivos Arquitectónicos

Añadir a la web de fxbLoader una gestión completa de plugins, presets y compatibilidad sin alterar las convenciones requeridas por el hardware de SM Pro Audio / VFX ni romper la compatibilidad de `vfxinfo.txt` o los archivos `.fxb`.

Estructura de almacenamiento por plugin en `plugs/<Plugin>/`:
- `fxbLoader.meta.json` → catálogo extendido, esquema JSON validado.
- `fxbLoader.log[.N]` → historial de operaciones, rotado por tamaño.
- `vfxinfo.txt` → descriptor de plataforma VFX (campos rígidos).
- `presets/` → bancos `.fxb` gestionados.

## Qué ya existe y qué aprovecha este plano

- `PluginEntry` de `POST /library/scan` ya lleva `name`, `path`, `hasLoader`, `hasVfxinfo`, `pluginName`, warnings.
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

Nuevos implementados:

- `webapp/src/plugin-metadata/`
  - `plugin-metadata.types.ts`
  - `plugin-metadata.schema.ts`
  - `plugin-metadata.service.ts`
  - `plugin-metadata.controller.ts`
  - `plugin-metadata.dto.ts`
  - `plugin-meta.constants.ts`
  - `index.ts`

- `webapp/src/plugin-log/`
  - `plugin-log.types.ts`
  - `plugin-log.service.ts`
  - `plugin-log.controller.ts`
  - `index.ts`

- `webapp/src/association-audit/`
  - `association-audit.types.ts`
  - `association-audit.service.ts`
  - `association-audit.controller.ts`
  - `association-audit.dto.ts`
  - `association-audit.module.ts`

- `webapp/src/wizard/`
  - `wizard.types.ts`
  - `wizard-parser.ts`
  - `wizard.service.ts`
  - `wizard.controller.ts`
  - `wizard.dto.ts`
  - `wizards-catalog.json`
  - `index.ts`

- `webapp/src/library/` (extensiones)
  - `library-import.types.ts`
  - `library-import.service.ts`
  - `library-import.dto.ts`

- `webapp/scripts/`
  - `sync-wizards.mjs`

- `webapp/test/`
  - `plugin-meta.service.test.ts`
  - `plugin-meta.controller.test.ts`
  - `plugin-log.service.test.ts`
  - `plugin-log.controller.test.ts`
  - `wizard.service.test.ts`
  - `library-import.service.test.ts`
  - `association-audit.service.test.ts`
  - `association-audit.docs.test.ts`
  - `ui.dom.test.ts`, `ui.markup.test.ts`, `ui.styles.test.ts`
  - Casos en `library.service.test.ts` y `library.controller.test.ts`

Modificados:

- `webapp/src/app.module.ts` → registrar módulos de metadatos, log y wizards.
- `webapp/src/library/library.module.ts` → registrar y proveer `LibraryImportService`.
- `webapp/src/library/library.controller.ts` → endpoints de inspección e importación de paquetes (`inspect-package`, `import-package`).
- `webapp/src/library/library.service.ts` → puntos de registro en las operaciones públicas hacia `PluginLogService` y `AssociationAuditService`.
- `webapp/src/ui/browser/main.ts` → paneles deslizantes de Catálogo, Wizard, Historial e Importador de paquetes; filtrado por 4 ejes de 3 estados, paginación embebida y resolución de scroll en tablas.
- `webapp/public/index.html` → estructura semántica y accesible para `#meta`, `#plugin-wizard`, `#log-drawer`, `#wizards` e `#import-package-drawer`.
- `webapp/public/styles.css` → diseño de drawers, badges, estados, paginación y menús contextuales.
- `webapp/src/client/` y `webapp/openapi.json` sincronizados y tipados rigurosamente con `additionalProperties: false`.

## Roadmap de tareas

### Tarea A — Esquema y archivo propio por plugin [HECHO]

- [x] Escribir el test que falla: plugin con `vfxinfo.txt` y sin archivo propio → catálogo por defecto, `exists: false`.
- [x] Implementar esquema + servicio de lectura/escritura atómica dentro de `pluginDir`.
- [x] Verificar que pasa y que el esquema valida campo común + extendido sin romper nada.

### Tarea B — Catálogo por plugin en la API y en la vista [HECHO]

- [x] Endpoint propio `GET/PUT` del archivo propio (`plugin-meta.controller.ts`), con control optimista (`mtimeMs`) estilo `fxbLoader.config`.
- [x] DTOs, validaciones Swagger/OpenAPI y suite de tests de controlador e integración HTTP.
- [x] Integración en la vista: panel de catálogo en el detalle del plugin (`src/ui/browser/main.ts`), permitiendo ver y editar campos comunes + extendidos de forma amigable.
- [x] Actualizar cliente tipado frontend tras consolidar endpoints (`plugins.meta.read` y `write`).
- [x] Evaluar `hasMetadata` en el escaneo: innecesario en la lista general dado que la UI y cliente abren bajo demanda y reportan `exists: false` sin penalizar el escaneo.

### Tarea C — Log por plugin rotado por tamaño [HECHO]

- [x] Servicio de log por plugin con los umbrales canónicos del documento de decisión de rotación: 1 MiB de rotación, máximo 7 archivos rotados (`fxbLoader.log.1` ... `.log.7`), entrada truncada por la derecha, concatenación ordenada para consulta.
- [x] Test propio: primera operación en plugin nuevo, rotación al exceder tamaño, política de degradación sin interrumpir la operación.

### Tarea D — Puntos de registro en las operaciones existentes [HECHO]

- [x] Instalar/desinstalar, importar bancos, convertir/restaurar/descartar respaldo, exportar banco → entrada de log al final.
- [x] Verificar que la operación sigue siendo válida si el log falla.
- [x] Tests unitarios/integración que cubran los puntos clave.

### Tarea E — Verificación en la vista real [HECHO]

- [x] Plugin de prueba con `vfxinfo.txt`, archivo propio y log.
- [x] Verificar en la app (repo local o Playwright) que la vista muestra campos rígidos, catálogo extendido, bancos, `fxbLoader.config` y el último trazo del log.
- [x] Ajustar tipos derivados si cambian los endpoints (OpenAPI, cliente tipado y auditorías DOM/CSS).

---

## Fase II: Mejoras de Usabilidad y Mantenimiento

- [x] **Búsqueda y filtrado en lista de plugins:**
  - Caja de búsqueda en tiempo real por texto (nombre de plugin, dll, ruta).
  - Cuatro ejes de filtro (instalación, bancos, wizard y compatibilidad), cada uno con un chip que abre sus tres estados: positivo, negativo y «todos». El chip se tiñe (verde el positivo, ámbar el negativo, gris «todos») y `aria-pressed` anuncia si el eje filtra.
  - Contador dinámico de resultados visibles (`X de Y plugin(s)`) y mensaje cuando ningún plugin coincide.
- [x] **Selectores visuales en el editor de `fxbLoader.config`:**
  - Desplegable interactivo para `defaultFxbName` con los `.fxb` descubiertos en `presets/` en el panel de bancos.
  - Checkbox / selector para `loadFxbBank` con persistencia atómica y control de concurrencia optimista (`mtimeMs`).
- [x] **Limpieza y consolidación de arranque:**
  - `start.bat` probado con compilación selectiva, verificación de huérfanos y liberación de puertos.
  - `.gitignore` actualizado con carpetas de respaldo locales (`_backup-*`, `_encoding-backup-*`, `_banks/`).


---

## Fase III: Gestión de Wizards de V-Machine / VFX

> **Objetivo:** Gestionar el repositorio oficial de wizards existentes (`_banks/wizards`, con 261+ sintetizadores y efectos catalogados) para autocompletar catálogos, generar `vfxinfo.txt` faltantes e inspeccionar dependencias; y posteriormente ofrecer un asistente para plugins nuevos sin wizard previo (con apoyo de desensamblado de la herramienta oficial si es necesario).

### Fase III.A: Repositorio e Indexación de Wizards Existentes [HECHO]

- [x] **Parser de Wizards (`wizard-parser.ts`):**
  - Soporte de sintaxis clave-valor y bloques multilínea delimitados por `...` (`notes:`, `vendor_notes:`, `dirs_to_copy:`, `files_to_copy:`, `registry_keys:`, `symlinks:`, `files_to_create:`).
  - Extracción de metadatos (`id`, `name`, `name_abbreviation`, `vendor`, `vendor_url`, `genre`, `notes`, `created`) y parámetros VST (`dll_name`, `dll_version`, `is_synth`, `has_editor`, `parameter_count`, `program_count`, `editor_width`, `editor_height`).
  - Extracción de directivas de hardware / Wine: carpetas de muestras (`dirs_to_copy`), archivos complementarios (`files_to_copy`), claves de registro de Windows (`REGEDIT4` en `registry_keys`) y enlaces simbólicos (`symlinks`).
- [x] **Servicio de Repositorio e Indexación (`wizard.service.ts`):**
  - Lectura e indexación en memoria de `_banks/wizards`:
    - Base de datos oficial `wizard_database_20101112/` (261 carpetas con archivos `.vfxwizard`).
    - Wizards avanzados en carpetas dedicadas (`Arturia-Minimoog`, `GForce-MTronPro`, `Native-Instruments-B4`, `Toontrack-EZDrummer`, `Independence-2-Free`, `TruePianos`, `Rob-Papen-BLUE`). Total: 268 wizards indexados.
  - Generación y sincronización de catálogo empaquetado `wizards-catalog.json` (`scripts/sync-wizards.mjs`) para no depender de escaneo en caliente de carpetas en producción.
  - Motor de matching con plugins de la librería por `id` numérico VST, coincidencia normalizada de nombre y nombre base de DLL.
- [x] **Endpoints REST OpenAPI (`wizard.controller.ts`):**
  - `GET /wizards`: Lista paginada y con búsqueda/filtros de los 268 wizards catalogados.
  - `GET /wizards/:id`: Detalles completos de un wizard (parámetros, notas, dependencias, claves `.reg`).
  - `GET /wizards/match`: Búsqueda del mejor wizard para un plugin dado su `id`, `name` o `dllName`.
  - `POST /wizards/apply-meta`: Inyecta los metadatos del wizard en el `fxbLoader.meta.json` del plugin.
  - `POST /wizards/create-vfxinfo`: Genera el archivo `vfxinfo.txt` en la carpeta del plugin cuando esté ausente o forzado con respaldo `.tx_`.
- [x] **Integración en la Interfaz Web y Experiencia Visual:**
  - **Indicador de Wizard en la tabla**: Columna dedicada *"Wizard"* con badge interactivo (`disponible` / `—`) y filtros rápidos en la barra superior (*"Con wizard"* / *"Sin wizard"*).
  - **Pestaña deslizante del Wizard (`#plugin-wizard`)**: Drawer responsive alineado con Catálogo y Bancos que muestra parámetros VST, directivas Wine/registro, dependencias y notas del asistente.
  - **Utilidad `vfxinfo.txt` de 1 clic**: Botón para crear o regenerar el archivo `vfxinfo.txt` oficial desde las directivas certificadas del wizard.
  - **Historial independiente (`#log-drawer`)**: Extracción de los logs a su propio panel deslizante con menú de acción dedicado en `···`.
  - **Alineación y corrección de scroll vertical**: Detección inteligente de límites de tabla (`drop-up`) y altura mínima de tabla (`min-height: 220px`) para evitar la aparición de barras de desplazamiento vertical al abrir menús de acciones.
- [x] **Pruebas unitarias, de integración y E2E:**
  - Pruebas del parser con archivos reales de `_banks/wizards`.
  - Pruebas del indexador, motor de matching, controladores y navegador Playwright (474 unitarias y 13 de navegador pasadas con 0 fallos).

---

### Fase III.B: Importador de Instrumentos y Paquetes (`.vfxlibrary`) a la Librería Activa [HECHO]

> **Objetivo:** Permitir importar nuevos instrumentos y sus bancos correspondientes desde paquetes externos (como `Novation V-Station demo.vfxlibrary`, `MDAPiano.vfxlibrary` o carpetas sueltas con estructura `plugs/` + `banks/`) directamente a la librería actualmente seleccionada en la aplicación (por ejemplo `_banks\storage`).

- [x] **Servicio de Inspección e Importación de Paquetes (`library-import.service.ts`):**
  - Resolución inteligente de la raíz del paquete (soporta tanto carpetas simples de plugin como estructuras anidadas o directas `.vfxlibrary` con `plugs/` y `banks/`).
  - Detección e inspección de plugins: extracción de DLL, lectura rápida de `vfxinfo.txt` (`id`, `name`), conteo de archivos y bytes totales.
  - Detección e inspección de bancos: conteo de presets `.vfxpreset` y cálculo de tamaño total en bytes.
  - Evaluación precisa de colisiones contra la librería de destino activa (`alreadyExistsInTarget`).
  - Copia atómica y recursiva segura con política configurable de colisión (`skip` para conservar existentes, `overwrite` para actualizar).
  - Emisión de log y trazabilidad en el subsistema de logs por plugin (`PluginLogService`).
- [x] **Endpoints REST OpenAPI (`library.controller.ts`):**
  - `POST /library/inspect-package`: Inspecciona una ruta externa y devuelve un resumen detallado con los plugins, bancos y colisiones detectadas.
  - `POST /library/import-package`: Ejecuta la importación selectiva con política de colisión y devuelve los elementos copiados y omitidos.
  - DTOs completos (`library-import.dto.ts`) con tipado Swagger estricto, tipos primitivos en campos anulables y ejemplos cerrados con `additionalProperties: false`.
  - Regeneración de `openapi.json` y del cliente tipado (`FxbClient.library.inspectPackage` y `importPackage`).
- [x] **Interfaz Gráfica / Asistente Deslizante (`#import-package-drawer`):**
  - Botón *"Importar"* en la cabecera superior con acceso directo.
  - Selector de carpeta de origen con diálogo nativo (`client.system.pick`).
  - Botón de inspección y panel de previsualización que muestra:
    - Tipo de paquete detectado (`.vfxlibrary` o carpeta de plugin) y ruta resuelta.
    - Detección recursiva profunda en subdirectorios de `plugs/` (ej. `plugs/<vendor>/<plugin>/`) y `banks/` (ej. `banks/<categoría>/<banco>.vfxbank`), así como paquetes individuales sin carpeta `plugs/` (como volcados de KVR con `vfxinfo.txt`).
    - Exclusión automática de carpetas de soporte (`wizards/`, `node_modules`, `_backup*`) en escaneos de directorios raíz.
    - Diseño compacto sin huecos verticales innecesarios (`min-height: 0` en tablas del drawer con scroll vertical contenido hasta 260px) y anchos de columna fijos para casillas, IDs de `vfxinfo.txt`, tamaños y badges de estado.
    - Tabla de plugins encontrados con casillas de selección, DLL, vfxinfo, tamaño y estado en destino (badge *"Nuevo"* / *"Ya existe"*).
    - Tabla de bancos encontrados con casillas de selección, número de presets, tamaño y estado en destino.
    - Selector de política de colisión (*Omitir existentes* / *Sobrescribir existentes*).
    - Botón de ejecución *"Importar a la librería"* con refresco automático de la tabla principal y reporte de bytes copiados.
  - Atajos de teclado (Escape), cierre por clic en el fondo oscuro (`#drawer-backdrop`) y navegación accesible por Tab.
- [x] **Utilidad Transversal de Validación y Reparación de Bancos (`vfx-bank-validator.ts`):**
  - Módulo utilitario transversal desacoplado para auditar la integridad técnica y la concordancia de bancos `.vfxbank` respecto al plugin y su Wizard certificado.
  - Inspección de cabeceras binarias de chunks (`!VFXCHUNKMAGIC!\0` en offsets 0..15, FourCC uint32 LE en offset 40).
  - Verificación cruzada entre el ID de plugin en `preset.vfx`, el ID binario en `channel_X_slot_Y_<id>.chunk` y el ID del Wizard oficial certificado.
  - Detección exhaustiva de carencias: `MISSING_DESCRIPTOR`, `MISSING_CHUNK`, `CHUNK_MAGIC_INVALID`, `CHUNK_ID_MISMATCH`, `DESCRIPTOR_ID_MISMATCH`.
  - Reparación automática de bancos desalineados: corrección de nombres de chunks, reescritura binaria de la cabecera (offset 40) con el FourCC objetivo y regeneración limpia del descriptor `preset.vfx`.
  - Integración en la previsualización del importador: indicación del Wizard oficial emparejado en plugins y estado de concordancia (`Concordante`, `Reparable`, `Inconcordante`) en cada banco candidato.
  - Opción de reparación en caliente durante la importación (`repairBanks: true`), alineando automáticamente los bancos con el ID del plugin destino antes de instalarlos en la librería.
- [x] **Verificación y Cobertura de Pruebas:**
  - Suite unitaria dedicada `library-import.service.test.ts` con paquetes reales (`Novation V-Station demo`, `MDAPiano`, KVR TruePianos y pruebas con subcarpetas anidadas en `plugs/Vendor/Plugin`).
  - Suite transversal `vfx-bank-validator.test.ts` verificando diagnóstico en bancos reales, detección de carencias y reparación end-to-end con reescritura de cabeceras binarias.
  - Validación completa de ejemplos OpenAPI (13/13 pasados en `openapi.examples.test.ts`).
  - Auditoría estricta de DOM y CSS (35/35 pasados sin selectores, IDs o clases muertas).
  - Suite de tests unitarios/integración completa.
  - Suite E2E de navegador con Playwright.

---

### Fase III.C: Adquisición / Alta de Instrumentos desde Wizards Certificados [COMPLETO]

> **Objetivo:** Adquirir y dar de alta instrumentos en la librería activa directamente a partir del catálogo oficial de 268 wizards, ahorrando la configuración manual cuando el usuario dispone del DLL original.

- [x] **Flujo de Alta desde Wizard:**
  - Endpoint `POST /wizards/install` y método cliente `client.wizards.install` implementados y tipados de extremo a extremo.
  - Desde el repositorio de wizards (columna *"Acción"* en cada fila) y desde el drawer de detalle de wizard de un plugin (`#plugin-wizard`): botón *"Instalar con DLL…"*.
  - Diálogo de selección nativo de Windows / SO (`client.system.pick` con filtro de archivos DLL).
  - Inspección PE32 obligatoria: valida binario de 32 bits (i386) y emite advertencias detalladas si se detecta un binario de 64 bits incompatible con hardware VFX.
  - El backend crea automáticamente la carpeta `<libraryRoot>/plugs/<NombreRecomendado>/` de forma atómica.
  - Copia atómica del DLL a su ruta relativa esperada (ej. `SuperWave P8/P8.dll`), genera el `vfxinfo.txt` oficial y crea `fxbLoader.meta.json` sincronizado sin conflictos.
  - Vuelca automáticamente archivos de claves de registro (`registry_keys.reg`) si el wizard las define, así como instrucciones (`wizard_readme.txt`).
  - Registro de auditoría atómico en `fxbLoader.log` mediante `PluginLogService`.
- [x] **Creación de Estructura Inicial:**
  - Inicialización automática del directorio `presets/` para almacenamiento inmediato de bancos `.fxb` y presets `.fxp`.
- [x] **Validación y Tests Exhaustivos:**
  - Tests unitarios en `test/wizard.service.test.ts` con DLLs PE32 y PE64 sintéticas, detección de errores 404/400/409 y verificación de archivos creados.
  - Tests de contratos OpenAPI y ejemplos sincronizados.
  - Integración completa con la interfaz web y auditoría estricta de selectores y accesibilidad.

---

### Fase III.D: Asistente para Plugins Nuevos sin Wizard (y Análisis del Binario) [COMPLETO]

> **Objetivo:** Ofrecer un proceso de importación y creación de asistentes para cualquier plugin VST que no tenga wizard previo, evitando tener que redactar a mano el `vfxinfo.txt` ni adivinar sus parámetros.

- [x] **Inspección Estática PE y Exportaciones VST (`inspectPeExports`):**
  - Parser PE32 / PE32+ que inspecciona `IMAGE_EXPORT_DIRECTORY` sin ejecutar código nativo.
  - Comprobación de arquitectura (32-bit i386 vs 64-bit AMD64).
  - Detección de puntos de entrada VST estándar (`VSTPluginMain`, `main`).
  - Extracción de nombres exportados y nombre interno del DLL (`internalDllName`).
- [x] **Endpoints en `LibraryModule`:**
  - `POST /library/inspect-dll`: inspecciona binario DLL, valida arquitectura y VST entrypoint, sugiere nombre/FourCC ID y busca si existe wizard coincidente en el catálogo.
  - `POST /library/create-custom-plugin`: instala plugin DLL en `plugs/<Plugin>/<Plugin>/<dll>`, genera `vfxinfo.txt`, `fxbLoader.meta.json` sincronizado, inicializa `presets/`, registra en `fxbLoader.log` y opcionalmente guarda plantilla `.vfxwizard`.
- [x] **Asistente Guiado en la UI Web:**
  - Drawer accesible `#custom-plugin-drawer` con selector/ruta de DLL.
  - Diagnóstico visual en tiempo real (arquitectura, entrypoint VST, nombre interno, advertencias).
  - Aviso de wizard existente si coincide, permitiendo derivar a la instalación guiada.
  - Formulario de alta (nombre, carpeta, VST ID FourCC, categoría synth/effect, fabricante, guardar como wizard).
- [x] **Validación y Tests Exhaustivos:**
  - Tests unitarios en `pe-exports.test.ts` (5 tests PE32/PE64 sintéticos).
  - Tests OpenAPI en `openapi.test.ts`.
  - Tests HTTP e integración en `http.integration.test.ts`.
  - Tests de contratos de errores en `error-bodies.test.ts`.
  - Tests de documentación en `library.docs.test.ts`.
  - Tests E2E de navegador en `browser.test.ts`.
  - Cero CSS muerto y cero markup muerto en `ui.styles.test.ts` y `ui.markup.test.ts`.

---

## Fase IV: Creación y Gestión Avanzada de Bancos (`.fxb` / `.fxp`)

> **Objetivo:** Ampliar las capacidades de gestión de presets permitiendo no solo importar y convertir bancos existentes, sino crearlos, descomponerlos y editarlos directamente desde la web sin depender de un DAW externo.

- [x] **Generador de bancos FXB (COMPLETO como `POST /library/banks/create`):**
  - [x] Creación desde cero de bancos `CcnK/FxBk` con programas `FxCk` (`numParams` parámetros a 0), cabecera estándar de Steinberg; el FourCC sale del `id` de `vfxinfo.txt` del plugin objetivo y el banco se revalida al escribirlo.
  - [x] Soporte del chunk opaco `FBCh` (`mode: 'chunk'`) para plugins con estado que no expongan parámetros: `chunkHex` con o sin `0x`, `chunkVersion` 1/2 con `currentProgram` en v2, `chunkNumPrograms` informativo, sin `programNames`/`numParams` (400 explícito) y `overwrite` compartido con el modo de programas; cabecera de 156 bytes + tamaño + contenido byte a byte. *(commit `47ae121`)*
  - [x] Visor y log con el chunk opaco: la tabla de bancos distingue el `FBCh` (tooltip con versión, chunk y programa activo; `numPrograms` marcado como informativo y columna «Chunk» con el tamaño del chunk opaco) y el log `create-bank` separa resumen y detalle del formato. E2e de Playwright contra el servidor real que crea el banco desde la página y verifica disco, visor y log.
  - [x] Formulario de creación en el cajón de bancos (`webapp`): sección **Crear un banco .fxb desde cero** con nombre, modo `programNames`/`chunk`, selector de endianness `little/big` común, `fxVersion`, `numParams`, `chunkHex`, versión 1/2, `currentProgram` y programas informativos, `overwrite` opcional; refresca el listado tras crear y muestra el error de la API tal cual. Compila y pasa la suite de UI (markup/estilos/tipos); e2e pendiente en el próximo paso.
- [ ] **Empaquetador y extractor `.fxp` ↔ `.fxb`:**
  - Importación por lotes de presets individuales (`.fxp`) para combinarlos en un banco unificado (`.fxb`).
  - Extracción de un banco `.fxb` hacia una colección de archivos `.fxp` individuales con nombre normalizado.
- [ ] **Inspector y editor de programas:**
  - Editor de la tabla de nombres de programas dentro de bancos FXB.
  - Reordenación, clonación y eliminación de programas individuales dentro de un banco.
  - Verificación cruzada entre el FourCC del banco y el `id` o binario del VST para alertar antes de intentar cargarlo si el preset no pertenece a ese plugin.

### Pendiente inmediato (trabajo en curso en el árbol, sin commit)

- **Fase FBCh en la UI ya verificada, sin commit:** columna y tooltip del chunk opaco en el
  visor de bancos, detalle del `create-bank` en el log del plugin, test de log en
  `banks.create.test.ts` y e2e de navegador de la creación FBCh (17/17 e2e, 557 unit). Falta
  commit junto a los dos puntos de abajo.
- **Ejemplos de auditoría con los tres tipos reales:** `ASSOCIATION_AUDIT_LIST_EXAMPLE` con
  `association-change`, `import` y `collision` enlazados por `packageSource`, test de contratos
  `openapi.test.ts` correspondiente y suite nueva `association-audit.docs.test.ts` (los contra la
  API real). Falta commit.
- **Regeneración de artefactos:** `openapi.json` y `api-types.ts` ya están regenerados contra el
  árbol completo; quedan marcados como modificados hasta que salga el commit de arriba.

---

## Fase V: Distribución Híbrida — Standalone .exe, Web Local y Web Remota Zero-Fork [PLANIFICADA]

> **Objetivo:** Distribuir la aplicación en tres formatos de entrega complementarios sin bifurcar código (política Zero-Fork):
> 1. **Desktop `.exe`**: Ejecutable nativo para Windows sin dependencias externas (doble clic y listo).
> 2. **Web Local**: Servidor local `localhost:3210` en Node.js (entorno actual).
> 3. **Web Remota**: Despliegue estático/Edge en Vercel con edición directa in-place mediante File System Access API y degradación elegante de funciones exclusivas de Win32.

### 1. Diagnóstico de las APIs de Acceso a Disco Existentes

La aplicación ya dispone de un ecosistema maduro de endpoints para interactuar con el disco:
- **`POST /system/pick` (`PickerService`):**
  - Abre selectores nativos de Windows vía PowerShell (`System.Windows.Forms.FileDialog` / `IFileOpenDialog`) para elegir carpetas o archivos devolviendo rutas absolutas.
  - *Diagnóstico:* Imprescindible para el `.exe` y Web Local en Windows. En Web Remota (Vercel), no puede invocar PowerShell; se sustituye por `window.showDirectoryPicker()` / `showOpenFilePicker()` nativo del navegador.
- **`POST /system/paths` (`PathsService`):**
  - Valida rutas absolutas almacenadas en `localStorage` contra `fs.stat` para podar sugerencias caducadas.
  - *Diagnóstico:* En local funciona contra el disco duro; en Web Remota valida contra el árbol en memoria o los handles retenidos por el navegador.
- **Operaciones de Librería (`LibraryService` / `LibraryController`):**
  - `POST /library/scan`, `POST /library/banks/*`, `POST /library/inspect-dll`, `POST /library/import-package`.
  - *Diagnóstico:* La lógica de manipulación (parseo de cabeceras binarias FXB, lectura de `vfxinfo.txt`, inspección PE32) es procesamiento de datos en memoria. Solo la entrada/salida final depende de `node:fs`.
  - **Conclusión:** Las APIs y DTOs actuales son **el contrato canónico perfecto** (`IFxbClient`). Permiten mantener la UI 100% intacta intercambiando únicamente la capa de transporte/almacenamiento.

---

### 2. Desglose de Subfases y Tareas

#### Subfase V.A: Desacoplamiento de Dominio y Contrato de Cliente (`IFxbClient`)
- [x] **Aislar la lógica de dominio en funciones puras (Web Standards):**
  - `fxb-bank.ts`: parseo, validación y conversión de endianness ahora soportan `Uint8Array` nativo (con sobrecargas genéricas de TypeScript y `DataView` estándar para el navegador). Probado con test unitario de `Uint8Array` puro y benchmark (> 1.25M parses/s).
  - `pe-exports.ts`: implementado `inspectPeExportsBuffer(data: Uint8Array)` para analizar DLLs en memoria sin tocar disco ni `node:fs`.
  - `vfxinfo.ts`: verificado que sus parsers y patchers (`splitLines`, `joinLines`, `analyzeVfxinfo`, `writeVfxinfoFields`, `patchVfxinfo`) ya son 100% funciones puras de texto.
- [x] **Matriz de Capacidades y Contrato de Cliente (`FxbClient`):**
  - Creado `SystemCapabilitiesController` (`GET /system/capabilities`) y DTO OpenAPI `SystemCapabilitiesResponseDto`.
  - Añadido `client.system.capabilities()` al cliente tipado `FxbClient` para consultar capacidades en tiempo de ejecución (`mode: desktop | web-local | web-remote`, `canCaptureRegistry`, `canTrash`, etc.).
- [ ] **Adaptador Browser para Almacenamiento Local (`BrowserFsStorage`):**
  - Crear la implementación de cliente cliente-side para resolver `client.library.*` sobre `FileSystemDirectoryHandle`.

#### Subfase V.B: Empaquetado Desktop .exe Nativo (Windows Standalone)
- [x] **Configurar Node.js SEA (Single Executable Application):**
  - Bundle del servidor NestJS y activos estáticos mediante `@vercel/ncc` + ExpressAdapter estático + `postject` en `scripts/package-desktop.mjs`.
  - Generación de `dist-desktop/ABDfxbloader.exe` 100% standalone sin dependencias de Node externas.
- [x] **Lanzador en Modo Aplicación (Edge App Mode):**
  - Al iniciar `ABDfxbloader.exe`, levanta el backend local en puerto configurable (`127.0.0.1:3210`) mediante `src/desktop.ts`.
  - Abre la ventana de la aplicación sin sobrecoste de Chromium ejecutando:
    `msedge.exe --app=http://127.0.0.1:3210 --window-size=1280,850`
  - Control de ciclo de vida: monitoriza el cierre de la ventana de Edge para detener el proceso del servidor de forma limpia.
  - Acceso total a características nativas: captura del registro de Windows (`capture.service.ts`), diálogos nativos (`picker.service.ts`), papelera de reciclaje (`trash.ts`) y revelado en el Explorador (`reveal.ts`).

#### Subfase V.C: Adaptador Web Remoto (Vercel / File System Access API)
- [x] **Configuración para despliegue en Vercel:**
  - Archivos `vercel.json` (raíz con `--prefix webapp`) y `webapp/vercel.json` (subcarpeta directa) con build estático de `webapp/public`.
  - Script `copy-vendor.mjs` para resolver `@abdsynths/shared/Components/I18n` a `webapp/public/vendor/abdsynths/`.
  - Configuración CORS en `app.setup.ts` para aceptar peticiones seguras desde `https://*.vercel.app` hacia el agente local en `127.0.0.1:3210`.
- [ ] **Edición directa in-place en el navegador:**
  - Si no se detecta backend local, la web solicita acceso a la carpeta de la librería mediante `window.showDirectoryPicker()`.
  - `BrowserFxbClient` monta el árbol de la carpeta `plugs/`, ejecuta el escaneo y gestiona conversiones FXB directamente en el navegador del usuario.
  - Privacidad y coste cero: ningún archivo de audio o preset se sube a internet.
- [x] **Detección de Agente Local (Modo Híbrido):**
  - Si la web remota se abre en un equipo que tiene el `.exe` o servidor local en ejecución, la web intenta conectar con `http://127.0.0.1:3210` (vía CORS habilitado).
  - Si responde el backend local, la web remota conmuta automáticamente a `HttpFxbClient`, habilitando todas las herramientas nativas de Windows.

#### Subfase V.D: Matriz de Capacidades y Degradación Elegante en la UI
- [x] **Endpoint y estado de capacidades (`capabilities`):**
  - Proporcionar la matriz de soporte:
    ```typescript
    interface AppCapabilities {
      mode: 'desktop' | 'web-local' | 'web-remote';
      canCaptureRegistry: boolean;
      canTrash: boolean;
      canRevealInExplorer: boolean;
      canNativePick: boolean;
    }
    ```
- [x] **Adaptación de la interfaz sin bifurcar markup:**
  - En modo Web Remota sin agente local, los botones de "Captura de instalación" y "Papelera de reciclaje" permanecen visibles pero deshabilitados o con aviso contextual:
    `"Función disponible exclusivamente en la versión de escritorio para Windows."`
  - Fallback a `window.showDirectoryPicker()` cuando `canNativePick` es falso.

---

### 3. Criterios de Aceptación de la Fase V
1. El archivo `ABDfxbloader.exe` generado pesa < 50 MB, no requiere Node.js instalado y arranca con doble clic abriendo una ventana limpia de aplicación en Windows 10/11.
2. La misma base de código TypeScript compila tanto para el binario de escritorio como para la web local y el despliegue estático de Vercel.
3. En la versión web remota desplegada en Vercel, un usuario con Google Chrome / Microsoft Edge puede abrir su carpeta de librería VFX desde un pendrive o disco duro local, escanearla, editar `vfxinfo.txt` y convertir bancos `.fxb` sin enviar datos a ningún servidor externo.
4. Cero duplicación de código en la UI y suite completa de tests automatizados verde en todos los modos.

---

## Revisión

Antes de cada tarea, la pregunta de cierre es la misma: ¿esto es verificable por archivos reales y por la API, o solo por unittest? Si solo por unittest, el plano pide más anclaje.

La decisión de ejecución se mantiene: **nativa, inline**, porque las tareas son modulares, los límites de dominio ya existen (`library`, `fxb-config`, `plugin-meta`, `wizard` y futuros `library-import` y `fxb-builder`) y las decisiones quedan registradas en este documento.

