@echo off
chcp 65001 >nul
title Tahtaya At - Akilli Tahta ve Telefon Koprusu
cd /d "%~dp0"
echo.
echo  =========================================================
echo   TAHTAYA AT baslatiliyor...
echo   Tarayicida Tahta Ekrani birazdan acilacak.
echo  =========================================================
echo.
start "" "http://localhost:8080/?ekran=tahta"
python server.py
pause
