@echo off
rem LagerHub - Update einspielen. Rechtsklick - "Als Administrator ausfuehren".
rem Startet update.ps1 aus demselben Ordner; -ExecutionPolicy Bypass, weil die
rem Dateien vom Stick kommen und Windows sie sonst als "aus dem Internet" sperrt.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
echo.
pause
