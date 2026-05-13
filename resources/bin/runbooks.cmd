@echo off
rem Shell script to launch Runbooks from the command line (Windows).
rem Finds the Electron executable relative to this script's location.

setlocal

set "SCRIPT_DIR=%~dp0"

rem resources\bin\ -> app root is two levels up
set "ELECTRON=%SCRIPT_DIR%..\..\Runbooks.exe"

if not exist "%ELECTRON%" (
  echo Error: Could not find the Runbooks executable at %ELECTRON% >&2
  echo Is the Runbooks app installed correctly? >&2
  exit /b 1
)

"%ELECTRON%" %*
