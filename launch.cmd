@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_EXE=%~dp0runtime\node\node.exe"
if exist "%NODE_EXE%" goto found
set "NODE_EXE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if defined NODE_EXE goto found
echo Node.js with npm is required. / Требуется Node.js с npm.
echo Download the Windows LTS installer from the official website.
echo Скачайте Windows LTS Installer с официального сайта, установите и повторите этот BAT.
echo This launcher does not install software or change Windows settings automatically.
start "" "https://nodejs.org/en/download"
pause
exit /b 1
:found
"%NODE_EXE%" "%~dp0project\scripts\windows-launch.mjs" %1 %2
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo FAILED / НЕ ЗАВЕРШЕНО. Read the message above / Прочитайте сообщение выше.
pause
exit /b %RESULT%
