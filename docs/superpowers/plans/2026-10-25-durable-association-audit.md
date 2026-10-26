# Auditoría durable de asociaciones — Diseño

> Fase posterior acordada junto con la preferencia local de DLL (ver `roadmap.md`).
> Estado: **IMPLEMENTADO** (2026-10-25) tal como se describe en este documento.

## Implementación (2026-10-25)

- `webapp/src/association-audit/`: tipos, servicio de apéndice con `fsync`,
  controlador, DTOs y módulo.
- `POST /library/association-audit/list` y `GET /library/association-audit/stream`
  (este último reutiliza el snapshot con los filtros como query).
- Escritura desde `LibraryService` (instalar y desinstalar el cargador, guardar
  `dll_name`, alta de plugin sin wizard) y `LibraryImportService` (importación,
  reimportación y colisiones enlazadas por `packageSource`).
- Lectura tolerante: las líneas corruptas se saltan; sin almacén, snapshot vacío
  con `exists: false`.
- Tests: `webapp/test/association-audit.service.test.ts` y los contratos de
  `openapi.test.ts` y `openapi.examples.test.ts`, más
  `webapp/test/association-audit.docs.test.ts` con los ejemplos ejecutados
  contra la API real (vacío, instalación, preferencia e importación con
  colisión enlazadas por `packageSource`).

Queda fuera lo listado al final del documento: visor de UI, compresión o
rotación del JSONL y auditoría de más campos de banco.

## Problema

- El log del plugin (`fxbLoader.log`) rotado por tamaño **pierde entradas**:
  no sirve como auditoría durable de cuándo cambió una asociación
  (p. ej. `dll_name`) ni de qué importación la trajo.
- Los cambios de asociación bien guardados por el panel bien derivados de
  importaciones/reimportaciones (con `repairBanks` que toca IDs y
  descriptores) deben quedar rastreables aunque el plugin se elimine,
  se reimporte bajo otra librería o el log rote tres veces por aquí.

## Decisión central

**Un solo almacén durable por librería**: `<libraryRoot>/fxbLoader.audit.jsonl`,
apéndice puro (una línea JSON por evento, con `fsync`), nunca rota ni se
compacta en esta fase. Los eventos de plugin llevan el nombre del plugin como
propiedad de la línea, no como contenedor: sobrevive a que la carpeta
`plugs/<Plugin>` desaparezca o se reimporte.

No se maqueta una base de datos: JSONL apéndice es trivial de respaldar,
diffable y suficiente para los volúmenes esperados (decenas de plugins,
miles de eventos). Si algún día hiciera falta indexarlo, se deriva un índice
en memoria al vuelo al leer el fichero.

## Modelo de datos (una línea por evento)

```jsonc
{
  "ts": "2026-10-25T09:32:11.482Z",     // ISO-8601 UTC
  "kind": "association-change",          // 'association-change' | 'import' | 'reimport' | 'collision'
  "plugin": "AnalogSynth",              // carpeta del plugin tal cual
  "libraryRoot": "C:/vfx/mylib",        // raíz canónica de la librería
  "field": "dll_name",                  // campo asociado ('dll_name' hoy; extensible a IDs de banco)
  "previousValue": "AnalogSynth/AnalogSynth.dll",
  "newValue": "AnalogSynth/fxbLoader.dll",
  // Solo en eventos de import/reimport/collision:
  "packageSource": "C:/downloads/pack.vfxlibrary",
  "collisionPolicy": "skip" | "overwrite",
  "collisionNames": ["OtroPlugin"],
  "repairedBanks": []
}
```

Reglas:

- **Escritura única:** solo los servicios escriben (`association-audit.service.ts`
  con `writeFileAtomic`/apéndice + `fsync`); el navegador nunca puede.
- **`previousValue` desde disco:** al guardar la preferencia DLL se lee el
  valor real de `vfxinfo.txt` antes del parcheo (no el borrador de la UI),
  y si coincide con `newValue` no se escribe evento (no hay cambio).
- **Import enlaza los cambios que causa:** una importación con
  `repairBanks` genera una entrada `import` con el resumen de
  `ImportPackageResult` (nombres importados y reparados) y, si parcheó
  `dll_name`, una `association-change` con el mismo `packageSource` para
  que ambas línea estén vinculadas por `packageSource` (+ `plugin`).
- **Colisiones registradas:** cada elemento de `skippedPlugins` /
  `skippedBanks` se registra como `collision` con la política aplicada,
  incluso si el resto de la importación terminó bien.
- **Eliminación del plugin:** el desinstalador añade una entrada
  `association-change` con `newValue: null` (tombstone) en vez de borrar
  nada — lo eliminado también se audita.
- **Encoding:** los ficheros parciales de la librería se leen como y donde
  el resto del proyecto (`latin1` byte a byte); JSONL es UTF-8 puro, se
  escapan `\u00XX` no válidos con `replace(/[\u0000-\u001F\u0080-\u0100]/g, …)` en el
  serializador si hoy hay rutas con acentos.

## Coexistencia con el log rotado

| | `fxbLoader.log` (existente) | `fxbLoader.audit.jsonl` (nuevo) |
| --- | --- | --- |
| Propósito | línea por operación, legible | evento auditable durable |
| Persistencia | rotada (1 MiB, 7 ficheros) | apéndice, nunca rota |
| Formato | texto cronológico con corchetes | JSONL |
| Alcance | dentro del plugin | por librería, cruza plugins |
| Escritura | `PluginLogService.append` (no bloqueante, degrada) | `AssociationAuditService.append` (no bloqueante, degrada a `false`) |

- **No duplican:** el log sigue narrando para humanos ("se reinstaló X"),
  la auditoría registra el **dado y cambia** ("dll_name pasó de A a B por
  importar `pack.vfxlibrary` con policy `skip`").
- El `detail` del log del plugin puede referenciar la auditoría:
  `[dll-preference] Guardar | audited_ts=…` si se quiere enlazar, pero el
  orden es: escribir en la auditoría **primero**, apilar el log después
  (si rota y pierde la línea de log, la auditoría queda).
- Al reimportar o reindexar la librería NO se limpia el audit: es
  histórico.

## Endpoints (calculados, solo lectura para el navegador)

- `POST /library/association-audit/list`
  - DTO: `{ libraryRoot }` + filtros opcionales `{ plugin?, kind?, from?, to?, limit? }`
  - Response: `{ auditPath, entries: AuditEntry[], total }` (los últimos `limit`, por defecto 200, speudónimo de lectura al final del fichero).
- `GET /library/association-audit/stream` — igual que el snapshot de log, para el visor.
- No exponer `POST` de escritura: solo los servicios internos auditar.

Swagger/DTOs y cliente tipado siguen las convenciones de
`plugin-log` (misma rotación de patterns, mismas suites de docs).

## Suite de tests (a definir al implementar)

- `association-audit.service.test.ts`: apéndice + fsync, filtro por plugin/tipo/fecha, `previousValue: null` tombstone, tolerancia a línea corrupta (salta y sigue).
- `plugin-dll-preference.test.ts`: extender para verificar la entrada del audit en cada guardado real (y ausencia si no cambia nada).
- `library-import.service.test.ts`: verificar las entradas `import`, `association-change` y `collision` enlazadas por `packageSource`.
- E2E de navegador: guardar preferencia → audit contiene el evento; importar con colisión → audit contiene `collision` con la política.

## Fuera de alcance de esta fase

- UI específica de auditoría (el visor puede empezar en el cajón de historial del plugin con un toast si el evento viene del audit).
- Compresión, rotación o compactación del JSONL.
- Auditoría de campos de banco más allá de las reparaciones que ya recoge `ImportPackageResult.repairedBanks`.
