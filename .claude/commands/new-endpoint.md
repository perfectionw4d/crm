---
description: הוסף endpoint חדש ל-server.js עם מוסכמות הפרויקט
allowed-tools: Read, Edit, Bash(grep:*), Bash(node:*), Bash(npm:*)
argument-hint: [תיאור ה-endpoint]
---

הוסף endpoint חדש ל-`server.js` בעקבות הבקשה הזו: $ARGUMENTS

עקוב אחרי המוסכמות:

1. **קרא קודם את `CLAUDE.md`** והבן את מבנה הפרויקט.
2. **מצא endpoint דומה** ב-`server.js` כקוד דוגמה (השתמש ב-grep לחיפוש בנקודה לוגית קרובה).
3. **הוסף route** עם הדרישות הבאות:
   - הגנה ב-`requirePassword` (אלא אם זה webhook חיצוני — אז כתוב הערה ברורה).
   - שימוש ב-`rj()` ו-`wj()` לקריאה/כתיבה של JSON. **אל תשתמש** ב-`fs.readFileSync`/`writeFileSync` ישירות.
   - מזהי ID חדשים: `uid()`.
   - תאריכים: `today()` עבור YYYY-MM-DD; `new Date().toISOString()` עבור timestamp מלא.
   - שמירה על סגנון קוד קיים (compact, ללא JSDoc מיותר).
4. **טפל בשגיאות** — `try/catch` עם `res.status(500).json({ error: ... })`.
5. **הוסף בלוג** — `console.log('[שם הקטע]', ...)` עבור פעולות חשובות.
6. **בדוק כי `.env` לא נדרש לתוספת חדשה** — אם כן, הוסף הערה ב-CLAUDE.md.
7. **תיעוד** — אם ה-endpoint נחשב, הוסף שורה לטבלת ה-routes ב-CLAUDE.md סעיף 6.

לאחר השינוי:
- הצע למשתמש להריץ `npm start` ולבדוק את ה-endpoint עם `curl` או דפדפן.
- אם השינוי משפיע על UI — ציין שצריך לעדכן גם את `public/index.html`.
- אל תבצע `git commit` אוטומטית.
