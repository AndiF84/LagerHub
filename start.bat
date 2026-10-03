@echo off
rem LagerHub per Doppelklick starten - ruft start.ps1 auf.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
