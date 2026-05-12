@echo off
start "" python -m http.server 8080
timeout /t 1 /nobreak >nul
start "" "chrome" --app=http://localhost:8080
