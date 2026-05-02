---
description: בדוק זרימה ספציפית במערכת מקצה לקצה (מקומית)
allowed-tools: Read, Bash(npm:*), Bash(node:*), Bash(curl:*), Bash(grep:*)
argument-hint: [שם הזרימה — למשל "יצירת הצעת מחיר" או "broadcast WA"]
---

בדוק את הזרימה הבאה מקצה לקצה (מקומית בלבד): $ARGUMENTS

### צעדים:

1. **ודא שהשרת רץ:**
   ```bash
   curl -s http://localhost:3000/api/sync-status > /dev/null && echo "✅ שרת עולה" || echo "❌ הרץ קודם npm start"
   ```

2. **קרא את הקטע הרלוונטי ב-`server.js`** (השתמש ב-CLAUDE.md סעיף 6 לאיתור).

3. **בדוק את ה-data של הזרימה:**
   - איזה קבצי JSON מעורבים?
   - האם יש דוגמאות קיימות שאפשר לבדוק?

4. **אם הזרימה כוללת:**
   - **WhatsApp** — בדוק שיש `WA_ACCESS_TOKEN` ב-`.env` (אבל אל תקרא את `.env`!). הצע `/api/wa/status`.
   - **Google sync** — בדוק `/auth/status`.
   - **WordPress** — בדוק `/api/wp/ping`.
   - **Email** — בדוק שיש `RESEND_API_KEY` (דרך התנהגות ה-API, לא קריאה ישירה).

5. **אל תפעיל מבחנים שעלולים לשלוח הודעות אמיתיות** (broadcast, send template) ללא אישור מפורש מהמשתמש.

6. **דווח:**
   - מה עובד ומה לא.
   - אילו קבצים השתנו (אם בכלל).
   - הצעות לשיפור.

### זרימות נפוצות במערכת:
- יצירת הצעת מחיר → שליחה במייל → אישור לקוח → המרה להזמנה → חתימה.
- ליד נכנס מ-Elementor → contact חדש ב-CRM → WhatsApp template אוטומטי.
- סנכרון Google Contacts → contacts חדשים מסומנים `fromGoogle: true`.
- broadcast WhatsApp → איטרציה על רשימה → תיעוד ב-`wa-messages.json`.
