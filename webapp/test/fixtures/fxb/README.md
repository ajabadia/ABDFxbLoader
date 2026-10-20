# Fixtures de bancos `.fxb` reales

Bancos creados por **plugins y hosts que no son nuestros**, usados para validar
`parseFxbBank` (y la importación HTTP) contra bytes reales en lugar de contra
archivos que generamos nosotros.

| Archivo | Plugin | Formato | Bytes | Para qué sirve |
|---|---|---|---|---|
| `massive-test-bank.FXB` | Native Instruments Massive | `FBCh`, big-endian, v1 | 2886 | Banco opaco con 128 programas y `chunkSize` de 2726 |
| `rea-comp.FXB` | Cockos ReaComp | `FxBk`, big-endian, v1 | 288 | Banco de parámetros de un programa, `fxVersion` 1100 |
| `nanohost-reeq-opaque-5100.fxb` | Cockos ReaEQ vía Nanohost | `FBCh`, big-endian, v2 | 320 | Versión 2 (con `currentProgram`) y chunk opaco de 160 bytes |
| `wavosaur-reeq-3set.fxb` | Cockos ReaEQ vía Wavosaur | `FxBk`, big-endian, v1 | 248 | Programa con chunk (`FPCh`), `fxVersion` 0 |
| `wavosaur-reeq-4500.fxb` | Cockos ReaEQ vía Wavosaur | `FxBk`, big-endian, v1 | 260 | Mismo plugin, otro export del host |
| `wam-obxd-factory.fxb` | OB-Xd (sintetizador) | `FBCh`, big-endian, v2 | 86 357 | Banco de fábrica real de 128 programas, `currentProgram` 6 |

Los seis se parsean **sin issues ni warnings** con el parser actual; el
manifiesto (`manifest.json`) fija el SHA-256, el tamaño y el resultado exacto de
`parseFxbBank`, así que cualquier cambio de comportamiento se ve como un diff.

## Procedencia

| Repositorio | Commit | Licencia |
|---|---|---|
| <https://github.com/CharlesHolbrow/vst2-preset-parser> (`test/`) | `d6c4e0e985e6e47026b5f60a44458908967449d1` | ISC |
| <https://github.com/nokitakaze/VSTAudioProcessor> (`VSTAudioProcessor.Test/Resources/`) | `3e721c7478e500e792061e1977b85a6b71060fb9` | LGPL-3.0 |
| <https://github.com/webaudiomodules/wam-examples> (`packages/obxd/presets/`) | `2179e50cf7bbc1f038a6e423651d9915505621f8` | MIT (repo); banco de OB-Xd, GPL-3.0 hasta 2.11 |

Son datos de preset (parámetros y chunks) exportados por esos hosts o por el
propio sintetizador, no distribuciones de los plugins. Los nombres se conservan
tal cual, incluidos los `.FXB` en mayúsculas, salvo cuando el original es
genérico (`factory.fxb`), en cuyo caso se antepone el plugin
(`wam-obxd-factory.fxb`).

## Reglas

- Son binarios: `webapp/.gitattributes` excluye `test/fixtures/**` de la
  normalización de finales de línea.
- No se editan a mano. Si se reemplaza uno, hay que actualizar `manifest.json`
  (hash, tamaño y resultado esperado) y el test lo verifica.
- Para añadir otro, cópialo aquí, añade su entrada al manifiesto con el origen y
  ejecuta `npm test`.
