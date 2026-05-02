@echo off
chcp 65001 >nul
echo.
echo  CRM שקוף בחזית - הפעלה
echo  ========================
echo.

cd /d "%~dp0"

if not exist ".env" (
  echo  יוצר קובץ .env...
  copy .env.example .env >nul 2>&1
)

if not exist "node_modules" (
  echo  מתקין חבילות (פעם ראשונה בלבד)...
  npm install
  echo.
)

echo  מפעיל שרת CRM...
start "" http://localhost:3000

start "CRM - שקוף בחזית" cmd /k "cd /d "%~dp0" && node server.js"
