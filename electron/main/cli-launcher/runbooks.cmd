@echo off
:: Template for the `runbooks` command that Runbooks installs as
:: %LOCALAPPDATA%\Runbooks\bin\runbooks.cmd on Windows. renderWindowsLauncher
:: in electron/main/cli-install.ts fills in each {{name}}, drops every line
:: that starts with ::, so these notes never reach the installed file, and
:: writes it with the CRLF line endings cmd.exe needs. Keep this file LF (see
:: .gitattributes).
::
:: Like the macOS/Linux launcher, it returns at once: a batch file would
:: otherwise wait for the app to quit, even though it is a GUI program.
::
:: {{marker}} is LAUNCHER_MARKER, which marks the file as written by Runbooks.
rem {{marker}}
:: Keeps ELECTRON_NO_ATTACH_CONSOLE, set below, out of the caller's shell.
setlocal
:: {{verboseFlag}} anywhere in the arguments runs the app in the foreground
:: instead, attached to the console (see VERBOSE_FLAG in cli-install.ts).
:: It is looked for with `shift`, which leaves %* as it was. A
:: `for %%a in (%*)` loop would treat the `?` in a go-getter `?ref=` as a
:: wildcard and expand it against the working directory.
:scan
if "%~1"=="" goto detach
if /i "%~1"=="{{verboseFlag}}" goto verbose
shift
goto scan
:: {{exe}} is the app's executable, escaped for cmd.exe by
:: renderWindowsLauncher.
:verbose
"{{exe}}" %*
exit /b %ERRORLEVEL%
:: `start` keeps the caller's working directory and environment.
:: ELECTRON_NO_ATTACH_CONSOLE stops Electron from attaching to the caller's
:: console and printing the app's logs there.
:detach
set "ELECTRON_NO_ATTACH_CONSOLE=1"
start "" "{{exe}}" %*
