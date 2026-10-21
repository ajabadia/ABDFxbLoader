# Fixtures de bancos `.fxb` reales

Bancos creados por **plugins y hosts que no son nuestros**, usados para validar
`parseFxbBank` (y la importación HTTP) contra bytes reales en lugar de contra
archivos que generamos nosotros. La única excepción es `massive-fpch-bank.fxb`,
ensamblado con programas reales de Massive porque no hay bancos `FxBk` con
programas `FPCh` publicados de los que fiarse (ver *El fixture FPCh*).

| Archivo | Plugin | Formato | Bytes | Para qué sirve |
|---|---|---|---|---|
| `massive-test-bank.FXB` | Native Instruments Massive | `FBCh`, big-endian, v1 | 2886 | Banco opaco con 128 programas y `chunkSize` de 2726 |
| `massive-fpch-bank.fxb` | Massive, ensamblado (ver abajo) | `FxBk`, big-endian, v1 | 5724 | Dos programas `FPCh` reales, chunks de 2718 y 2730 bytes |
| `rea-comp.FXB` | Cockos ReaComp | `FxBk`, big-endian, v1 | 288 | Banco de un programa `FxCk` de 19 parámetros, `fxVersion` 1100 |
| `nanohost-reeq-opaque-5100.fxb` | Cockos ReaEQ vía Nanohost | `FBCh`, big-endian, v2 | 320 | Versión 2 (con `currentProgram`) y chunk opaco de 160 bytes |
| `wavosaur-reeq-3set.fxb` | Cockos ReaEQ vía Wavosaur | `FxBk`, big-endian, v1 | 248 | Programa `FxCk` de 9 parámetros, `fxVersion` 0 |
| `wavosaur-reeq-3set-le.fxb` | El mismo banco, en **little-endian** | `FxBk`, little-endian, v1 | 248 | El mismo export con los enteros y floats invertidos: es el caso de un plugin que guarda su struct nativo sin convertir |
| `wavosaur-reeq-4500.fxb` | Cockos ReaEQ vía Wavosaur | `FxBk`, big-endian, v1 | 260 | Programa `FxCk` de 12 parámetros, otro export del host |
| `wam-obxd-factory.fxb` | OB-Xd (sintetizador) | `FBCh`, big-endian, v2 | 86 357 | Banco de fábrica real de 128 programas, `currentProgram` 6 |
| `mausynth-az-bank.fxb` | MauSynth (sintetizador) | `FxBk`, big-endian, **v2** | 34 156 | 100 programas `FxCk` con nombre propio y parámetros float; el único `FxBk` de versión 2, con `currentProgram` 0 |

Los nueve se parsean **sin issues ni warnings** con el parser actual; el
manifiesto (`manifest.json`) fija el SHA-256, el tamaño y el resultado exacto de
`parseFxbBank`, así que cualquier cambio de comportamiento se ve como un diff.

## Procedencia

| Repositorio | Commit | Licencia |
|---|---|---|
| <https://github.com/CharlesHolbrow/vst2-preset-parser> (`test/`) | `d6c4e0e985e6e47026b5f60a44458908967449d1` | ISC |
| <https://github.com/nokitakaze/VSTAudioProcessor> (`VSTAudioProcessor.Test/Resources/`) | `3e721c7478e500e792061e1977b85a6b71060fb9` | LGPL-3.0 |
| <https://github.com/webaudiomodules/wam-examples> (`packages/obxd/presets/`) | `2179e50cf7bbc1f038a6e423651d9915505621f8` | MIT (repo); banco de OB-Xd, GPL-3.0 hasta 2.11 |
| <http://bji.yukihotaru.com/vst/MauSynth%20AZ%20bank.fxb> (AZur Studio, descarga directa, consultado el 2026-10-20) | — | CC0-1.0 (nota `#CCZero PublicDomain (CC01.0)` en la ficha del propio banco) |

Son datos de preset (parámetros y chunks) exportados por esos hosts o por el
propio sintetizador, no distribuciones de los plugins. Los nombres se conservan
tal cual, incluidos los `.FXB` en mayúsculas, salvo cuando el original es
genérico (`factory.fxb`) o trae espacios (`MauSynth AZ bank.fxb`), en cuyo caso
se antepone el plugin en minúsculas (`wam-obxd-factory.fxb`,
`mausynth-az-bank.fxb`).

### El fixture little-endian

`wavosaur-reeq-3set-le.fxb` es `wavosaur-reeq-3set.fxb` con cada entero y float
de 32 bits invertido; los nombres y los chunks opacos quedan byte a byte iguales.
No es un archivo publicado por Wavosaur ni por ReaEQ: es **el mismo banco real
re-serializado** en el orden que escribe un plugin de Windows que guarda su
struct nativo sin pasarlo a big-endian, que es el camino que el parser acepta con
`endianness: 'little'`.

El manifiesto lo marca con `source.derivedFrom` y `source.method`, y el test
`el fixture little-endian es un banco real con los enteros invertidos` recorre
ambos archivos campo a campo para comprobar que solo cambia el orden de bytes.

Se regenera (y produce exactamente el mismo archivo) con:

```bash
node test/fixtures/fxb/make-little-endian.mjs \
  test/fixtures/fxb/wavosaur-reeq-3set.fxb \
  test/fixtures/fxb/wavosaur-reeq-3set-le.fxb
```

### El fixture FPCh

Ninguno de los bancos publicados que hemos podido verificar trae programas
`FPCh`: los hosts que exportan estos plugins escriben un chunk de banco entero
(`FBCh`), y los bancos de parámetros sueltos son `FxCk`. Por eso
`massive-fpch-bank.fxb` se **ensambla** con dos programas `FPCh` reales
exportados por Massive —`massive-init.fxp` y `massive-test-patch.fxp`, copiados
tal cual del repositorio de origen—: un host que guarda un banco de un plugin
con programas chunk escribe exactamente esa cabecera `FxBk` y copia después cada
chunk sin tocarlo (`numPrograms` 2, `fxID` NiMa, `fxVersion` 1, `byteSize` =
tamaño − 8). No se modifica ni un byte de los programas; solo se antepone la
cabecera del banco. Los dos programas de origen (`massive-init.fxp`, 2778
bytes, y `massive-test-patch.fxp`, 2790 bytes) se guardan en este mismo
directorio para que la regeneración no dependa de la red.

El manifiesto lo declara con `source.programs` (los dos `.fxp` que viajan en
este directorio) y `source.method`.

Se regenera (y produce exactamente el mismo archivo) con:

```bash
node test/fixtures/fxb/make-fpch-bank.mjs \
  test/fixtures/fxb/massive-fpch-bank.fxb \
  test/fixtures/fxb/massive-init.fxp \
  test/fixtures/fxb/massive-test-patch.fxp
```

### Tamaños declarados

Cada entrada del manifiesto lleva un bloque `programs` obligatorio:

```json
"programs": {
  "count": 2,
  "fxck": 0,
  "fpch": 2,
  "params": null,
  "chunkBytes": { "min": 2718, "max": 2730 },
  "byteSizeTotal": 5552
}
```

`count` son los programas que debe recorrer el banco (`fxck` + `fpch`),
`params` resume los `numParams` de los `FxCk` (total y rango) y `chunkBytes` el
`chunkSize` de los `FPCh`; los `FBCh` opacos declaran todo a cero y `null`,
porque no llevan programas. Los tests recorren los tamaños que declara el
propio archivo y comprueban, para **todos** los fixtures a la vez:

- que `byteSize === 48 + 4 × numParams` en cada `FxCk` y
  `byteSize === 52 + chunkSize` en cada `FPCh`;
- que la suma de los `byteSize` y los rangos de parámetros y chunks coinciden
  con el manifiesto, y que `numPrograms` de la cabecera cuadra;
- que los programas cubren el archivo exacto y que el banco declara
  `tamaño − 8` bytes.

El bloque **no se escribe a mano**: sale de los propios bytes.
`derive-programs.mjs` recorre cada `.fxb` con los tamaños que declara el archivo
y el test `el manifiesto coincide con los bloques programs derivados de los
.fxb` exige que `manifest.json` sea exactamente lo generado. Si el banco no se
puede recorrer entero (truncado, un programa con `fxMagic` desconocido o bytes
de más), el script falla en vez de inventar un bloque.

```bash
node test/fixtures/fxb/derive-programs.mjs          # imprime los bloques derivados
node test/fixtures/fxb/derive-programs.mjs --check  # falla si el manifiesto se desvía
node test/fixtures/fxb/derive-programs.mjs --write  # reescribe solo esos bloques
```

`--write` sustituye el valor de `programs` de cada entrada y deja el resto del
manifiesto byte a byte igual; una entrada ya sincronizada no se toca.

Un banco sin bloque `programs` no pasa el test, así que no se puede añadir uno
sin validar sus programas. Los dos caminos tienen además su test de mutación
(un `FxCk` con `numParams` cambiado y un `FPCh` con `chunkSize` de más) para que
la comprobación no pase por vacuidad, y el script tiene los suyos: un manifiesto
con un solo byte de diferencia debe fallar en `--check`, y `--write` debe
devolverlo al contenido versionado sin tocar nada más.

## Reglas

- Son binarios: `webapp/.gitattributes` excluye `test/fixtures/**` de la
  normalización de finales de línea.
- No se editan a mano. Si se reemplaza uno, hay que actualizar `manifest.json`
  (hash, tamaño y resultado esperado) y regenerar el bloque `programs` con
  `node test/fixtures/fxb/derive-programs.mjs --write`; el test verifica ambas
  cosas.
- Cada entrada declara `source.repo` + `commit` + `path` (archivo publicado en
  un repositorio), `source.url` + `retrieved` (descarga directa de una web) o
  `source.derivedFrom` (derivado de otro fixture del manifiesto), y siempre
  `license` y `plugin`; el test lo comprueba. Si el banco se ensambla con
  programas sueltos, añade `source.programs` (los `.fxp` que viajan en el
  directorio) y `source.method`, y el test comprueba que existen.
- Para añadir otro, cópialo aquí, añade su entrada al manifiesto con el origen y
  ejecuta `npm test`.
