# Fixture de librería VFX

Reproduce el layout que espera `fxbLoaderConfig.exe`:

```
plugs\
  <Plugin>\
    vfxinfo.txt
    <Plugin>\
      <Plugin>.dll
```

Los `.dll` de los plugins son cabeceras PE32 de 256 bytes y **no** son plugins
reales: no se ejecutan, pero el escaneo lee su cabecera para comprobar que son
`PE32 i386`, la arquitectura que acepta `fxbLoader.dll`. El instalador solo
conserva la ruta de `dll_name` para poder restaurarla.

Los fixtures que se crean en cada test hacen lo mismo con
[`writePluginDll`](../../helpers/vfx-plugin.ts), que escribe siempre un PE32
real (o un PE32+ cuando el test espera un rechazo) en la ruta que declara
`dll_name`. Un `vfxinfo.txt` cuyo binario no existe ya no vale como fixture: el
escaneo lo marca **incompatible** (`Instalar` deshabilitado) y
`POST /library/install` lo rechaza con **422** en vez de dejar el plugin
apuntando a un archivo inexistente. `OB-Xd` existe para que
[`synth-bank.fixture.test.ts`](../../synth-bank.fixture.test.ts) importe su
banco de fábrica real en un plugin de esta librería. La DLL que sí se prueba de
verdad es
[`vst/fxbLoader.dll`](../../../../vst/fxbLoader.dll), la del repositorio.

`vfxinfo.txt` está en ANSI con CRLF, como los que escribe el host.

## Usar una librería real

El test acepta una librería real sin tocar el fixture:

```bash
FXB_VFX_LIBRARY="C:\VFX\MiLibreria" npm test
```

Se copia entera a un directorio temporal y se opera sobre la copia; el test
elige el primer plugin con `vfxinfo.txt` que no tenga ya el cargador.
