# Tabla reutilizable e historial del plugin — Plan de implementación

> **Para agentes de implementación:** usa la skill `executing-plans` para llevar a cabo este plan tarea a tarea. Cada paso se marca con casillas.

**Objetivo:** Crear una base común de tabla configurable por vista y migrar a ella el panel deslizante Historial de operaciones del plugin, preparando una futura migración compatible de la tabla principal.

**Arquitectura:** Mantener la aplicación actual en TypeScript y DOM nativo, sin añadir dependencias. Separar la transformación tipada de filas (ordenación, búsqueda, filtros y paginación) de la definición declarativa de columnas y del renderizador DOM; configurar Historial mediante esa interfaz. La futura tabla principal podrá adoptar el mismo contrato cuando le corresponda, sin migrarla ahora ni forzar cambios en sus controles.

**Stack:** TypeScript, HTML semántico, CSS existente y node:test/Playwright ya incluidos en el proyecto.

**Spec:** Acuerdo aprobado en conversación: piloto solo en el panel «Historial» de operaciones del plugin; tabla principal al final; datos actuales ya estructurados en `timestamp`, `action`, `summary`, `detail`; búsqueda de campos mostrados; paginación inicial de 100; configuración inicial por vista, sin persistencia; primer clic ascendente y clic repetido invierte; columna activa destacada con CSS e indicador triangular; permitir columnas ordenables/no ordenables, filtros configurables, celdas personalizadas y enlaces; futura migración retrocompatible.

## Restricciones globales

- No alterar formato ni procedimientos que escriben el log: `PluginLogService.read` ya entrega entradas estructuradas.
- No migrar la tabla principal ni otras tablas en el piloto.
- No persistir ordenación, búsqueda, filtros ni paginación entre aperturas.
- Mantener la ruta, el foco/teclado, estados vacío/error/cargando, metadatos del log y enlaces existentes del cajón.
- No añadir dependencias ni descartar/cambiar trabajo local preexistente.
- El estado inicial será por vista y no global compartido.

## Foco de revisión

- Fechas inválidas o vacías: orden determinista sin impedir ordenar fechas válidas.
- Detalles ausentes y entradas antiguas no parseadas: se muestran y buscan sin errores.
- Búsqueda/cambio de tamaño/ordenación en una página posterior: limitar a una página válida o reiniciar donde corresponda.
- Log vacío/inexistente/error HTTP: no mostrarlo como dato real y conservar el estado apropiado.
- Teclado y lectores de pantalla: cabeceras accionables con estado de orden accesible, además del triángulo.

---

## Mapa de cambios

- Crear `webapp/src/ui/table.ts`: tipos declarativos y operaciones puras de tabla con renderizador DOM común.
- Modificar `webapp/src/ui/browser/main.ts`: configurar Historial y conectar el renderer, sin alterar escritura del log.
- Modificar `webapp/public/index.html`: sustituir lista de cajas por controles/contenedor semántico.
- Modificar `webapp/public/styles.css`: estilos compartidos para cabeceras, indicador, filas y paginador, según variables existentes.
- Crear `webapp/test/table.test.ts`: cobertura de ordenación, búsqueda, filtros, paginación y rendering.
- Modificar pruebas UI/e2e existentes para el Historial; preservar cambios ya presentes en el checkout.

## Tarea 1: Núcleo tipado y contrato declarativo

**Archivos:** crear `webapp/src/ui/table.ts`; crear `webapp/test/table.test.ts`.

**Interfaces:** `TableColumn<T>` declara `id`, `label`, `getValue(row)`, `sortable` (true por defecto), `sortType` (`text | number | date | boolean`), `searchable` (true por defecto), `renderCell` opcional que retorna `Node`, y clase/atributos opcionales de celda. `TableView<T>` declara columnas, `getRowId`, `initialSort: {columnId, direction}`, `pageSize` (100 por defecto), campos de búsqueda y filtros opcionales. Cada filtro identifica columna, etiqueta y opciones neutra/positiva/negativa con predicados. Estado de interacción local a instancia. `processTableRows<T>(rows, view, state)` aplica filtros, búsqueda, orden y página; retorna filas visibles, total filtrado y páginas totales. Texto localizado y case-insensitive; tipos numéricos/fecha comparados como tales; valores ausentes deterministas.

- [ ] **Paso 1: Escribir pruebas fallidas**: orden texto asc/desc estable, fecha/número, faltantes, columna no ordenable, búsqueda configurada, filtros neutro/positivo/negativo, tamaño por defecto 100, página fuera de rango tras filtrar y conjunto vacío.
- [ ] **Paso 2: Ejecutar** pruebas focalizadas `node --test` según la configuración TypeScript existente; confirmar fallos por falta de implementación.
- [ ] **Paso 3: Implementar** contrato y transformación pura sin dependencias externas.
- [ ] **Paso 4: Verificar** prueba focalizada y `npm run build:ui`.

## Tarea 2: Renderizador accesible y controles genéricos

**Archivos:** modificar `webapp/src/ui/table.ts`; ampliar `webapp/test/table.test.ts`; modificar `webapp/public/styles.css`.

**Interfaces:** `mountTable<T>(root, view, rows): TableController<T>` genera tabla semántica/controles; `setRows(rows)` actualiza datos sin perder configuración; `destroy()` quita listeners. Cambios de criterios reinician página. Columnas no ordenables son texto; las ordenables usan control nativo accesible y `aria-sort`; dirección se comunica también por `data-direction` y CSS.

- [ ] **Paso 1: Añadir pruebas DOM** con helper existente para orden inicial, clic asc/desc, no ordenable, `aria-sort`, búsqueda, filtros, navegación y tamaño.
- [ ] **Paso 2: Ejecutar** pruebas y confirmar fallo esperado.
- [ ] **Paso 3: Implementar** montaje y actualización; renderizar valores de forma segura con nodos/textContent, no HTML inyectado.
- [ ] **Paso 4: Añadir estilos** responsivos y temáticos; cabecera activa remarcada por CSS, triángulo direccional y foco visible.
- [ ] **Paso 5: Verificar** pruebas focalizadas, build UI y tests de estilos.

## Tarea 3: Migrar el panel Historial

**Archivos:** modificar `webapp/src/ui/browser/main.ts`, `webapp/public/index.html`, y pruebas pertinentes `webapp/test/ui.markup.test.ts`, `ui.styles.test.ts`, `ui.test.ts`, `e2e/browser.test.ts`.

**Configuración:** columnas Fecha, Acción, Resumen, Detalle; orden inicial fecha descendente; búsqueda en las cuatro columnas; filtros vacíos en este piloto (la interfaz los admite); 100 por página. Fecha ISO para ordenar y `logTimestamp` para mostrar; detalle ausente como em dash; `raw` como title/tooltip, no columna. Mantener mensajes diferentes para log inexistente y log sin entradas legibles.

- [ ] **Paso 1: Añadir/adaptar pruebas** para columnas y valores existentes, vacío, fecha reciente primero, cambio reversible, búsqueda, 100 por página, carga y error; no depender del antiguo `<ul>`.
- [ ] **Paso 2: Ejecutar** tests UI focalizados y confirmar fallos previos a integración.
- [ ] **Paso 3: Integrar** vista configurada, preservando ciclo de carga/error, resumen, rotaciones, cierre y foco del drawer.
- [ ] **Paso 4: Actualizar** marcado y estilos; retirar regla antigua solo si no se usa en otra vista.
- [ ] **Paso 5: Verificar** tests focalizados, `npm run build`, `npm test` y `npm run test:e2e` si Playwright está disponible. No cambiar endpoint, persistencia ni tabla principal.

## Tarea 4: Retrocompatibilidad y cierre

- [ ] **Paso 1: Revisar** defaults del contrato: columnas ordenables y buscables, 100 filas, filtros opcionales, estado local por instancia.
- [ ] **Paso 2: Ejecutar** build y suite completa; revisar diff acotado y conservar cambios ajenos/preexistentes.
- [ ] **Paso 3: Informar** que el piloto fue Historial y la tabla principal queda intacta; no crear commit ni realizar migraciones extra.

## Autorrevisión

- **Cobertura:** orden tipado/reversible e indicador CSS, columna inicial, columnas no ordenables, búsqueda configurable, filtros neutros/positivos/negativos, renderizado/enlaces personalizados, paginación 100, datos estructurados, migración futura y pruebas asignadas.
- **Proporción:** una sola vista piloto; sin migrar tabla principal ni persistir preferencias.
- **Ajuste técnico:** frontend TypeScript sin framework, HTML existente, CSS compartido, node:test y Playwright presentes; usar contrato propio headless evita dependencia inapropiada.
- **Checkout:** existen muchos cambios locales y archivos nuevos no relacionados, incluidos archivos solapados. La implementación debe preservar hunks y archivos que no cree; nunca sobrescribir ni limpiar cambios ajenos.
