@echo off
start "Spectator" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-spectator.ps1" %*
