# ABDfxbloader — VST FXB/FXP Preset Loader & VFX Management Suite

Cargador de bancos de presets VST (`.fxb` / `.fxp`) y suite web de gestión, adquisición y diagnóstico para entornos basados en **SM Pro Audio / VFX Machine** (hardware V-Machine y software VFX Host).

---

## Componentes del Repositorio

- **`vst/fxbLoader.dll`**: DLL cargador VST2 (32-bit PE32 i386) que intercepta la carga del instrumento dentro del host VFX y carga automáticamente el banco `.fxb` predeterminado al abrir el plugin.
- **`fxbLoaderConfig.exe`**: Herramienta clásica de configuración (Win32 legacy) para asociar el cargador a plugins de una librería.
- **`webapp/`**: Aplicación web moderna (NestJS + TypeScript puro para navegador) que sustituye y amplía la herramienta clásica:
  - Escaneo e instalación atómica con control optimista de concurrencia.
  - Validación de compatibilidad PE32 (i386 de 32 bits vs 64 bits).
  - Gestión integral de bancos `.fxb`: importación streaming NDJSON, conversión in-situ de orden de bytes (Little/Big-Endian) con respaldo `.orig`, exportación y papelera segura.
  - Catálogo de metadatos `fxbLoader.meta.json` y registro de actividad `fxbLoader.log`.
  - Auditoría durable de asociaciones DLL por librería en `fxbLoader.audit.jsonl` (apéndice sin rotación, cruza plugins).
  - Preferencia de DLL por plugin con guardado protegido contra pérdida de borradores.
  - Importador recursivo de paquetes `.vfxlibrary` y volcados externos con alineación y reparación transversal de chunks binarios (`vfx-bank-validator`).
  - Catálogo oficial indexado de **268 wizards** certificados de SM Pro Audio / VFX Machine para adquisición e instalación desatendida.
  - Asistente de alta guiada para plugins VST nuevos sin wizard previo con análisis estático PE de la tabla de exportaciones (`inspectPeExports`).
- **`_banks/wizards/`**: Repositorio canónico de archivos `.vfxwizard` oficiales.
- **`roadmap.md`**: Hoja de ruta arquitectónica del proyecto y estado de las fases.

---

## Arranque Rápido (Windows)

En la raíz del repositorio, ejecuta:

```bat
start.bat
```

`start.bat` se encarga automáticamente de:
1. Comprobar y liberar el puerto 3210 si estuviera ocupado.
2. Instalar dependencias si faltan.
3. Compilar el servidor y la interfaz web (`dist/` y `public/js/`).
4. Iniciar el servicio web en `http://127.0.0.1:3210`.
5. Abrir la interfaz en tu navegador predeterminado.

Opciones útiles de entorno:
```bat
start.bat 8080                    :: Utilizar otro puerto
set FXB_NO_BROWSER=1 && start.bat :: Arrancar sin abrir el navegador
set FXB_SKIP_SERVER=1 && start.bat:: Compilar y verificar sin arrancar el servidor
```

---

## Documentación y Pruebas

Para detalles completos sobre la API REST, OpenAPI/Swagger, arquitectura técnica y ejecución de la suite de pruebas:

- Consulta el [README de la webapp](webapp/README.md).
- Documentación OpenAPI Swagger: [http://127.0.0.1:3210/docs](http://127.0.0.1:3210/docs) (con el servidor iniciado).
- Hoja de ruta del proyecto: [roadmap.md](roadmap.md).
- Especificación del formato de configuración: [fxbLoaderConfig.spec.md](fxbLoaderConfig.spec.md).

Para ejecutar las pruebas desde la carpeta `webapp/`:
```bash
cd webapp
npm test               # Suite completa de pruebas unitarias e integración (529+ tests)
npm run test:coverage  # Generación de informe de cobertura HTML
npm run test:e2e       # Pruebas end-to-end con navegador real (Playwright)
```
