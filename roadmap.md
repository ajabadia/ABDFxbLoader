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
- **Fase IV: Creación y Gestión Avanzada de Bancos (.fxb / .fxp) [COMPLETO]**
- **Fase V: Distribución Híbrida — Standalone .exe, Web Local y Web Remota Zero-Fork [COMPLETO]**
- **Fase VI: Experiencia del Músico, Gestión Total V-Machine y Robustez [EN MARCHA]**

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
  - Fallback a `window.showDirectoryPicker()` y `window.showOpenFilePicker()` cuando `canNativePick` es falso.
- [x] **Enlaces interactivos y guiado de rutas hacia Ajustes:**
  - Sistema transversal de avisos de estado con botones de acción interactivos (`StatusAction` / `renderStatusWithAction`).
  - Al faltar la ruta de librería (`!libraryRoot`), el aviso de inicio y de escaneo ofrece el botón `[Configurar en Ajustes]` con icono SVG que abre el cajón deslizante y posiciona el foco en `#library-root`.
  - Si ya hay ruta configurada, no se muestra mensaje ni enlace de advertencia.
  - Extendida la detección y navegación asistida por foco a todas las secciones y cajones:
    - Cajón de Asistentes (`Wizards`): aviso informativo al abrir si no hay librería + aviso interactivo al intentar instalar.
    - Cajón de Plugins Personalizados (`Create Plugin`): aviso informativo al abrir si no hay librería + foco asistido en `#custom-plugin-root` o `#custom-plugin-path` al analizar/crear.
    - Cajón de Importación (`Import Package`): foco asistido en `#import-package-path` o `#library-root`.
    - Cajón de Auditoría y Auditoría de Datos: enlace interactivo directo al campo de librería en Ajustes.
    - Instalación de cargador individual y en lotes: detección de fallos por DLL faltante o inválida con enlace directo a enfocar el campo `#dll-source` en Ajustes.
    - Suite de pruebas `ui.status-actions.test.ts` e integración e2e en verde.

---

### 3. Criterios de Aceptación de la Fase V
1. El archivo `ABDfxbloader.exe` generado pesa < 50 MB, no requiere Node.js instalado y arranca con doble clic abriendo una ventana limpia de aplicación en Windows 10/11.
2. La misma base de código TypeScript compila tanto para el binario de escritorio como para la web local y el despliegue estático de Vercel.
3. En la versión web remota desplegada en Vercel, un usuario con Google Chrome / Microsoft Edge puede abrir su carpeta de librería VFX desde un pendrive o disco duro local, escanearla, editar `vfxinfo.txt` y convertir bancos `.fxb` sin enviar datos a ningún servidor externo.
4. Cero duplicación de código en la UI y suite completa de tests automatizados verde en todos los modos.

---

## Fase VI: Experiencia del Músico, Gestión Total V-Machine y Robustez (Plan de Ejecución)

> **Objetivo:** Transformar la aplicación para que sea 100% comprensible y autónoma para un músico no técnico, gestionar la SM Pro Audio V-Machine de extremo a extremo (incluyendo bancos y presets de hardware) y subsanar las regresiones detectadas en la UI y suite de pruebas.

### 1. Fase VI.A: Estabilización Inmediata y Corrección de Regresiones (Bloque 0) [COMPLETADA]
- [x] **Corrección de exportación de `FxbApiError` en [`api.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/ui/browser/api.ts):**
  - Cambiado `export type { FxbApiError }` por `export { FxbApiError }` para que `test/error-helpers.test.ts` compile sin error `TS1362`.
- [x] **Limpieza de regla CSS muerta en [`styles.css`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/public/styles.css):**
  - Eliminada la regla huérfana `.table-check-all` en línea 2570 dejando `ui.styles.test.ts` en verde.
- [x] **Corrección de sintaxis HTML e i18n en [`index.html`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/public/index.html):**
  - Corregidos los `<input type="checkbox" / data-i18n="...">` en líneas 346, 409, 447, 539, 1134, 1144: movido `data-i18n` a un `<span>` que envuelve el texto visible de la etiqueta para que la traducción al español e inglés se aplique fielmente.
  - Corregido el encabezado del Wizard (`#plugin-wizard-title`): movido `data-i18n` a un `<span>` interno para que `applyI18n()` no destruya `<span id="plugin-wizard-plugin"></span>`.
- [x] **Comportamiento del cajón de Ajustes (`#settings-drawer`):**
  - En [`openSettingsForLibraryRootAction()`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/ui/browser/main.ts), abrir el cajón `#settings-drawer` antes de hacer foco en `#library-root`.
  - Asegurado que `closeAllDrawers()`, el clic en `#drawer-backdrop` y la tecla `Escape` cierren `#settings-drawer`.
  - Conectado `#vmachine-change-drive` para abrir `#settings-drawer` y enfocar `#vmachine-drive`.
- [x] **Exponer operaciones de banco en la UI de `#banks`:**
  - Añadido menú de acciones de fila (`rowActions` con selector "···") a la tabla de bancos `#banks-table`: opciones de "Usar como por defecto", "Renombrar", "Vaciar programas" y "Eliminar banco", con confirmación nativa, refresco reactivo de listado y soporte completo en español e inglés.
- [x] **Verificación:** Ejecutado `npm test` completo (**706 tests pasando, 0 fallos**).

### 2. Fase VI.B: Gestión Total de V-Machine en Hardware (Bancos y Presets Nativos) [EN MARCHA]
- [x] **Guardas preventivas y guiado asistido a Ajustes:**
  - Bloqueo de creación de plugin sin wizard (`openCustomPluginDrawer`) e importación de paquete (`openImportPackageDrawer`) si `libraryRoot` está vacío, abriendo de inmediato Ajustes con foco en el selector de carpeta.
  - Bloqueo de instalación desde Wizards (`promptAndInstallFromWizard`) si `libraryRoot` está vacío con redirección y foco asistido directo en Ajustes.
- [x] **Ergonomía de navegación en la cabecera y Ajustes:**
  - Colocado el botón **"Unidad"** como la primera opción a la izquierda en la cabecera principal (`#vmachine-nav-btn` antes de Librería y Wizards).
  - En el cajón de **Ajustes**, priorizada la configuración de la **Unidad / Drive** situándola en primer lugar antes de la ruta de librería.
- [x] **Ergonomía de presentación en la vista de Unidad:**
  - Transformado el inventario de la unidad en una **tabla estándar unificada** (`vmInventoryTableView` montada sobre `#vmachine-inventory`) con los mismos principios de ordenación, columnas claras (nombre, librería, estado, archivos/tamaño) e integración de diseño del resto de la app.
  - Asegurado que la tabla de comparación con la librería (`#vmachine-sync`) mantenga paridad y acciones de copia.
- [x] **Modal de instalación de Wizards con zona Drag & Drop:**
  - Dotado el modal de instalación asistida de una zona dropzone interactiva para arrastrar el archivo `.dll` o seleccionarlo con clic, complementando el selector de archivos.

---

#### Especificación de Implementación Detallada — Fase VI.B (Bancos Nativos `.vfxbank`, Escenas Multi-Plugin de 4 Canales y Sincronización USB)

> **Propósito de esta sección:** Guía técnica, funcional y de interfaz **autocontenida y verificada contra el binario oficial `vfx.exe`** (`C:\Program Files (x86)\VFX\VFX\vfx.exe`, SHA-256 `5d48a6cb9dc2d8818dcb8caf372b6789338f60d5cfbf83f844d9808ad60873b1`) y bancos reales de `_banks/`, redactada para que cualquier modelo o desarrollador la implemente de extremo a extremo sin ambigüedades ni regresiones en las auditorías del repositorio.

##### 0. Verdad de Terreno del Hardware V-Machine y Formatos Nativos (Ingeniería Inversa de `vfx.exe`)

1. **Jerarquía en disco (`banks/`) — Librería local y Pendrive USB:**
   - **Librería local:** `<libraryRoot>/banks/`
   - **Pendrive USB:** `<Drive>:\<LibraryName>.vfxlibrary\banks\` (hermana de `plugs\`).
   - **Carpetas de banco (dos variantes reales a soportar en lectura/escaneo/sync):**
     1. **Canónica (usar siempre al crear nuevos bancos):** `NNN_<BankName>.vfxbank` (ej. `000_Novation V-Station demo.vfxbank`), donde `NNN` es un índice decimal de 3 dígitos (`000`..`127`).
     2. **Stock / Legacy SM Pro Audio (reconocer en lectura/sync):** `NNN_<BankName>` sin sufijo `.vfxbank` siempre que contenga al menos un subdirectorio `*.vfxpreset` (ej. `004_Demo Synths`, `005_Demo Drums & Effects`).
   - **Inexistencia de `bank.vfx`:** En el formato nativo de V-Machine **NO existe ningún archivo `bank.vfx`**. El índice y nombre del banco vienen determinados exclusivamente por el nombre de la carpeta del banco.
   - **Límites estrictos impuestos por `vfx.exe`:**
     - Máximo **128 bancos** numerados (`000_`..`127_`) y máximo **128 presets por banco** (`000_`..`127_`).
     - Longitud máxima de `<BankName>` (sin `NNN_` ni `.vfxbank`): **30 caracteres** (`strlen < 31`).
     - Longitud máxima de `<PresetName>` (sin `NNN_` ni `.vfxpreset`): **30 caracteres** recomendados para LCD/FAT32, caracteres inválidos de sistema de archivos Windows/FAT32 (`<>:"/\|?*` y controles `0x00..0x1F`) prohibidos o saneados.
     - Cada línea de `preset.vfx` debe medir **`< 80` caracteres** antes del salto de línea (aserción `n < 80` en `vfx_configuration_controller.c:493`), codificación **`latin1`** y saltos de línea **`CRLF` (`\r\n`)**.

2. **Arquitectura Multi-Plugin de 4 Canales + Aux + Master en `preset.vfx` (`0x41d4a0` y `0x41a600`):**
   - Un preset nativo `.vfxpreset` es una **escena completa de directo** compuesta por **7 buses de mezcla** (`channel_index < 4 + 2 + 1`) y **3 slots de plugin en serie por bus** (`slot_index < 3`, posiciones `slot_a`, `slot_b`, `slot_c`; máximo 21 slots direccionables):
     - **`channel: 0` .. `channel: 3` (Canales 1 a 4 en la UI):** Los **4 canales principales de instrumento/audio** de la V-Machine.
       - Permiten cargar hasta **4 sintetizadores simultáneos** (uno en el `Slot A` de cada canal) más **2 efectos de inserción en cadena por canal** (`Slot B` y `Slot C`, ej. `Bass Module` en Slot A + `E-Phonic LOFI` en Slot B).
       - Modos musicales que habilitan los 4 canales:
         - **Single:** 1 instrumento en `Canal 1` (`channel: 0`), canales 2–4 vacíos (`volume: 0`).
         - **Layer (Capas):** 2 a 4 instrumentos en canales distintos recibiendo el mismo `midi_channel` (ej. `0` = Omni) y rango completo (`midi_note_min: 0`, `midi_note_max: 0` o `0..127`), mezclados con `volume` y `pan` independientes.
         - **Split (División de teclado):** Zonas de teclado separadas con `midi_note_min` / `midi_note_max` (ej. Canal 1 Bajo `0..59` + Canal 2 Piano/Lead `60..127`) y `midi_transpose` independiente (`-48..+48` semitonos). *Nota de formato:* en `preset.vfx`, `midi_note_min: 0` + `midi_note_max: 0` significa «rango completo sin restricción» (`0..127`), mientras que para un split inferior real que acabe en Si2 se escribe `midi_note_min: 0` y `midi_note_max: 59`.
         - **Multitímbrico (Multi 4 partes):** 4 instrumentos asignados a `midi_channel: 1`, `2`, `3` y `4` respectivamente.
     - **`aux: 0` y `aux: 1` (Aux 1 y Aux 2 en la UI):** 2 buses estéreo de envío/retorno (3 slots de efecto cada uno, ej. Reverb compartida en `Aux 1` y Delay en `Aux 2`), alimentados desde `send: 0` y `send: 1` de cada canal.
     - **`master:` (Bus Master en la UI):** 1 bus estéreo maestro con 3 slots de inserción global (ej. EQ / Compresor / Limitador) y nivel maestro (`volume: 206` ≈ `0 dB` nominal; rango entero `0..255`, centro de `pan` = `128`).
   - **Estructura exacta e indentación posicional de `preset.vfx` (`version: 3`):**
     - **Importante:** En `preset.vfx` **NO existen etiquetas `slot_a:`/`slot_b:`/`slot_c:`**. Dentro de cada bloque `channel: N`, `aux: N` o `master:`, aparecen **exactamente 3 bloques `        plugin:` consecutivos** (8 espacios de sangría) que corresponden por orden posicional a `slot_a` (1º), `slot_b` (2º) y `slot_c` (3º). Si un slot está vacío, se escribe `        plugin:` sin valor seguido de línea en blanco.
     - Ejemplo canónico real (`version: 3`, sangrías exactas de `0`, `4`, `8` y `12` espacios):
       ```text
       preset: Bass + Lead Split
           version: 3
           tempo_bpm: 120
           time_signature_num: 4
           time_signature_den: 4
           tempo_bpm_midi: 0
           mixer_midi_channel: 0
           audio_buffer_size: 0

           channel: 0
               plugin: 1316377392
                   name: V-Station Demo
                   short_name: VStat
                   midi_channel: 0
                   midi_note_min: 0
                   midi_note_max: 59
                   midi_transpose: 0
                   midi_from_computer: 1
                   chained_midi: 0
                   midi_thru: 0
                   program_midi: 0
                   parameter_count: 160
                   selected_program: 0
                   midi_map: 74: 12
                   priority_parameter: 12

               plugin:

               plugin:

               volume: 206
               pan: 128
               left_in: 0
               right_in: 0
               mute: 0
               solo: 0
               mute_others_midi: 0
               toggle_mute_midi: 0
               toggle_solo_midi: 0
               volume_midi: 0
               pan_midi: 0
               mute_midi: 0
               solo_midi: 0

               send: 0
                   gain: 0
                   is_pre: 0
                   gain_midi: 0
                   is_pre_midi: 0

               send: 1
                   gain: 0
                   is_pre: 0
                   gain_midi: 0
                   is_pre_midi: 0
       ```
       *(Seguido de `channel: 1`, `channel: 2`, `channel: 3`, `aux: 0`, `aux: 1` y `master:` con idéntica estructura de 3 bloques `plugin:`, mezcla y 2 bloques `send:`).*
     - **Compatibilidad de lectura v2 y preservación round-trip:** Los presets antiguos (v2) omiten `version: 3`, `mixer_midi_channel`, `mute_others_midi`, `toggle_mute_midi` y `toggle_solo_midi`. El parser debe aceptarlos con valores `0` por defecto y escribir siempre en `version: 3`, **preservando intactas** las líneas opcionales `midi_map: <cc>: <param>` (`cc` `1..127`) y `priority_parameter: <param>` de cada slot cuando se edite un preset existente.
     - **Restricción de `short_name`:** Máximo **6 caracteres ASCII** (`strlen < 7` en `vfx.exe`) para el display LCD físico de la V-Machine (autogenerable desde `name_abbreviation` del Wizard o las primeras 6 letras/dígitos del nombre).

3. **Nomenclatura Exacta de Archivos `.chunk` por Bus y Slot (`FUN_0041d2b0` en `0x41d2b0`):**
   - Mientras que en `preset.vfx` los índices de `channel:` (`0..3`) y `aux:` (`0..1`) empiezan en `0`, **en el nombre del archivo `.chunk` v3 empiezan en `1` (`1-based`)**:
     - `channel: 0..3`, slot `0..2` (`a`/`b`/`c`): `channel_${channelIndex + 1}_slot_${'a'|'b'|'c'}_${pluginId}.chunk` (ej. `channel_1_slot_a_1316377392.chunk` .. `channel_4_slot_c_1280263753.chunk`).
     - `aux: 0..1`, slot `0..2` (`a`/`b`/`c`): `aux_${auxIndex + 1}_slot_${'a'|'b'|'c'}_${pluginId}.chunk` (ej. `aux_1_slot_a_...chunk`, `aux_2_slot_b_...chunk`).
     - `master:`, slot `0..2` (`a`/`b`/`c`): `master_slot_${'a'|'b'|'c'}_${pluginId}.chunk`.
     - *Compatibilidad solo lectura (v1/v2 legacy):* `channel${0..3}_${'a'|'b'|'c'}.chunk`, `aux${0..1}_${'a'|'b'|'c'}.chunk`, `master_${'a'|'b'|'c'}.chunk`.
   - **Plugins sin estado («chunkless»):** Cuando un plugin tiene `parameter_count === 0` y no expone chunk opaco VST (`vstChunkSize === 0 && parameterDumpSize === 0`, ej. `4Front Piano Module` o `Bass Module`), `vfx.exe` emite `"Plugin has no chunkiness to save"` y **NO crea archivo `.chunk`**. La ausencia de `.chunk` en ese caso es **100% válida** y no debe marcarse como `MISSING_CHUNK`.

4. **Layout Binario Real de `.chunk` (100 bytes de cabecera v4 + CRC-16) y Corrección de Bug Actual:**
   - **ALERTA DE BUG EXISTENTE A CORREGIR:** Actualmente [`webapp/src/library/vfx-bank-validator.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/library/vfx-bank-validator.ts) (`buildVfxChunkBuffer` / `repairVfxBank`) construye una cabecera errónea de 52 bytes con un timestamp en `+16` y parchea el `pluginId` en el offset `0x28` **sin recalcular los checksums CRC-16 en `0x10` y `0x12`**, lo que provoca que `vfx.exe` y la V-Machine rechacen el archivo con `"Bad header checksum in v%d chunk file"`.
   - **Mapa binario exacto (`vfx_vst_host_save_chunk_file` `0x4adff0` / `vfx_vst_host_read_chunk_file` `0x4aec50`, Little-Endian):**

     | Offset | Tamaño | Tipo | Campo | Descripción / Valor |
     | :--- | :--- | :--- | :--- | :--- |
     | `0x00` | 16 B | `ascii` | `magic` | `"!VFXCHUNKMAGIC!\0"` (`21 56 46 58 43 48 55 4E 4B 4D 41 47 49 43 21 00`) |
     | `0x10` | 2 B | `uint16le` | `headerChecksum` | CRC-16 de los **80 bytes** `buf[0x14 .. 0x64]` |
     | `0x12` | 2 B | `uint16le` | `overallChecksum` | Continuación del mismo estado CRC-16 alimentado con el payload `buf[0x64 .. totalBytes]` y finalizado |
     | `0x14` | 4 B | `uint32le` | `version` | `4` en escritura (en lectura aceptar `1..4`; validar CRC si `version >= 3`) |
     | `0x18` | 4 B | `uint32le` | `totalBytes` | `100 + parameterDumpSize + vstChunkSize` (máx. `0xA00000` = 10 MiB) |
     | `0x1C` | 4 B | `uint32le` | `vstChunkSize` | Tamaño en bytes de `vstChunk` (va **después** de `parameterDump`) |
     | `0x20` | 4 B | `uint32le` | `parameterDumpSize` | `parameterCount * 4` bytes (`float32le[]`, va **primero** en `0x64`) |
     | `0x24` | 4 B | `uint32le` | `flags` | `1` |
     | `0x28` | 4 B | `int32le` | `pluginId` | ID VST de 32 bits coincidente con `id:` de `vfxinfo.txt` |
     | `0x2C` | 4 B | `uint32le` | `pluginVersion` | `dll_version` de `vfxinfo.txt` (o `1000` / `0` si no consta) |
     | `0x30` | 4 B | `uint32le` | `numPrograms` | `program_count` de `vfxinfo.txt` (`AEffect.numPrograms`) |
     | `0x34` | 48 B | `uint8[48]` | `reserved` | Relleno de ceros (`0x00`) hasta completar exactamente **100 bytes** (`0x64`) |
     | `0x64` | `parameterDumpSize` | `float32le[]` | `parameterDump` | Array de `parameterCount` floats IEEE-754 LE (`0.0 .. 1.0`) |
     | `0x64 + P` | `vstChunkSize` | `uint8[]` | `vstChunk` | Estado opaco del VST (p. ej. extraído de un banco `FBCh` o programa `FPCh`) |

   - **Algoritmo CRC-16 exacto de `vfx.exe` (`0x438ef0`, `0x438fa0`, `0x439020` — verificado bit a bit contra `.chunk` reales):**
     ```typescript
     export function vfxCrc16Update(crc: number, data: Uint8Array): number {
       let reg = crc & 0xffff;
       for (let i = 0; i < data.length; i++) {
         const byte = data[i]!;
         for (let bit = 0; bit < 8; bit++) {
           const msb = (reg & 0x8000) !== 0;
           reg = ((reg << 1) & 0xffff) | ((byte & (0x80 >> bit)) !== 0 ? 1 : 0);
           if (msb) reg = (reg ^ 0x1021) & 0xffff;
         }
       }
       return reg;
     }

     export function vfxCrc16Finalize(crc: number): number {
       let reg = crc & 0xffff;
       for (let bit = 0; bit < 16; bit++) {
         const msb = (reg & 0x8000) !== 0;
         reg = (reg << 1) & 0xffff;
         if (msb) reg = (reg ^ 0x1021) & 0xffff;
       }
       return reg;
     }

     // Cálculo al construir o reparar un buffer `buf` de longitud >= 100:
     // const headerState = vfxCrc16Update(0xffff, buf.subarray(0x14, 0x64));
     // view.setUint16(0x10, vfxCrc16Finalize(headerState), true);
     // const overallState = vfxCrc16Update(headerState, buf.subarray(0x64));
     // view.setUint16(0x12, vfxCrc16Finalize(overallState), true);
     ```

---

##### 1. Subbloque VI.B.1 — Núcleo Puro de Formatos Nativos y Reparación (`Uint8Array` / Zero-Fork)

> **Regla de arquitectura (Fase V Zero-Fork):** Toda la lógica de parseo y serialización de `.chunk` y `preset.vfx` debe escribirse usando exclusivamente **`Uint8Array`, `DataView` y `TextDecoder('latin1')` / codificador `latin1` puro**, sin importar `node:fs` ni `Buffer` exclusivo de Node, para que funcione tanto en el backend NestJS como en el futuro `BrowserFxbClient` (Web Remota).

- [ ] **Crear [`webapp/src/library/vfx-chunk.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/library/vfx-chunk.ts):**
  - Implementar `vfxCrc16Update`, `vfxCrc16Finalize`, `parseVfxChunk(data: Uint8Array)`, `buildVfxChunk(input: VfxChunkBuildInput): Uint8Array` y `patchVfxChunkPluginId(data: Uint8Array, newPluginId: number): Uint8Array` (actualizando `0x28` y recalculando `0x10` y `0x12`).
  - Implementar puente `.fxb` → `.chunk` (`buildVfxChunkFromFxb(fxbBytes: Uint8Array, options: { programIndex?: number; pluginId: number; pluginVersion?: number; numPrograms?: number; parameterCount?: number }): Uint8Array | null`):
    - Si el `.fxb` es `FxBk` (programas regulares `FxCk`): extrae los `numParams` floats del `programIndex` seleccionado (convirtiendo de Big-Endian o Little-Endian según el `.fxb` a `float32le` en `parameterDump`) y deja `vstChunkSize = 0`.
    - Si el `.fxb` es `FBCh` (chunk opaco): extrae el payload opaco como `vstChunk` y, si `parameterCount > 0`, inicializa `parameterDump` a `0.0` (o conserva un `parameterDump` previo de plantilla si se proporciona).
    - Si `parameterCount === 0` y no hay `vstChunk`, devuelve `null` (plugin chunkless: no se escribe archivo `.chunk`).
- [ ] **Crear [`webapp/src/library/vfx-preset.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/library/vfx-preset.ts):**
  - Tipos completos: `VfxPresetDescriptor`, `VfxMixerStrip` (`kind: 'channel' | 'aux' | 'master'`, `index: number`, `slots: [VfxPluginSlot | null, VfxPluginSlot | null, VfxPluginSlot | null]`, `volume`, `pan`, `leftIn`, `rightIn`, `mute`, `solo`, `muteOthersMidi`, `toggleMuteMidi`, `toggleSoloMidi`, `volumeMidi`, `panMidi`, `muteMidi`, `soloMidi`, `sends: [VfxSendConfig, VfxSendConfig]`), `VfxPluginSlot` (incluyendo `midiMaps: { cc: number; param: number }[]`, `priorityParameters: number[]`, `extraLines: string[]`).
  - Funciones `parsePresetVfx(content: string): VfxPresetDescriptor`, `serializePresetVfx(preset: VfxPresetDescriptor): string` (garantizando `CRLF`, sangrías `0/4/8/12`, `short_name <= 6` y líneas `< 80` chars), `createEmptyPresetDescriptor(name: string): VfxPresetDescriptor`, `formatVfxChunkFilename(stripKind, stripIndex, slotIndex, pluginId): string`, `parseVfxBankFolderName(folder: string)` y `formatVfxBankFolderName(index: number, name: string): string`.
- [ ] **Actualizar [`webapp/src/library/vfx-bank-validator.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/library/vfx-bank-validator.ts):**
  - Delegar `readVfxChunkHeader` y `buildVfxChunkBuffer` en `vfx-chunk.ts` (cabecera real de 100 bytes + verificación de `headerChecksum` y `overallChecksum` con nuevo código de incidencia `CHUNK_CHECKSUM_INVALID` reparable automáticamente).
  - Soportar presets multi-plugin de **4 canales × 3 slots + Aux 1/2 + Master** sin sobrescribir ni perder los canales `1..3`, `aux` ni `master` al reparar un banco (`repairVfxBank`), y no reportar `MISSING_CHUNK` cuando el slot tenga `parameter_count: 0` y el plugin sea chunkless.
  - Reconocer carpetas de banco tanto con sufijo `.vfxbank` como carpetas `NNN_<Name>` que contengan subcarpetas `.vfxpreset`.

---

##### 2. Subbloque VI.B.2 — Servicios Backend, Endpoints OpenAPI y Sincronización USB

- [ ] **Ampliar [`webapp/src/common/api-errors.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/common/api-errors.ts) con nuevos `API_ERROR_CODES`:**
  - Añadir: `'bankFolderMissing'`, `'bankAlreadyExists'`, `'bankNameInvalid'`, `'bankLimitExceeded'`, `'presetFolderMissing'`, `'presetLimitExceeded'`, `'presetInvalid'`, `'chunkInvalid'`, `'pluginNotInstalled'`.
  - Registrar el mapeo HTTP (`404`, `409`, `400`, `422`) en los controladores y añadir las traducciones correspondientes bajo `msg.apiError.<code>` tanto en `locales/es.ts` como en `locales/en.ts`.
- [ ] **Crear `VfxBanksService`, `VfxBanksController` y `vfx-banks.dto.ts` en `webapp/src/library/` (registrados en `LibraryModule`):**
  - Todos los DTOs deben usar `@ApiProperty` / `@ApiPropertyOptional` con `example` explícito, tipos primitivos explícitos en propiedades anulables (`nullable: true`) y esquemas cerrados compatibles con `openapi.test.ts` y `openapi.examples.test.ts`.
  - **Endpoints REST bajo `/library/vfx-banks`:**
    1. `POST /library/vfx-banks/list` (`{ libraryRoot }`): Escanea `<libraryRoot>/banks/`, devuelve la lista ordenada de bancos con `{ folder, index, name, isCanonicalSuffix, presetCount, totalBytes, mtimeMs, referencedPlugins: [{ id, name, installedFolder, isSynth }], missingPluginIds, health: 'valid' | 'repairable' | 'broken', issuesCount }`.
    2. `POST /library/vfx-banks/inspect` (`{ libraryRoot, bankFolder }`): Devuelve metadatos del banco y la lista ordenada de presets (`000..127`), incluyendo para cada preset el resumen visual de los **4 canales** (`channelsSummary`: slots activos A/B/C, rango MIDI `noteMin..noteMax`, `midiChannel`, `transpose`, `volume`), `auxSummary`, `masterSummary`, `tempoBpm` e incidencias del validador.
    3. `POST /library/vfx-banks/create` (`{ libraryRoot, name, index? }`): Crea atómicamente `<libraryRoot>/banks/NNN_<name>.vfxbank` (calculando el primer índice libre `000..127` si `index` se omite; valida `name.length <= 30` y `< 128` bancos). Registra evento en `AssociationAuditService`.
    4. `POST /library/vfx-banks/rename` (`{ libraryRoot, bankFolder, newName, newIndex? }`) y `POST /library/vfx-banks/reorder` (`{ libraryRoot, orderedBankFolders }`): Renombrado y reindexación atómica (`000_..NNN_`) usando directorio temporal intermedio en la misma partición para evitar colisiones de nombres.
    5. `POST /library/vfx-banks/delete` (`{ libraryRoot, bankFolder }`): Envía la carpeta del banco a la papelera de reciclaje en Windows (`trash.ts`) o elimina de forma segura, registrando auditoría.
    6. `POST /library/vfx-banks/repair` (`{ libraryRoot, bankFolder }`): Ejecuta `repairVfxBank` recalculando CRC-16, corrigiendo nombres `.chunk` o alineando IDs contra los plugins instalados en `plugs/`.
    7. `POST /library/vfx-banks/preset/read` (`{ libraryRoot, bankFolder, presetFolder }`): Devuelve el `VfxPresetDescriptor` completo (los 4 canales × 3 slots + Aux 1/2 + Master) junto con metadatos de los `.chunk` presentes en disco y los bancos `.fxb` disponibles de cada plugin instalado para alimentar los selectores de la UI.
    8. `POST /library/vfx-banks/preset/save` (`{ libraryRoot, bankFolder, presetFolder?, index?, preset, slotSoundSources? }`):
       - Crea (si `presetFolder` se omite) o actualiza atómicamente `NNN_<preset.name>.vfxpreset`.
       - Para cada uno de los **7 buses × 3 slots**:
         - Si el slot está vacío, elimina cualquier `.chunk` residual de esa posición `(bus, slot)`.
         - Si el slot asigna un plugin instalado y `slotSoundSources` indica `{ mode: 'fxb', fxbName, programIndex }`, genera el `.chunk` real de 100 bytes + CRC-16 desde `plugs/<Plugin>/presets/<fxbName>`.
         - Si `mode: 'keep'` y ya existía un `.chunk` válido para ese mismo `pluginId`, lo conserva intacto.
         - Si `mode: 'default'` (o no se especifica y no había `.chunk` previo), intenta clonar un `.chunk` base del plugin si existe o genera un `.chunk` inicial válido con `parameterCount` parámetros a `0.0` (u omite `.chunk` si `parameter_count === 0`).
       - Escribe `preset.vfx` mediante `writeFileAtomic` y registra traza en `PluginLogService` de los plugins implicados.
    9. `POST /library/vfx-banks/preset/clone`, `POST /library/vfx-banks/preset/delete` y `POST /library/vfx-banks/preset/reorder`: Operaciones atómicas sobre carpetas `.vfxpreset` manteniendo numeración consecutiva `000_..127_` y respetando el tope hardware de 128 presets por banco (`presetLimitExceeded`).
    10. `POST /library/vfx-banks/generate-from-plugin` (`{ libraryRoot, pluginFolder, bankFolder?, fxbName?, maxPresets? }`):
        - Utilidad directa para el músico: dado un plugin instalado en `plugs/<pluginFolder>` (con o sin `fxbLoader`), crea un banco `.vfxbank` (o añade presets a uno existente) generando automáticamente un `.vfxpreset` inicial (Canal 1 / Slot A apuntando al plugin) o convirtiendo hasta 128 programas de un `.fxb` del plugin en `.vfxpreset` individuales seleccionables desde la rueda física de la V-Machine.
- [ ] **Integrar opción de banco inicial al dar de alta plugins (`WizardController` / `LibraryController`):**
  - Añadir flag opcional `createInitialVfxBank?: boolean` (por defecto `false` en API por retrocompatibilidad de tests existentes, activable por checkbox en UI) en `POST /wizards/install` y `POST /library/create-custom-plugin`, invocando `VfxBanksService.generateFromPlugin`.
- [ ] **Extender [`webapp/src/vmachine/vmachine.service.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/vmachine/vmachine.service.ts), `vmachine.controller.ts` y `vmachine.dto.ts` para `banks/`:**
  - `GET /vmachine/inventory`: añadir `banks: VMachineStickBankDto[]` dentro de cada entrada de `libraries[]` (con `folder`, `name`, `presetCount`, `files`, `bytes`, `referencedPluginIds`, `missingPluginIdsOnStick`: IDs de plugins usados por algún preset del banco que **no** están presentes en `plugs\` de esa misma `.vfxlibrary` del pendrive).
  - `GET /vmachine/sync`: añadir `banks: VMachineBankSyncEntryDto[]` y `bankCounts: { total, same, differs, missing }` en `VMachineSyncResponseDto`.
    - Estado `missing` (la carpeta del banco no está en `<Drive>:\<Lib>.vfxlibrary\banks\`), `differs` (difiere el conjunto de archivos relativos, tamaños o contenido de `preset.vfx`/`.chunk`), `same` (idéntico).
    - Incluir `requiredPluginFolders: string[]` y `missingOnStickPluginFolders: string[]` cruzando los `pluginId` de todos los slots de los 4 canales/Aux/Master del banco con los plugins de `<libraryRoot>/plugs/` y del USB.
  - `POST /vmachine/copy`:
    - Hacer `folders?: string[]` opcional si se envía `bankFolders?: string[]` (exigir que `folders.length + bankFolders.length > 0`, manteniendo compatibilidad 100% con peticiones actuales que solo envían `folders`).
    - Añadir `includeRequiredPlugins?: boolean`: cuando es `true`, resuelve e incluye automáticamente en la copia las carpetas de `plugs/` requeridas por los `bankFolders` seleccionados que aún falten en el pendrive.
    - Verificar espacio libre combinado (`plugs` + `banks`) antes de escribir (`notEnoughSpace`) y copiar cada archivo con la misma verificación SHA-256 (`<= 32 MiB`) / tamaño (`> 32 MiB`) y reporte unificado (`copied`, `replaced`, `bytes`, `verified`, `copiedPlugins`, `copiedBanks`).
- [ ] **Regenerar artefactos OpenAPI y Cliente Tipado:**
  - Añadir `client.vfxBanks.*` y ampliar `client.vmachine.*` en [`webapp/src/client/fxb-client.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/client/fxb-client.ts).
  - Ejecutar `npm --prefix webapp run client` para actualizar `webapp/openapi.json` y `webapp/src/client/api-types.ts`.

---

##### 3. Subbloque VI.B.3 — Diseño Funcional, Interfaz de Usuario (UI/UX) y Flujo del Músico

1. **Navegación Principal en Cabecera (`.top-actions` en [`webapp/public/index.html`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/public/index.html)):**
   - Añadir el botón `#vfx-banks-nav-btn` (`class="nav-btn"`, icono `#icon-banks`) inmediatamente después de `#library-nav-btn` (`Librería`) y antes de `#wizards-nav-btn` (`Wizards`), estableciendo el orden natural de trabajo:
     `Unidad` → `Librería` (Plugins) → `Bancos V-Machine` (Escenas de 4 canales) → `Wizards` → `Añadir` → `Auditoría` → `Ajustes`.

2. **Nueva Vista Principal `#vfx-banks-view` (`class="view" hidden aria-labelledby="vfx-banks-title"`):**
   - ** Guardas de `libraryRoot`:** Si `libraryRoot` está vacío, mostrar aviso con `renderStatusWithAction` (`[Configurar en Ajustes]` → abre `#settings-drawer` y enfoca `#library-root`), exactamente igual que en Librería y Unidad, y bloquear botones de creación.
   - **Tarjeta superior — Listado de Bancos Nativos (`#vfx-banks-table` sobre `mountTable`):**
     - Barra de acciones con botón primario `#vfx-bank-create-btn` (`+ Nuevo banco V-Machine`) y botón `#vfx-banks-refresh-btn` (`Actualizar`).
     - Columnas de `mountTable`:
       1. `index`: Nº LCD (`000`..`127`, monoespacio).
       2. `name`: Nombre del banco + carpeta pequeña debajo.
       3. `presetCount`: Nº de escenas/presets (`X / 128`).
       4. `plugins`: Badges compactos con los plugins usados en sus presets (y `.badge.warn` si algún plugin referenciado no está instalado en `plugs/`).
       5. `health`: Badge de integridad (`Válido` verde / `Reparable` ámbar / `Incompleto` rojo).
       6. `rowActions` (`···`): `Ver escenas / presets`, `Nueva escena (4 canales)`, `Renombrar banco`, `Reparar banco` (si es reparable), `Copiar a la Unidad` (atajo directo si hay unidad configurada) y `Eliminar banco`.
     - Filtros chip en la tabla: Salud (`Todos` / `Con avisos` / `Válidos`) y Tipo (`Todos` / `Multi-plugin` / `Un solo plugin`).
   - **Tarjeta inferior contextual — Escenas / Presets del Banco Seleccionado (`#vfx-bank-detail-card`, visible al elegir un banco):**
     - Cabecera con nombre del banco activo, contador `N / 128 presets`, botón primario `#vfx-preset-create-btn` (`+ Nueva escena / preset`) y selector rápido de reordenación (`Subir` / `Bajar`).
     - Tabla `#vfx-presets-table` montada con `mountTable`:
       1. `index`: Programa LCD (`000`..`127`).
       2. `name`: Nombre del preset.
       3. `channels`: **Resumen visual de los 4 canales** mediante 4 píldoras `.vfx-ch-pill` (`Ch1`, `Ch2`, `Ch3`, `Ch4`): muestra nombre corto/plugin en Slot A, indicador `+FX` si Slot B o C tienen efectos de inserción, y etiqueta de zona MIDI si hay split o canal dedicado (ej. `Ch1: VStat [C-2..B2]`, `Ch2: Piano +LOFI [C3..G8]`, `Ch3: —`, `Ch4: —`).
       4. `buses`: Indicador compacto si `Aux 1`, `Aux 2` o `Master` tienen efectos cargados.
       5. `tempoBpm`: Tempo (`120 BPM`).
       6. `rowActions` (`···`): `Editar escena (4 canales)`, `Clonar escena`, `Mover arriba`, `Mover abajo`, `Eliminar escena`.

3. **Cajón / Compositor Visual de Escena Multi-Plugin de 4 Canales (`#vfx-preset-drawer`):**
   - Estructura HTML: `<section id="vfx-preset-drawer" class="card drawer vfx-preset-drawer" role="dialog" aria-modal="true" aria-labelledby="vfx-preset-drawer-title" tabindex="-1" hidden>`. Ancho ampliado en escritorio (`max-width: 1080px; width: 95vw`) para alojar cómodamente el rack de 4 canales.
   - **Bloque 1 — Cabecera global y Visor LCD Hardware:**
     - Campos en fila `.row`: Nombre de escena (`#vfx-preset-name`, máx. 30 chars), Tempo BPM (`#vfx-preset-tempo`, `number` `20..300`), Compás (`#vfx-preset-timesig-num` / `#vfx-preset-timesig-den`, por defecto `4/4`).
     - **Simulador LCD V-Machine (`.vfx-lcd-preview`):** Recuadro compacto con tipografía monoespaciada que previsualiza `BNK 000:000 <PresetName>` en la línea 1 y los `short_name` de 6 caracteres de los 4 canales (`1:VStat 2:4FPN 3:---- 4:----`) en la línea 2.
   - **Bloque 2 — Plantillas Musicales de 1 Clic (`.vfx-layout-presets`):**
     - Botones secundarios rápidos para configurar el enrutado MIDI/mezcla sin cálculos manuales:
       - `Simple (Canal 1)`: Activa Ch 1 en rango completo Omni, silencia Ch 2–4.
       - `Layer Doble (Ch 1 + Ch 2)`: Activa Ch 1 y Ch 2 en rango completo Omni a volumen equilibrado (`185`) para apilar dos sintetizadores.
       - `Split Teclado Bajo / Teclas (C3)`: Configura Ch 1 en notas `0..59` (`C-2..B2`) y Ch 2 en notas `60..127` (`C3..G8`).
       - `Multi 4 Partes (MIDI 1–4)`: Asigna `Ch 1 → MIDI 1`, `Ch 2 → MIDI 2`, `Ch 3 → MIDI 3`, `Ch 4 → MIDI 4`.
   - **Bloque 3 — Visualizador Unificado de Zonas de Teclado MIDI (`.vfx-keyboard-map` / Integración `@abdsynths/shared` MidiKeyboard):**
      - **Evaluación y aprovechamiento del teclado unificado de `@abdsynths/shared` (`Code/MidiKeyboard` / `@abdsynths/midi-keyb` como en `ABDNeuModMakr`):**
        - En `ABDNeuModMakr` se emplea `KeyboardStrip.ts` envolviendo `createKeyboard` de `@abdsynths/midi-keyb` (`numOctaves: 5`, `startNote: baseOctave * 12`, resaltado dinámico de teclas por zona/rango).
        - En `ABDfxbloader` el teclado de `@abdsynths/shared` encaja perfectamente para:
          1. **Visualización de zonas por canal (Split & Layer):** colorear e iluminar las teclas del piano según el canal activo (`Ch 1` a `Ch 4` con código cromático identificativo), indicando puntos de división (*split points*) y solapamientos.
          2. **Tira compacta / Ribbon:** para mantener la compacidad del cajón cuando el músico solo necesita ver el rango, disponer de una vista resumida de 128 notas y opción de expandir el teclado interactivo completo (`enableCollapse: true`).
          3. **Audición interactiva:** permitir pulsar notas (ratón o teclado QWERTY) con eventos `onNoteOn`/`onNoteOff` para comprobación sonora o monitoreo visual en directo.
   - **Bloque 4 — Rack de los 4 Canales (`#vfx-channels-grid`, `.vfx-channels-grid`):**
     - Grid responsivo de 4 tarjetas (`.vfx-channel-card`, 4 columnas en pantallas anchas `>= 1100px`, 2×2 en medianas, 1 columna en móvil), correspondientes a `Canal 1`..`Canal 4` (`channel: 0..3`):
       - **Encabezado del canal:** Etiqueta `Canal N`, conmutadores compactos `Mute` y `Solo` (`button[aria-pressed]`) y botón `Limpiar canal`.
       - **Slot A (Instrumento Principal / Fuente):**
         - `<select>` con los plugins instalados en `<libraryRoot>/plugs/`, agrupados en `<optgroup>` *Instrumentos / Sintetizadores* (`is_synth: 1`) y *Efectos* (`is_synth: 0`), más `— Vacío —`. Si el preset cargado referencia un `pluginId` que no está en `plugs/`, mostrar opción de advertencia `ID <id> (No instalado en librería)` sin perderlo salvo que el usuario lo cambie.
         - Input `short_name` (`maxlength="6"`, etiqueta «Texto LCD (6 máx.)», rellenado automáticamente al elegir plugin).
         - Selector de **Sonido / Programa (`.fxb`)**: desplegable con `(Mantener actual)` / `(Por defecto / fxbLoader)` + los bancos `.fxb` del plugin elegido y selector de programa (`001..128`) cuando el `.fxb` es de programas `FxBk`.
       - **Slots B y C (Efectos de Inserción en Serie del Canal):**
         - Presentados de forma limpia (visibles directamente si tienen plugin asignado, o desplegables mediante botón `+ Añadir efecto de inserción (Slot B / C)` cuando están vacíos para no abrumar visualmente). Mismo selector de plugins (priorizando `<optgroup>` de *Efectos*), `short_name` y programa inicial.
       - **Controles MIDI del Canal:**
         - `Canal MIDI`: `<select>` (`Omni (Todos)` = `0`, `Canal 1`..`Canal 16`).
         - `Nota mín.` y `Nota máx.`: inputs/selectores `0..127` mostrando nombre musical junto al número (`60 · C3`), sincronizados con `.vfx-keyboard-map`.
         - `Transposición`: `-48` a `+48` semitonos (con botones rápidos `-12` / `0` / `+12`).
       - **Mezcla del Canal:**
         - `Volumen` (`input[type="range"]` `0..255`, valor numérico legible en `%`; al asignar el primer plugin a un canal vacío sube automáticamente de `0` a `206` y al vaciar los 3 slots baja a `0`).
         - `Panorama` (`input[type="range"]` `0..255`, `128` = `C`, etiqueta `L..C..R`).
         - Envíos `Aux 1` y `Aux 2` (`0..255` + check compacto `Pre` dentro de opciones de envío).
   - **Bloque 5 — Buses Globales Colapsables (`<details id="vfx-global-buses">`: `Aux 1`, `Aux 2` y `Master`):**
     - Tres tarjetas horizontales compactas para `Aux 1` (`aux: 0`), `Aux 2` (`aux: 1`) y `Master` (`master:`), cada una con sus 3 slots de efecto (`Slot A`, `Slot B`, `Slot C`) y control de nivel de retorno / nivel maestro (`volume: 206` por defecto en Master).
     - Nota informativa si algún slot conserva asignaciones avanzadas de hardware (`N mapeos MIDI CC y M parámetros prioritarios conservados`).
   - **Pie del cajón:** Estado `#vfx-preset-status` (`role="status" aria-live="polite"`), botón primario `#vfx-preset-save-btn` (`Guardar escena`) y `#vfx-preset-cancel-btn` (`Cancelar`).

4. **Ampliación de la Vista «Unidad» (`#vmachine-view`) y Atajos desde Plugins:**
   - En `#vmachine-view`:
     - Mostrar tanto los **Plugins (`plugs/`)** como los **Bancos Nativos (`banks/`)** tanto en el inventario de lo que ya tiene el pendrive como en la sección «Comparado con la librería».
     - Usar pestañas accesibles o dos bloques claros con `mountTable` (`#vmachine-inventory` + `#vmachine-banks-inventory`, y `#vmachine-sync` + `#vmachine-banks-sync`).
     - En `#vmachine-banks-sync`, mostrar en cada fila: Banco, Escenas/Presets, Plugins requeridos (marcando con badge ámbar si alguno de los plugins de sus 4 canales aún no está en el pendrive), Estado (`Falta en la unidad` / `Distinto` / `Al día`) y Tamaño.
     - Checkbox `#vmachine-include-bank-deps` (marcado por defecto): *«Incluir automáticamente los plugins que necesiten los bancos copiados si faltan en la unidad»*.
     - El botón primario `#vmachine-copy` sincroniza en una sola operación verificada los plugins y bancos pendientes/seleccionados.
   - En el cajón `#banks` de un plugin individual y en `#dialog-wizard-install` / `#custom-plugin-drawer`:
     - Botón `#banks-generate-vfxbank-btn` en `#banks`: *«Crear banco nativo V-Machine desde este plugin / .fxb»* (abre miniformulario o ejecuta `generate-from-plugin` y ofrece ir al banco creado).
     - Checkbox `#wizard-install-create-bank` y `#custom-plugin-create-bank`: *«Crear banco V-Machine inicial para que aparezca directamente en la pantalla de la unidad»*.

---

##### 4. Subbloque VI.B.4 — Reglas Estrictas de Integración: Estilos CSS, HTML/ARIA e Internacionalización (i18n)

> **CRÍTICO PARA EL MODELO IMPLEMENTADOR:** El repositorio cuenta con auditorías estáticas automatizadas muy estrictas que hacen fallar `npm test` ante el menor descuido de CSS, DOM o traducciones. Deben cumplirse **todas** estas reglas:

1. **Estilos Generales y Sistema de Diseño ([`webapp/public/styles.css`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/public/styles.css) + [`webapp/test/ui.styles.test.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/test/ui.styles.test.ts)):**
   - **Prohibido usar colores literales (`#hex`, `rgb(...)`) fuera de `:root`:** Utilizar **exclusivamente** las variables CSS semánticas del sistema (`var(--bg)`, `var(--surface)`, `var(--border)`, `var(--text)`, `var(--muted)`, `var(--accent)`, `var(--accent-text)`, `var(--ok-bg)`, `var(--ok-text)`, `var(--off-bg)`, `var(--off-text)`, `var(--danger)`, `var(--danger-bg)`, `var(--warn-bg)`, `var(--warn-border)`, `var(--warn-text)`, `var(--shadow)`). Esto garantiza soporte automático en tema **Claro, Oscuro y Automático**.
   - **Altura unificada de controles (`auditControlHeight`):** Todo `<input>` textual/numérico, `<select>` y `<button>` estándar en filas `.row` debe respetar `var(--control-height)` (`42px`). Para botones diminutos dentro de cabeceras de canal (ej. `Mute`/`Solo` o píldoras), usar clases específicas con sus propias reglas bien acotadas sin alterar `button` global.
   - **Scroll de tablas paginadas dentro de cajones (`auditPaginatedTableScroll`):** Si se monta una tabla `mountTable` dentro de un `.drawer`, añadir siempre el override explícito en `styles.css` **después** de `.drawer .table-wrap`:
     ```css
     .mi-contenedor-tabla .table-wrap {
       max-height: none;
       overflow-y: visible;
     }
     ```
   - **Cero selectores CSS muertos (`auditCss`):** `ui.styles.test.ts` parsea cada selector de `styles.css` y verifica que coincida con la jerarquía real de `public/index.html` o con clases creadas dinámicamente en `src/ui/**/*.ts`. **No escribir ni una sola regla CSS «por si acaso»** que no tenga su elemento real en HTML o TS, y evitar combinadores hermanos (`+`, `~`) innecesarios.
   - **Reutilizar componentes visuales existentes:** `.card`, `.drawer`, `.summary`, `.row`, `.field`, `.note`, `.status`, `.badge` (`.badge.on`, `.badge.off`, `.badge.warn`, `.badge.danger`), `.icon` con `<svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-..."></use></svg>`. Si hace falta un icono nuevo (p. ej. `#icon-sliders` para el mezclador de 4 canales), declararlo como `<symbol viewBox="0 0 24 24">` dentro del `<svg class="icon-sprite">` al inicio de `public/index.html` usando solo trazo `currentColor` sin `fill`.

2. **Marcado HTML, Accesibilidad ARIA y Ciclo de Cajones ([`webapp/public/index.html`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/public/index.html) + [`webapp/test/ui.markup.test.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/test/ui.markup.test.ts)):**
   - **Cero marcado huérfano (`auditMarkup`):** Todo `id="..."`, `class="..."`, `data-*="..."` y atributo de estado `aria-*` (`aria-expanded`, `aria-pressed`, `aria-selected`, `aria-checked`) declarado en `public/index.html` **debe** ser leído/usado en `styles.css`, en `src/ui/**/*.ts` (mediante `byId`, `query`, `classList`, `dataset`, `getAttribute`/`setAttribute`) o por otro atributo HTML (`for`, `aria-labelledby`, `aria-describedby`, `aria-controls`).
   - **Regla de oro de `data-i18n` con elementos hijos:** `applyI18n()` asigna `el.textContent = t(key)`. **NUNCA** colocar `data-i18n` en un elemento (`<button>`, `<label>`, `<h2>`, `<h3>`, `<summary>`) que contenga `<input>`, `<svg>` o `<span id="...">` hijos; envolver siempre el texto literal dentro de un `<span data-i18n="...">Texto en inglés</span>` dedicado.
   - **Gestión de Drawers y Modales:** Registrar `#vfx-preset-drawer` (y cualquier diálogo auxiliar `<dialog>`) en `elements.ts`, incluir su cierre en `closeAllDrawers()`, soportar cierre con tecla `Escape` y clic en `#drawer-backdrop`, gestionar `aria-modal="true"` y devolver el foco al elemento disparador al cerrar.
   - **Modularidad en TypeScript del navegador (`webapp/src/ui/browser/`):** Para mantener limpio `main.ts`, implementar la vista de bancos y el compositor de 4 canales en módulos dedicados (`webapp/src/ui/browser/vfx-banks-view.ts` y `webapp/src/ui/browser/vfx-preset-drawer.ts`) e importarlos con extensión `.js` (`import { ... } from './vfx-banks-view.js'`), cumpliendo `tsconfig.ui.json` (cero dependencias runtime de terceros).

3. **Internacionalización Completa ES / EN ([`webapp/test/i18n-keys.test.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/test/i18n-keys.test.ts)):**
   - **Paridad estricta 100%:** Toda clave pasada a `t('...')` debe ser un **literal de cadena estático** (nunca interpolar `t(\`vfx.\${kind}\`)` porque el escáner estático no la vería o usar un mapa explícito de literales `{ channel: t('vfxPreset.stripChannel'), aux: t('vfxPreset.stripAux'), master: t('vfxPreset.stripMaster') }`).
   - Toda clave añadida debe existir con valor no vacío en **ambos** diccionarios:
     - [`webapp/src/ui/i18n/locales/es.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/ui/i18n/locales/es.ts)
     - [`webapp/src/ui/i18n/locales/en.ts`](file:///d:/desarrollos/ABDSynths/ABDfxbloader/webapp/src/ui/i18n/locales/en.ts)
   - **Idioma base del HTML estático:** En `public/index.html`, los textos iniciales de fallback, `title`, `placeholder` y `aria-label` se escriben en **inglés** junto con sus atributos `data-i18n`, `data-i18n-title`, `data-i18n-placeholder` y `data-i18n-label`.
   - **Estructura de namespaces recomendada en `es.ts` y `en.ts`:**
     - `nav.vfxBanks`, `nav.vfxBanksTitle`
     - `vfxBanks.*` (`title`, `note`, `createBank`, `bankName`, `presetCount`, `healthValid`, `healthRepairable`, `healthBroken`, `emptyBanks`, `emptyPresets`, `generateFromPlugin`, `missingPluginWarn`, `confirmDeleteBank`, etc.)
     - `vfxPreset.*` (`drawerTitle`, `sceneName`, `tempo`, `timeSignature`, `lcdPreview`, `layoutSingle`, `layoutLayer`, `layoutSplit`, `layoutMulti4`, `channelTitle`, `slotInstrument`, `slotInsertB`, `slotInsertC`, `addInsertFx`, `emptySlot`, `shortName`, `soundSource`, `soundKeep`, `soundDefault`, `midiChannel`, `midiOmni`, `noteMin`, `noteMax`, `transpose`, `volume`, `pan`, `sendAux1`, `sendAux2`, `globalBuses`, `aux1`, `aux2`, `master`, `preservedMidiMaps`, `saveScene`, `savedOk`, etc.)
     - `vmachine.*` (`tabPlugins`, `tabBanks`, `banksInventoryEmpty`, `banksSyncEmpty`, `includeBankDeps`, `missingPluginsBadge`, etc.)
     - `msg.apiError.*` (todos los nuevos códigos añadidos en `API_ERROR_CODES`).

---

##### 5. Subbloque VI.B.5 — Plan de Pruebas y Criterios de Aceptación Verificables

- [ ] **1. Tests unitarios binarios y de formato (`webapp/test/vfx-chunk.test.ts`, `webapp/test/vfx-preset.test.ts` y ampliación de `vfx-bank-validator.test.ts`):**
  - Verificar que `vfxCrc16Update` + `vfxCrc16Finalize` sobre archivos `.chunk` reales de `_banks/` reproduce exactamente los `uint16le` almacenados en `0x10` y `0x12` (p. ej. `0x460e` y `0xfc2d` en `channel_1_slot_b_1280263753.chunk`).
  - Verificar creación desde cero de `.chunk` de 100 bytes desde programas `FxBk` y chunks `FBCh`, reparación de `pluginId` recalculando CRC-16, y ausencia legítima de `.chunk` en plugins con `parameter_count: 0`.
  - Verificar round-trip sin pérdidas (`parsePresetVfx` → `serializePresetVfx`) de escenas reales con **4 canales**, splits MIDI (`0..59` / `60..127`), efectos insertados en `Slot B`/`Slot C`, envíos `Aux 1/2`, `Master`, `midi_map` y `priority_parameter`, comprobando `CRLF` y longitud `< 80` chars por línea.
- [ ] **2. Tests de servicio, controlador, OpenAPI y sincronización USB (`webapp/test/vfx-banks.service.test.ts`, `vmachine.service.test.ts`, `openapi.test.ts`, `openapi.examples.test.ts`):**
  - Ciclo completo CRUD sobre directorios temporales: crear banco `.vfxbank`, guardar escena con 4 canales poblando `.chunk` desde `.fxb` reales, clonar, reordenar, reparar e inspeccionar.
  - Verificar en `VMachineService` el inventario de `banks/` en unidad simulada, detección de `missing` / `differs` / `same`, detección de dependencias de plugins faltantes en el stick y copia atómica verificada con `includeRequiredPlugins: true`.
  - Pasar al 100% `openapi.test.ts`, `openapi.examples.test.ts` y `error-bodies.test.ts`.
- [ ] **3. Auditorías estáticas obligatorias de UI, CSS, HTML e i18n:**
  - `ui.styles.test.ts`: 0 reglas CSS muertas, altura de controles uniforme y sin doble scroll en cajones.
  - `ui.markup.test.ts` y `ui.dom.test.ts`: 0 IDs, clases, `data-*` o `aria-*` huérfanos o inexistentes.
  - `i18n-keys.test.ts`: 100% de claves literales resueltas en `es` y `en`.
- [ ] **4. Test E2E en navegador real con Playwright (`webapp/test/browser.test.ts` o suite dedicada):**
  - Crear un banco V-Machine desde la vista `Bancos V-Machine`, abrir el compositor de escena, configurar **2+ canales simultáneos** (p. ej. Split o Layer con sintetizador en Slot A + efecto en Slot B), guardar, comprobar en el disco real del servidor que `preset.vfx` y `channel_1_slot_a_<id>.chunk` / `channel_2_slot_a_<id>.chunk` existen con cabecera de 100 bytes y CRC-16 válido, y sincronizar el banco hacia una carpeta de unidad V-Machine simulada desde la vista `Unidad`.
  - Ejecutar `npm --prefix webapp run build` y `npm --prefix webapp test` con **0 fallos**.


### 3. Fase VI.C: Usabilidad y Lenguaje para el Músico No Técnico
- [ ] **Traducción de jerga técnica a lenguaje musical comprensible:**
  - "PE32 / Entrypoint VST" → "Compatible con V-Machine (32 bits)" con badge visual verde/rojo.
  - "Orden de bytes little-endian / big-endian" → "Formato de banco: Estándar V-Machine / Formato Windows".
  - "Poner cargador" → "Activar carga automática de sonidos (fxbLoader)" con explicación clara de beneficio.
  - Agrupar parámetros crudos (FourCC, tamaño de editor en px, chunks hexadecimales) dentro de un acordeón `<details>` de "Opciones técnicas / avanzadas", presentando valores por defecto inteligentes.
- [ ] **Simplificación del flujo de importación de bancos `.fxb`:**
  - Priorizar el botón visual de selección de archivos y zona de arrastrar y soltar (drag & drop), dejando el `<textarea>` de rutas manuales como opción secundaria o colapsada.
- [ ] **Separación de vistas avanzadas:**
  - Mover la pestaña `Auditoría` (logs `.jsonl`) y el alta sin wizard compleja a un modo o acceso secundario para no abrumar al músico en la barra principal.
  - Añadir tooltips explicativos y un mini tour o guía rápida integrada ("Cómo preparar tu pendrive para la V-Machine en 3 pasos").

### 4. Fase VI.D: Rendimiento Binario, Optimización y Ciclo de Memoria (Snapshots / FXB)
- [ ] **Análisis del flujo de gestión de archivos `.fxb` y conversión de byte order:**
  - ¿Cómo optimizar el rendimiento de la lectura/escritura en JavaScript/TypeScript? (Uso de `Buffer` / `DataView` preasignados, reducción de copias intermedias de memoria al transformar cabeceras FxBk/FBCh y streaming directo para chunks grandes).
- [ ] **Auditoría de fugas de memoria en manejo de snapshots del sistema:**
  - Análisis de retención de referencias en caché durante la captura del Registro de Windows y diffs del sistema de ficheros (`CaptureService`).
  - Asegurar liberación explícita de descriptores de archivos, streams y buffers pesados tras emitir las respuestas o cancelar tareas.

---

## Revisión

Antes de cada tarea, la pregunta de cierre es la misma: ¿esto es verificable por archivos reales y por la API, o solo por unittest? Si solo por unittest, el plano pide más anclaje.

La decisión de ejecución se mantiene: **nativa, inline**, porque las tareas son modulares, los límites de dominio ya existen (`library`, `fxb-config`, `plugin-meta`, `wizard` y futuros `library-import` y `fxb-builder`) y las decisiones quedan registradas en este documento.

