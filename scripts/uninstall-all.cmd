@echo off
REM Bridge for systems without pwsh (PowerShell Core) on PATH.
REM Forwards to Windows PowerShell 5.1 which is built into Windows.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-all.ps1" %*
