# זרימה: סנכרון Google (Calendar / Tasks / Contacts)

## סקירה

הסנכרון הוא **דו-כיווני**:
- **Push** — כל שינוי ב-CRM נדחף ל-Google מיד.
- **Pull** — קריאה מ-Google כל 5 דקות (או לפי בקשה ידנית).

הקבצים המעורבים:
- `data/tokens.json` — OAuth tokens של החשבון הראשי.
- `data/extra-tokens.json` — חשבונות Gmail נוספים (קריאת מיילים בלבד).
- `data/sync-status.json` — מצב סנכרון אחרון.

---

## 1. חיבור ראשוני

**flow:**
1. משתמש לוחץ "התחבר עם Google" בהגדרות.
2. `GET /auth/google` → redirect ל-Google consent screen.
3. אחרי אישור → `GET /auth/callback` → tokens נשמרים ב-`tokens.json`.
4. ה-`scope` כולל: `calendar`, `tasks`, `contacts`, `gmail.readonly`.

**הוספת חשבון Gmail נוסף:** `/auth/google/add` (גם כן OAuth, נשמר ב-`extra-tokens.json`).

---

## 2. סנכרון Contacts

**endpoint ידני:** `POST /api/sync/contacts` (`requireAuth` middleware).

**flow:**
1. שולף את כל אנשי הקשר מ-Google People API.
2. לכל אחד — מנסה למצוא רשומה תואמת ב-`contacts.json` לפי `googleContactId`.
3. אם נמצא — עדכון. אם לא — יצירה חדשה עם `fromGoogle: true`.
4. **שינוי ב-CRM** → push מיידי ל-Google דרך `people.updateContact`.

**שחזור אנשי קשר שנמחקו:** `POST /api/sync/contacts/restore` — שולף contactsים שנמחקו ב-CRM אבל עדיין ב-Google.

---

## 3. סנכרון Calendar / Tasks

**endpoint ידני:** `POST /api/sync/calendar`.

**flow:**
1. שליפת כל ה-events והtasks מהחודש האחרון + 3 חודשים קדימה.
2. מיפוי לרשומות ב-`tasks.json` לפי `googleEventId` / `googleTaskId`.
3. הפרדה לפי `type`:
   - `event` → Google Calendar
   - `task` → Google Tasks
   - `meeting` / `show` → גם וגם (תלוי בלוגיקה הספציפית).

**טריגר אוטומטי:** כשמשתמש יוצר משימה ב-CRM → `POST /api/tasks` → אם יש OAuth, push מיידי לפני החזרת התשובה.

---

## 4. תזמון אוטומטי

ב-`server.js` יש `setInterval` (כל 5 דקות) שמפעיל:
- pull contacts (אם ה-`tokens.json` תקף).
- pull calendar events.
- pull tasks.

**אם ה-token פג:** רענון אוטומטי דרך `googleapis` library (משתמש ב-`refresh_token`).

---

## 5. Gmail (קריאה בלבד)

**endpoint:** `GET /api/contacts/:id/emails` (server.js שורה ~1042).

**flow:**
1. שולף את ה-`email` של איש הקשר.
2. עובר על כל ה-tokens (`tokens.json` + `extra-tokens.json`).
3. מבצע `gmail.users.messages.list` עם query `from:<email> OR to:<email>`.
4. מחזיר 20 מיילים אחרונים.

**הערה:** שליחת מיילים **לא** דרך Gmail API — דרך Resend (סעיף 9 ב-CLAUDE.md).

---

## תקלות נפוצות

### "Token expired"
- הרענון האוטומטי אמור לעבוד. אם לא — מחק את `tokens.json` ובצע חיבור מחדש.

### "Quota exceeded"
- Google API limits: People = 90 read/min, Calendar = 1M/day.
- אם broadcast גדול — שקול להוסיף `setTimeout` בין קריאות.

### "אנשי קשר כפולים"
- קורה אם משתמש ערך contact ב-Google ובאותו זמן ב-CRM.
- פתרון: חיפוש לפי שם + טלפון (לא רק `googleContactId`).

### "אירועי 5 דקות לא מסונכרנים"
- בדוק `sync-status.json` — מתי היה ה-sync האחרון?
- בדוק לוגים: `console.log('[SYNC]', ...)`.

---

## למה זה לא DB?

החלטה מודעת. Google הוא ה-"DB" האמיתי — JSON המקומי הוא **cache** + תוספות (sigs, status, notes ש-Google לא תומך). זה גם אומר:
- אם data/contacts.json נמחק — sync יחזיר את הכל (חוץ מנתוני CRM שלא היו ב-Google).
- אסור למחוק `tokens.json` במקרה — תאבדו את החיבור.
