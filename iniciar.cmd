@echo off
chcp 65001 >nul
setlocal

rem ---------------------------------------------------------------------------
rem  Tres Tickets - arranque para Windows
rem
rem  Se puede ejecutar con doble clic: no hace falta abrir PowerShell ni saber
rem  en que carpeta estas parado. El script se para solo en su propia carpeta,
rem  verifica que Node este instalado y con la version correcta, levanta el
rem  servidor y abre el navegador.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

title Tres Tickets

echo.
echo   Tres Tickets
echo   ============
echo.

rem --- 1. Node instalado? -----------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo   [X] No encontre Node.js en esta computadora.
    echo.
    echo   Tres Tickets necesita Node.js para funcionar: es el programa que
    echo   corre el servidor. Se instala una sola vez.
    echo.
    echo     1. Entra a  https://nodejs.org
    echo     2. Descarga la version LTS ^(el boton grande de la izquierda^)
    echo     3. Instalala con Siguiente / Siguiente / Finalizar
    echo     4. CERRA esta ventana y volve a hacer doble clic en iniciar.cmd
    echo.
    echo   El paso 4 importa: Windows solo ve los programas nuevos en las
    echo   ventanas que se abren despues de instalarlos.
    echo.
    pause
    exit /b 1
)

rem --- 2. Version suficiente? -------------------------------------------------
for /f "tokens=*" %%v in ('node -v') do set "NODE_VERSION=%%v"

if not defined NODE_VERSION (
    echo   [X] Node esta instalado pero no responde.
    echo.
    echo   Proba reinstalarlo desde  https://nodejs.org  y volve a intentar.
    echo.
    pause
    exit /b 1
)

set "NODE_NUM=%NODE_VERSION:v=%"
set "NODE_MINOR=0"
for /f "tokens=1,2 delims=." %%a in ("%NODE_NUM%") do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)

set "NODE_OK=1"
if %NODE_MAJOR% LSS 22 set "NODE_OK=0"
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 5 set "NODE_OK=0"

if "%NODE_OK%"=="0" (
    echo   [X] Tenes Node %NODE_VERSION%, y hace falta 22.5 o mas nuevo.
    echo.
    echo   La base de datos usa el SQLite que viene adentro de Node, que en
    echo   versiones anteriores no existe.
    echo.
    echo     1. Entra a  https://nodejs.org
    echo     2. Instala la version LTS encima de la que tenes
    echo     3. CERRA esta ventana y volve a hacer doble clic en iniciar.cmd
    echo.
    pause
    exit /b 1
)

echo   Node %NODE_VERSION% - listo.
echo.
echo   Levantando el servidor... ^(la primera vez tarda unos segundos
echo   porque carga los eventos de ejemplo^)
echo.
echo   Cuando termines, cerra esta ventana para apagar el servidor.
echo.

rem --- 3. Servidor ------------------------------------------------------------
rem  TT_OPEN=1 hace que el propio servidor abra el navegador, pero recien
rem  cuando ya esta escuchando: asi no hay que adivinar cuanto tarda.
set "TT_OPEN=1"
node --disable-warning=ExperimentalWarning server\src\index.js

echo.
echo   El servidor se detuvo.
pause
