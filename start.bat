@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ---------------------------------------------------------------------------
rem  fxbLoader web - inicio en Windows
rem
rem  Uso:  start.bat [puerto]        (por defecto 3210)
rem
rem  1. Libera el puerto: cierra lo que este escuchando en el.
rem  2. Instala dependencias y compila si el build falta, esta desactualizado o
rem     le sobran archivos sin fuente (huerfanos: un .js de dist o public\js
rem     cuyo .ts ya no existe). Al recompilar borra antes dist y public\js para
rem     no arrastrar esas salidas.
rem  3. Arranca el servidor en esta ventana (aqui quedan los logs).
rem  4. Espera a que responda y abre la UI en el navegador.
rem
rem  FXB_NO_BROWSER=1 evita abrir el navegador (util para automatizar).
rem  FXB_SKIP_SERVER=1 recorre compilacion y limpieza y sale sin arrancar el
rem                    servidor: lo usa el job de CI que prueba este .bat.
rem ---------------------------------------------------------------------------

set "ROOT=%~dp0"
pushd "%ROOT%" || exit /b 1

if "%~1"=="" goto env_port
set "PORT=%~1"
goto check_port

rem Sin argumento: PORT del entorno (lo lee el servidor) o 3210. Un 0 heredado
rem no es un puerto utilizable, asi que se ignora.
:env_port
if "%PORT%"=="" set "PORT=3210"
if "%PORT%"=="0" set "PORT=3210"

:check_port
rem Solo digitos: cualquier otra cosa deja un token al partir por digitos.
for /f "delims=0123456789" %%A in ("%PORT%") do goto bad_port
if %PORT% LSS 1 goto bad_port
if %PORT% GTR 65535 goto bad_port

where node >nul 2>&1
if errorlevel 1 goto no_node

if exist "webapp\node_modules" goto deps_ok
echo Instalando dependencias (npm ci)...
pushd webapp
call npm ci
set "STATUS=%ERRORLEVEL%"
popd
if not "%STATUS%"=="0" goto fail_npm
:deps_ok

rem El build solo sirve si sigue siendo actual. La decision vive en un script
rem de Node (`webapp\scripts\build-decision.mjs`) para que se pueda probar en
rem cualquier sistema: devuelve 0 si el build esta al dia y 1 si hay que
rem recompilar, con el motivo en una linea. Tambien comprueba los huerfanos
rem (un .js emitido cuyo .ts ya no existe) aunque ninguna fecha lo delate:
rem `tsc` no borra esas salidas y se servirian como si existieran. Ante
rem cualquier duda (o si el script no esta) recompila: nunca se sirve un build
rem viejo.
node "webapp\scripts\build-decision.mjs"
if not errorlevel 1 goto build_ok

rem `tsc` no limpia: si se borro o se renombro un archivo fuente, su .js sigue
rem en dist/ o public/js/ y se sirve como si existiera. Por eso la decision
rem tambien mira los huerfanos, y esta rama borra las dos salidas antes de
rem compilar; solo en esta rama, con el build al dia y sin huerfanos no se toca
rem nada. Si no se pueden borrar (algo las tiene abiertas) se avisa en vez de
rem compilar encima y dejar huerfanos sin enterarse.
echo Limpiando dist y public\js...
if exist "webapp\dist" rmdir /s /q "webapp\dist"
if exist "webapp\public\js" rmdir /s /q "webapp\public\js"
if exist "webapp\dist" goto fail_clean
if exist "webapp\public\js" goto fail_clean

echo Compilando servidor y UI (npm run build)...
pushd webapp
call npm run build
set "STATUS=%ERRORLEVEL%"
popd
if not "%STATUS%"=="0" goto fail_build
:build_ok

rem Modo de las pruebas de CI: ya esta compilado y limpio, pero no se arranca el
rem servidor (ocuparia la ventana y el job no lo necesita).
if defined FXB_SKIP_SERVER goto build_only

echo Liberando el puerto %PORT%...
set "SEEN=;"

rem En algunas maquinas (VPN, antivirus, filtros de red) `netstat` no lista el
rem socket LISTENING aunque el puerto este ocupado, asi que la fuente principal
rem es Get-NetTCPConnection: se acepta cualquier estado porque un socket a medio
rem cerrar sigue reteniendo el puerto. `netstat` queda como respaldo.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort %PORT% -ErrorAction SilentlyContinue; $c.OwningProcess"`) do call :kill_port %%P
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do call :kill_port %%P

rem Windows tarda un momento en soltar el puerto tras matar al proceso. Se
rem sondea con una conexion TCP: en Windows SO_REUSEADDR deja atar el puerto
rem aunque ya este escuchando, asi que un bind no sirve como prueba.
set /a WAIT=0
:wait_free
node -e "var s=require('net').connect(+process.argv[1],'127.0.0.1');s.on('connect',function(){process.exit(1)});s.on('error',function(){process.exit(0)})" %PORT% >nul 2>&1
if not errorlevel 1 goto port_free
set /a WAIT+=1
if %WAIT% GEQ 20 goto port_busy
ping -n 2 127.0.0.1 >nul
goto wait_free

:port_free
if defined KILLED echo Puerto liberado.
echo Arrancando fxbLoader en el puerto %PORT%...
echo http://127.0.0.1:%PORT%/  (Ctrl+C para detenerlo)
if defined FXB_NO_BROWSER goto run_server

rem Proceso auxiliar: espera a que la API responda y abre la UI. Se lanza
rem aparte para que el servidor ocupe esta ventana con sus logs.
start "" /B powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/' -TimeoutSec 2; if ($r.StatusCode -eq 200) { Start-Process 'http://127.0.0.1:%PORT%/'; break } } catch { }; Start-Sleep -Milliseconds 500 }" >nul 2>&1

:run_server
pushd webapp
node dist/main.js
set "STATUS=%ERRORLEVEL%"
popd
if "%STATUS%"=="0" goto finish
echo.
echo El servidor termino con codigo %STATUS%.
if not defined FXB_NO_BROWSER pause
rem Sin este salto, el flujo caeria en :build_only y borraria el codigo de error.
goto finish

:build_only
set "STATUS=0"
goto finish

:finish
popd
exit /b %STATUS%

rem --- Cierra un PID que retiene el puerto, sin repetirlo ni tocar el 0. ------
:kill_port
if "%~1"=="" exit /b 0
if "%~1"=="0" exit /b 0
echo %SEEN% | findstr /C:";%~1;" >nul
if not errorlevel 1 exit /b 0
set "SEEN=%SEEN%%~1;"
set "PNAME="
for /f "tokens=1 delims=," %%N in ('tasklist /FI "PID eq %~1" /NH /FO CSV 2^>nul') do if not defined PNAME set "PNAME=%%~N"
taskkill /F /PID %~1 >nul 2>&1
set "KRES=%ERRORLEVEL%"
if "%KRES%"=="0" echo   cerrado PID %~1 [%PNAME%]
if not "%KRES%"=="0" echo   no se pudo cerrar el PID %~1 [%PNAME%]: puede requerir permisos de administrador.
if "%KRES%"=="0" set "KILLED=1"
exit /b 0

:bad_port
echo Puerto no valido: "%PORT%". Usa un numero entre 1 y 65535.
goto fail

:no_node
echo No se encontro Node.js en el PATH. Instala Node 20 o superior.
goto fail

:fail_npm
echo Fallo "npm ci". Revisa la salida anterior.
goto fail

:fail_clean
rem Sin este aviso, el build se haria encima del anterior y los huerfanos
rem volverian a quedarse ahi sin que se note.
echo No se pudieron borrar "webapp\dist" o "webapp\public\js": algun archivo
echo esta en uso (un servidor o un editor con esos archivos abiertos).
echo Cierralo y vuelve a lanzar start.bat.
goto fail

:fail_build
echo Fallo "npm run build". Revisa la salida anterior.
goto fail

:port_busy
echo El puerto %PORT% sigue ocupado. Quien lo retiene puede ser un proceso
echo protegido (PID 4, servicio del sistema o de otro usuario): revisa
echo   netstat -ano ^| findstr :%PORT%
echo y cierra ese proceso, o lanza start.bat con otro puerto.
goto fail

:fail
popd
exit /b 1
