# fxbLoader web — configuración y librería VFX

Módulo NestJS que reproduce el comportamiento de `fxbLoaderConfig.exe` y de
`fxbLoader.dll` sobre una librería VFX (`<libraryRoot>\plugs\<plugin>\`):

- lectura y escritura de `fxbLoader.config` según
  [la especificación](../fxbLoaderConfig.spec.md), con escritura atómica y
  control optimista de cambios externos;
- escaneo de la librería, instalación y desinstalación del cargador en un
  plugin, guardando el respaldo `vfxinfo.tx_` y creando `presets\`;
- validación de que el `fxbLoader.dll` y el binario original del plugin son
  **PE32 i386**, con los plugins incompatibles marcados antes de instalar.

## Instalación y pruebas

```bash
cd webapp
npm install
npm test        # compila UI + tests y ejecuta node:test (unitarios + HTTP)
npm run test:coverage  # igual, con cobertura y coverage/html/index.html
npm run test:perf   # solo rendimiento (parser e importación), un archivo a la vez
npm run test:e2e    # navegador real (Playwright) contra dist/main.js
npm run build   # servidor (dist/) + UI (public/js/)
npm run build:ui  # solo la UI: tsc -p tsconfig.ui.json
npm start       # http://127.0.0.1:3210 (PORT para cambiarlo)
npm run openapi # regenera openapi.json desde los decoradores
npm run client  # openapi + tipos del cliente (src/client/api-types.ts)
```

El servidor escucha solo en loopback: escribe en el disco del usuario.

### Arranque en Windows

[`start.bat`](../start.bat), en la raíz del repositorio, hace todo de una vez:
cierra lo que esté ocupando el puerto, instala dependencias y compila si el
build falta o es más viejo que el fuente, arranca el servidor y abre la UI en
el navegador.

La comparación de fechas es lo que evita servir una versión vieja: `tsc`
estampa la fecha de emisión en `dist/` y `public/js/`, así que si el archivo
más reciente de `src/`, `tsconfig*.json` o `package*.json` es posterior al
punto de entrada más antiguo (o falta alguno), vuelve a ejecutar
`npm run build`. Esa decisión vive en
[`scripts/build-decision.mjs`](scripts/build-decision.mjs) —Node puro, sale 0
si el build está al día y 1 con el motivo en una línea— en vez de en PowerShell
dentro del `.bat`: así se prueba en cualquier sistema con
[test/build-decision.test.ts](test/build-decision.test.ts), y el job **start.bat ·
Windows** de la CI recorre además el `.bat` entero. Si el script falla o no está,
el arranque recompila igual (nunca sirve un build viejo).

Las fechas no bastan: `tsc` no borra lo que ya emitió, así que un `.js` (o su
`.js.map`) cuyo `.ts` se borró o renombró sigue en el build con fecha antigua y
se sirve como si existiera. Por eso la decisión recorre también `dist/` y
`public/js/` buscando **huérfanos** —todo `x.js`/`x.js.map` sin `x.ts`, `x.tsx`,
`x.mts` o `x.cts` en `src/`— y recompila aunque el build esté al día, nombrando
en la primera línea cuáles sobran (hasta cinco, el resto se resume con «y N
más»). Un archivo que no emite `tsc` (notas, fixtures) no cuenta.

Antes de recompilar **borra `dist/` y `public/js/`**: así salen también los
huérfanos de la compilación anterior. La limpieza va solo en la rama que
recompila (con el build al día y sin huérfanos no se toca nada) y, si no puede
borrar esas carpetas porque algún archivo está en uso, se detiene con un aviso
en vez de compilar encima y dejar las salidas huérfanas sin que se note.

```bat
start.bat            :: puerto 3210
start.bat 8080       :: otro puerto
set FXB_NO_BROWSER=1 && start.bat   :: sin abrir el navegador
set FXB_SKIP_SERVER=1 && start.bat  :: compila y sale (job de CI de Windows)
```

Para liberar el puerto usa `Get-NetTCPConnection` y, como respaldo, `netstat`:
en algunas máquinas (VPN, antivirus) `netstat` no lista el socket aunque el
puerto esté ocupado, así que se acepta cualquier estado de la conexión y se
cierra por PID (mostrando el nombre del proceso). Después espera a que el
puerto acepte conexiones antes de arrancar, para no chocar con `EADDRINUSE`.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) compila y ejecuta la
suite en cada `push` a `main`/`master`, en cada pull request y a mano
(`workflow_dispatch`). Matriz: **Ubuntu y Windows** × **Node 22 y 24**, con
`fail-fast: false` para ver los cuatro resultados aunque uno falle.

Pasos, con `working-directory: webapp`: `npm ci` (caché de npm a partir de
`package-lock.json`), `npm run build`, `npm test`. Antes de nada comprueba que
existe `vst/fxbLoader.dll`: sin ella el test de integración se omitiría en
silencio y el job falla con un `::error` que apunta al test.

El workflow asume que la raíz del repositorio contiene `webapp/` y `vst/`, y
que la DLL (174 080 bytes) está incluida en el repo. No hay pasos específicos de
plataforma: las dependencias son JS puro y los tests usan `os.tmpdir()`, así que
el mismo comando vale en ambos sistemas.

El job **start.bat · Windows** (`windows-latest`, Node 24) compila una vez y
lanza el `.bat` con `FXB_NO_BROWSER=1` y `FXB_SKIP_SERVER=1` (compila y sale,
sin arrancar el servidor) en tres situaciones: con el build al día no debe
limpiar ni compilar; con huérfanos en `dist/` y `public/js/` y **ninguna fecha
tocada** debe citarlos como motivo, limpiar, compilar y dejar el build completo;
y con el build limpio y un `tsconfig.json` reciente debe citar esa fecha. Los
huérfanos van en su propio paso porque su motivo se adelanta al de las fechas:
mezclados, el job comprobaría el texto equivocado. Si `start.bat` no está en el
checkout, el job falla con `::error` en vez de dar verde sin haber probado nada.

El job **Navegador · Chromium** (`ubuntu-latest`, Node 24) instala Chromium
(`npx playwright install --with-deps chromium`), compila y ejecuta
`npm run test:e2e`; si falla, publica la captura de la página en el artefacto
**`e2e-chromium`** (7 días). Va fuera de la matriz para no descargar el
navegador en cada combinación de sistema y versión.

El job **Cobertura HTML** (`ubuntu-latest`, Node 24) ejecuta
`npm run test:coverage` con **umbrales mínimos** y publica el resultado como
artefacto **`coverage-html`** (14 días de retención, también cuando fallan los
umbrales). Se descarga desde la página de la ejecución en
**Actions → Artifacts**, o con `gh run download <run-id> -n coverage-html`; el
punto de entrada es `index.html`.

## Cobertura

```bash
cd webapp
npm run test:coverage   # compila, ejecuta node:test y escribe coverage/
# abre coverage/html/index.html directamente en el navegador
```

La cobertura la produce el propio test runner de Node
(`node --test --experimental-test-coverage`), sin c8, nyc ni istanbul:

1. [scripts/coverage.mjs](scripts/coverage.mjs) limpia `coverage/`, ejecuta la
   suite con los reporteros `spec` y `lcov`, y deja el dato en
   `coverage/lcov.info`;
2. [scripts/lcov-html.mjs](scripts/lcov-html.mjs) convierte ese `lcov.info` en
   `coverage/html` (`index.html` con el resumen por archivo y una página por
   archivo con el código y los éxitos de cada línea), sin dependencias nuevas;
3. si la suite falla se conserva su código de salida, y si no se generó el
   lcov o quedó vacío el comando falla en vez de publicar un informe vacío;
4. si se pasan umbrales y algún porcentaje queda por debajo, termina con
   código 1 aunque los tests hayan pasado.

Los umbrales se declaran en el propio comando (porcentajes de 0 a 100):

```bash
npm run test:coverage -- --min-lines 94 --min-functions 80 --min-branches 78
```

La CI usa esos tres valores, justo por debajo del dato actual (líneas 94.50 %,
funciones 81.21 %, ramas 82.52 %), así que una regresión que tire la cobertura
rompe el job con una anotación `::error::` y el resumen de qué métrica falló.
Una métrica sin datos también falla: no se puede dar por cumplido un umbral que
no se midió. Un flag desconocido o un porcentaje fuera de rango salen con código
2, para no confundir un error de uso con cobertura insuficiente.

Los tests quedan fuera del denominador (`--test-coverage-exclude=dist-test/test/**`).
El informe cubre el JavaScript que realmente se ejecuta, es decir el compilado
en `dist-test/src/**` (el runner de Node no remapea los source maps a `.ts`), y
las rutas son relativas a `webapp/`. Los porcentajes del job y del informe
coinciden con la tabla que imprime `npm run test:coverage`.

## UI web

Abre <http://127.0.0.1:3210/> con el servidor arrancado. La página permite:

1. elegir la carpeta de la librería (la que contiene `plugs\`) con **Elegir
   carpeta…**, que abre el diálogo del sistema, o escribirla a mano, y pulsar
   **Escanear** (el diálogo ya escanea al elegir);
2. ver cada plugin con su estado, compatibilidad con el cargador de 32 bits,
   `pluginName` y si tiene `vfxinfo.txt`; el escaneo valida que el
   `fxbLoader.dll` sea un **PE32 i386** y lee la arquitectura del binario
   original. Los plugins incompatibles (por ejemplo, PE32+ AMD64, o con un
   `dll_name` que apunta a un archivo que no existe) se marcan y el botón
   **Instalar** queda deshabilitado con el motivo;
3. **Instalar** o **Desinstalar** con un clic, con el resultado en la misma
   tabla y los errores de la API tal cual (409, 422, etc.);
4. **Instalar todos** / **Desinstalar todos** manda el lote al servidor con
   `POST /library/batch/stream`: los procesa **en serie y en el orden recibido**
   y devuelve el resultado de cada plugin (`status`, `message` y `actions`), de
   modo que un fallo no detiene al resto. Si hay más plugins que el tope por
   petición, el lote se trocea y se manda en peticiones consecutivas, con el
   **progreso de todas acumulado en la misma barra**: «Instalando 501 de 501»
   sigue contando aunque cambie la petición. Mientras dura, la vista pinta el
   **progreso en caliente** —una barra, «Instalando 2 de 5: Bass…», una línea
   con el paso interno en curso («paso 2 de 5 · copiando fxbLoader.dll»), la
   fila del plugin resaltada y un **reloj** («12,4 s transcurridos · ~18 s
   restantes · 0,3 s en el paso actual»)— porque el servidor escribe un evento
   NDJSON por cada plugin, cada paso y cada cierre. El reloj se mide en la
   vista, así que incluye la red y el salto entre trozos, cronometra cada paso
   por separado y estima lo que falta con la media de los plugins ya resueltos
   (mientras no haya ninguno, dice que está calculando en vez de inventarse un
   número). Al terminar muestra el resumen
   (`N de M`, cuántos fallaron) y un desplegable con el error de cada plugin
   fallido, cada uno con su botón **Reintentar** (que usa los endpoints
   individuales y no repite el lote entero). **Reintentar fallidos (N)**, en la
   fila de acciones del lote, reintenta **todos** los pendientes en orden, cada
   uno con su acción y sin detenerse en el primero que vuelva a fallar. Mientras
   dura reutiliza la misma barra, la misma línea de paso y el mismo reloj del
   lote: «paso 2 de 3 · reintentando Rhodes», con el tiempo de cada reintento y
   la estimación de los que quedan. Al terminar refresca el escaneo una sola vez
   y deja en la lista solo los que sigan fallando. **Cancelar** aparece solo
   mientras corre el lote y aborta la petición en curso con `AbortController`:
   el servidor termina el plugin que tenía entre manos y no empieza otro, y el
   resumen separa lo confirmado (`N de M`) de los plugins que quedaron sin
   confirmar. Entonces aparece **Reanudar N sin confirmar**, que vuelve a
   mandar el lote con **solo** esos plugins, en el mismo orden y con la misma
   acción, sin repetir los que ya respondieron; la lista se contrasta con el
   escaneo posterior, así que el plugin que el servidor terminó después de
   cancelar no se toca otra vez (reinstalarlo daría un 409) y el botón
   desaparece si ya no queda nada por hacer. Los fallos del intento anterior
   siguen en su desplegable con su **Reintentar** individual y con
   **Reintentar fallidos (N)** para probarlos todos de nuevo;
5. **Bancos** abre la vista del plugin: sus `.fxb` con tipo, programas,
   `uniqueID` y `fxVersion`; un formulario para importar rutas absolutas de
   `.fxb` (una por línea, admite las comillas de «copiar como ruta»), con un
   botón **Añadir archivos…** que abre el diálogo del sistema y **suma** los
   `.fxb` elegidos al cuadro de texto sin borrar lo escrito ni repetir rutas, con el
   resultado por archivo —el servidor responde NDJSON (`POST
   /library/banks/import/stream`), así que la barra avanza en cuanto se resuelve
   cada banco, también dentro del trozo, y no al cerrarlo; por encima de 50
   rutas la vista las manda en peticiones de 50 y va acumulando el resultado de
   cada archivo en la misma lista, con una barra de progreso que cuenta los
   archivos resueltos sobre el total del cuadro de texto y el avance
   «Importando 50 de 120 archivo(s)…»—; **Exportar un banco en otro orden de bytes**, que
   convierte un banco importado a `little`/`big` y lo guarda al lado como
   `banco-le.fxb`/`banco-be.fxb` sin tocar el original (para los bancos legacy
   que guardó un plugin de Windows); **Convertir orden de bytes**, junto al
   selector de **banco por defecto**, que reescribe ese mismo `.fxb` en su sitio
   con el orden contrario y deja el original como `banco.fxb.orig` (pide
   confirmación, porque sustituye el archivo que carga la DLL); **Restaurar
   original**, que devuelve ese banco al contenido de su `.orig` sin pisar el
   respaldo —el botón solo se habilita si la lista anuncia que existe, y también
   pide confirmación, porque reemplaza el banco que carga la DLL—; **Descartar
   respaldo**, que envía ese `.orig` a la Papelera de reciclaje sin tocar el
   banco (pide confirmación y al terminar dice dónde recuperarlo; también se
   deshabilita si no hay respaldo); y el selector de banco por defecto, que guarda `defaultFxbName` y
   «cargar al abrir el plugin» en `fxbLoader.config`. Si la DLL reescribe el
   archivo entre medias, el 409 refresca el snapshot y pide volver a guardar en
   vez de pisar los cambios.

La carpeta y la ruta opcional del DLL se guardan en `localStorage`. Además se
recuerdan las **últimas ocho rutas usadas** de cada tipo —carpetas de librería,
DLL y bancos— en `fxbLoader.recentLibraryRoots`, `fxbLoader.recentDlls` y
`fxbLoader.recentBanks`: lo más reciente primero, sin duplicados aunque cambien
mayúsculas o la barra final. Los dos campos de texto ofrecen ese historial con
un `<datalist>` nativo, y en **Importar bancos .fxb** las rutas recientes
aparecen como botones que suman el banco al cuadro de texto sin borrar lo
escrito. Cada chip lleva además una **×** que olvida solo ese banco, y al final
de la fila **Olvidar** vacía todos los bancos recientes —deja intactos el
historial de carpetas y DLL y la lista escrita— y desaparece con ellos. Al cargar la vista se comprueba con `POST /system/paths` que esas
rutas sigan existiendo: las que ya no están en el disco —o que ahora son del
otro tipo, una carpeta donde se esperaba un `.fxb`— se descartan del historial
y de `localStorage`, así que ni las sugerencias ni los botones ofrecen rutas
muertas. En **Opciones avanzadas**, **Vaciar historial de rutas** olvida las tres
listas y borra sus claves de `localStorage` —pide confirmación, no toca lo
escrito en los campos y queda deshabilitado cuando no hay historial—. También se
puede indicar otro `fxbLoader.dll` con **Elegir DLL…** (rellena la ruta y vuelve
a escanear para validarla) o escribiéndola; vacío usa el que resuelve el
servidor. No hay autenticación: la UI y la API solo escuchan en `127.0.0.1`.

Los tres botones llaman a `POST /system/pick`, que abre el diálogo **en el
servidor** (PowerShell + `System.Windows.Forms`): el navegador no puede devolver
rutas absolutas, así que el diálogo nativo es la forma de elegir sin pegar
rutas. La petición queda abierta hasta que la persona acepta o cancela; cancelar
devuelve `paths: []` y la vista no cambia nada. Solo hay un diálogo a la vez
(**409** si se pide otro) y fuera de Windows responde **501**. Los botones se
deshabilitan mientras hay una petición en curso y al abrir el de los bancos se
propone la carpeta del último `.fxb` de la lista.

Los estáticos viven en [public/](public/index.html) y se sirven con
`app.useStaticAssets` desde [app.setup.ts](src/app.setup.ts). `GET /` devuelve
`index.html`, y las rutas `/library/*` y `/fxb-config` siguen teniendo prioridad
sobre los estáticos.

La UI está escrita en TypeScript y usa el cliente tipado de
[src/client](src/client/index.ts). `index.html` carga un único módulo ESM,
`/js/ui/browser/main.js`; el resto del grafo (`/js/ui/batch.js`,
`/js/ui/bank-import.js`, `/js/client/fxb-client.js`) llega por `import` nativo. El build es un solo
`tsc -p tsconfig.ui.json` (`npm run build:ui`) que emite a `public/js/`, sin
bundler ni dependencias nuevas; `npm run build` y `npm test` lo ejecutan antes
de servir o probar la página.

La vista ([src/ui/browser/main.ts](src/ui/browser/main.ts)) solo maneja el DOM:
las peticiones van por `createFxbClient({ baseUrl: '' })`, así que los tipos de
entrada y salida salen de `openapi.json` y un DTO cambiado rompe la compilación.
La orquestación del lote vive en el servidor
([library.service.ts](src/library/library.service.ts), método `runBatch`), que
emite cada evento según avanza (`start`, `plugin` con `running` y el estado
final, `step` por paso interno, `end`); la vista solo llama a
`client.library.batchStream` y traduce ese flujo con
[applyBatchEvent/progressLabel/stepLabel/retryProgress/failuresOf/summarize de src/ui/batch.ts](src/ui/batch.ts),
que no toca el DOM ni conoce `fetch` y se prueba con datos simples en
[test/batch.test.ts](test/batch.test.ts). Cuando la lista pasa del tope por
petición, `runBatchInChunks` la parte con `splitBatch` y suma el progreso de
cada petición en un solo estado con `mergeProgress`: la barra y la cuenta son
las del lote completo, no las de la petición en curso. Si una petición se corta
(400, error de red o `end` ausente) el recorrido se detiene ahí, lo confirmado se
conserva y el resumen dice cuántos plugins quedaron sin confirmar. El endpoint se
prueba de punta a punta
en [test/library.batch.test.ts](test/library.batch.test.ts) (orden, fallos que
no cancelan el lote, `dryRun`, `force` y validaciones) y el progreso en
[test/library.batch.stream.test.ts](test/library.batch.stream.test.ts), que
consulta el disco desde el propio callback para comprobar que el aviso de
«en curso» sale antes de que el plugin esté escrito, y valida el NDJSON por HTTP
(incluido que un 400/422 siga siendo JSON y no un flujo a medias).

`index.html` y `styles.css` se comprueban sin abrir el navegador:
[test/ui.test.ts](test/ui.test.ts) cruza los ids, selectores y `[data-field]` que
escribe la vista con el HTML (incluida la plantilla de filas), y
[test/ui.styles.test.ts](test/ui.styles.test.ts) audita cada regla de
`styles.css` con ese mismo matcher: si un selector no coincide con ningún
elemento del HTML, ni depende de un nombre que cree el JS, ni pinta una fila de
la plantilla, la regla se reporta como muerta con su línea. Hoy no hay ninguna;
el test está para que renombrar un id o una clase no deje CSS huérfano. En el
sentido contrario, [test/ui.markup.test.ts](test/ui.markup.test.ts) recorre los
ids, clases, atributos `data-*` y atributos ARIA de `index.html` (plantilla de
filas incluida) y falla si no los usa nadie: un id vale si lo pinta el CSS, lo
busca la vista o lo referencia otro atributo del propio HTML (`for`,
`aria-labelledby`, `href="#…"`); una clase, si tiene regla o si la vista la
escribe con `classList`/`className`/`setAttribute`; y un `data-*` vale si el CSS
o un selector de la vista lo exigen con ese valor (`[data-field="name"]`) o si
la vista lee el atributo entero con `dataset` —una escritura como
`dataset.blocked = …` no cuenta, porque no prueba que ese atributo del HTML se
consulte—, así que un `data-field` o un `data-action` de la plantilla que la
vista dejó de leer se reporta como muerto.

Los ARIA se separan por lo que los consume. Un `role`, un nombre accesible
(`aria-label`, `aria-labelledby`), una descripción, una live region, una
relación o una propiedad fija los consume el árbol de accesibilidad: la
declaración estática ya es su uso. Los estados que la interfaz tiene que
mantener al día (`aria-busy`, `aria-checked`, `aria-expanded`, `aria-pressed` y
`aria-selected`) sí se auditan: valen si el CSS o la vista los consultan o
actualizan con `getAttribute`/`setAttribute`/`removeAttribute`, y el valor del
selector tiene que coincidir con el declarado, igual que en `data-*`. Un estado
que solo aparece en el HTML queda congelado y se reporta como muerto. Hoy no hay
ninguno suelto; el único id que no toca la vista es `#banks-title`, que existe
solo para el `aria-labelledby` de `#banks` y así está anotado en el HTML.

## Documentación OpenAPI

Con el servidor arrancado:

- Swagger UI: <http://127.0.0.1:3210/docs>
- JSON OpenAPI: <http://127.0.0.1:3210/docs-json>
- Artefacto versionado: [openapi.json](openapi.json), generado con
  `npm run openapi`.

El documento describe **todos** los endpoints:

- `/fxb-config`: `FxbConfigDto`, `FxbConfigSnapshotDto`, las peticiones y los
  errores, con ejemplos para **200**, **400** (ruta inválida y validación) y
  **409** (`mtimeMs` obsoleto).
- `/library`: peticiones `LibraryScanRequestDto`, `LibraryInstallRequestDto`,
  `LibraryUninstallRequestDto`, `LibraryBatchRequestDto`,
  `LibraryBanksListRequestDto`, `LibraryBanksImportRequestDto`,
  `LibraryBankExportRequestDto`, `LibraryBankConvertRequestDto`,
  `LibraryBankRestoreRequestDto` y `LibraryBankInspectRequestDto`; respuestas
  `LibraryScanResponseDto`, `LibraryOperationResponseDto`,
  `LibraryBatchResponseDto` (con `LibraryBatchPluginResultDto` por plugin),
  `LibraryBanksListResponseDto`, `LibraryBanksImportResponseDto`,
  `LibraryBankExportResponseDto`, `LibraryBankConvertResponseDto`,
  `LibraryBankRestoreResponseDto` y `LibraryBankInspectResponseDto`; banco
  (`BankInfoDto`, `BankReferenceDto`, `BankImportResultDto`, `PluginBankDto`,
  `BankExportFileDto`, `BankBackupFileDto`, `BankBackupSummaryDto`) y
  errores (`LibraryErrorDto`, `LibraryConflictErrorDto`,
  `LibraryBanksImportErrorDto`). Cada operación trae
  ejemplos de petición y de cada código (**200**, **400**, **404**, **409**,
  **422**), incluidos el plan de `dryRun`, la instalación, la desinstalación, un
  lote de plugins con su resultado por plugin, un lote de bancos aceptado o
  rechazado, la conversión en el sitio con su respaldo y la restauración desde
  ese respaldo.

**Todos** los cuerpos se publican **cerrados**: cada DTO de
`components.schemas` —peticiones y respuestas, correctas o de error— lleva
`additionalProperties: false`, y el cierre sigue los `$ref` a los DTO que
embeben —el `current` del 409 (`FxbConfigSnapshotDto` con su `config`), el
`plugin`, la `reference`, los `results` de la importación de bancos
(`BankImportResultDto` y `BankInfoDto`), la `config` de `banks/list` y el
`backup` de `banks/convert` y `banks/restore`—, de modo que un ejemplo con un
campo que ningún DTO declara falla la validación en cualquier nivel y en
cualquier código, no solo en los errores. `@nestjs/swagger` no emite esa palabra
clave, así que [swagger.ts](src/swagger.ts) la añade sobre el documento ya
generado, recorriendo **todos** los esquemas antes de servirlo en `/docs` y de
escribirlo en `openapi.json`. Solo se cierran los objetos con propiedades
declaradas (no los envoltorios `allOf: [$ref]` ni los mapas que ya declaran su
propio `additionalProperties`); como cada cuerpo JSON de las rutas es un `$ref`
(o un `anyOf` de `$ref`) a esos componentes, cerrar los componentes cierra todas
las peticiones y respuestas, y un test impide que un cuerpo con el esquema
incrustado escape al cierre.

El contrato es más estricto que el parser: el servidor arma cada entrada campo a
campo, así que hoy un campo desconocido en una petición se ignora en vez de
devolver **400**. El esquema lo prohíbe igualmente (el cliente tipado no puede
enviarlo) y los ejemplos no pueden traerlo; queda anotado como diferencia
pendiente entre contrato y ejecución.

Los tests mantienen la documentación honesta. [test/openapi.test.ts](test/openapi.test.ts)
compara `openapi.json` con el documento generado y fija los DTO de cada
operación; [test/openapi.examples.test.ts](test/openapi.examples.test.ts) valida
**cada ejemplo contra su propio esquema** (con Ajv: cuerpos, respuestas,
parámetros y los ejemplos de cada propiedad), exige que **todas** las
operaciones y **todos** los códigos documenten al menos un ejemplo y comprueba
que todos los DTO estén cerrados y que ningún cuerpo lleve el esquema
incrustado. Con ejemplos mutados a propósito verifica que un campo de más deje
de validar en los DTO anidados (`current`, su `config`, `plugin`, `results`, el
`bank`), en **cualquier respuesta** —correcta o de error— y en **cada petición**.
[test/library.docs.test.ts](test/library.docs.test.ts) ejecuta los endpoints
reales y comprueba que los ejemplos tienen exactamente los campos que devuelve la
API, y [test/client.test.ts](test/client.test.ts) exige que los tipos del cliente
coincidan con el documento. Si cambias los DTOs o las respuestas, ejecuta
`npm run client` (que ya regenera `openapi.json`).

## Cliente TypeScript

[`src/client`](src/client/index.ts) expone un cliente tipado derivado del
contrato, pensado para una futura UI:

```ts
import { createFxbClient, isFxbApiError } from './src/client';

const api = createFxbClient(); // http://127.0.0.1:3210
const scan = await api.library.scan({ libraryRoot: 'C:\\VFX\\Library' });

api.library.install({ libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth' })
  .then((result) => console.log(result.actions.length))
  .catch((error: unknown) => {
    if (isFxbApiError(error) && error.status === 409) console.error(error.message);
  });
```

- [api-types.ts](src/client/api-types.ts) lo genera `openapi-typescript`
  (dependencia de desarrollo) desde `openapi.json`; no se edita a mano. Un test
  falla si deja de coincidir con el documento generado.
- [fxb-client.ts](src/client/fxb-client.ts) es el envoltorio de `fetch`:
  `library.scan | install | uninstall | batch | batchStream | listBanks |
  importBanks | importBanksStream | exportBank | inspectBank` y `config.read |
  write`.
- `library.batchStream` e `library.importBanksStream` leen el NDJSON con su
  propio lector de flujo: entregan cada evento a `onEvent` en cuanto llega (sin
  esperar al final) y resuelven con el `result` del evento `end`; si el flujo se
  corta sin `end`, lanzan.
- [bank-import-stream.ts](src/client/bank-import-stream.ts) tiene los tipos de
  los eventos de la importación (`start`, `bank` y `end`);
  [bank-limits.ts](src/client/bank-limits.ts), el tope de bancos por petición.
- [batch-stream.ts](src/client/batch-stream.ts) tiene los tipos de esos eventos.
  Vive con el cliente y no con el servicio para que el build del navegador no
  arrastre el código del servidor (`Buffer`, sistema de archivos).
- Los cuerpos de petición, respuesta y error se derivan del propio documento
  (`RequestBody`, `SuccessBody`, `ErrorBody`): si un DTO cambia, la UI deja de
  compilar hasta adaptarse. Los errores llegan como `FxbApiError` con `status`
  y `body` ya parseado.
- `baseUrl` es configurable; con `baseUrl: ''` las peticiones son relativas, útil
  si la UI se sirve desde el mismo Nest. También acepta un `fetch` propio para
  instrumentar la red.

## Endpoints de configuración

### `POST /fxb-config/read`

```json
{ "pluginDir": "C:\\VFX\\plugs\\MySynth" }
```

Devuelve:

```json
{
  "configPath": "C:\\VFX\\plugs\\MySynth\\fxbLoader.config",
  "exists": true,
  "mtimeMs": 1760000000000.123,
  "size": 96,
  "config": {
    "pluginName": "MySynth.dll",
    "defaultFxbName": "Rhodes.fxb",
    "programDirName": "presets",
    "loadFxbBank": true
  },
  "warnings": []
}
```

Si el archivo no existe devuelve los valores por defecto con `exists: false` y
`mtimeMs: null`; no crea nada.

### `PUT /fxb-config`

```json
{
  "pluginDir": "C:\\VFX\\plugs\\MySynth",
  "expectedMtimeMs": 1760000000000.123,
  "config": { "defaultFxbName": "Rhodes.fxb", "loadFxbBank": false }
}
```

- `expectedMtimeMs` es obligatorio: el valor leído, o `null` si el archivo no
  existía. Si ya no coincide, responde **409** con `current` (el estado actual)
  y no escribe.
- `config` es parcial: el resto se conserva de disco.
- Responde con el mismo snapshot que `read`.
- Errores de validación: **400** con `issues`.

## Endpoints de librería

`libraryRoot` es la carpeta que contiene `plugs\` (la que se elige con
«open vfxLibrary» en el binario). Siempre debe ser una ruta absoluta.

### `POST /library/scan`

```json
{
  "libraryRoot": "C:\\VFX\\Library",
  "dllSourcePath": "C:\\fxbLoader\\vst\\fxbLoader.dll"
}
```

`dllSourcePath` es opcional; si falta se usa `FXB_LOADER_DLL` y, en último
término, el `vst\fxbLoader.dll` del repositorio.

```json
{
  "libraryRoot": "C:\\VFX\\Library",
  "plugsPath": "C:\\VFX\\Library\\plugs",
  "loader": {
    "path": "C:\\fxbLoader\\vst\\fxbLoader.dll",
    "valid": true,
    "bitness": 32,
    "machine": "i386",
    "issues": []
  },
  "plugins": [
    {
      "name": "MySynth",
      "path": "C:\\VFX\\Library\\plugs\\MySynth",
      "installed": true,
      "hasVfxinfo": true,
      "pluginName": "MySynth.dll",
      "warnings": [],
      "compatible": true,
      "compatibilityIssues": []
    }
  ]
}
```

Solo se listan directorios. `installed` replica al binario: existe
`fxbLoader.config`. Los `.config` ilegibles o con avisos aparecen en
`warnings` sin abortar el escaneo.

El escaneo lee la cabecera PE del cargador y del binario original del plugin
(`dll_name` de `vfxinfo.txt`; en instalados, del respaldo `vfxinfo.tx_`).
`compatible` es `true` para PE32 i386, `false` si el binario es de 64 bits u otra
arquitectura, si existe pero no es un PE usable (archivo vacío, truncado o sin
cabecera), si el cargador no es PE32 i386 **o si el archivo del `dll_name` no
existe** (el host no tendría nada que cargar); `null` solo si el DLL está pero no
se pudo leer. Los motivos van en `compatibilityIssues`. No se carga el DLL
entero: solo se leen las cabeceras DOS/PE.

### `POST /library/install`

```json
{
  "libraryRoot": "C:\\VFX\\Library",
  "plugin": "MySynth",
  "dllSourcePath": "C:\\fxbLoader\\vst\\fxbLoader.dll",
  "force": false,
  "dryRun": false
}
```

`dllSourcePath` es opcional: si falta se usa `FXB_LOADER_DLL` y, en último
término, el `vst\fxbLoader.dll` del repositorio. `dryRun: true` devuelve el plan
(`actions`) sin tocar el disco.

Pasos, en este orden:

1. respalda `vfxinfo.txt` como `vfxinfo.tx_` (si ya existe, **no** lo pisa);
2. copia el DLL como `<plugin>\fxbLoader.dll`;
3. reescribe la primera línea `dll_name` como
   `dll_name: <plugin>/fxbLoader.dll`;
4. escribe `fxbLoader.config` con `pluginName` tomado del `dll_name` original;
5. crea `presets\`.

El `pluginName` se toma del respaldo o de la configuración vigente al
reinstalar, nunca del `dll_name` ya parcheado (que daría `fxbLoader.dll`).
Reinstalar (`force`) conserva `defaultFxbName` y `loadFxbBank`.

La instalación vuelve a validar el cargador y el binario original antes de
escribir: rechaza con **422** un `fxbLoader.dll` que no sea PE32 i386, un plugin
de 64 bits o un `dll_name` que apunte a un archivo **inexistente** (se trata
como incompatible), sin tocar el disco.

Códigos: **200**, **400** (ruta/nombre inválido, DLL ausente), **404** (plugin
inexistente), **409** (ya instalado sin `force`), **422** (`vfxinfo.txt` sin
línea `dll_name`, `dll_name` sin archivo —tratado como incompatible—, cargador
que no es PE32 i386 o plugin incompatible).

### `POST /library/uninstall`

```json
{ "libraryRoot": "C:\\VFX\\Library", "plugin": "MySynth" }
```

Mueve el `vfxinfo.txt` modificado a `vfxinfo.loader`, restaura `vfxinfo.tx_`
como `vfxinfo.txt` y borra `fxbLoader.config`. El DLL y los bancos importados
se conservan, igual que en el original.

Códigos: **200**, **404**, **409** (no instalado o sin respaldo).

### `POST /library/batch`

```json
{
  "libraryRoot": "C:\\VFX\\Library",
  "action": "install",
  "plugins": ["MySynth", "GrandPiano"],
  "dllSourcePath": "C:\\fxbLoader\\vst\\fxbLoader.dll",
  "force": false,
  "dryRun": false
}
```

El lote de instalar/desinstalar vive en el servidor (antes lo hacía la vista
con una petición por plugin). Recorre `plugins` **en serie y en el orden
recibido** —el instalador escribe sobre el mismo árbol— y devuelve el resultado
de cada uno. `dllSourcePath` y `force` se aplican igual que en
`POST /library/install`; `dryRun` también vale para `uninstall` y devuelve el
plan de cada plugin sin tocar el disco.

Respuesta **200** (aunque fallen todos, porque el lote ya se ha recorrido):

```json
{
  "action": "install",
  "dryRun": false,
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "results": [
    {
      "name": "MySynth",
      "status": "installed",
      "message": null,
      "entry": { "name": "MySynth", "installed": true, "…": "…" },
      "actions": [{ "kind": "backup", "…": "…" }]
    },
    {
      "name": "GrandPiano",
      "status": "failed",
      "message": "GrandPiano ya tiene fxbLoader instalado (usa force para reinstalar)",
      "entry": null,
      "actions": []
    }
  ]
}
```

Por plugin: `status` (`installed`, `uninstalled`, `planned` si `dryRun` solo
calculó el plan, o `failed`), `message` (`null` si no falló), `entry` (estado
tras la operación, `null` si no se pudo operar) y `actions` (los pasos dados o
el plan). **Sin reintentos automáticos**: un fallo se reporta y la vista ofrece
reintentarlo con los endpoints individuales.

Validación: la raíz de la librería y el cargador se comprueban una sola vez,
antes de tocar ningún plugin. Códigos: **200**, **400** (`action` desconocida,
`plugins` vacío o rutas inválidas: se rechaza el lote entero sin procesar
nada), **422** (cargador que no es PE32 i386).

El lote admite **como máximo 500 plugins por petición**
(`MAX_PLUGINS_PER_BATCH` en
[batch-stream.ts](src/client/batch-stream.ts), junto al contrato, para que lo
puedan usar el servidor y el navegador): por encima responde **400** con
`como máximo 500 plugins por petición` y no procesa ninguno, ni siquiera el
primero de la lista. Es un tope de petición, no del lote completo —existe para
que una sola petición no se convierta en una lista arbitraria de nombres—, así
que la vista trocea la lista y manda varias peticiones seguidas. Se comprueba en
[test/library.batch.test.ts](test/library.batch.test.ts) en los dos lados del
borde (500 se acepta y se recorre plugin a plugin; 501 se rechaza entero) y el
troceado de la vista en [test/batch.test.ts](test/batch.test.ts).

### `POST /library/batch/stream`

El mismo cuerpo, el mismo tope de 500 plugins y las mismas validaciones que
`POST /library/batch`, pero la respuesta no es un JSON único: es **NDJSON**
(`application/x-ndjson`, una línea JSON por evento) que el servidor escribe
**según avanza** el lote. Es lo que usa la vista para el progreso en caliente.

```
{"type":"start","action":"install","dryRun":false,"total":2,"plugins":["MySynth","GrandPiano"]}
{"type":"plugin","index":0,"total":2,"name":"MySynth","status":"running","message":null}
{"type":"step","index":0,"total":2,"name":"MySynth","step":"backup","stepIndex":0,"steps":5}
{"type":"step","index":0,"total":2,"name":"MySynth","step":"copy","stepIndex":1,"steps":5}
{"type":"step","index":0,"total":2,"name":"MySynth","step":"patch","stepIndex":2,"steps":5}
{"type":"step","index":0,"total":2,"name":"MySynth","step":"write-config","stepIndex":3,"steps":5}
{"type":"step","index":0,"total":2,"name":"MySynth","step":"create-dir","stepIndex":4,"steps":5}
{"type":"plugin","index":0,"total":2,"name":"MySynth","status":"installed","message":null}
{"type":"plugin","index":1,"total":2,"name":"GrandPiano","status":"running","message":null}
{"type":"plugin","index":1,"total":2,"name":"GrandPiano","status":"failed","message":"GrandPiano ya tiene fxbLoader instalado (usa force para reinstalar)"}
{"type":"end","result":{ "action":"install", "total":2, "succeeded":1, "failed":1, "results":[…] }}
```

- `start` sale **después** de validar la petición entera (raíz y cargador), así
  que un **400**/**422** sigue siendo una respuesta JSON normal: no hay eventos
  a medias.
- `plugin` sale dos veces por plugin: `status: "running"` antes de operarlo y
  el estado final (`installed`, `uninstalled`, `planned`, `failed`) después.
- Si el cliente cierra la respuesta (el botón **Cancelar** de la vista), el
  servidor deja de empezar plugins: termina el que está en curso —puede estar
  ya a medias en disco— y corta el flujo sin `end`. La vista conserva los
  eventos finales que sí recibió y resume con ellos lo confirmado.
- `step` sale entre esos dos avisos, uno por cada paso interno del plugin:
  `backup`, `copy`, `patch`, `write-config` y `create-dir` al instalar;
  `restore`, `restore` y `delete` al desinstalar. `stepIndex`/`steps` dicen por
  cuál va (0-based) y cuántos hará. Un plugin que falla antes de tocar nada
  (inexistente, ya instalado) no manda ninguno, y con `dryRun` tampoco hay
  pasos porque no se ejecuta nada: solo se calcula el plan.
- `end` lleva el mismo `result` que devolvería `POST /library/batch`.

La respuesta va con `cache-control: no-store` y sin `content-length`, y no se
comprime; si el cliente corta la conexión el servidor deja de escribir y termina
el lote en curso. El contrato de los eventos está en
[batch-stream.ts](src/client/batch-stream.ts) y lo comparten el servidor y el
cliente.

### `POST /library/banks/list`

```json
{ "libraryRoot": "C:\\VFX\\Library", "plugin": "MySynth" }
```

Devuelve `presetsDir` (según `programDirName`), `presetsDirExists`, `banks[]`
(`fileName`, `size` y la cabecera `bank` ya interpretada), `defaultBackup`
(`fileName` y `size` del `<banco>.orig` del banco por defecto, o `null` si no
hay respaldo) y el snapshot de
`fxbLoader.config` con su `mtimeMs` para el control optimista de
`PUT /fxb-config`. Solo lee la cabecera de cada banco, **no crea la carpeta**
si falta (responde `banks: []`) y no escribe nada; los archivos que no son
bancos VST2 se omiten.

Códigos: **200**, **400** (`libraryRoot` inválido), **404** (plugin
inexistente), **422** (`programDirName` no es un nombre de carpeta simple).

### `POST /library/banks/import`

```json
{
  "libraryRoot": "C:\\VFX\\Library",
  "plugin": "MySynth",
  "sourcePaths": ["C:\\Banks\\Rhodes.fxb", "C:\\Banks\\Strings.fxb"],
  "expectedUniqueId": "MySy",
  "expectedFxVersion": 1000,
  "overwrite": true
}
```

Copia los `.fxb` a `<plugin>\<programDirName>\` (por defecto `presets\`),
creando la carpeta si hace falta, con la misma escritura atómica que el resto.
Cada archivo se valida por separado y la respuesta trae `results` con
`status` (`imported`, `overwritten`, `rejected`), `compatibility`, el `bank`
parseado y los motivos del rechazo. Un **422** significa que **todos** los
bancos del lote se rechazaron; el cuerpo sigue trayendo `results` con el motivo
de cada uno. Mandar la lista entera en una petición (hasta 50) es más rápido y
da el mismo resultado por archivo que una petición por banco, que además
convierte cada rechazo en el 422 de esa petición: ver **Lote o peticiones
sueltas** más abajo, con las cifras de las dos estrategias.

**Validación de formato** (cabecera VST2 que comprueba `fxHeader::check`):
`chunkMagic` `CcnK`, `byteSize` contra el tamaño real, `fxMagic` `FxBk` o
`FBCh`, versión 1 o 2, `uniqueID`, versión del plugin y, en los `FxBk`, cada
programa (`CcnK`, tamaños de `FxCk`/`FPCh`, coherencia de `uniqueID`). Se
aceptan archivos little-endian y big-endian.

El parser se valida también contra **nueve bancos reales** de otros plugins y
sintetizadores (`FBCh` v1 y v2, `FxBk` con programas `FxCk`/`FPCh`, versiones 1
y 2), incluido el banco de fábrica de 128 programas de **OB-Xd** y un banco de
sintetizador `FxBk` v2 con 100 programas de **MauSynth**, en
[`test/fixtures/fxb/`](test/fixtures/fxb/README.md). Uno de ellos
(`wavosaur-reeq-3set-le.fxb`) es un export real de Wavosaur re-serializado en
**little-endian** —el orden que escribe un plugin de Windows que guarda su
struct nativo sin convertir—, para que ese camino se pruebe con datos de verdad
y no solo con los bancos que generamos. Cada fixture lleva su SHA-256, el
origen exacto y el resultado esperado en `manifest.json`; los tests parsean,
comprueban la cabecera de 160 bytes e importan los archivos reales byte a byte.
El banco con programas `FPCh` (`massive-fpch-bank.fxb`) se ensambla con dos
programas reales de Massive —un host que guarda un banco de un plugin con
programas chunk escribe esa misma cabecera y copia los chunks tal cual—.
**Todos** los fixtures declaran en `manifest.json`, además de su `size` y su
`sha256`, un bloque `programs` con el número de programas y, en cada uno, el
tamaño que dice ocupar (`byteSize = 48 + 4 × numParams` en los `FxCk`,
`byteSize = 52 + chunkSize` en los `FPCh`) además de la suma de `byteSize` y el
rango de parámetros o chunks. Esos tres campos **no se escriben a mano**:
[`derive-manifest.mjs`](test/fixtures/fxb/derive-manifest.mjs) deriva de los
bytes de cada `.fxb` el tamaño, el SHA-256 y el bloque `programs`, y un test
exige que `manifest.json` coincida con lo generado, así que el manifiesto no
puede desviarse del binario. Para añadir un fixture solo hacen falta `file`,
`source` y `expected`: `derive-manifest.mjs --write` inserta `size`, `sha256` y
`programs` en la entrada si aún no están, sin ningún número provisional. La
tabla de ese README también se genera:
[`render-readme-table.mjs`](test/fixtures/fxb/render-readme-table.mjs) toma el
orden, el plugin y el propósito del manifiesto y el formato y el tamaño reales
de cada `.fxb`, y `--check` falla si la tabla se desvía de los archivos.
Los tests recorren los tamaños declarados con bytes reales, comprueban que
cubren el archivo exacto y que un `numParams`, un `chunkSize` o un `byteSize`
manipulados se rechazan.

**Rendimiento** con esos mismos bancos: [`test/fxb-bank.performance.test.ts`](test/fxb-bank.performance.test.ts)
cronometra 500 parseos de cada uno (tras 50 de calentamiento) y publica mediana,
p95 y parses/s como diagnóstico del test; exige que la mediana se quede por
debajo de 25 ms por banco, un techo muy por encima de los microsegundos reales
para que no dependa de la máquina. La comparación no es entre plugins: el banco
de MauSynth es un `FxBk` y el parser recorre sus 100 programas, mientras que el
de OB-Xd es un `FBCh` de 128 programas y solo se valida la cabecera y el tamaño
del chunk, así que los dos números miden trabajos distintos.

**Importación completa** con los mismos bancos:
[`test/banks.import.performance.test.ts`](test/banks.import.performance.test.ts)
mide el trabajo real de `POST /library/banks/import` —leer el `.fxb`, parsearlo,
validar compatibilidad y destino y copiarlo con escritura atómica— y lo compara
con el parser solo. Cronometra cuatro alturas para poder atribuir la diferencia:
parser sobre un buffer en memoria (500 muestras), lectura + parse, el servicio
en proceso sin HTTP y la petición HTTP completa con su JSON (40 muestras cada
una, todas con calentamiento). Publica mediana, p95 y operaciones/s, y exige
25/1500/2000 ms de mediana para parser, servicio y HTTP: techos amplios para
detectar un salto de orden sin depender de la máquina (en `npm test` los
archivos corren en paralelo y la importación compite por el disco). En un equipo
normal el parser tarda microsegundos y la importación milisegundos, así que el
coste está en el disco (lectura, copia atómica y `rename`), no en el parseo.
Para leer cifras comparables, ejecuta solo los tests de rendimiento:

```bash
npm run test:perf   # parser y importación, un archivo a la vez
```

**Lote o peticiones sueltas** con los nueve bancos reales: el mismo archivo mide
una petición con los nueve frente a una petición por banco, sobre una biblioteca
nueva en cada muestra y en el mismo orden (2 de calentamiento y 11 muestras por
estrategia, mediana). En dos ejecuciones con `npm run test:perf`, el lote único
tardó **19–23 ms** y las nueve peticiones **66–80 ms**: **3,4–3,5×** más, unos
**5–6 ms por petición de más** (validación de rutas, lectura de
`fxbLoader.config`, búsqueda de la referencia del destino y el JSON de ida y
vuelta). La copia de los bancos cuesta lo mismo en los dos casos, así que la
diferencia es el coste fijo de cada petición.

Las dos estrategias dan **el mismo resultado por archivo**: en los nueve
fixtures —de cinco plugins distintos— se importan los dos bancos de Massive
(`NiMa`, que fijan la referencia) y se rechazan los otros siete por
incompatibilidad, igual y en el mismo orden con una petición que con nueve. Lo
que cambia es el HTTP: el lote único responde **un 200** con los nueve
resultados, mientras que las peticiones sueltas producen **2×200 y 7×422**
(«Ningún banco se pudo importar»), porque cada rechazo deja a su petición sin
ninguna importación. Un cliente que corte en el primer 4xx dejaría de procesar la
lista en el primer banco de otro plugin, aunque el servidor sepa explicar el
motivo de cada uno.

Por eso la vista manda **una sola petición con toda la lista** mientras quepa en
el tope de 50 bancos por petición (`MAX_BANKS_PER_REQUEST`): es más rápida, el
resultado por banco es el mismo y un rechazo no cancela el resto. Esa petición
usa `POST /library/banks/import/stream`, así que dentro del trozo la barra
avanza con cada evento `bank` en vez de esperar al cierre. Por encima de 50 la
lista se trocea en peticiones de 50 y el resultado de todas se acumula en una
sola lista, en el orden del cuadro de texto; un trozo con todos los bancos
rechazados termina su NDJSON con `end` y los motivos de cada archivo, sin
impedir el trozo siguiente, que es justo lo que pasa al mezclar bancos de varios
plugins. Si un trozo falla por otro motivo, la importación se corta y lo ya
copiado se conserva a la vista.

Mientras dura, la vista pinta una **barra de progreso** junto al formulario, con
el mismo aspecto que la del lote de plugins: `max` es el total de rutas del
cuadro de texto —no el del trozo en curso— y `value` los archivos que ya tienen
resultado, así que el avance se acumula entre peticiones y no reinicia en cada
una. El estado la acompaña con «Importando 50 de 120 archivo(s)…» y, al cerrar
el último trozo, la barra se oculta y queda el resumen (`N importado(s), M
rechazado(s).`). Partir la lista tiene además sentido si un proxy corta
peticiones largas. Las cifras son de un equipo de desarrollo: sirven para
comparar las dos estrategias de HTTP, no como presupuesto de otra máquina, y se
reproducen con `npm run test:perf`. El flujo añade una línea por banco; la
medición compara el endpoint sin flujo, que sigue dando el mismo resultado por
archivo.

**Compatibilidad** con el plugin, por orden:

1. `expectedUniqueId` / `expectedFxVersion` explícitos (4 caracteres tipo
   `MySy` o entero).
2. Un banco ya presente en la carpeta de destino, solo al añadir un nombre
   nuevo (al reemplazar manda el usuario). Se reporta como `existing-bank`.
3. El primer banco importado del lote, para los siguientes (`batch`).
4. Si no hay referencia, se importa como `unverified`.

`fxHeader::check` (`FUN_100038c0`, verificado en pseudocódigo y ensamblador)
compara **solo** `chunkMagic`, `fxMagic` y el `fxID` con el `uniqueID` del
plugin: no mira `fxVersion` ni los tamaños. Por eso la compatibilidad se decide
por uniqueID, y `expectedFxVersion` solo se exige si el cliente lo pasa
explícitamente. Una web no puede hospedar el VST de 32 bits para leer el
`uniqueID` vivo, así que la identidad viene de fuera o se infiere de los bancos
ya importados. La validación estructural de este módulo es **más estricta** que
la de la DLL: rechaza `byteSize` incoherentes, versiones desconocidas y
programas truncados que el binario cargaría a ciegas.

`overwrite` es `true` por defecto, como el original (que sobrescribe sin
avisar), pero el resultado marca `overwritten`. Códigos: **200** si al menos
un banco se importó, **400** petición o ruta inválida, **404** plugin
inexistente, **422** si todos fueron rechazados (el cuerpo incluye `results`).

El banco importado **no se aplica** al plugin: eso lo hace `fxbLoader.dll` al
abrir el plugin. Aquí solo se valida y se deja disponible en el listbox que
lee la DLL.

### `POST /library/banks/import/stream`

El mismo cuerpo, el mismo tope de 50 bancos y las mismas validaciones que
`POST /library/banks/import`, pero la respuesta es **NDJSON**
(`application/x-ndjson`, una línea JSON por evento) que el servidor escribe
**según procesa cada archivo**. Es lo que usa la vista para mover la barra
banco a banco.

```
{"type":"start","total":2,"sourcePaths":["C:\\Banks\\Rhodes.fxb","C:\\Banks\\Strings.fxb"]}
{"type":"bank","index":0,"total":2,"result":{"source":"C:\\Banks\\Rhodes.fxb","fileName":"Rhodes.fxb","target":"…\\presets\\Rhodes.fxb","status":"imported","compatibility":"compatible","reason":null,"issues":[],"warnings":[],"bank":{…}}}
{"type":"bank","index":1,"total":2,"result":{"source":"C:\\Banks\\Strings.fxb","fileName":"Strings.fxb","target":"…\\presets\\Strings.fxb","status":"rejected","compatibility":"incompatible","reason":"uniqueID distinto del plugin","issues":[],"warnings":[],"bank":{…}}}
{"type":"end","result":{"plugin":{…},"presetsDir":"…\\presets","reference":{…},"results":[…]}}
```

- `start` sale **después** de validar la petición entera (raíz, plugin, rutas,
  tope y referencias), así que un **400**/**404** sigue siendo una respuesta
  JSON normal: no hay eventos a medias.
- `bank` sale una vez por archivo, **también cuando se rechaza**, con el mismo
  `result` que aparecería en `results` del endpoint normal. `index` es la
  posición 0-based dentro de la petición.
- `end` lleva el mismo `result` que devolvería `POST /library/banks/import`.
  Si **todos** los bancos se rechazan, el flujo termina con **200** y `end` en
  vez de un 422: una vez enviado `start` el código ya no se puede cambiar, y la
  vista cuenta los `rejected` de cada evento. El 422 queda para el endpoint sin
  flujo, donde la respuesta entera se decide antes de escribir.
- Si el cliente corta la conexión (por ejemplo al cerrar la pestaña), el
  servidor termina el archivo en curso y no empieza otro; el flujo se cierra sin
  `end`, que el cliente interpreta como corte.
- La respuesta va con `cache-control: no-store`, sin `content-length` y con
  `x-accel-buffering: no`, para que ningún proxy acumule la respuesta.

El contrato de los eventos está en
[bank-import-stream.ts](src/client/bank-import-stream.ts) y lo comparten el
servidor y el cliente.

### `POST /library/banks/convert`

Convierte **en el sitio** el banco que `fxbLoader.config` marca como
predeterminado (`defaultFxbName`). Es el mismo trabajo que `banks/export`, pero
sin archivo nuevo: el `.fxb` se reescribe en su ruta y conserva el nombre, así
que la DLL lo sigue cargando y la configuración no cambia. El cuerpo solo lleva
la librería y el plugin; `endianness` es opcional y sin él se elige el orden
contrario al que tiene el banco, que es la conversión natural de un banco
legacy.

```json
{
  "libraryRoot": "C:\\VFX\\Library",
  "plugin": "MySynth"
}
```

Antes de escribir nada se guarda una copia byte a byte del original como
`<banco>.fxb.orig`, en la misma carpeta. Como no termina en `.fxb`, no aparece
en la lista de bancos ni se puede confundir con uno. Si el respaldo ya existe
**no se pisa**: lo valioso es el archivo anterior a la primera conversión, y una
segunda conversión (por ejemplo para volver al orden de partida) lo conserva y
responde `backupCreated: false`. El banco convertido se vuelve a parsear antes
de sustituir al original y, si el nombre ya declara un orden con el sufijo
`-le`/`-be`, no se convierte al contrario (habría que renombrarlo, y aquí el
nombre lo fija la configuración).

La respuesta trae `fileName` (el `defaultFxbName` usado), `source` y `target`
(mismo `path`, `bank` interpretada antes y después), `backup` (`fileName`,
`path`, `size` y `sha256`, o `null` si no había nada que convertir),
`backupCreated`, `changed`, `fields`, `programs` y `chunks`. Con el banco ya en
el orden pedido responde **200** con `changed: false` y sin escribir ni crear
respaldo.

Códigos: **200**, **400** (`libraryRoot` inválido, `endianness` desconocida o un
`defaultFxbName` con separadores o sin `.fxb`), **404** (plugin inexistente),
**409** (el plugin no tiene banco por defecto configurado o el archivo no está
en su carpeta) y **422** (el archivo no es un `.fxb` válido, la conversión lo
dejaría inválido o el nombre declara el otro orden).

### `POST /library/banks/restore`

Deshace `banks/convert`: devuelve el banco por defecto (`defaultFxbName`) al
contenido de su respaldo `<banco>.fxb.orig`, en la misma ruta y con el mismo
nombre, para que la DLL lo siga cargando sin tocar la configuración.

```json
{
  "libraryRoot": "C:\\VFX\\Library",
  "plugin": "MySynth"
}
```

El respaldo **solo se lee**: no se renombra, no se mueve y no se reescribe, así
que restaurar no lo consume y la operación se puede repetir (o volver a
convertir después, que conserva el mismo `.orig`). Antes de escribir se
reparsea el respaldo, de modo que un `.orig` corrupto no puede dejar el plugin
con un banco roto. Si el banco ya es byte a byte el respaldo, responde **200**
con `changed: false` y sin escribir nada. La sustitución usa la misma escritura
atómica que el resto (temp + fsync + rename).

La respuesta trae `fileName`, `restored` (el banco en disco: `fileName`,
`path`, `size`, `sha256` y la `bank` interpretada), `backup` (`fileName`,
`path`, `size` y `sha256` del respaldo usado) y `changed`.

Códigos: **200**, **400** (`libraryRoot` inválido o un `defaultFxbName` con
separadores o sin `.fxb`), **404** (plugin inexistente), **409** (el plugin no
tiene banco por defecto o el banco nunca se convirtió, así que no hay `.orig`)
y **422** (el respaldo está vacío, supera el tamaño máximo o no es un `.fxb`
válido).

### `POST /library/banks/discard-backup`

Envía el respaldo `<banco>.fxb.orig` del banco por defecto a la papelera sin
tocar el `.fxb`. Es la vuelta atrás de `banks/convert`: el `.orig` sale de la
carpeta del plugin y `banks/restore` deja de encontrarlo (409), pero el archivo
no se destruye: queda en la Papelera de reciclaje y se puede recuperar. El
cuerpo solo lleva la librería y el plugin.

```json
{
  "libraryRoot": "C:\\VFX\\Library",
  "plugin": "MySynth"
}
```

El contenido del respaldo **no se valida** antes de moverlo: descartar un
`.orig` corrupto o ajeno es uno de los motivos para hacerlo. Se lee solo para
devolver qué salió de la carpeta, con `fileName`, `path` (ruta original), `size`
y `sha256` en `discarded`; el `fileName` del banco por defecto queda como
estaba. La respuesta añade `trash` con:

- `label`: la papelera del sistema (`Papelera de reciclaje de Windows`, o
  `Papelera` en Linux/macOS);
- `path`: la carpeta donde quedó el archivo, o `null` en Windows, que no expone
  una ruta a su Papelera de reciclaje;
- `hint`: cómo recuperarlo (por ejemplo, abrir la Papelera de reciclaje y pulsar
  «Restaurar», o la carpeta de la papelera XDG).

En Windows se usa la Papelera de reciclaje real
(`Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile` con
`RecycleOption.SendToRecycleBin`); en Linux se respeta la especificación XDG
(`~/.local/share/Trash`, con su archivo `.trashinfo` para poder restaurarlo) y
en macOS se mueve a `~/.Trash`. La vista pide confirmación con el nombre y el
tamaño del archivo, deshabilita el botón si la lista no anuncia respaldo
(`defaultBackup: null`) y, al terminar, muestra la papelera y cómo recuperarlo.

Códigos: **200**, **400** (`libraryRoot` inválido o un `defaultFxbName` con
separadores o sin `.fxb`), **404** (plugin inexistente), **409** (sin banco por
defecto o sin `.orig` que descartar) y **422** (no se pudo mover a la papelera;
el `.orig` queda intacto en su sitio).

### `POST /library/banks/export`

Convierte un banco **ya importado** al orden de bytes pedido. Es para los
`.fxb` que un plugin de Windows guardó con su struct nativo (little-endian): el
cargador los lee igual —detecta el orden por `chunkMagic`—, pero otra
herramienta puede exigir el estándar big-endian.

```json
{
  "libraryRoot": "C:\\VFX\\Library",
  "plugin": "MySynth",
  "fileName": "Legacy.fxb",
  "endianness": "little",
  "overwrite": false
}
```

Escribe un archivo **nuevo** al lado del original (`Legacy.fxb` →
`Legacy-le.fxb`, o `-be` para big-endian) y no toca el importado. Solo se
invierten los campos numéricos de 32 bits: la cabecera del banco, la de cada
programa, los parámetros de los `FxCk` y los tamaños de chunk (`FPCh` por
programa y el del banco `FBCh`). Los nombres y los chunks opacos quedan byte a
byte iguales, y el resultado se vuelve a parsear antes de escribirse.

La respuesta trae `source` y `target` (`fileName`, `path`, `size`, `sha256` y la
`bank` interpretada), `changed` (`false` si ya estaba en ese orden y no había
nada que invertir), `fields` (campos reescritos), `programs` y `chunks`. El
banco convertido aparece en la lista y puede fijarse como banco por defecto
como cualquier otro.

Códigos: **200**, **400** (`fileName` con separadores o sin `.fxb`, banco
ausente de la carpeta del plugin, `libraryRoot` inválido o `endianness` que no
sea `big`/`little`), **404** (plugin inexistente), **409** (ya existe el
destino y `overwrite` no es `true`) y **422** (el archivo no es un `.fxb`
válido o su nombre ya declara un orden que no coincide con su contenido).

### `POST /library/banks/inspect`

Valida un `.fxb` y lo compara con los bancos que ya tiene un plugin, **sin
copiar ni modificar nada**. Sin `libraryRoot`/`plugin` solo inspecciona el
archivo.

```json
{
  "sourcePath": "C:\\Banks\\Rhodes.fxb",
  "libraryRoot": "C:\\VFX\\Library",
  "plugin": "MySynth"
}
```

Devuelve `valid`, `bank`, `sha256`, `issues`/`warnings`, la `reference` usada
(explícita o el primer banco del plugin), `compatibility`, el `target` que
tendría y `targetExists`, y `existingBanks[]` con `sameUniqueId` y
`sameFxVersion` por banco. Un archivo que no es un banco VST2 responde **200**
con `valid: false` y los motivos en `issues`; una ruta inválida es **400**, un
plugin inexistente **404** y un `programDirName` roto **422**. No crea
`presets\` si no existe y el origen queda intacto.

## Diálogo nativo

### `POST /system/pick`

Abre un diálogo del sistema en la máquina donde corre el servidor y devuelve las
rutas absolutas elegidas. Lo usan los botones **Elegir carpeta…**, **Elegir
DLL…** y **Añadir archivos…** de la vista.

```json
{
  "kind": "files",
  "title": "Elige los bancos .fxb para importar",
  "extensions": ["fxb"],
  "initialDir": "C:\\Bancos"
}
```

- `kind`: `folder` (carpeta), `file` (un archivo) o `files` (varios, con Ctrl o
  Mayús).
- `title`: opcional, hasta 80 caracteres; vacío usa uno por defecto.
- `extensions`: opcional, hasta 5, **sin punto** (`fxb`, no `.fxb`); se ignoran
  al elegir carpeta.
- `initialDir`: opcional, ruta absoluta de Windows (`C:\…` o `\\servidor\…`)
  donde abrir el diálogo. Si ya no existe se ignora, igual que en el diálogo de
  Windows.

Devuelve `{ "paths": [...] }` en el orden del diálogo. Cancelar **no es un
error**: responde **200** con `paths: []` y la vista no modifica ningún campo.
Un `kind` desconocido, un título largo, una extensión con punto o un
`initialDir` relativo son **400**; dos diálogos a la vez, **409**; y un servidor
que no corre en Windows (no hay `System.Windows.Forms`), **501**.

El diálogo se abre con `powershell.exe -NoProfile -STA` y las rutas vuelven en
base64 por `stdout`, para que acentos y espacios no dependan de la página de
códigos de la consola. La petición HTTP queda abierta mientras el diálogo está
visible; el navegador no puede cerrarlo, así que hay uno como máximo por
servidor.

### `POST /system/paths`

Dice cuáles de las rutas recordadas por la vista siguen en el disco. El
navegador no puede consultarlo, así que lo pregunta al servidor, que ve el mismo
disco: es lo que permite descartar del historial una carpeta renombrada, un
`.fxb` borrado o un DLL desinstalado.

```json
{
  "paths": [
    "C:\\VFX\\Library",
    "C:\\fxbLoader\\vst\\fxbLoader.dll",
    "C:\\Bancos\\Borrado.fxb"
  ]
}
```

- `paths`: hasta 32 rutas absolutas; una lista vacía responde `results: []`.

Devuelve un elemento por ruta, **en el mismo orden**:

```json
{
  "results": [
    { "path": "C:\\VFX\\Library", "exists": true, "isDirectory": true },
    { "path": "C:\\fxbLoader\\vst\\fxbLoader.dll", "exists": true, "isDirectory": false },
    { "path": "C:\\Bancos\\Borrado.fxb", "exists": false, "isDirectory": false }
  ]
}
```

Una ruta que falta **no es un error**: llega con `exists: false` e
`isDirectory: false` y la vista la borra de su historial. `isDirectory` solo
tiene sentido cuando la ruta existe. Una entrada que no es texto, más de 32
rutas o una ruta relativa son **400**; una ruta sin permisos de lectura cuenta
como inexistente, no como fallo de la petición.

## Diferencias deliberadas con el binario

- Si `vfxinfo.txt` no tiene ninguna línea `dll_name`, el original escribe un
  `fxbLoader.config` vacío y crea `presets\`; aquí se rechaza con **422** para
  no dejar un plugin a medio configurar.
- El original trunca cada línea de `vfxinfo.txt` a 127 bytes (`fgets`) y lo
  reescribe entero en modo texto. Aquí solo se sustituye la línea `dll_name` y
  se conservan los bytes y finales de línea del resto.
- El instalador original escribe solo `pluginName = <nombre>`; este módulo
  escribe las cuatro claves con los mismos valores por defecto que aplica la
  DLL (`programDirName = presets`, `loadFxbBank = yes`). El resultado al abrir
  el plugin es idéntico.
- `FUN_00405620`, que el binario aplica al nombre del plugin, solo elimina NULs
  embebidos: no normaliza mayúsculas ni formato, así que se usa el nombre de la
  carpeta tal cual.
- La desinstalación restaura primero y borra `fxbLoader.config` al final (el
  binario lo borra primero) para no perder la marca de instalado si falla una
  restauración.

## Garantías

- **Atómico**: cada escritura usa un temporal en el mismo directorio, `fsync`,
  `rename` y `fsync` del directorio (cuando el sistema lo permite). El temporal
  se borra si algo falla.
- **Sin corrupción de codificación**: lee y escribe `latin1` byte a byte, que
  conserva CP-1252. Nunca escribe UTF-8 ni BOM.
- **Límites del binario**: 63 caracteres por valor, sin `/`, sin caracteres de
  control, `programDirName` no vacío.
- **Detección de cambios externos**: `mtimeMs` en cada lectura; la escritura
  exige el valor vigente.
- **Sin traversal**: `plugin` debe ser un nombre simple, sin separadores.

## Estructura

```
public/                        UI estática (index.html, styles.css; js/ es build)
src/app.setup.ts               resolución y montaje de public/
src/ui/browser/                vista de la UI (DOM + cliente tipado)
src/ui/batch.ts                progreso y resultado del lote para la vista
src/ui/picker.ts               carpetas de partida y suma de rutas del diálogo nativo
src/common/atomic-file.ts      temporales + fsync + rename compartidos
src/common/trash.ts            envía archivos a la papelera (reciclaje, XDG, ~/.Trash)
src/fxb-config/
  fxb-config.constants.ts      límites y literales del binario
  fxb-config.types.ts          contrato, snapshot y errores de dominio
  fxb-config.parser.ts         FUN_10003f50 + FUN_100037a0
  fxb-config.serializer.ts     FUN_100037f0 + validación
  fxb-config.service.ts        E/S atómica y control de mtime
  fxb-config.controller.ts     REST + decoradores OpenAPI
  fxb-config.dto.ts            esquemas y ejemplos de Swagger
  fxb-config.module.ts
src/swagger.ts                 documento OpenAPI (/docs y openapi.json)
src/openapi.ts                 script que escribe openapi.json
src/client/
  api-types.ts                 tipos generados desde openapi.json (npm run client)
  fxb-client.ts                cliente fetch tipado (library + config + system)
  index.ts                     punto de entrada del cliente
src/system/
  picker.types.ts              entrada validada y errores del diálogo
  picker.service.ts            PowerShell + System.Windows.Forms (uno a la vez)
  picker.controller.ts         POST /system/pick + validación
  picker.dto.ts                esquemas y ejemplos de Swagger
  paths.service.ts             comprobación de rutas recordadas (fs.stat)
  paths.controller.ts          POST /system/paths + validación
  paths.dto.ts                 esquemas y ejemplos de Swagger
  system.module.ts
src/library/
  vfxinfo.ts                   análisis y parcheo de vfxinfo.txt
  pe.ts                        lectura de cabeceras PE32/PE32+
  loader-dll.ts                resolución del fxbLoader.dll por defecto
  fxb-bank.ts                  parser y validación de .fxb (VST2)
  library.types.ts             modelo, peticiones y errores
  library.service.ts           scan / install / uninstall / importBanks
  library.controller.ts        REST + decoradores OpenAPI
  library.dto.ts               esquemas y ejemplos de Swagger
  library.module.ts
test/
  fxb-config.test.ts           vectores de la especificación
  fxb-config.service.test.ts   conflictos, atomicidad, CP-1252
  vfxinfo.test.ts              parser de vfxinfo.txt
  pe.test.ts                   arquitecturas PE32/PE32+ y errores de cabecera
  library.service.test.ts      escaneo, compatibilidad, instalación, desinstalación
  library.controller.test.ts   mapeo de errores del controlador
  fxb-bank.test.ts             parser .fxb y compatibilidad
  bank-import.test.ts          importación de bancos por banco y troceada (acumulado y corte)
  banks.import.stream.test.ts  importación NDJSON (eventos por archivo, 200 y validaciones)
  fxb-bank.fixtures.test.ts    parser e importación con bancos .fxb reales
  fixtures.readme.test.ts      tabla del README generada desde el manifiesto y los .fxb
  banks.service.test.ts        importación, referencias y rechazos
  banks.http.test.ts           importación por HTTP
  banks.inspect.test.ts        inspección sin copia y comparación con el plugin
  http.integration.test.ts     Nest completo + supertest (200/400/409)
  openapi.test.ts              esquemas, ejemplos y sincronía de openapi.json
  trash.test.ts                papelera de reciclaje (Windows) y XDG (~/.local/share/Trash)
  library.docs.test.ts         ejemplos de /library contra respuestas reales
  client.test.ts               tipos generados y cliente contra el servidor real
  system.picker.test.ts        validación, exclusión mutua y mapeo de errores del diálogo
  system.paths.test.ts         validación, stat y respuesta de POST /system/paths
  picker.test.ts               carpeta de partida y suma de rutas de la vista
  recents.test.ts              historial de rutas: orden, duplicados, datos corruptos y poda
  ui.test.ts                   estáticos, ids y selectores de la UI contra index.html
  ui.dom.test.ts               parser de HTML y matcher de selectores de ese test
  ui.styles.test.ts            audita styles.css contra index.html (reglas muertas)
  ui.markup.test.ts            audita index.html al revés (ids, clases, data-* y ARIA sin uso)
  helpers/css.ts               parser de CSS, auditoría de selectores y del marcado
  vfx-library.integration.test.ts  DLL real + copia de librería VFX
  synth-bank.fixture.test.ts   importa el banco real de OB-Xd en la librería de prueba
  build-decision.test.ts        decisión de compilación de start.bat (fechas, huérfanos y limpieza)
  library.batch.stream.test.ts  progreso del lote (intercalado y NDJSON por HTTP)
  fxb-bank.performance.test.ts tiempo del parser con los bancos reales de MauSynth y OB-Xd
  banks.import.performance.test.ts  importación completa frente al parser; una petición frente a nueve
  helpers/timing.ts            medición de muestras (mediana, p95, operaciones/s)
  fixtures/vfx-library/        librería de prueba (plugins stub)
  fixtures/fxb/                bancos .fxb reales, manifest derivado, derive-manifest.mjs y tabla del README
  e2e/browser.test.ts          escaneo + instalación + bancos en Chromium (npm run test:e2e)
  helpers/fxb-bank.ts          constructor de .fxb para los tests
  helpers/ui-dom.ts            parser HTML y matcher de los selectores escritos a mano
  helpers/pe.ts                cabeceras PE32/PE32+ mínimas para los tests
  helpers/vfx-plugin.ts        escribe el DLL que declara el vfxinfo de un fixture
```

## Prueba de navegador

[`test/e2e/browser.test.ts`](test/e2e/browser.test.ts) recorre la UI como una
persona, contra el servidor real: arranca `dist/main.js` compilado en un puerto
libre, abre Chromium con Playwright y, sobre una copia temporal del
[fixture de librería](test/fixtures/vfx-library/README.md), **escanea** (3
plugins, 0 instalados), **instala** `OB-Xd` (comprueba el badge, el resumen y
que el `fxbLoader.dll` copiado tiene el SHA-256 del repositorio), abre
**Bancos**, **importa** el banco real `wam-obxd-factory.fxb` y lo deja como banco
por defecto (verifica el `.fxb` copiado y las claves de `fxbLoader.config` en
disco). También comprueba que la carpeta escaneada aparece en el `<datalist>` de
la librería y que el banco importado queda como botón reciente: al pulsarlo con
el cuadro vacío, la vista vuelve a escribir su ruta. Después pulsa **Olvidar**
en esa fila y comprueba que solo se van los bancos recientes: el banco sigue en
el cuadro, la carpeta en su `<datalist>` y solo `fxbLoader.recentBanks` se
borra. En el lote comprueba
también que la vista pinta los pasos internos que
llegan por el flujo («paso 2 de 5 · copiando fxbLoader.dll»): como los eventos
de un plugin llegan dentro de la misma tarea, los recoge con un
`MutationObserver` en vez de leer el texto al final. Al final exige que la
página no haya lanzado errores de JavaScript.

El segundo test comprueba el troceado del lote sin instalar 501 plugins de
verdad: responde al escaneo y a `POST /library/batch/stream` desde Playwright con
un plugin más que el tope, y exige que la vista mande **dos** peticiones (ninguna
por encima de 500, los trozos en orden) y que, mientras la segunda está en vuelo,
la barra siga en «Instalando 501 de 501» con `max` del lote completo y un solo
`<progress>` en la página.

El tercero cubre **cancelar y reanudar**: deja la primera petición del lote en
vuelo (la responde la prueba, no el instalador real), pulsa **Cancelar**, y
exige que el resumen separe lo confirmado de lo pendiente y que aparezca
**Reanudar 2 sin confirmar**. El escaneo posterior dice que Alpha sí terminó, así
que al pulsar el botón la vista manda **solo** `Beta` y `Gamma`, en el orden del
lote; al completarse, el botón desaparece. También exige que la página no haya
lanzado errores de JavaScript.

El cuarto importa **51 bancos reales** (copias del de OB-Xd) contra el servidor
instalado y exige que la vista mande dos peticiones de 50 y 1, que la lista de
resultados tenga 51 filas sin ningún rechazo y que la tabla del plugin acabe con
los 51 bancos. Otro test importa **tres bancos reales en un solo flujo** y
registra cada valor que la vista asigna al `<progress>`: la barra debe pasar por
1, 2 y 3 antes del `end`, no saltar del 0 al total al cerrar la petición. El
quinto simula con Playwright las respuestas del import: el
primer trozo contesta un NDJSON con **50 eventos `bank` rechazados y su `end`**
(no un 422, porque el flujo ya empezó) y el segundo lo mismo con un importado, y
la vista debe seguir con el segundo trozo, acumular los 50 rechazos y el
importado y terminar en «1 importado(s), 50 rechazado(s).». La segunda respuesta
se retiene
para mirar la barra a mitad: con el último archivo aún en vuelo debe mostrar
`value` 50 sobre `max` 51, el estado «Importando 50 de 51 archivo(s)…» y, al
cerrar el import, ocultarse.

El sexto cubre **Reintentar fallidos**: simula un lote en el que fallan dos de
tres plugins, comprueba que el botón aparece con la cuenta, que los reintenta en
el orden del lote y que, si uno vuelve a fallar, se queda en la lista mientras
el otro sale. Retiene la primera respuesta para mirar el progreso a mitad: la
barra muestra `value` 0 sobre `max` 2, el paso dice «paso 1 de 2 · reintentando
…» y el reloj ya cuenta el tiempo del reintento. El escaneo posterior es el del
servidor real.

El séptimo cubre los botones del diálogo (`POST /system/pick`): intercepta esa
petición con Playwright —el navegador de prueba no puede pulsar un diálogo de
Windows— y comprueba el contrato de la vista: **Elegir carpeta…** rellena el
campo y escanea, **Elegir DLL…** propone la carpeta de la ruta escrita, rellena
el campo y vuelve a escanear para validarlo, y **Añadir archivos…** suma los
bancos elegidos a la lista sin borrar lo escrito ni repetir rutas. También exige
que la petición lleve el `kind`, el título, las extensiones y la `initialDir`
que espera el servidor, y que la página no lance errores de JavaScript.

El último test cubre el **historial de rutas**: siembra `localStorage` con una carpeta
viva y otra renombrada, un DLL y un banco borrados, y exige que al cargar solo
quede la carpeta que sigue existiendo, que el historial podado se guarde y que
**Vaciar historial de rutas** (en Opciones avanzadas) pida confirmación
—cancelarla lo conserva— y, al aceptarla, deje los `<datalist>`, los botones de
bancos y las tres claves vacíos sin tocar lo escrito en los campos. El de la
importación por encima del tope comprueba la **×** de un chip: deja los otros
siete y borra el banco elegido también de `localStorage`.

```bash
cd webapp
npx playwright install chromium   # una vez, o --with-deps chromium en Linux
npm run test:e2e
```

Queda fuera de `npm test` y de la cobertura porque necesita el navegador; el
build (`npm run build`) es parte del script. Si algo falla, guarda una captura en
`test-results/` y escribe los logs del servidor, y CI publica esa carpeta como
artefacto.

## Test con la DLL real

[`vfx-library.integration.test.ts`](test/vfx-library.integration.test.ts) copia
una librería a un directorio temporal, instala con el
[`vst/fxbLoader.dll`](../vst/fxbLoader.dll) real (sin pasar `dllSourcePath`) y
comprueba que el archivo copiado tiene el mismo SHA-256, que el respaldo es byte
a byte, que la config y `presets\` se crean y que la desinstalación restaura el
original. Si la DLL no está, el test se marca como omitido.

La librería de [`fixtures/vfx-library`](test/fixtures/vfx-library/README.md)
reproduce el layout real, pero sus DLL de plugin son cabeceras PE32 mínimas.
Para usar una librería VFX de verdad:

```bash
FXB_VFX_LIBRARY="C:\VFX\MiLibreria" npm test
```

Se copia su `plugs\` (lo único que se lee) a un temporal y se elige el primer
plugin compatible con `vfxinfo.txt` sin el cargador; la ruta original nunca se
modifica.
