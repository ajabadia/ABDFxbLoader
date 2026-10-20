# Descompilación de `vst\fxbLoader.dll` con el MCP `rea`

Segunda mitad del paquete `fxbLoader`. La primera (`fxbLoaderConfig.exe`) está en
[fxbLoaderConfig.rea-report.md](fxbLoaderConfig.rea-report.md).

## 1. Ficha del binario

| Campo | Valor |
|---|---|
| Archivo | `vst\fxbLoader.dll` |
| SHA-256 | `a61bbe2156dfdba3f83a6b726abb3b35c1fe1d7778aeaa4cdf320cfe991aac70` |
| Formato | PE32, DLL, `Intel i386` (32 bits) |
| Image base | `0x10000000` |
| Secciones | `Headers`, `.text` (112 128 B), `.rdata`, `.data`, `.rsrc`, `.reloc`, `tdb` |
| Procedimientos | 935 |
| Cadenas definidas | 444 |
| Export VST2 | `VSTPluginMain` @ `0x100065b0` |
| PDB | ninguno referenciado; símbolos sintéticos `FUN_*` |

Proveedor: Ghidra 12.1.4 headless, análisis por defecto.

## 2. Qué es

Un **plugin VST2 envoltorio** (wrapper). Se instala sustituyendo el `dll_name` del
plugin original en `vfxinfo.txt`; la evidencia apunta a que carga ese plugin con
`LoadLibrary` + `GetProcAddress` y reenvía la interfaz `AEffect` al original,
interceptando el arranque para inyectar el banco `.fxb`. La llamada concreta a
`LoadLibrary` no se ha trazado todavía (ver §7).

Evidencia observada:

- Imports presentes: `LoadLibraryA`, `LoadLibraryW`, `GetProcAddress`,
  `FreeLibrary`, `GetModuleFileNameA/W`, `CreateFileA`.
- Claves de configuración: `pluginName`, `defaultFxbName`, `programDirName`,
  `loadFxbBank`.
- Cadenas de diagnóstico: `sbPresetMan::loadFile()`, `fxBankData::insertTo()`,
  `fxHeader::check()`, `fxb bank file`, `%s*.fxb`.

Presumiblemente el nombre del DLL original sale de `pluginName`; el banco
preseleccionado, de `defaultFxbName`; el directorio de bancos importados es
`<plugin>\<programDirName>\` (por defecto `presets`). `loadFxbBank` **no** es un
nombre de archivo: es un booleano `yes`/`no` que activa o desactiva la carga.
Las claves están verificadas; qué hace exactamente cada una se deduce del uso y
del parser, no de una traza completa.

## 3. Mapa de funciones

| Dirección | Rol | Evidencia |
|---|---|---|
| `0x100065b0` | `VSTPluginMain`: llama al host callback, construye el objeto (`0xb48` bytes) y salta al dispatcher | export + xref |
| `0x100031a0` | `operator new(0xb48)` + constructor `FUN_10002dd0` | pseudocódigo |
| `0x10003f50` | Lee `<dll>.config` y rellena el estado (rutas, `pluginName`, `loadFxbBank`, …) | xref a `"loadFxbBank"` `0x1001d84c` |
| `0x1000a1d0` | Llena el listbox con `<presets>\*.fxb` | xref a `"%s*.fxb"` `0x1001e3c0` |
| `0x10004630` | Carga + inyección de un banco; tabla de errores | xref a `"fxBankData::insertTo()"` `0x1001da30` |
| `0x10004600` → `0x10003c00` | Lee el `.fxb` completo en memoria y valida cabecera | pseudocódigo |
| `0x100038c0` | `fxHeader::check()`: chunkMagic, `fxMagic` ∈ {FxCk, FxBk, FPCh, FBCh} y `fxID` == uniqueID del plugin; **no** compara byteSize, versión ni fxVersion | pseudocódigo + ensamblador |
| `0x1000a4f0` | Diálogo de importación: `GetOpenFileNameA` multiselección, valida y copia a `presets\` | pseudocódigo + xref a `"fxb bank file"` |
| `0x10004340` | `fxBankData::insertTo()`: inyecta el banco vía dispatcher VST2 | pseudocódigo |
| `0x100037f0` | Reescribe `fxbLoader.config` completo (4 claves) al guardar ajustes | xref a `"loadFxbBank = %s\n"` |

## 4. Pseudocódigo descompilado

> Salida de Ghidra normalizada a C legible. Los nombres son sintéticos; los
> offsets son los del `fxBank`/`AEffect` originales. Identificadores como `copy`,
> `build_path` o `apply_program` son **placeholders** para código inline o
> subrutinas sin nombre, no símbolos reales del binario.

### 4.1 `FUN_10003f50` — lectura de `fxbLoader.config`

```c
void load_config(char *self)          /* self: bloque de estado del plugin */
{
    copy(self,          self + 0x208);          /* ruta del DLL      */
    strrchr(self + 0x208, '.');
    strncpy(..., ".config", 8);                 /* fxbLoader.config  */

    copy(self, self + 0x104);                   /* directorio plugin */
    strrchr(self + 0x104, '\\')[1] = 0;

    self[0x9e4] = 1;                            /* flag "yes"        */

    /* <plugin>\presets\  (FUN_10003ed0) */
    build_path(self + 0x79c, "presets", self + 0x104, true);

    FILE *f = fopen(self + 0x208, "r");
    if (!f) return;

    while (!feof(f)) {
        char line[304];
        fgets(line, 0x12d, f);

        if (char *slash = strchr(line, '/')) *slash = 0;   /* comentario */
        char *eq = strchr(line, '=');
        if (!eq) continue;
        *eq = 0;

        char *value = trim(eq + 1);
        char *key   = trim(line);

        if      (!strcmp(key, "pluginName"))    { copy(value, self + 0x30c); append_backslash(self + 0x34c); }
        else if (!strcmp(key, "defaultFxbName")){ copy(value, self + 0x554); }
        else if (!strcmp(key, "programDirName")){ build_path(self + 0x79c, value, self + 0x104, true); }
        else if (!strcmp(key, "loadFxbBank"))   { set_bank_flag(self + 0x9e4, value); }
    }
}
```

Observaciones:

- El `.config` se busca **junto al DLL**, no en el directorio actual. Eso ata la
  DLL a la copia que dejó el instalador.
- El formato es `clave = valor`, con `/` iniciando comentario. Si no existe el
  archivo, el plugin sigue arrancando con valores por defecto.
- `pluginName` se guarda con una barra final añadida: se usa como prefijo de ruta.
- La llamada está en `FUN_10004820` (inicialización): hace `GetModuleFileNameA`
  sobre el propio DLL, `FUN_10003730` y después `FUN_10003f50`. Se relee en cada
  instancia del plugin, no una vez por proceso.

### 4.2 `FUN_10004340` — `fxBankData::insertTo()`

```c
int insert_bank(fxBankData *bank, AEffect *plugin)
{
    uint32 magic = swap_if_needed(bank->fxMagic);

    if (magic == 'FxBk') {                        /* 0x4678426b */
        uint32 n = swap_if_needed(bank->numPrograms);
        if (n != plugin->numPrograms) return 1;   /* "numPrograms wrong value" */

        if (plugin->dispatcher(plugin, effBeginLoadBank, 0, 0,
                               &bank->header, 0) == -1)   /* 0x4b */
            return 2;

        for (int i = 0; i < bank->numPrograms; ++i) {
            if (plugin->dispatcher(plugin, effBeginSetProgram, 0, 0, 0, 0) == -1)  /* 0x43 */
                return 3;
            plugin->dispatcher(plugin, effSetProgram, 0, i, 0, 0);                 /* 0x02 */
            if (plugin->dispatcher(plugin, effEndSetProgram, 0, 0, 0, 0) == -1)    /* 0x44 */
                return 4;
            /* FUN_100038c0 + FUN_100039a0; contenido no identificado */
            apply_program(&bank->programs[i], plugin);
        }
    } else if (magic == 'FBCh') {                 /* 0x46424368 */
        if (swap_if_needed(bank->numPrograms) != plugin->numPrograms) return 5;

        if (plugin->dispatcher(plugin, effBeginLoadBank, 0, 0,
                               &bank->header, 0) == -1)
            return 6;

        plugin->dispatcher(plugin, effSetChunk, 0, swap_if_needed(bank->chunkSize),
                           bank->chunk, 0);       /* 0x18 */
    } else {
        return 7;                                 /* "fxMagic wrong value" */
    }

    if (plugin->dispatcher(plugin, effBeginSetProgram, 0, 0, 0, 0) == -1)
        return 8;
    plugin->dispatcher(plugin, effSetProgram, 0, bank->currentProgram, 0, 0);
    return plugin->dispatcher(plugin, effEndSetProgram, 0, 0, 0, 0) == -1 ? 9 : 0;
}
```

La tabla de errores del binario confirma el flujo:

| Código | Mensaje |
|---|---|
| 1 | regular - numPrograms wrong value |
| 2 | regular - effBeginLoadBank |
| 3 | regular - effBeginSetProgram |
| 4 | regular - effEndSetProgram |
| 5 | chunk - numPrograms wrong value |
| 6 | chunk - effBeginLoadBank |
| 7 | fxMagic wrong value |
| 8, 9 | end - effEndSetProgram |

### 4.3 `FUN_10004630` — orquestador de carga

```c
void load_bank(void *self, AEffect *plugin)
{
    char path[304];
    /* copia la ruta recibida y llama a sbPresetMan::loadFile() */
    int rc = load_file(sbPresetMan, plugin, path);
    /* 0 = ok; 1 = open; 2 = memoria; 3 = lectura; 4 = tipo incorrecto */

    if (rc != 0) { show_error("File", path, "could not be loaded"); return; }

    rc = insert_bank(self->bankData, plugin);
    if (rc != 0) { show_error("Bank", path, "could not be loaded"); return; }

    show_info("Bank", path, "loaded successfully");
}
```

### 4.4 `FUN_10003c00` — lectura y validación del `.fxb`

```c
int sbPresetMan_loadFile(sbPresetMan *this, AEffect *plugin, const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return 1;

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    rewind(f);

    this->data = malloc(size);
    this->size = size;
    if (!this->data) throw 1;
    if (fread(this->data, 1, size, f) != size) throw 1;

    int rc = fxHeader_check(this->data, plugin);
    /* 0 = ok; 1 = chunkMagic/fxMagic inválido o uniqueID distinto */
    fclose(f);
    if (rc) throw 1;
    return 0;
}
```

No reconstruye el banco: lee el archivo entero y deja los bytes en
`this->data`/`this->size`. La comprobación real (`FUN_100038c0`, verificada
también en ensamblador) es más laxa de lo que sugerían los mensajes:

```c
int fxHeader_check(uint *bank, AEffect *plugin)
{
    if (swap_if_needed(bank[0]) != 'CcnK') return 1;
    uint magic = swap_if_needed(bank[2]);
    if (magic != 'FxCk' && magic != 'FxBk' && magic != 'FPCh' && magic != 'FBCh')
        return 1;
    if (swap_if_needed(bank[4]) != plugin->uniqueID) return 1;
    return 0;
}
```

El `switch` de `FUN_10003c00` conserva mensajes para los códigos 2–6
(`byteSize`, versión VST, uniqueID, versión del plugin), pero **el check solo
devuelve 0 o 1**: esos casos son mensajes muertos. En particular, la DLL no
compara `fxVersion` ni valida tamaños antes de cargar.

### 4.4.1 `FUN_1000a4f0` — importación de bancos del diálogo

```c
void import_banks(state *self)
{
    /* GetOpenFileNameA con OFN_ALLOWMULTISELECT, filtro "fxb bank file" */
    for (cada archivo seleccionado) {
        sprintf(path, "%s\\%s", dir, name);
        if (load_file(&self->preset_man, self->plugin, path) != 0)
            return;                        /* aborta el lote completo */
        copy_basename(self->current_name, path);
        write_preset_file(self);           /* fopen(destino, "wb") + fwrite */
    }
    refresh_list(self);
}
```

- Se valida **antes** de escribir ese archivo, y el destino se construye con el
  `programDirName` vigente.
- En una multiselección, si un archivo falla se aborta el resto, pero los
  anteriores ya pueden estar copiados (no hay transacción).
- Sobrescribe sin avisar, como dice el readme.

### 4.5 `FUN_1000a1d0` — listado de bancos en el diálogo

```c
sprintf(pattern, "%s*.fxb", presets_dir);
h = FindFirstFileA(pattern, &fd);
if (h == INVALID_HANDLE_VALUE) {
    add_string(list, "no fxb bank files found");   /* 0x79 */
    self[0xa94] = 0;          /* limpia la selección */
    FUN_1000a130(self);       /* refresco de estado; cuerpo no revisado */
    return;
}
SendMessage(listbox, LB_RESETCONTENT, 0, 0);
do { add_string(list, fd.cFileName); } while (FindNextFileA(h, &fd));
FindClose(h);
select_string(list, defaultFxbName);               /* LB_FINDSTRING + LB_SETCURSEL */
```

### 4.6 `FUN_100037f0` — escritura de `fxbLoader.config`

```c
void save_config(state *self)
{
    FILE *f = fopen(self->config_path /* +0x208 */, "w");   /* trunca */
    if (!f) return;

    fprintf(f, "pluginName = %s\n",     self->plugin_name);   /* +0x450 */
    fprintf(f, "defaultFxbName = %s\n", self->default_bank);  /* +0x698 */
    fprintf(f, "programDirName = %s\n", self->program_dir);   /* +0x8e0 */
    fprintf(f, "loadFxbBank = %s\n",    self->load_bank);     /* +0x9e5 */
    fclose(f);
}
```

El archivo se escribe **entero y desde cero** cada vez que el usuario acepta el
cuadro de diálogo de la DLL. No hay merge: cualquier clave que no esté en esta
lista desaparece. Y se escribe con `fopen("w")`, sin archivo temporal ni rename.

## 5. Opcodes VST2 usados

Calculados sobre `AEffectOpcodes`/`AEffectXOpcodes` del SDK VST 2.4:

| Valor | Símbolo | Uso en la DLL |
|---|---|---|
| `0x02` | `effSetProgram` | selecciona el programa antes de aplicar cada patch |
| `0x18` | `effSetChunk` | banco opaco (`FBCh`), índice 0 = banco |
| `0x43` | `effBeginSetProgram` | abre la secuencia de cambio de programa |
| `0x44` | `effEndSetProgram` | cierra la secuencia |
| `0x4b` | `effBeginLoadBank` | consulta previa con `VstPatchChunkInfo*`; `-1` aborta |

## 6. Consecuencia para un port web

Al **cargar**, la DLL no escribe nada en disco: lee el archivo y lo inyecta
llamando al `dispatcher` del plugin con `effBeginLoadBank` / `effSetChunk` /
`effSetProgram`. Eso exige tener el plugin cargado en el mismo proceso, con su
`AEffect*` vivo. El **diálogo de importación** sí escribe: copia el `.fxb`
validado a `presets\` con `fopen(..., "wb")` + `fwrite` (sin temporal ni
rename), sobrescribiendo el destino.

Por tanto, en una aplicación web:

- gestionar y validar `.fxb` sí es posible (el formato ya está caracterizado);
- **aplicar** el banco a un plugin no, salvo con un sidecar nativo que hospede el
  VST2 de 32 bits y exponga esas llamadas por IPC.

También queda claro que el `.config` no es solo una marca de instalación: es la
configuración operativa que lee la DLL al arrancar.

### 6.1 Lo que sí cambia respecto al plan inicial

El `.config` es un **contrato estable de cuatro claves**, escrito por
`FUN_100037f0` y leído por `FUN_10003f50` en cada arranque. Eso permite que la
aplicación web controle el comportamiento de la DLL sin escribir código nativo:

- activar o desactivar la carga al arrancar (`loadFxbBank`, booleano);
- elegir qué banco se preselecciona (`defaultFxbName`), que hasta ahora solo se
  podía cambiar desde el diálogo del propio plugin;
- redirigir el directorio de bancos (`programDirName`).

Tres consecuencias prácticas para el port:

1. **El instalador debe conservar o reescribir las cuatro claves**, no solo
   `pluginName`. El instalador original solo escribe `pluginName = <p>`; si el
   web hace lo mismo, borra la selección de banco del usuario.
2. **La DLL reescribe el archivo al guardar**, así que la web no es la fuente de
   verdad: hay que releerlo antes de mostrarlo y no mantener caché.
3. **Hay carrera de escritura**: `fopen("w")` trunca y no es atómico. La web
   debería editar solo con el host cerrado, o detectar el `mtime` y avisar.

Se mantiene igual el resto: sigue haciendo falta el host nativo para *aplicar*
el banco, y no hace falta JUCE ni MIDI para nada de esto.

## 7. Limitaciones del análisis

- Sin PDB, todos los nombres son sintéticos.
- Ghidra tipa mal la firma de `VSTPluginMain` (trata el `hostCallback` como
  `int` y el `AEffect*` como función). El cuerpo del wrapper y el reenvío de
  `process`/`processReplacing`/editor **no** se han descompilado función a
  función; haría falta el listado de instrucciones.
- La función que hace el `LoadLibrary` del plugin original no está identificada
  todavía; la presencia de imports y de la clave `pluginName` sostiene la
  arquitectura de wrapper, pero no se ha trazado la llamada.
- `DAT_100285d9` decide si se aplica byte-swap a los enteros del banco. Su
  semántica exacta (¿archivo big-endian? ¿host big-endian?) no está fijada.
- La sesión de Ghidra del MCP es efímera: las anotaciones se pierden al cerrarla.- `FUN_100038c0` (`fxHeader::check`) ya está verificado en pseudocódigo y
  ensamblador: solo valida magic y uniqueID. Los códigos 2–6 del `switch` de
  `FUN_10003c00` no son alcanzables con esta implementación.
- La ruta del plugin dentro de `FUN_1000a4f0` se obtiene con una llamada
  indirecta al dispatcher del wrapper (`vtable + 0x78`) que no se ha trazado
  hasta el `AEffect` original; se infiere que devuelve el puntero del plugin.

## 8. Cómo reproducirlo

```
rea.open_binary("C:/Users/ajaba/Downloads/fxbloader/vst/fxbLoader.dll")
rea.binary_overview()
rea.search_strings("fxb")
rea.xrefs("0x1001d84c")        # loadFxbBank
rea.xrefs("0x1001e3c0")        # "%s*.fxb"
rea.xrefs("0x1001da30")        # fxBankData::insertTo()
rea.procedure_pseudo_code("0x10003f50")
rea.procedure_pseudo_code("0x10004340")
rea.procedure_pseudo_code("0x10004630")
```
