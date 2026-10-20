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
npm test        # compila y ejecuta node:test (unitarios + integración HTTP)
npm run build
npm start       # http://127.0.0.1:3210 (PORT para cambiarlo)
npm run openapi # regenera openapi.json desde los decoradores
npm run client  # openapi + tipos del cliente (src/client/api-types.ts)
```

El servidor escucha solo en loopback: escribe en el disco del usuario.

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

## UI web

Abre <http://127.0.0.1:3210/> con el servidor arrancado. La página permite:

1. escribir la carpeta de la librería (la que contiene `plugs\`) y pulsar
   **Escanear**;
2. ver cada plugin con su estado, compatibilidad con el cargador de 32 bits,
   `pluginName` y si tiene `vfxinfo.txt`; el escaneo valida que el
   `fxbLoader.dll` sea un **PE32 i386** y lee la arquitectura del binario
   original. Los plugins incompatibles (por ejemplo, PE32+ AMD64) se marcan y
   el botón **Instalar** queda deshabilitado con el motivo;
3. **Instalar** o **Desinstalar** con un clic, con el resultado en la misma
   tabla y los errores de la API tal cual (409, 422, etc.);
4. **Instalar todos** / **Desinstalar todos** recorre en lote los plugins
   escaneados compatibles que admiten esa acción, en serie y con **un reintento
   por plugin** ante fallos transitorios (red o 5xx; los 4xx deterministas no se
   repiten). Al terminar muestra el resumen (`N de M`, cuántos fallaron) y un
   desplegable con el error de cada plugin fallido, cada uno con su botón
   **Reintentar** sin repetir el lote entero;
5. **Bancos** abre la vista del plugin: sus `.fxb` con tipo, programas,
   `uniqueID` y `fxVersion`; un formulario para importar rutas absolutas de
   `.fxb` (una por línea, admite las comillas de «copiar como ruta») con el
   resultado por archivo; y el selector de **banco por defecto**, que guarda
   `defaultFxbName` y «cargar al abrir el plugin» en `fxbLoader.config`. Si la
   DLL reescribe el archivo entre medias, el 409 refresca el snapshot y pide
   volver a guardar en vez de pisar los cambios.

La carpeta y la ruta opcional del DLL se guardan en `localStorage`. En
**Opciones avanzadas** se puede indicar otro `fxbLoader.dll`; vacío usa el que
resuelve el servidor. No hay autenticación: la UI y la API solo escuchan en
`127.0.0.1`.

Los estáticos viven en [public/](public/index.html) y se sirven con
`app.useStaticAssets` desde [app.setup.ts](src/app.setup.ts); no hay build de
frontend ni dependencias nuevas. `GET /` devuelve `index.html`, y las rutas
`/library/*` y `/fxb-config` siguen teniendo prioridad sobre los estáticos.

La orquestación del lote está en [public/batch.js](public/batch.js): no toca el
DOM ni conoce `fetch`, recibe las llamadas desde `app.js` y se prueba con dobles
en [test/batch.test.ts](test/batch.test.ts) (orden, reintento por plugin, fallo
tras el reintento y resumen).

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
  `LibraryUninstallRequestDto`, `LibraryBanksImportRequestDto` y
  `LibraryBankInspectRequestDto`; respuestas `LibraryScanResponseDto`,
  `LibraryOperationResponseDto`, `LibraryBanksImportResponseDto` y
  `LibraryBankInspectResponseDto`; banco (`BankInfoDto`, `BankReferenceDto`,
  `BankImportResultDto`, `PluginBankDto`) y errores (`LibraryErrorDto`,
  `LibraryConflictErrorDto`, `LibraryBanksImportErrorDto`). Cada operación trae
  ejemplos de petición y de cada código (**200**, **400**, **404**, **409**,
  **422**), incluidos el plan de `dryRun`, la instalación, la desinstalación y un
  lote de bancos aceptado o rechazado.

Tres tests mantienen la documentación honesta: uno compara `openapi.json` con el
documento generado, otro ejecuta los endpoints reales y comprueba que los
ejemplos tienen exactamente los campos que devuelve la API, y el tercero exige
que los tipos del cliente coincidan con el documento. Si cambias los DTOs o las
respuestas, ejecuta `npm run client` (que ya regenera `openapi.json`).

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
  `library.scan | install | uninstall | importBanks | inspectBank` y
  `config.read | write`.
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
arquitectura (o si el cargador no es PE32 i386), y `null` si el binario no se
pudo inspeccionar; los motivos van en `compatibilityIssues`. No se carga el
DLL entero: solo se leen las cabeceras DOS/PE.

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
escribir: rechaza con **422** un `fxbLoader.dll` que no sea PE32 i386 o un
plugin de 64 bits, sin tocar el disco.

Códigos: **200**, **400** (ruta/nombre inválido, DLL ausente), **404** (plugin
inexistente), **409** (ya instalado sin `force`), **422** (`vfxinfo.txt` sin
línea `dll_name`, cargador que no es PE32 i386 o plugin incompatible).

### `POST /library/uninstall`

```json
{ "libraryRoot": "C:\\VFX\\Library", "plugin": "MySynth" }
```

Mueve el `vfxinfo.txt` modificado a `vfxinfo.loader`, restaura `vfxinfo.tx_`
como `vfxinfo.txt` y borra `fxbLoader.config`. El DLL y los bancos importados
se conservan, igual que en el original.

Códigos: **200**, **404**, **409** (no instalado o sin respaldo).

### `POST /library/banks/list`

```json
{ "libraryRoot": "C:\\VFX\\Library", "plugin": "MySynth" }
```

Devuelve `presetsDir` (según `programDirName`), `presetsDirExists`, `banks[]`
(`fileName`, `size` y la cabecera `bank` ya interpretada) y el snapshot de
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
parseado y los motivos del rechazo.

**Validación de formato** (cabecera VST2 que comprueba `fxHeader::check`):
`chunkMagic` `CcnK`, `byteSize` contra el tamaño real, `fxMagic` `FxBk` o
`FBCh`, versión 1 o 2, `uniqueID`, versión del plugin y, en los `FxBk`, cada
programa (`CcnK`, tamaños de `FxCk`/`FPCh`, coherencia de `uniqueID`). Se
aceptan archivos little-endian y big-endian.

El parser se valida también contra **seis bancos reales** de otros plugins y
sintetizadores (`FBCh` v1 y v2, `FxBk` con programas `FxCk`/`FPCh`, big-endian),
incluido el banco de fábrica de 128 programas de **OB-Xd**, en
[`test/fixtures/fxb/`](test/fixtures/fxb/README.md). Cada fixture lleva su
SHA-256, el origen exacto y el resultado esperado en `manifest.json`; los tests
parsean, comprueban la cabecera de 160 bytes e importan los archivos reales
byte a byte.

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
public/                        UI estática (index.html, app.js, batch.js, styles.css)
src/app.setup.ts               resolución y montaje de public/
src/common/atomic-file.ts      temporales + fsync + rename compartidos
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
  fxb-client.ts                cliente fetch tipado (library + config)
  index.ts                     punto de entrada del cliente
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
  fxb-bank.fixtures.test.ts    parser e importación con bancos .fxb reales
  banks.service.test.ts        importación, referencias y rechazos
  banks.http.test.ts           importación por HTTP
  banks.inspect.test.ts        inspección sin copia y comparación con el plugin
  http.integration.test.ts     Nest completo + supertest (200/400/409)
  openapi.test.ts              esquemas, ejemplos y sincronía de openapi.json
  library.docs.test.ts         ejemplos de /library contra respuestas reales
  client.test.ts               tipos generados y cliente contra el servidor real
  ui.test.ts                   estáticos servidos y API accesible
  vfx-library.integration.test.ts  DLL real + copia de librería VFX
  synth-bank.fixture.test.ts   importa el banco real de OB-Xd en la librería de prueba
  fixtures/vfx-library/        librería de prueba (plugins stub)
  fixtures/fxb/                bancos .fxb reales + manifest de hashes
  helpers/fxb-bank.ts          constructor de .fxb para los tests
  helpers/pe.ts                cabeceras PE32/PE32+ mínimas para los tests
```

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
