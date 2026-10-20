# Especificación de `fxbLoader.config`

Contrato del archivo de configuración que comparten `fxbLoaderConfig.exe` y
`vst\fxbLoader.dll`, reconstruido por ingeniería inversa y pensado para
implementarse desde la aplicación web.

Fuentes: [fxbLoaderConfig.rea-report.md](fxbLoaderConfig.rea-report.md) y
[fxbLoaderDll.rea-report.md](fxbLoaderDll.rea-report.md).

## 1. Ubicación y nombre

`<plugin_dir>\fxbLoader.config`, junto a la copia de `fxbLoader.dll` que instala
el configurador.

La DLL **no** usa el directorio de trabajo: obtiene su propia ruta con
`GetModuleFileNameA` (`FUN_10004820`), copia esa cadena y reemplaza desde el
último `.` por `.config` (`FUN_10003f50`). Es decir, el nombre del archivo deriva
del nombre de la DLL, no de una constante.

> Caso límite: si el módulo no tuviera `.` en la ruta, `strrchr` devuelve `NULL`
> y la DLL escribiría en una dirección nula. No ocurre con `fxbLoader.dll`, pero
> conviene no renombrar la DLL sin extensión.

## 2. Codificación y formato

| Aspecto | Valor |
|---|---|
| Codificación | ANSI del sistema (CP-1252 en Windows occidental); **sin BOM** |
| Fin de línea | CRLF (`\n` en modo texto de `fprintf`) |
| BOM | No soportado: un BOM UTF-8 haría que la primera clave sea `\xEF\xBB\xBFpluginName` y no coincida |
| Longitud de línea | 300 caracteres (`fgets(buf, 301, f)`); una línea más larga se parte en dos |
| Formato | `clave = valor`, una por línea |
| Comentarios | Todo lo que sigue al primer `/` se descarta |

La lectura y la escritura usan `_fopen`/`_fgets`/`_fprintf` ANSI, no `_wfopen`.
Por eso el archivo no es UTF-8 y **no debe escribirse como UTF-8**.

## 3. Gramática y algoritmo de lectura

```
archivo     := linea*
linea       := texto ("\r\n" | "\n")
texto       := (clave "=" valor)?          ; sin '/' en clave ni valor
clave       := espacios* identificador espacios*
valor       := espacios* texto_libre espacios*
```

Algoritmo exacto (`FUN_10003f50`), por línea:

1. Leer hasta 300 caracteres o fin de línea.
2. Si contiene `/`, truncar ahí (afecta también al valor).
3. Si no contiene `=`, ignorar la línea.
4. Partir por el **primer** `=`; el resto queda en el valor.
5. `trim` de la clave y del valor con esta regla exacta (`FUN_100037a0`):
   - quita espacios (`' '`) al principio;
   - quita espacios, `\r` y `\n` al final;
   - **no** quita tabuladores, comillas ni otros espacios.
6. Comparar la clave de forma **case-sensitive** contra las cuatro conocidas.
   Las claves desconocidas se ignoran.

Consecuencias prácticas:

- `pluginName=Foo.dll`, `pluginName = Foo.dll` y `  pluginName  =  Foo.dll  `
  son equivalentes.
- `\tpluginName = Foo.dll` **no** coincide: el tabulador no se recorta.
- Un valor con `/` se trunca: `C:/banks/x.fxb` se lee como `C:`. Usar `\`.
- Las claves son sensibles a mayúsculas: `PluginName` se ignora.

## 4. Claves

| Clave | Tipo | Valor por defecto si falta | Máx. | Semántica |
|---|---|---|---|---|
| `pluginName` | cadena | `""` | 63 | Nombre del DLL original del plugin (no una ruta, no un nombre comercial). Lo escribe el instalador a partir del `dll_name:` original. |
| `defaultFxbName` | cadena | `""` | 63 | Nombre del archivo `.fxb` preseleccionado en el listbox del plugin. Solo nombre, sin ruta. |
| `programDirName` | cadena | `presets` | 63 | **Nombre** de la subcarpeta de bancos, relativa al directorio del plugin. No es una ruta. |
| `loadFxbBank` | booleano | `yes` (activo) | — | Activa o desactiva la carga del banco al abrir el plugin. |

### 4.1 `pluginName`

El instalador toma la línea `dll_name:` de `vfxinfo.txt`, se queda con el texto
posterior a la **última `/`** y lo guarda aquí antes de reescribir `dll_name`
para apuntar a `fxbLoader.dll`. Ejemplo:

```
vfxinfo.txt (original):   dll_name: VST/MySynth.dll
fxbLoader.config:         pluginName = MySynth.dll
vfxinfo.txt (instalado):  dll_name: VST/fxbLoader.dll
```

Es el dato con el que la DLL localiza el plugin que envuelve. Sin él, el wrapper
no tiene a quién reenviar.

### 4.2 `defaultFxbName`

Se usa para preseleccionar una entrada del listbox:

```c
SendMessageA(listbox, LB_FINDSTRING, 0, defaultFxbName);
SendMessageA(listbox, LB_SETCURSEL, indice, 0);   /* 0 si no se encontró */
```

Si el archivo no existe en `<plugin>\<programDirName>\`, la selección cae en el
primer elemento (índice 0), no en "ninguno".

### 4.3 `programDirName`

Por defecto `presets`. El lector construye dos buffers contiguos con
`FUN_10003ed0`: el nombre en `+0x79c` y el directorio base en `+0x7dc`, ambos con
barra final. El escritor vuelca solo el nombre, así que **el valor del archivo es
el nombre de la carpeta**:

```
plugin_dir\programDirName\*.fxb
```

Es el directorio que el configurador crea al instalar y en el que la DLL lista
los bancos (`FindFirstFileA("%s*.fxb")`). No admite rutas absolutas de forma
fiable: se concatenaría con el directorio del plugin.

### 4.4 `loadFxbBank`

No es un nombre de archivo: es un **booleano**. El parser (`FUN_100032e0`) lo
compara contra una tabla de literales y guarda un flag en `+0x9e4` y la cadena
`yes`/`no` en `+0x9e5`.

| Valor aceptado | Efecto |
|---|---|
| `yes`, `Yes`, `YES`, `true`, `True`, `TRUE`, `1` | activa la carga |
| `no`, `No`, `NO`, `false`, `FALSE`, `0` | desactiva la carga |
| cualquier otro (`False`, `off`, `on`, …) | **no cambia nada**: queda el valor por defecto, que es activo |

Ese último caso es un comportamiento real, no un error de lectura: la función
solo desactiva cuando encuentra un literal falso exacto. Si se quiere desactivar,
hay que escribir `no` o `false`/`FALSE`/`0`, nunca `False`.

## 5. Comportamiento en el arranque

`FUN_10004820` (inicialización) hace, en orden:

1. Poner a cero el estado y fijar `loadFxbBank` activo con la cadena `yes`.
2. `GetModuleFileNameA` sobre el propio DLL.
3. `FUN_10003730` (normalización de la ruta).
4. `FUN_10003f50` (lectura del `.config` y construcción de rutas).

Después, al abrir el editor, `FUN_1000a1d0` lista `<plugin>\<programDirName>\*.fxb`,
añade los nombres al listbox y preselecciona `defaultFxbName`.

El consumidor final del flag `loadFxbBank` (la decisión de aplicar el banco al
arrancar) no está trazado; sí lo está que el flag se guarda y que la carga se
ejecuta con `fxbLoader::loadFile` → `fxBankData::insertTo`.

## 6. Escritura

### 6.1 La DLL (`FUN_100037f0`)

Reescribe el archivo **completo** con `fopen(path, "w")`:

```
pluginName = <valor>\r\n
defaultFxbName = <valor>\r\n
programDirName = <valor>\r\n
loadFxbBank = <yes|no>\r\n
```

- Sin merge: cualquier clave desconocida desaparece.
- Sin escritura atómica: trunca y escribe; un fallo a mitad deja el archivo
  incompleto.
- Orden fijo, siempre las cuatro claves, siempre con CRLF final.

### 6.2 El instalador original (`FUN_00405ee0`)

Escribe **solo** `pluginName = <nombre>`, con `fputs`. El valor arrastra el salto
de línea de la línea `dll_name` original (en modo texto acaba siendo un único
CRLF); si esa era la última línea sin salto, el archivo queda sin salto final.
Si `vfxinfo.txt` no tenía línea `dll_name`, crea un archivo de 0 bytes. Es decir,
el instalador produce un archivo mínimo y válido, pero incompleto según el
contrato.

### 6.3 Lo que debe escribir la aplicación web

1. Leer el archivo existente (si existe).
2. Fusionar los cuatro valores, conservando los que no se cambien.
3. Serializar las cuatro claves, en el orden de la DLL, con CRLF.
4. Escribir de forma atómica (temporal + rename) y verificar el `mtime` antes.

Escribir solo `pluginName` como hace el instalador es aceptable al instalar
desde cero, pero **destruye la selección de banco** si el usuario ya la tenía.

## 7. Reglas de validación para la web

| Regla | Motivo |
|---|---|
| Máximo 63 caracteres por valor | La DLL copia con `strcpy` sin límites a buffers de 64 bytes; un valor largo desborda campos contiguos |
| Sin `/` en claves ni valores | El parser trunca la línea en el primer `/` |
| Sin tabuladores al principio de clave | El `trim` solo quita espacios |
| ASCII imprimible | Evita depender de CP-1252 y de la interpretación del host |
| Sin salto de línea dentro de un valor | Rompe el formato |
| CRLF, sin BOM | Formato nativo del escritor |
| Claves exactas, case-sensitive | El parser no normaliza |

## 8. Implementación de referencia (TypeScript)

Lectura byte-preservante: `latin1` en Node mapea 1:1 los 256 valores de byte, de
modo que un ciclo leer→parsear→serializar→escribir conserva los bytes originales
aunque la decodificación no sea CP-1252 "real". Para texto nuevo, limitarse a
ASCII.

```ts
export interface FxbConfig {
  pluginName: string;
  defaultFxbName: string;
  programDirName: string;
  loadFxbBank: boolean;
}

const DEFAULTS: FxbConfig = {
  pluginName: '',
  defaultFxbName: '',
  programDirName: 'presets',
  loadFxbBank: true,
};

const TRUTHY = new Set(['yes', 'Yes', 'YES', 'true', 'True', 'TRUE', '1']);
const FALSY  = new Set(['no', 'No', 'NO', 'false', 'FALSE', '0']);

function trimKey(s: string) {
  return s.replace(/^ +/, '').replace(/[ \r\n]+$/, '');
}

export function parseConfig(raw: string): FxbConfig {
  const cfg = { ...DEFAULTS };

  for (const line of raw.split('\n')) {
    let text = line;
    const slash = text.indexOf('/');
    if (slash !== -1) text = text.slice(0, slash);

    const eq = text.indexOf('=');
    if (eq === -1) continue;

    const key = trimKey(text.slice(0, eq));
    const value = trimKey(text.slice(eq + 1));

    switch (key) {
      case 'pluginName':     cfg.pluginName = value; break;
      case 'defaultFxbName': cfg.defaultFxbName = value; break;
      case 'programDirName': cfg.programDirName = value; break;
      case 'loadFxbBank':
        if (TRUTHY.has(value)) cfg.loadFxbBank = true;
        else if (FALSY.has(value)) cfg.loadFxbBank = false;
        /* valor desconocido: se deja el valor por defecto (true) */
        break;
    }
  }
  return cfg;
}

export function serializeConfig(cfg: FxbConfig): string {
  const check = (v: string) => {
    if (v.length > 63) throw new Error('valor demasiado largo (máx. 63)');
    if (v.includes('/') || /[\r\n]/.test(v)) throw new Error('valor no válido');
  };
  check(cfg.pluginName);
  check(cfg.defaultFxbName);
  check(cfg.programDirName);
  if (!cfg.programDirName) throw new Error('programDirName no puede estar vacío');

  return [
    `pluginName = ${cfg.pluginName}`,
    `defaultFxbName = ${cfg.defaultFxbName}`,
    `programDirName = ${cfg.programDirName}`,
    `loadFxbBank = ${cfg.loadFxbBank ? 'yes' : 'no'}`,
  ].join('\r\n') + '\r\n';
}
```

Escritura atómica sugerida: escribir en `fxbLoader.config.tmp` en el mismo
directorio, `fsync`, y `rename` sobre el destino. Antes, comparar `mtime` con el
leído; si cambió, abortar y releer (la DLL pudo haber guardado).

## 9. Vectores de prueba

| # | Entrada | Resultado esperado |
|---|---|---|
| 1 | archivo vacío | defaults: `''`, `''`, `presets`, `true` |
| 2 | `pluginName = MySynth.dll` (sin CRLF) | `pluginName = 'MySynth.dll'`, resto defaults |
| 3 | `  pluginName  =  A.dll  \r\n` | `pluginName = 'A.dll'` |
| 4 | `pluginName = A/B.dll` | `pluginName = 'A'` (truncado en `/`) |
| 5 | `PluginName = X.dll` | ignorado |
| 6 | `loadFxbBank = False` | `true` (no coincide con ningún literal) |
| 7 | `loadFxbBank = NO` | `false` |
| 8 | `programDirName =` (vacío) | `''` — la DLL construye una ruta degenerada; la web debe rechazarlo, no sustituirlo en silencio |
| 9 | línea de 400 caracteres | se procesa como dos líneas |
| 10 | `\xEF\xBB\xBFpluginName = A.dll` | ignorado (BOM delante de la clave) |

## 10. Evidencia

| Dato | Origen |
|---|---|
| Ruta y parseo | `FUN_10003f50`, `0x10003f50` |
| `trim` exacto | `FUN_100037a0`, `0x100037a0` |
| Construcción de rutas | `FUN_10003ed0`, `0x10003ed0` |
| Booleano `loadFxbBank` | `FUN_100032e0`, `0x100032e0`; tabla de literales en `0x1001d680`–`0x1001d6f0` |
| Escritura completa | `FUN_100037f0`, `0x100037f0` |
| Inicialización | `FUN_10004820`, `0x10004820` |
| Listado y preselección | `FUN_1000a1d0`, `0x1000a1d0` |
| `pluginName` del instalador | `FUN_00405ee0` en el informe del EXE |

## 11. Límites de esta especificación

- No se ha trazado el consumidor del flag `loadFxbBank` que decide aplicar el
  banco al arrancar; la semántica "activa/desactiva" se deduce del nombre y de
  los literales aceptados.
- El comportamiento con valores de más de 63 caracteres se deduce de los
  tamaños de buffer y de los `strcpy` sin comprobación; no se ha ejecutado el
  binario para provocar el desbordamiento.
- La interpretación de CP-1252 es la habitual en Windows occidental; en otras
  configuraciones regionales el host podría usar otra página de códigos ANSI.
