# CLAUDE.md — שקוף בחזית CRM

> מסמך הקשר עבור Claude Code. זהו ה־"זיכרון הפרויקטלי" שיוטען אוטומטית בכל סשן של Claude Code בתיקייה הזו.
> תאריך עדכון אחרון: 2026-04-26

---

## 1. הקשר עסקי בקצרה

הפרויקט הוא **CRM ייעודי** עבור **ירון (טוני) אנטניר** — אמן סיפורים, מופע "שקוף בחזית" ומחבר הספר *"לא הייתי מקולקל, הייתי פצוע"*. ה־CRM מנהל את כל מחזור החיים העסקי של מופעים, הרצאות וסדנאות:

1. **לידים נכנסים** דרך אתר WordPress (Elementor webhook), Google Contacts, או הזנה ידנית.
2. **טיפוח** — שיחות WhatsApp, מיילים, משימות מעקב, התאמת סטטוס (cold → warm → vip).
3. **הצעת מחיר** (`quotes`) — נוצרת מתוך כרטיס איש קשר, נשלחת במייל, מתפרסמת ב־WordPress תחת `/offers/{מספר}/`.
4. **הזמנת עבודה** (`orders`) — מומרת מהצעה מאושרת, חתימה דיגיטלית, מתפרסמת תחת `/orders/{מספר}/`.
5. **ביצוע ומעקב** — אירועים בקלנדר, היסטוריית מופעים בכרטיס, תזמון WhatsApp follow-up.

**מי הלקוחות:** עיריות, מתנ"סים, בתי ספר, ארגונים פרטיים, יחידים. רוב התקשורת בעברית. אזור גיאוגרפי: ישראל.

**מה ייחודי כאן:**
- ממשק עברית מלא RTL.
- WhatsApp Cloud API (לא Baileys) הוא ערוץ הליבה — לא רק email.
- אין DB; כל האחסון JSON על דיסק (Volume ב־Railway).
- SPA בקובץ HTML יחיד עם React 18 + Babel inline.

---

## 2. סטאק טכנולוגי

| שכבה | טכנולוגיה |
|------|-----------|
| **Backend** | Node.js 20 + Express 4 |
| **Frontend** | React 18 + Babel (inline ב־`public/index.html`) |
| **אחסון** | JSON files ב־`data/` (Volume ב־Railway) |
| **אימות** | `express-session` + `session-file-store` + bcrypt-style pbkdf2 |
| **OAuth** | Google APIs (`googleapis`) — Calendar, Tasks, People (Contacts), Gmail |
| **WhatsApp** | Meta Cloud API (graph.facebook.com) — לא Baileys |
| **מייל** | Resend API ראשי, Gmail SMTP fallback מקומי |
| **PDF / הצעות** | HTML inline → puppeteer-core (אופציונלי) או הדפסת דפדפן |
| **פריסה** | Railway.app + Docker + Volume `/app/data` |
| **Webhook** | WordPress (Elementor) → `/api/webhook/elementor` |

**אורך השרת:** `server.js` הוא מונוליט יחיד של ~4,170 שורות. אין פיצול לקבצים. שינויים מתבצעים inline.

---

## 3. מבנה הפרויקט

```
crm/
├── server.js                  ← השרת המלא (~4,170 שורות) — נקודת הכניסה
├── public/
│   ├── index.html             ← SPA: React + JSX inline (~המסך הראשי)
│   ├── login.html             ← מסך כניסה (admin password / email+password)
│   ├── reset-password.html    ← איפוס סיסמה
│   ├── rsvp.html              ← דף RSVP חיצוני
│   ├── favicon.svg
│   └── import-template.xlsx   ← תבנית ייבוא אנשי קשר
├── data/                      ← Volume מתמיד (לא ב־git!)
│   ├── contacts.json          ← 419+ אנשי קשר
│   ├── orgs.json              ← ארגונים
│   ├── tasks.json             ← משימות + אירועים
│   ├── quotes.json            ← הצעות מחיר
│   ├── orders.json            ← הזמנות עבודה
│   ├── shows.json             ← תבניות מופעים
│   ├── signatures.json        ← חתימות מייל/WA
│   ├── users.json             ← משתמשי המערכת
│   ├── tokens.json            ← Google OAuth tokens
│   ├── extra-tokens.json      ← tokens של חשבונות Gmail נוספים
│   ├── wa-messages.json       ← inbox WhatsApp
│   ├── scheduled-wa.json      ← הודעות WA מתוזמנות
│   ├── help.json              ← מאמרי הדרכה (guides + Q&A)
│   ├── sync-status.json       ← מצב סנכרון אחרון
│   ├── userinfo.json          ← פרטי בעל המערכת
│   ├── quote-settings.json    ← ברירות מחדל להצעות
│   ├── standalone-shows.json  ← מופעים עצמאיים
│   ├── quotes-html/           ← HTML של הצעות שנוצרו
│   ├── quotes-pdf/            ← PDFים של הצעות
│   └── sessions/              ← session-file-store
├── CRM-Backups/               ← גיבויים יומיים (זיפ של data/*.json)
├── backups/                   ← גיבויים נוספים
├── orders-html/               ← HTML של הזמנות
├── Dockerfile
├── nixpacks.toml
├── railway.json
├── package.json               ← name: "shakuf-crm", v2.0.0
├── .env                       ← לא ב־git
├── .gitignore                 ← node_modules/, data/, .env, *.log
├── crm.html                   ← גרסת legacy של הSPA
├── migrate-data.js            ← העברת נתונים ל־Railway
├── generate_quote.py          ← סקריפט יצירת הצעה (Python, עזר)
├── logo.png                   ← לוגו של "שקוף בחזית"
├── NotoSansHebrew-*.ttf       ← פונטים עבריים ל־PDF
├── CRM-PROMPT.md              ← פרומפט בנייה היסטורי (יותר מקיף, פחות מעודכן)
├── מדריך-התקנה.md             ← מדריך התקנה ללקוח
└── start.bat                  ← הרצה מקומית ב־Windows
```

---

## 4. הרצה ופיתוח

### מקומית (Windows / Linux)
```bash
# התקנת תלויות (חד פעמי)
npm install

# הרצה — ברירת מחדל PORT=3000
npm start
# או:
node server.js
```

### Windows
- יש `start.bat` קצר שמריץ `node server.js`.
- מומלץ להגדיר `.env` עם `PORT`, `ADMIN_PASSWORD`, `GOOGLE_CLIENT_*`.

### Docker
```bash
docker build -t shakuf-crm .
docker run -p 3000:3000 -v $(pwd)/data:/app/data --env-file .env shakuf-crm
```

### Railway (production)
- פריסה אוטומטית מ־GitHub (push ל־`main`).
- `nixpacks.toml` מגדיר את build.
- Volume מצמיד ל־`/app/data` — קבצי JSON שורדים restart.
- `RAILWAY_STATIC_URL` משמש לבניית `REDIRECT_URI` של OAuth.
- PORT מוגדר אוטומטית על ידי Railway (לא 3000).

### בדיקות
**אין מערכת בדיקות אוטומטית** כיום. אימות שינויים נעשה ידנית בדפדפן. בעת שינוי קוד:
1. הרץ מקומית, התחבר עם admin password.
2. בדוק את הזרימה הספציפית שנגעת בה.
3. וודא שאין שגיאות ב־console של הדפדפן וב־stdout של השרת.

---

## 5. משתני סביבה (.env)

```env
# שרת
PORT=3000
SESSION_SECRET=...
ADMIN_PASSWORD=...           ← סיסמת מנהל ראשי (כניסה ללא אימייל)
RECOVERY_CODE=...            ← קוד שחזור חירום

# Google OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Railway
RAILWAY_STATIC_URL=crm-shakuf-production.up.railway.app

# WhatsApp Cloud API
WA_PHONE_NUMBER_ID=...
WA_BUSINESS_ACCOUNT_ID=...
WA_ACCESS_TOKEN=...
NOTIFY_PHONE=972525105100    ← מספר ירון להתראות אבטחה

# WordPress
WP_URL=https://shakufbahazit.co.il
WP_API_KEY=...

# Email — Resend (primary, cloud)
RESEND_API_KEY=re_...
RESEND_FROM=crm@thezebra.co.il

# Email — Gmail SMTP (fallback מקומי בלבד)
SMTP_USER=tony@thezebra.co.il
SMTP_PASS=...                ← App Password
SMTP_FROM=tony@thezebra.co.il
```

⚠️ **הערה:** `.dockerignore` כן מתעלם מ־`data/`, אבל **לא** מ־`.env` — ולכן `.env` נכנס לתוך ה־image. זה עניין מודע (סביבת prod מקבלת variables דרך Railway, לא דרך הקובץ).

---

## 6. ארכיטקטורת השרת — מפת ניווט ב־`server.js`

| קטע | שורות (משוערות) | תפקיד |
|-----|----------------|-------|
| Imports + Helmet + Rate Limiter | 1–80 | אבטחה, התראות WA על brute-force |
| Express init + middlewares | 80–170 | sessions, auth middleware, helpers |
| Auth routes (`/login`, `/logout`, reset) | 170–280 | כניסה, איפוס סיסמה |
| Users CRUD (`/api/users`) | 280–360 | ניהול משתמשים מרובים |
| Google OAuth flow | 530–600 | `/auth/google`, `/auth/callback` |
| Generic CRUD factory (`O`, `C`, `T`, `S`, `SIG`, `BF`) | ~600–930 | פקטורי ל־list/create/update/remove |
| Orgs / Contacts / Tasks / Shows / Signatures routes | 932–1140 | רוטים גנריים מ־factory |
| Bulk operations (contacts) | 943–965 | bulk-status, bulk-delete |
| Gmail integration | 966–1115 | `/api/emails/recent`, `/api/contacts/:id/emails` |
| Quotes (הצעות מחיר) | 1266–1480 | generate, view, status, publish ל־WP |
| Projects / Pipeline | 1516–1768 | ניהול פייפליין מכירות |
| Orders (הזמנות עבודה) | 1768–1970 | generate, view, status, חתימה |
| Sync (Google Calendar / Contacts) | 1970–2150 | סנכרון דו־כיווני |
| Task-done callback | 2426 | endpoint לסימון משימה כבוצעה ממייל |
| WhatsApp Cloud API | 2756–2960 | status, connect, send, broadcast, inbox, scheduled, overdue |
| Bot flows | 3014–3035 | בוט WhatsApp אוטומטי (flows) |
| Settings (quote, show templates, bot) | 3030–3045 | הגדרות מערכת |
| WordPress webhook | 3044–3260 | קליטת לידים מ־Elementor |
| Import contacts (xlsx) | 3259–3290 | analyze, preview, commit |

> **מספר רוטים מוערך:** ~117 endpoints.

### החלקים העיקריים בקצרה:

**generic CRUD factory** — לכל ישות (orgs, contacts, tasks, shows, signatures, bot flows) יש אובייקט (`O`, `C`, `T`, `S`, `SIG`, `BF`) עם 4 פונקציות: `list`, `create`, `update`, `remove`. כל אחת קוראת/כותבת JSON file דרך `rj()` ו־`wj()` helpers. זה מסביר למה רובן שורה אחת בכל route.

**helpers מרכזיים:**
- `rj(filename, default)` — read JSON עם fallback.
- `wj(filename, data)` — write JSON pretty-printed.
- `uid()` — מזהה רנדומלי 8 תווים hex.
- `today()` — תאריך בפורמט ISO (YYYY-MM-DD).
- `requirePassword(req,res,next)` — middleware שדורש session מאומת.
- `requireAuth(req,res,next)` — דורש בנוסף Google OAuth token תקין.

---

## 7. מבני נתונים (JSON schemas — נכון לפועל)

> זוהי המציאות בקבצי הנתונים, לא רק התיעוד ההיסטורי.

### `contacts.json` — איש קשר
```jsonc
{
  "id": "fe08c34e",                    // 8 hex chars
  "name": "מונה אריאל",
  "organizationId": null | "org1",
  "role": "מנהלת תרבות",
  "phone": "052-1234567",
  "email": "x@y.com",
  "city": "תל אביב",
  "status": "lead" | "cold" | "warm" | "hot" | "booked" | "vip" | "notRelevant",
  "source": "Google Contacts" | "WhatsApp בוט" | "המלצה" | "Elementor" | ...,
  "notes": "",
  "tags": ["VIP", "ליד-וואטסאפ"],
  "conversations": [{ "id", "date", "type": "call|whatsapp|email", "content" }],
  "showHistory": [{ "id", "date", "venue", "showType", "status", "fee", "notes" }],
  "nextFollowUp": "2026-04-20",        // YYYY-MM-DD או ""
  "googleContactId": "people/c123...", // null אם לא מסונכרן
  "createdAt": "2026-04-21",
  "fromGoogle": true,                  // אם הגיע מסנכרון
  "restoredAt": "ISO timestamp"        // אם שוחזר
}
```

### `orgs.json` — ארגון
מבנה זהה ל־contact + שדה `industry` (תחום). שדה `organizationId` לא רלוונטי כאן.

### `tasks.json` — משימה / אירוע
```jsonc
{
  "id": "c5affced",
  "title": "התקשר ליניב אורבך",
  "type": "task" | "event" | "meeting" | "show",
  "contactId": null | "id",
  "organizationId": null | "id",
  "conversationId": null | "id",
  "dueDate": "YYYY-MM-DD",             // ל־task
  "startDateTime": "ISO" | null,       // ל־event/meeting
  "endDateTime": "ISO" | null,
  "location": null | "string",
  "completed": false,
  "googleEventId": null,               // מסונכרן ל־Calendar
  "googleTaskId": "abc...",            // מסונכרן ל־Tasks
  "notes": "",
  "priority": "low" | "normal" | "high",
  "createdAt": "YYYY-MM-DD",
  "fromGoogle": true
}
```

### `quotes.json` — הצעת מחיר
```jsonc
{
  "id": "1651f863",
  "quoteNumber": "001",                // מתחיל מ־001, ייחודי
  "quoteDate": "21 באפריל 2026",       // עברית
  "fileName": "quote_1651f863.html",
  "contactId": "dc3517e6",
  "contactName": "מונה אריאל",
  "showName": "הרצאה" | "שקוף בחזית",
  "price": 998,                        // מחיר בסיס
  "total": 1098,                       // כולל מע"מ
  "status": "draft" | "sent" | "approved" | "rejected",
  "createdAt": "ISO",
  "wpUrl": "https://shakufbahazit.co.il/offers/001/",
  "wpPublished": true,
  "orderId": "34f20e91"                // אם הומר להזמנה
}
```

### `orders.json` — הזמנת עבודה
```jsonc
{
  "id": "eb91c600",
  "orderNumber": "2104261",            // מבוסס תאריך + רץ
  "orderDate": "21 באפריל 2026",
  "fileName": "order_eb91c600.html",
  "quoteNumber": "2104265",
  "quoteId": "11df410b",
  "contactId": "dc3517e6",
  "contactName": "מונה אריאל",
  "showName": "שקוף בחזית",
  "total": 3000,
  "status": "pending" | "signed" | "completed" | "cancelled",
  "createdAt": "ISO",
  "wpUrl": "https://shakufbahazit.co.il/orders/2104261/",
  "signedAt": "ISO",
  "signature": "data:image/png;base64,..."  // חתימה דיגיטלית
}
```

### `users.json` — משתמשי מערכת
```jsonc
{
  "id": "...",
  "name": "ירון",
  "email": "tony@thezebra.co.il",
  "passwordHash": "salt:hash",         // pbkdf2-sha512, 100k iterations
  "contactId": null,
  "active": true,
  "createdAt": "ISO",
  "resetToken": null | "hex32",
  "resetExpiry": null | "ISO"          // שעה מהיצירה
}
```

### `tokens.json` / `extra-tokens.json` — Google OAuth
מכיל `access_token`, `refresh_token`, `scope`, `expiry_date`. רענון אוטומטי ב־`googleapis`.

### `wa-messages.json` — Inbox WhatsApp
הודעות מהקליינטים, ממופות לאיש קשר ב־CRM (אם זוהה לפי טלפון).

### `scheduled-wa.json` — הודעות מתוזמנות
מערך הודעות שיישלחו בזמן עתידי. cron פנימי ב־`server.js` סורק אותן.

### `help.json` — מרכז הדרכה
מאמרי `guide` (עם `steps[]`) ושאלות `qa`. `status: "published" | "pending"`.

---

## 8. מוסכמות פיתוח

### שפה ו־RTL
- **כל ה־UI בעברית.** טקסטים, כותרות, הודעות שגיאה, כפתורים.
- **תאריכים:** לרוב בפורמט ISO (`YYYY-MM-DD`) ב־data, אבל נציגים בעברית בהצעות (`21 באפריל 2026`).
- **טלפונים:** נשמרים גם עם וגם בלי `0` מקדים, יש פונקציית `normPhoneCrm()` לנרמול.
- **קידומת בינ"ל:** `972` מוצמד ל־WhatsApp (`0525105100` → `972525105100`).

### זרימת מזהים (IDs)
- `id` הוא תמיד `uid()` = 8 תווי hex רנדומליים (`crypto.randomBytes(4).toString('hex')`).
- חריגים: `org1`, `org2` (seed values), `c1..c4` (seed contacts), `h1..h10` (seed help articles).
- `quoteNumber` מתחיל ב־`001` ועולה.
- `orderNumber` נבנה מ־`DDMMYY` + מונה רץ (למשל `2104261`).

### עבודה עם קבצי JSON
- **אל תקרא/תכתוב ידנית** עם `fs.readFileSync` — תמיד עבור דרך `rj()` / `wj()`.
- **שמור הסטוריה:** בכל write, רצוי לעדכן `updatedAt` (לא תמיד נעשה — ראוי לשפר).
- **גיבויים:** סקריפט יומי ב־`CRM-Backups/` (משימה מתוזמנת ב־Cowork). שומר 30 גיבויים אחרונים.

### פרונט (`public/index.html`)
- **קובץ HTML יחיד** — מכיל React + Babel inline + כל ה־CSS + כל ה־JSX.
- אין build step. שינוי = refresh דפדפן.
- **State management:** React hooks, אין Redux/Context גלובלי.
- **קריאות API:** `fetch('/api/...')` ישיר, עם credentials מ־session cookie.
- **עיצוב:** indigo (`#6366f1`) ראשי, רדיוס 12px, צללים עדינים.
- **רספונסיבי:** עובד גם במובייל (sidebar הופך ל־bottom-nav).

### אבטחה
- כל route תחת `/api/` עובר `requirePassword`, חוץ מ:
  - `/api/webhook/elementor` (חיצוני)
  - `/api/admin/import-data` (secret-protected, למיגרציה)
- **Rate limit:** 5 ניסיונות תוך 15 דק' = חסימה 15 דק'.
- **התראת אבטחה:** אחרי 10 כישלונות → WhatsApp ל־`NOTIFY_PHONE`.
- **Reset tokens:** רנדומליים 32 בייטים, תפוגה שעה אחת.
- **חשוב:** סיסמאות נשמרות כ־`salt:hash` עם pbkdf2-sha512, 100k iterations.

---

## 9. אינטגרציות חיצוניות

### Google Workspace
- **Calendar** ↔ `tasks.json` (events) — סנכרון דו־כיווני, push מיידי, pull כל 5 דק'.
- **Tasks** ↔ `tasks.json` (tasks) — אותו דבר.
- **People (Contacts)** ↔ `contacts.json`.
- **Gmail** — קריאת מיילים אחרונים לכרטיס איש קשר; שליחה דרך Resend (לא Gmail API).
- תמיכה ב־**מספר חשבונות Gmail** (`extra-tokens.json`).

### WhatsApp Cloud API
- **Endpoint:** `https://graph.facebook.com/v18.0/{WA_PHONE_NUMBER_ID}/messages`.
- **תבניות מאושרות:** `first_message` (header = שם, body קבוע). אין כפתור call (דורש Calling API).
- **Webhook:** מקבל הודעות נכנסות ל־`wa-messages.json`.
- **שידור (broadcast):** איטרציה על רשימת מזהים, לא parallel (כדי לכבד rate limits).
- **תזמון:** `scheduled-wa.json` נסרק כל דקה.

### WordPress
- **Polling:** כל 5 דק' שולף `wp-json/...` להופעות חדשות.
- **Elementor webhook:** `POST /api/webhook/elementor` (ללא auth) — קולט לידים, יוצר contact, שולח template אוטומטי.
- **פרסום הצעות/הזמנות:** דחיפת HTML מבוסס `WP_API_KEY` ל־endpoint מותאם באתר.

### Resend (Email)
- ראשי לכל המיילים בענן.
- `from: "שקוף בחזית CRM <crm@thezebra.co.il>"`.
- Fallback ל־Gmail SMTP רק אם `RESEND_API_KEY` חסר.

---

## 10. מסך SPA — מבנה הניווט

הסיידבר השמאלי (RTL: צד שמאל = פתיח):

| אייקון | לשונית | תיאור |
|--------|--------|-------|
| 👤 | אנשי קשר | רשימת lead/warm/hot/vip + כרטיס מפורט |
| 🏢 | ארגונים | חברות, עיריות, מתנ"סים |
| 💬 | שיחות | inbox WhatsApp, ממופה לאיש קשר |
| 📋 | משימות | רשימת tasks + מונה דחופים |
| 🎭 | אירועים | events מהקלנדר |
| 🎤 | מופעים | תבניות מופעים (defaultFee וכו') |
| 📄 | הצעות מחיר | quotes + יצירה + שליחה |
| 📲 | וואטסאפ | broadcast, scheduled, templates |
| 📚 | הדרכה | help.json — חיפוש + שאל שאלה |
| ⚙️ | הגדרות | quote/shows/users/connections/google/about |

---

## 11. דברים מעניינים / פיטפולים שכדאי לדעת

1. **אורך `server.js`:** מונוליטי 4,170 שורות. שיפוץ הדרגתי לקבצים יהיה רצוי, אבל לא דחוף.
2. **`crm.html`** ב־root הוא **legacy** של ה־SPA. ה־production מגיש `public/index.html`. אם משנים UI, **אל** תיגעו ב־`crm.html`.
3. **שני קבצי `CRM-Backups`:** אחד ב־root (`crm/CRM-Backups/`) ואחד תוך `data/CRM-Backups/`. הסקריפט המתוזמן כותב לזה שב־root.
4. **קוד Python (`generate_quote.py`)** — סקריפט עזר לבדיקת PDF, לא חלק מהזרימה ה־production.
5. **Baileys ב־`package.json`** — נשאר כתלות אבל **לא בשימוש**. ההחלטה ב־v2 הייתה לעבור ל־WhatsApp Cloud API. אפשר להסיר בעת ניקוי.
6. **`puppeteer-core`** — לא מותקן עם Chrome מובנה. הPDF נוצר בעיקר על ידי הדפסת דפדפן ישירות מתוך `quotes-html/`.
7. **Sessions ב־data/sessions/** — אם מוחקים את התיקייה כל המשתמשים יתנתקו. אל תמחקו ב־production.
8. **`wpUrl` בהצעות:** מצביע ל־`/offers/{quoteNumber}/` — לקוח רואה הצעה ציבורית עם כפתור אישור שמשנה `status` ל־`approved`.
9. **חתימה ב־orders:** `data:image/png;base64,...` — הקובץ JSON תופח כאשר יש הרבה הזמנות חתומות.
10. **ייבוא xlsx:** משתמש ב־`xlsx` package. תהליך 3 שלבים — `analyze` (זיהוי עמודות), `preview` (אישור מיפוי), commit סופי.

---

## 12. עבודה עם Claude Code — המלצות

### מה לבקש מ־Claude Code:
- **הוספת endpoint חדש** — מומלץ להצביע על endpoint דומה כקוד דוגמה (למשל "תוסיף route דומה ל־`/api/quotes` בשביל…"
- **תיקון UI ב־`public/index.html`** — Claude יעבוד טוב, אבל הקובץ גדול. כדאי להפנות לקטע ספציפי.
- **שינוי schema של JSON** — תמיד לדאוג למיגרציה רטרואקטיבית של קבצים קיימים.
- **דיבוג** — Claude יכול להריץ `node server.js` בסביבת dev ולקרוא לוגים.

### מה לעשות **לפני** שמירת שינוי משמעותי:
1. ודא שיש גיבוי עדכני (משימה יומית רצה אוטומטית — בדוק `CRM-Backups/`).
2. צור branch ב־git, commit לפני בדיקה.
3. בדוק מקומית עם `npm start`.

### תיאום עם Cowork
- ב־Cowork יש **משימה מתוזמנת** (`crm-daily-backup`) שמגבה כל יום את `data/*.json` ל־`CRM-Backups/`.
- יש קובץ הפרומפט הראשי `CRM-PROMPT.md` שמתעד את ההיסטוריה (ארוך מאוד, גרסת build מקורית).
- ל־Cowork יש גישה גם ל־OneDrive — לכן הגיבויים מסונכרנים אוטומטית לענן.

### טיפים לפיתוח:
- **השרת מוגש דרך `app.use(express.static('public'))`** — קבצים סטטיים ב־`public/` נגישים ישירות.
- **`/api/*`** = JSON, **שאר ה־routes** = HTML.
- בעת הוספת helper גלובלי — שים אותו לפני `app.use(...)` כדי שיהיה זמין ב־middleware.

---

## 13. פרטי בעל המערכת

- **שם:** ירון (טוני) אנטניר
- **אימייל:** tony@thezebra.co.il
- **טלפון:** 0525105100 (WhatsApp Business)
- **אתר:** https://shakufbahazit.co.il
- **עסק:** מופעי סיפור "שקוף בחזית"
- **ספר:** *"לא הייתי מקולקל, הייתי פצוע"* — על השירות הצבאי, פציעה וטראומה ארוכת שנים, ותהליך השיקום.
- **WhatsApp Business name:** "שקוף בחזית" (שם מאושר על ידי Meta).

---

## 14. קישורים שימושיים

- אתר: https://shakufbahazit.co.il
- Railway: `crm-shakuf-production.up.railway.app`
- מסמך build היסטורי: `./CRM-PROMPT.md`
- מדריך התקנה: `./מדריך-התקנה.md`
- WhatsApp Cloud API docs: https://developers.facebook.com/docs/whatsapp/cloud-api
- Resend API: https://resend.com/docs
- Google APIs: https://developers.google.com/people, /calendar, /tasks
