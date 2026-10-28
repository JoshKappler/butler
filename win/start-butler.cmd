@echo off
rem Starts Butler from this checkout. Used by the Startup shortcut and by
rem butler-keys.ahk when Pause is pressed while Butler is down.
cd /d "%~dp0.."
rem electron.exe directly: a GUI process with no console, so closing a
rem console window cannot take Butler down, and no cmd is left behind.
start "" "%~dp0..\node_modules\electron\dist\electron.exe" .
