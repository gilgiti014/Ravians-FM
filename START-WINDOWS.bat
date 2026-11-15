@echo off
title Ravians FM
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Download it from https://nodejs.org and run this again. & pause & exit /b)
if not exist node_modules (call npm install)
start "" http://localhost:3000/#/studio
node server.js
pause
