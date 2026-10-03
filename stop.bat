@echo off
rem LagerHub per Doppelklick beenden - ruft stop.ps1 auf.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
