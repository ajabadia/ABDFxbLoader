# Decisión: log del plugin — archivo por plugin, rotación por tamaño

## Qué se elige

- **Un archivo por plugin**, no uno por sesión, ni uno por operación, ni uno global.
- **Rotación por tamaño**: cuando el archivo activo excede un umbral elegido, se rota en `<plugin>/fxbLoader.log.1`, `.log.2`, … hasta un número finito de rotados. No se rota por fecha, ni por sesión, ni por número de registros.
- **Un archivo activo abierto/cerrado por escritura**, estilo los demás archivos de la app hoy. No se mantiene un handle persistente por plugin.

## Rasgos del archivo activo

- Nombre: `fxbLoader.log`
- Ubicación: `<plugin>/`
- Contenido: entradas con marca de tiempo y resumen de operación. Sin log exhaustivo de cada paso interno del cargador.
- Rotación: archivo activo → `.log.1` → `.log.2` … hasta el número máximo de rotados.
- Lectura de consulta: concatenación ordenada de los archivos activos del plugin.

## Política de degradación

- Si el log no escribe, la operación del cargador sigue siendo válida y no se interrumpe.
- El log es complementario, no requisito ni condición de éxito de las operaciones.

## Por qué este formato

- Aísla problemas por plugin: un archivo corrupto o muy grande queda contenido en ese plugin.
- Un plugin pequeño tiene un solo archivo y no se complica.
- La rotación por tamaño es canónica y fácil de razonar frente a una recombinación por sesión o por fecha.
- Se ajusta al estilo de la app: archivos en disco, escritura atómica cuando aplica, sin mantener estado persistente entre escrituras.

## Umbrales canónicos adoptados en este documento

- **Tamaño de rotación del archivo activo:** 1 MiB escrito (1_048_576 bytes). El archivo activo se rota cuando el registro acetylation del nuevo escrito lo haría exceder ese tamaño, sin esperar a una escritura posterior.
- **Número máximo de archivos rotados:** 7. `fxbLoader.log.1` … `fxbLoader.log.7`. Al superar 7 el archivo `.log.7` se descarta.
- **Nombre del archivo activo:** `fxbLoader.log`, dentro de `<plugin>/`.
- **Nombre de los rotados:** `fxbLoader.log.1`, `fxbLoader.log.2`, …, donde `.1` es el más reciente.
- **Contenido mínimo por entrada:** timestamp ISO-8601 + resumen de operación. Sin repetición del árbol completo de `actions` si es muy largo; si el resumen es largo, se trunca desde el final, no desde el inicio.

## Cláusulas explícitas

- El log no borraría ni renombraría `vfxinfo.txt` ni los `.fxb`.
- El log del plugin no se mezcla con la configuración del plugin (`fxbLoader.config`) ni con el catálogo propio (`fxbLoader.meta.json`).
- Si la operación crea el plugin o sus carpetas, el log queda dentro de la carpeta del plugin cuando exista; si no existe, la operación decide si registra o degrada.
- La operación pública escribe una sola entrada al final, con timestamp y resumen; no repite todos los pasos internos ni todos los resultados si el conjunto es grande.

## Decisiones firmadas el 2026-10-22
