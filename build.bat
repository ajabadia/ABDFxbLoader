@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ---------------------------------------------------------------------------
rem  ABDfxbloader - Compilador del ejecutable standalone para Windows (.exe)
rem
rem  Uso:
rem    build.bat          Compila TypeScript, empaqueta activos y genera ABDfxbloader.exe
rem    build.bat --run    Compila y además arranca el .exe generado
rem ---------------------------------------------------------------------------

set "ROOT=%~dp0"
pushd "%ROOT%" || exit /b 1

echo ======================================================================
echo   ABDfxbloader - Compilando Ejecutable Standalone (.exe)
echo ======================================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] No se encuentra Node.js en el sistema.
    echo         Por favor, instala Node.js ^(v20 o superior^) para compilar.
    popd
    exit /b 1
)

if not exist "webapp\node_modules" (
    echo [1/3] Instalando dependencias de webapp...
    pushd webapp
    call npm install
    if errorlevel 1 (
        echo [ERROR] Falló la instalación de dependencias.
        popd
        popd
        exit /b 1
    )
    popd
) else (
    echo [1/3] Dependencias verificadas en webapp\node_modules.
)

echo.
echo [2/3] Compilando TypeScript y empaquetando ejecutable (Node SEA + Edge App)...
pushd webapp
call npm run package:desktop
set "BUILD_STATUS=%ERRORLEVEL%"
popd

if not "%BUILD_STATUS%"=="0" (
    echo.
    echo [ERROR] Ocurrió un error durante la compilación del ejecutable.
    popd
    exit /b %BUILD_STATUS%
)

echo.
echo [3/3] ¡Compilación finalizada con éxito!
echo.
set "EXE_PATH=%ROOT%webapp\dist-desktop\ABDfxbloader.exe"
if exist "%EXE_PATH%" (
    for %%F in ("%EXE_PATH%") do (
        echo   Ejecutable generado:
        echo     Ruta:   %%~fF
        echo     Tamaño: %%~zF bytes
    )
) else (
    echo   Aviso: El archivo %EXE_PATH% no se encontró en la ruta esperada.
)

echo.
echo ======================================================================
echo   Listo para usar con doble clic en Windows (sin depender de Node.js).
echo ======================================================================
echo.

if /i "%~1"=="--run" (
    echo Arrancando ABDfxbloader.exe...
    start "" "%EXE_PATH%"
)

popd
exit /b 0
