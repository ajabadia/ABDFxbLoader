# Descompilación de `fxbLoaderConfig.exe` con el MCP `rea`

Fecha del análisis: 2026-10-19
Herramienta: servidor MCP **rea** (workflow compuesto sobre **Ghidra 12.1.4**, headless)

---

## 1. Ficha del binario

| Campo | Valor |
|---|---|
| Ruta | `C:\Users\ajaba\Downloads\fxbloader\fxbLoaderConfig.exe` |
| SHA-256 | `1a87d48f0106f6a2fd92a8424bef9d5bb22a2af5fecf0d1f091a165285d8a4e2` |
| Formato | PE (ejecutable, no DLL) |
| Arquitectura | x86 (32 bits) |
| Image base | `0x400000` |
| Procedimientos analizados | 655 |
| Cadenas definidas | 370 |
| PDB referenciado | `fxbLoaderSetup.pdb` (GUID `e2225918-ab0e-4912-ae46-476ac8c46189`, age 1, RSDS) — **no cargado**, por eso los nombres son `FUN_0040xxxx` |

Secciones:

| Sección | Rango | Tamaño |
|---|---|---|
| Headers | `0x400000`–`0x400400` | 0x400 |
| .text | `0x401000`–`0x413200` | 0x12200 |
| .rdata | `0x414000`–`0x419400` | 0x5400 |
| .data | `0x41a000`–`0x41cf50` | 0x2f50 |
| .rsrc | `0x41d000`–`0x465600` | 0x48600 |
| .reloc | `0x466000`–`0x468400` | 0x2400 |

## 2. Stack / procedencia del código

- **MSVC** (CRT estático de la era VS2010: mensajes `R60xx`, `/GS` cookie en `DAT_0041a084`, `__security_check_cookie`).
- **Win32++** (`Win32xx::CWnd`, `Win32xx::CDialog`, `CStatic`, `CHyperlink`), framework de <https://sourceforge.net/projects/win32-framework> — **no** es MFC, pese a los nombres `CDialog`.
- Clase de aplicación RTTI: `.?AVCDialogDemoApp@@` → el autor partió de la **demo `CDialogDemo` de Win32++**.
- Solo APIs Win32 clásicas: USER32, KERNEL32, GDI32, COMCTL32, SHELL32 (`SHBrowseForFolderW` para elegir la librería VFX).
- Contenedores `std::vector` de MSVC (por eso los `vector<T> too long`, `invalid map/set<T> iterator`).

## 3. Funciones de la aplicación identificadas

| Dirección | Rol | Evidencia |
|---|---|---|
| `FUN_004059d0` | Escanea `<lib>\plugs\*.*` y reparte plugins en los dos listbox | xref a `"\\plugs\\*.*"` `0x41691c` |
| `FUN_00405c50` | Botón **`>>`**: instala el fxbLoader en los plugins seleccionados | xref a `"Select one ore more devices ... not available"` `0x416a38` |
| `FUN_00405ee0` | Instalación de **un** plugin (copia DLL, respalda/parchea `vfxinfo.txt`) | xref a `"\\vfxinfo.txt"` `0x416e90` |
| `FUN_00406310` | Desinstalación de **un** plugin (restaura `vfxinfo.txt`) | xref a `"\\vfxinfo.loader"` `0x416f1c` |
| `FUN_00406570` | Devuelve el objeto `CWnd` del listbox (helper Win32++) | usada por el escaneo |

IDs de control usados en el diálogo: `0x79` (121) = listbox "fxbLoader not available", `0x7A` (122) = listbox "fxbLoader is installed".
Mensajes: `0x180` `LB_ADDSTRING`, `0x184` `LB_RESETCONTENT`, `0x187` `LB_GETSEL`, `0x189` `LB_GETTEXT`, `0x18B` `LB_GETCOUNT`.

## 4. Pseudocódigo descompilado

> Salida de Ghidra, normalizada a C legible (`__swprintf` = `swprintf`, `__wfopen` = `_wfopen`). Los nombres son sintéticos.

### 4.1 `FUN_004059d0` — escaneo de la librería y llenado de los listbox

```c
void FUN_004059d0(void)
{
    wchar_t base[260], pattern[262];
    _WIN32_FIND_DATAW fd;
    HANDLE h;

    swprintf(base, L"%s%s", this->library_path /* +0x94 */, L"\\plugs");
    if (GetFileAttributesW(base) == INVALID_FILE_ATTRIBUTES) {
        SendDlgItemMessageW(this->hDlg, 0x7A, LB_ADDSTRING, 0, (LPARAM)L"plugin path not found");
        return;
    }

    swprintf(pattern, L"%s%s", this->library_path, L"\\plugs\\*.*");
    h = FindFirstFileW(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) {
        SendDlgItemMessageW(this->hDlg, 0x79, LB_ADDSTRING, 0, (LPARAM)L"no plugins found in library");
        return;
    }

    /* limpia ambos listbox */
    LB_RESETCONTENT(this->GetListBox(0x79));
    LB_RESETCONTENT(this->GetListBox(0x7A));

    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0)
            continue;

        swprintf(base, L"%s%s%s", this->library_path, L"\\plugs\\", fd.cFileName);
        if ((GetFileAttributesW(base) & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            swprintf(base, L"%s%s%s%s", this->library_path, L"\\plugs\\",
                     fd.cFileName, L"\\fxbLoader.config");

            /* ¿existe la marca de instalación? */
            UINT id = (GetFileAttributesW(base) == INVALID_FILE_ATTRIBUTES) ? 0x79 : 0x7A;
            SendDlgItemMessageW(this->hDlg, id, LB_ADDSTRING, 0, (LPARAM)fd.cFileName);
        }
    } while (FindNextFileW(h, &fd));

    FindClose(h);
}
```

**Regla de clasificación:** un plugin cuenta como *instalado* si existe
`<lib>\plugs\<plugin>\fxbLoader.config`.

### 4.2 `FUN_00405c50` — botón `>>` (instalar seleccionados)

```c
void FUN_00405c50(app_t *app)
{
    wchar_t name[262];
    int done = 0;

    HWND hList = GetDlgItem(app->hDlg, 0x79);
    CWnd *wnd  = app->GetWnd(hList);
    if (IsWindow(hList) && wnd == NULL) {
        app->AttachWnd(hList);          /* FUN_00402ee0 */
        wnd = app->GetWnd(hList);
    }

    int count = SendMessageW(wnd->m_hWnd, LB_GETCOUNT, 0, 0);
    for (int i = count - 1; i >= 0; --i) {
        if (SendMessageW(wnd->m_hWnd, LB_GETSEL, i, 0) > 0) {
            ++done;
            if (SendMessageW(wnd->m_hWnd, LB_GETTEXT, i, (LPARAM)name) != -1)
                FUN_00405ee0(app, name);   /* instalar un plugin */
        }
    }

    if (done != 0) {
        FUN_004059d0();                    /* refrescar listas */
        return;
    }
    MessageBoxW(app->hDlg,
        L"Select one ore more devices from the \"fxbLoader not available\" list to the left \n"
        L"before hitting the \">>\" button.\n\n"
        L"Hit the \"Help\" button for further information on how to use this utility.",
        L"fxbLoader Setup", MB_ICONINFORMATION /* 0x40 */);
}
```

### 4.3 `FUN_00405ee0` — instalación de un plugin (núcleo del programa)

```c
void FUN_00405ee0(app_t *app, const wchar_t *plugin)
{
    wchar_t dst[260], src[260];
    char    line[128];
    std::vector<char[128]> lines;
    FILE   *f;

    /* 1. copiar la DLL del cargador */
    swprintf(dst, L"%s%s%s%s", app->library_path, L"\\plugs\\", plugin, L"\\fxbLoader.dll");
    swprintf(src, L"%s%s",   app->app_path,     L"\\vst\\fxbLoader.dll");

    if (GetFileAttributesW(src) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(app->hDlg,
            L"fxbLoader.dll could not be found. Please reinstall the application.\n\n"
            L"Hit the \"Help\" button for further information on how to use this utility.",
            L"fxbLoader Setup", MB_ICONHAND /* 0x10 */);
        return;
    }
    CopyFileW(src, dst, FALSE);

    /* 2. respaldar vfxinfo.txt -> vfxinfo.tx_ */
    swprintf(src, L"%s%s%s%s", app->library_path, L"\\plugs\\", plugin, L"\\vfxinfo.txt");
    swprintf(dst, L"%s%s%s%s", app->library_path, L"\\plugs\\", plugin, L"\\vfxinfo.tx_");
    CopyFileW(src, dst, FALSE);

    /* 3. leer vfxinfo.txt línea a línea (máx. 128 bytes) */
    f = _wfopen(src, L"r");
    if (!f) return;
    while (!feof(f)) {
        if (fgets(line, 0x80, f) != NULL)
            lines.push_back(line);          /* vector<char[128]> con realojos manuales */
    }
    fclose(f);

    /* 4. buscar la línea "dll_name" y reescribirla */
    bool found = false;
    size_t idx = 0;
    for (; idx < lines.size(); ++idx) {
        if (strstr(lines[idx], "dll_name") != NULL) { found = true; break; }
    }

    char config[128] = {0};                 /* cero inicial: caso "sin dll_name" */
    if (found) {
        /* nombre del plugin = texto tras la última '/' de esa línea */
        char *p = strrchr(lines[idx], '/');
        sprintf(config, "pluginName = %s", p + 1);

        /* FUN_00405620 normaliza el nombre del plugin */
        sprintf(lines[idx], "dll_name: %s/fxbLoader.dll\n", FUN_00405620(plugin));
    }

    /* 5. reescribir vfxinfo.txt */
    f = _wfopen(src, L"w");
    if (!f) { /* liberar vector */ return; }
    for (size_t i = 0; i < lines.size(); ++i)
        fputs(lines[i], f);
    fclose(f);

    /* 6. escribir fxbLoader.config y crear presets\ */
    swprintf(src, L"%s%s%s%s", app->library_path, L"\\plugs\\", plugin, L"\\fxbLoader.config");
    f = _wfopen(src, L"w");
    if (f) {
        fputs(config, f);
        fclose(f);

        swprintf(src, L"%s%s%s%s", app->library_path, L"\\plugs\\", plugin, L"\\presets");
        CreateDirectoryW(src, NULL);
    }
}
```

**Observaciones**

- El respaldo se llama `vfxinfo.tx_` (así lo documenta el README).
- La marca de "instalado" que usa el escaneo es el archivo `fxbLoader.config`, cuyo
  contenido es `pluginName = <nombre>`.
- Si `vfxinfo.txt` **no** contiene ninguna línea `dll_name`, la función no inserta nada:
  escribe `fxbLoader.config` vacío y crea `presets\` igualmente (posible caso límite no previsto).

### 4.4 `FUN_00406310` — desinstalación de un plugin

Ghidra perdía los argumentos variádicos de `swprintf`; la secuencia real se reconstruyó
desde el listado de instrucciones (`0x406310`–`0x4063f8`):

```c
void FUN_00406310(app_t *app, const wchar_t *plugin)
{
    wchar_t txt[260], loader[260], tx_[260];

    /* 1. borrar la marca de instalación */
    swprintf(txt, L"%s%s%s%s", app->library_path, L"\\plugs\\", plugin, L"\\fxbLoader.config");
    DeleteFileW(txt);

    /* 2. borrar un backup antiguo */
    swprintf(txt,    L"%s%s%s%s", app->library_path, L"\\plugs\\", plugin, L"\\vfxinfo.txt");
    swprintf(loader, L"%s%s%s%s", app->library_path, L"\\plugs\\", plugin, L"\\vfxinfo.loader");
    DeleteFileW(loader);

    /* 3. conservar el vfxinfo.txt modificado como vfxinfo.loader */
    MoveFileW(txt, loader);

    /* 4. restaurar el original vfxinfo.tx_ -> vfxinfo.txt */
    swprintf(tx_, L"%s%s%s%s", app->library_path, L"\\plugs\\", plugin, L"\\vfxinfo.tx_");
    MoveFileW(tx_, txt);        /* MoveFileW(origen = vfxinfo.tx_, destino = vfxinfo.txt) */
}
```

Interpretación de los `MoveFileW` (stdcall, argumentos de derecha a izquierda):

| Llamada | Origen | Destino |
|---|---|---|
| `0x4063b7` | `vfxinfo.txt` | `vfxinfo.loader` |
| `0x4063e7` | `vfxinfo.tx_` | `vfxinfo.txt` |

Es exactamente lo que describe el README: al desinstalar se conserva el
`vfxinfo.txt` modificado como `vfxinfo.loader` y se restaura el original guardado en
`vfxinfo.tx_`. **La DLL `fxbLoader.dll` y la carpeta `presets\` no se borran**
(el README indica que hay que eliminarlas a mano).

## 5. Mapa de comportamiento

```
fxbLoaderConfig.exe
│
├─ "open vfxLibrary"  ── SHBrowseForFolderW ──► valida *.vfxlibrary
│
├─ FUN_004059d0  (escanear)
│     <lib>\plugs\*/fxbLoader.config ?
│        sí → listbox 0x7A  "fxbLoader is installed"
│        no → listbox 0x79  "fxbLoader not available"
│
├─ ">>"  FUN_00405c50 → por cada seleccionado en 0x79:
│     FUN_00405ee0
│        <app>\vst\fxbLoader.dll → <lib>\plugs\<p>\fxbLoader.dll
│        <lib>\plugs\<p>\vfxinfo.txt → vfxinfo.tx_        (respaldo)
│        parchea la línea "dll_name:" a "dll_name: <p>/fxbLoader.dll"
│        escribe <lib>\plugs\<p>\fxbLoader.config  ("pluginName = <p>")
│        crea    <lib>\plugs\<p>\presets\
│     refresca listas
│
└─ "<<"  (handler no descompilado en esta pasada; mismos IDs de lista)
      FUN_00406310
         borra fxbLoader.config
         vfxinfo.txt → vfxinfo.loader
         vfxinfo.tx_ → vfxinfo.txt
      refresca listas
```

## 6. Cadenas relevantes (dirección → texto)

| Dirección | Texto |
|---|---|
| `0x4168c0` | `fxbLoader Setup` (título de los MessageBox) |
| `0x4167e8` | `%s\nThe selected folder does not seem to be a VFX library.\n(folder name: *.vfxlibrary).\n\nOperation canceled!` |
| `0x4168f0` | `plugin path not found` |
| `0x416934` | `no plugins found in library` |
| `0x416d70` | `fxbLoader.dll could not be found. Please reinstall the application....` |
| `0x416e90` | `\vfxinfo.txt` |
| `0x416eac` | `\vfxinfo.tx_` |
| `0x416f1c` | `\vfxinfo.loader` |
| `0x416998` | `\fxbLoader.config` |
| `0x416f08` | `\presets` |
| `0x416ed8` | `pluginName = %s` |
| `0x416ee8` | `dll_name: %s/fxbLoader.dll\n` |
| `0x416a38` | `Select one ore more devices from the "fxbLoader not available" list...` |
| `0x416bb0` | `Select one ore more devices from the "fxbLoader is installed" list...` |
| `0x416d28` | `\fxbLoader.dll` |
| `0x416d48` | `\vst\fxbLoader.dll` |

## 7. Limitaciones del análisis

- El **PDB no está disponible** (`fxbLoaderSetup.pdb`): no hay nombres originales de
  funciones, clases ni tipos. Todos los `FUN_*` son sintéticos.
- El proveedor REA importa el binario en un **proyecto Ghidra efímero**: al cerrar la
  sesión se pierden anotaciones y renombrados (los bytes originales nunca se modifican).
- Ghidra pierde los argumentos variádicos de `swprintf` en algunas funciones; en
  `FUN_00406310` hubo que reconstruir la lógica desde el **listado de instrucciones**.
- El handler del botón `<<` no se descompiló en esta pasada (sí su helper de
  desinstalación). Su comportamiento se deduce del par de cadenas y de los mismos IDs
  de lista, pero no está verificado función a función.
- No se analizó `vst\fxbLoader.dll` (el cargador que inyecta el banco `.fxb`).

## 8. Cómo reproducirlo con el MCP rea

```
open_binary      { "path": "C:\\Users\\ajaba\\Downloads\\fxbloader\\fxbLoaderConfig.exe" }
binary_overview  { }
list_strings     { }
xrefs            { "address": "0x416e90" }   -> 0x405f94, 0x40635d
procedure_pseudo_code { "procedure": "0x405f94" }
procedure_pseudo_code { "procedure": "0x405a4c" }
procedure_pseudo_code { "procedure": "0x405d48" }
procedure_assembly    { "procedure": "0x406310" }
```

Equivalente en Ghidra de escritorio: importar el PE, dejar correr el auto-análisis
(x86:LE:32:default) y aplicar los símbolos de este informe con `L` / `Ctrl+L` sobre
cada `FUN_*`.
