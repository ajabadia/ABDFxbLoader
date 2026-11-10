# Roadmap - ABDfxbloader

## Objetivo
Mejorar mantenibilidad, testabilidad y DX sin romper funcionalidad. Todo debe pasar tests y `npm run client`.

## Principios
- **Estructura canónica**: agrupar por feature/dominio, no por tipo. Evitar `utils/` genérico.
- **Dividir monolíticos**: extraer módulos cohesivos, mantener comportamiento idéntico.
- **Tests primero**: antes/después de cada extracción, `npm test` debe seguir en verde.
- **Sin cambios funcionales**: refactor puro salvo mejoras explícitas acordadas.
- **Tipos OpenAPI**: usar siempre `src/client/api-types.ts`.

## Monolíticos detectados
| Archivo | Líneas | Acción |
|---------|--------|--------|
| `src/ui/browser/main.ts` | 7723 | **PRIORITARIO** - Dividir en módulos por feature |
| `src/library/library.service.ts` | 2717 | Dividir por subdominios (banks, plugins, import, audit) |
| `src/library/library.dto.ts` | 2521 | Agrupar por feature o mantener si muy acoplado |
| `src/library/library.controller.ts` | 2114 | Dividir por rutas/feature |
| `src/capture/capture.service.ts` | 1313 | Evaluar extracción |
| `src/wizard/wizard.service.ts` | 1083 | Evaluar extracción |

*(api-types.ts es generado, no dividir)*

## Fase 1: Dividir `main.ts` (UI)

### Estructura propuesta (canónica)
```
src/ui/browser/
├── app/
│   ├── bootstrap.ts      # init, wiring, bootLibrary
│   ├── router.ts         # navegación/vistas
│   └── shell.ts          # layout, drawers, toasts
├── features/
│   ├── library/          # biblioteca, raíz, estado
│   │   ├── index.ts
│   │   ├── state.ts
│   │   └── handlers.ts
│   ├── import/           # importación de paquetes/bancos
│   │   ├── index.ts
│   │   ├── handlers.ts
│   │   └── selection.ts
│   ├── banks/            # gestión de bancos
│   ├── plugins/          # plugins, filtros
│   ├── audit/            # auditoría de datos
│   ├── settings/         # ajustes (librería, VM, etc.)
│   ├── capture/          # captura/wizards
│   ├── vmachine/         # unidad VM
│   └── batch/            # acciones por lote
├── shared/
│   ├── api/              # fetch helpers, errors
│   ├── dom/              # helpers DOM (ya existe dom.ts)
│   ├── format/           # formateo
│   └── utils/            # utilidades puras
└── main.ts               # entry point mínimo (solo import + bootstrap)
```

### Plan de ejecución
1. **Inventario** (1-2h): extraer funciones por sección con `grep -n "^function\|^async function"` y agrupar por feature. Identificar estado global.
2. **Crear estructura**: carpetas + `index.ts` con re-exports.
3. **Extraer `shared/api`**: unificar fetch, manejo de `msg.apiError`, timeouts. Migrar llamadas una por una.
4. **Extraer features pequeños primero**: `settings`, `vmachine` (ya parcialmente aislados). Verificar tests.
5. **Extraer `import` y `banks`**: con lógica compleja (selección, resumen). Tests tras cada bloque.
6. **Extraer resto**: `audit`, `plugins`, `library`, `capture`, `batch`.
7. **Reducir `main.ts`**: dejar solo bootstrap + wiring. Objetivo < 500 líneas.
8. **Verificación**: `npm run client && npm test` en verde.

## Fase 2: Dividir backend monolíticos

### `library.service.ts` (2717 líneas)
Dividir por:
- `library/banks/` - operaciones con bancos (.fxb)
- `library/plugins/` - plugins, validación
- `library/import/` - import-package
- `library/audit/` - auditoría
- `library/roots/` - gestión de raíces de librería

Mantener facade `library.service.ts` que delega para no romper DI.

### `library.controller.ts` (2114) y `library.dto.ts` (2521)
Agrupar DTOs por feature en subcarpetas o mantener pero con imports organizados. Controlador dividir por rutas.

## Fase 3: Mejoras transversales

- [ ] **Test paridad i18n**: comparar claves + marcadores `{n}` entre `es.ts` y `en.ts`. Fallar si difieren.
- [ ] **Detección hardcoded strings**: script para detectar `textContent = '`, `innerHTML = '` sin i18n (warning en CI local).
- [ ] **Unificar API client**: `shared/api/client.ts` con timeout/abort, tipado estricto.
- [ ] **Error handling UI**: toast global + captura errores no controlados.
- [ ] **Accesibilidad**: auditoría básica (focus trap en modales/drawers, aria-live).
- [ ] **Virtualización**: evaluar para listas largas si necesario.

## Criterios de aceptación
- Todos los tests pasan (`npm test`)
- `npm run client` genera tipos sin errores
- Funcionalidad idéntica (manual smoke test en puntos clave)
- Sin archivos > 1000 líneas en UI (objetivo). Backend >1500 justificar o dividir.
- Estructura canónica (feature-based)
- Sin imports circulares

## Notas
- Trabajar por commits lógicos (aunque usuario no pida push, mantener commits claros)
- Ejecutar tests tras cada extracción significativa
- Si hay duda sobre extraer, preferir extraer con barrel exports
- Mantener compatibilidad con imports existentes durante migración
