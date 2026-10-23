# Fixtures de bancos `.fxb` reales

Bancos creados por **plugins y hosts que no son nuestros**, usados para validar
`parseFxbBank` (y la importación HTTP) contra bytes reales en lugar de contra
archivos que generamos nosotros. La única excepción es `massive-fpch-bank.fxb`,
ensamblado con programas reales de Massive porque no hay bancos `FxBk` con
programas `FPCh` publicados de los que fiarse (ver *El fixture FPCh*).

La tabla se genera desde `manifest.json` y el tamaño real de cada `.fxb`; el
bloque entre los marcadores no se edita a mano (ver *Reglas*).

<!-- fixtures:tabla:inicio -->
| Archivo | Plugin | Formato | Bytes | Para qué sirve |
| --- | --- | --- | ---: | --- |
| `massive-test-bank.FXB` | Native Instruments Massive (banco de prueba de 128 programas) | `FBCh`, big-endian, v1 | 2 886 | Banco opaco con 128 programas y `chunkSize` de 2726 |
| `massive-fpch-bank.fxb` | Native Instruments Massive (banco de dos programas FPCh reales, chunks opacos de 2718 y 2730 bytes) | `FxBk`, big-endian, v1 | 5 724 | Dos programas `FPCh` reales, chunks de 2718 y 2730 bytes |
| `rea-comp.FXB` | Cockos ReaComp | `FxBk`, big-endian, v1 | 288 | Banco de un programa `FxCk` de 19 parámetros, `fxVersion` 1100 |
| `nanohost-reeq-opaque-5100.fxb` | Cockos ReaEQ, banco opaco exportado por Nanohost | `FBCh`, big-endian, v2 | 320 | Versión 2 (con `currentProgram`) y chunk opaco de 160 bytes |
| `wavosaur-reeq-3set.fxb` | Cockos ReaEQ, banco de parámetros exportado por Wavosaur | `FxBk`, big-endian, v1 | 248 | Programa `FxCk` de 9 parámetros, `fxVersion` 0 |
| `wavosaur-reeq-3set-le.fxb` | Cockos ReaEQ, banco de parámetros exportado por Wavosaur (el mismo banco, en little-endian) | `FxBk`, little-endian, v1 | 248 | El mismo export con los enteros y floats invertidos: es el caso de un plugin que guarda su struct nativo sin convertir |
| `wavosaur-reeq-4500.fxb` | Cockos ReaEQ, otra versión del export de Wavosaur | `FxBk`, big-endian, v1 | 260 | Programa `FxCk` de 12 parámetros, otro export del host |
| `wam-obxd-factory.fxb` | OB-Xd (sintetizador virtual-analógico de discoDSP), banco de fábrica de 128 programas | `FBCh`, big-endian, v2 | 86 357 | Banco de fábrica real de 128 programas, `currentProgram` 6 |
| `mausynth-az-bank.fxb` | MauSynth (Pekka Kauppila), sintetizador analógico virtual gratuito para Windows | `FxBk`, big-endian, v2 | 34 156 | 100 programas `FxCk` con nombre propio y parámetros float; el único `FxBk` de versión 2, con `currentProgram` 0 |
<!-- fixtures:tabla:fin -->

## Procedencia

| Archivo | Repositorio | Commit | Licencia |
| --- | --- | --- | --- |
| `massive-test-bank.FXB` | https://github.com/CharlesHolbrow/vst2-preset-parser (`test/massive-test-bank.FXB`) | `d6c4e0e985e6e47026b5f60a44458908967449d1` | ISC |
| `massive-fpch-bank.fxb` | https://github.com/CharlesHolbrow/vst2-preset-parser (`test/init.FXP` + `test/massive-test-patch.FXP`, ensamblados) | `d6c4e0e985e6e47026b5f60a44458908967449d1` | ISC |
| `rea-comp.FXB` | https://github.com/CharlesHolbrow/vst2-preset-parser (`test/rea-comp.FXB`) | `d6c4e0e985e6e47026b5f60a44458908967449d1` | ISC |
| `nanohost-reeq-opaque-5100.fxb` | https://github.com/nokitakaze/VSTAudioProcessor (`VSTAudioProcessor.Test/Resources/nanohost-reeq-opaque-5100.fxb`) | `3e721c7478e500e792061e1977b85a6b71060fb9` | LGPL-3.0 |
| `wavosaur-reeq-3set.fxb` | https://github.com/nokitakaze/VSTAudioProcessor (`VSTAudioProcessor.Test/Resources/wavosaur-reeq-3set.fxb`) | `3e721c7478e500e792061e1977b85a6b71060fb9` | LGPL-3.0 |
| `wavosaur-reeq-3set-le.fxb` | derivado de `wavosaur-reeq-3set.fxb` (enteros y floats de 32 bits invertidos) | `3e721c7478e500e792061e1977b85a6b71060fb9` (heredada del banco original) | LGPL-3.0 |
| `wavosaur-reeq-4500.fxb` | https://github.com/nokitakaze/VSTAudioProcessor (`VSTAudioProcessor.Test/Resources/wavosaur-reeq-4500.fxb`) | `3e721c7478e500e792061e1977b85a6b71060fb9` | LGPL-3.0 |
| `wam-obxd-factory.fxb` | https://github.com/webaudiomodules/wam-examples (`packages/obxd/presets/factory.fxb`) | `2179e50cf7bbc1f038a6e423651d9915505621f8` | MIT (repo); banco de OB-Xd, GPL-3.0 hasta 2.11 |
| `mausynth-az-bank.fxb` | http://bji.yukihotaru.com/vst/MauSynth%20AZ%20bank.fxb (AZur Studio, descarga directa, consultado el 2026-10-20) | — | CC0-1.0 |

Los nueve se parsean **sin issues ni warnings** con el parser actual; el
manifiesto (`manifest.json`) fija el SHA-256, el tamaño y el resultado exacto de
`parseFxbBank`, así que cualquier cambio de comportamiento se ve como un diff.

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

Cada entrada del manifiesto lleva `size`, `sha256` y un bloque `programs`
obligatorio:

```json
"programs": {
  "count": 2,
  "fxck": 0,
  "fpch": 2,
  "params": null,
  "chunkBytes": { "min": 2718, "max": 2730 },
  "byteSizeTotal": 5552
},
"size": 5724,
"sha256": "e17d11bc0d6a0d5dd93cad596aa2765ce0311d290f8050d8cc92d713bbe6ac66"
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

Ninguno de esos tres campos **se escribe a mano**: salen de los propios bytes.
`derive-manifest.mjs` calcula `size` y `sha256` del archivo, recorre el banco con
los tamaños que declara cada programa y el test
`el manifiesto coincide con lo derivado de los .fxb: size, sha256 y programs`
exige que `manifest.json` sea exactamente lo generado. Una entrada nueva puede
declarar solo `file`, `source` y `expected`: `--write` **inserta** `size`,
`sha256` y `programs` detrás de `file` si aún no están, con la indentación del
manifiesto. Si el banco no se puede recorrer entero (truncado, un programa con
`fxMagic` desconocido o bytes de más), el script falla en vez de inventar un
bloque.

```bash
node test/fixtures/fxb/derive-manifest.mjs          # imprime lo derivado
node test/fixtures/fxb/derive-manifest.mjs --check  # falla si el manifiesto se desvía
node test/fixtures/fxb/derive-manifest.mjs --write  # reescribe o añade esos campos
```

`--write` sustituye el valor de `size`, `sha256` y `programs` de cada entrada,
añade los que falten y deja el resto del manifiesto byte a byte igual; una
entrada ya sincronizada no se toca. `--check` sí los echa en falta
(`manifiesto ausente`), así que un banco no se puede dar por bueno sin validar
sus programas. Los dos caminos tienen además su test de mutación
(un `FxCk` con `numParams` cambiado y un `FPCh` con `chunkSize` de más) para que
la comprobación no pase por vacuidad, y el script tiene los suyos: un manifiesto
con un solo byte de diferencia en `size`, `sha256` o `programs` debe fallar en
`--check`, y `--write` debe devolverlo al contenido versionado sin tocar nada
más.

### Tabla del README

La tabla de arriba también se genera: `render-readme-table.mjs` lee el orden,
`source.plugin` y `purpose` de `manifest.json`, y saca de la cabecera y los
bytes de cada `.fxb` el formato (`FxBk`/`FBCh`, orden de bytes y versión) y el
tamaño. Después compone las filas entre los marcadores `fixtures:tabla:inicio`
y `fixtures:tabla:fin`. La celda «Bytes» no se escribe a mano: si el manifiesto
declara un tamaño distinto del archivo, el script falla en vez de publicar el
número equivocado. `--check` compara el bloque completo y señala la fila que se
desvía; `--write` sustituye solo ese bloque y deja el resto del README byte a
byte igual.

```bash
node test/fixtures/fxb/render-readme-table.mjs          # imprime la tabla
node test/fixtures/fxb/render-readme-table.mjs --check  # falla si el README se desvía
node test/fixtures/fxb/render-readme-table.mjs --write  # regenera la tabla
```

## Reglas

- Son binarios: `webapp/.gitattributes` excluye `test/fixtures/**` de la
  normalización de finales de línea.
- No se editan a mano. Si se reemplaza uno, hay que actualizar `manifest.json`
  (origen y resultado esperado) y regenerar `size`, `sha256` y `programs` con
  `node test/fixtures/fxb/derive-manifest.mjs --write`; el test verifica que los
  tres coinciden con los bytes.
- Cada entrada declara `source.repo` + `commit` + `path` (archivo publicado en
  un repositorio), `source.url` + `retrieved` (descarga directa de una web) o
  `source.derivedFrom` (derivado de otro fixture del manifiesto), y siempre
  `license` y `plugin`; el test lo comprueba. Si el banco se ensambla con
  programas sueltos, añade `source.programs` (los `.fxp` que viajan en el
  directorio) y `source.method`, y el test comprueba que existen.
- Para añadir otro, cópialo aquí y añade su entrada al manifiesto con `file`,
  `source`, `expected` y un `purpose` breve (ningún número); ejecuta
  `node test/fixtures/fxb/derive-manifest.mjs --write` y el script calcula e
  inserta `size`, `sha256` y `programs` desde los bytes. Después regenera la
  tabla con `node test/fixtures/fxb/render-readme-table.mjs --write`. Los tests
  fallan si falta un campo derivado, el propósito o si la tabla no coincide con
  el manifiesto y los archivos.
