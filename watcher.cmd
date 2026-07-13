@echo off
start "Spectator CLI watcher" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-watcher.ps1"
