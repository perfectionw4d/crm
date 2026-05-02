# פרומפט לבניית שקוף בחזית CRM

---

## תיאור כללי

בנה לי CRM (מערכת ניהול קשרי לקוחות) מלאה לאמן סיפורים בשם **ירון אנטניר — שקוף בחזית**.
הMCRM מיועד לניהול: אנשי קשר, ארגונים, משימות, מופעים, הצעות מחיר, הזמנות עבודה, תקשורת (WhatsApp + מייל) וסנכרון עם גוגל.

---

## סטאק טכנולוגי

- **Backend**: Node.js + Express
- **Frontend**: React 18 + Babel (SPA בקובץ HTML אחד `public/index.html`)
- **אחסון נתונים**: קבצי JSON בתיקיית `data/`
- **פריסה**: Railway.app עם Docker + Volume מתמיד ב-`/app/data`
- **אימות**: sessions + express-session + session-file-store
- **סנכרון**: Google Calendar / Tasks / Contacts API (OAuth2)
- **WhatsApp**: Meta WhatsApp Cloud API (לא Baileys)
- **מייל**: Resend API (לא SMTP)
- **PDF/הצעות מחיר**: יצירת HTML + הדפסה

---

## מבנה קבצים

```
/
├── server.js           ← שרת אחד מלא (~3000 שורות)
├── public/
│   ├── index.html      ← כל ה-SPA (React + JSX inline)
│   ├── login.html      ← דף כניסה (email+password / מנהל ראשי)
│   └── reset-password.html ← איפוס סיסמה
├── data/               ← כל הנתונים (ב-Railway: Volume)
│   ├── contacts.json
│   ├── orgs.json
│   ├── tasks.json
│   ├── quotes.json
│   ├── orders.json
│   ├── shows.json
│   ├── signatures.json
│   ├── users.json
│   ├── help.json
│   ├── wa-messages.json
│   ├── scheduled-wa.json
│   ├── tokens.json
│   └── sessions/
├── .env
├── Dockerfile
├── package.json
└── migrate-data.js     ← סקריפט העברת נתונים ל-Railway
```

---

## משתני סביבה (.env)

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=shakuf-crm-secret-2024
PORT=3000
ADMIN_PASSWORD=...          ← סיסמת מנהל ראשי
RECOVERY_CODE=...           ← קוד שחזור

# WhatsApp Cloud API
WA_PHONE_NUMBER_ID=...
WA_BUSINESS_ACCOUNT_ID=...
WA_ACCESS_TOKEN=...

# WordPress
WP_URL=https://shakufbahazit.co.il
WP_API_KEY=...
NOTIFY_PHONE=972525105100

# Email via Resend
RESEND_API_KEY=re_...
RESEND_FROM=crm@thezebra.co.il

# Gmail SMTP (fallback מקומי בלבד)
SMTP_USER=tony@thezebra.co.il
SMTP_PASS=...
SMTP_FROM=tony@thezebra.co.il

# Railway
RAILWAY_STATIC_URL=crm-shakuf-production.up.railway.app
```

---

## מערכת אימות (Auth)

### שני מצבי כניסה:
1. **מנהל ראשי** — סיסמה בלבד (ישנה, לא דורשת מייל)
2. **משתמש רגיל** — אימייל + סיסמה

### קובץ `users.json`:
```json
[{
  "id": "...",
  "name": "...",
  "email": "...",
  "passwordHash": "salt:hash",  ← crypto.pbkdf2Sync
  "contactId": null,
  "active": true,
  "createdAt": "...",
  "resetToken": null,
  "resetExpiry": null
}]
```

### נקודות קצה:
- `POST /login` — email+password או password בלבד
- `GET /logout`
- `POST /api/auth/forgot-password` — שולח מייל איפוס דרך Resend
- `GET /api/auth/reset-password/:token` → `reset-password.html`
- `POST /api/auth/reset-password` — שומר סיסמה חדשה
- `GET/POST/PUT/DELETE /api/users`

### כללי סיסמה:
- מינימום 8 תווים
- לפחות אות גדולה, ספרה וסימן מיוחד
- UI מייצר סיסמה אוטומטית + כפתור 🔄 לסיסמה חדשה
- הולידציה בזמן אמת עם ✅/❌

### מייל ברוכים הבאים:
נשלח אוטומטית בעת יצירת משתמש עם פרטי כניסה.

---

## מודולי הנתונים

### אנשי קשר (`contacts.json`)
```json
{
  "id", "name", "organizationId", "role", "phone", "email", "city",
  "status",        ← cold/warm/hot/booked/vip/notRelevant
  "source",        ← מאיפה הגיע
  "notes",
  "tags": [],
  "conversations": [{ "id","date","type","content" }],
  "showHistory":   [{ "id","date","venue","showType","status","fee","notes" }],
  "nextFollowUp",
  "googleContactId",
  "createdAt",
  "isAdmin": false   ← שדה עתידי
}
```

### ארגונים (`orgs.json`)
אותו מבנה כמו אנשי קשר + `industry`.

### משימות / אירועים (`tasks.json`)
```json
{
  "id", "title", "type",   ← task/event/meeting/show
  "contactId", "organizationId", "conversationId",
  "dueDate", "startDateTime", "endDateTime", "location",
  "completed", "googleEventId", "googleTaskId",
  "notes", "priority",    ← low/medium/high
  "createdAt"
}
```

### הצעות מחיר (`quotes.json`)
```json
{
  "id", "contactId", "organizationId",
  "showName", "showDate", "venue",
  "items": [{ "description","quantity","price","total" }],
  "totalAmount", "currency": "ILS",
  "signatureName", "signatureText",
  "status",         ← draft/sent/accepted/rejected
  "notes",
  "pdfPath",
  "createdAt"
}
```

### הזמנות עבודה (`orders.json`)
מבנה דומה להצעות מחיר + `invoiceNumber`, `paymentStatus`.

### מופעים (`shows.json`)
```json
{
  "id", "name", "description", "defaultFee",
  "category", "duration", "notes"
}
```

### חתימות (`signatures.json`)
```json
{
  "id", "name", "text", "isDefault",
  "channel",   ← email/whatsapp/both
  "createdAt"
}
```

---

## ממשק משתמש (index.html)

### סרגל ניווט שמאלי:
- 👤 אנשי קשר
- 🏢 ארגונים
- 💬 שיחות (WhatsApp)
- 📋 משימות (עם מונה)
- 🎭 אירועים (עם מונה)
- 🎤 מופעים
- 📄 הצעות מחיר
- 📲 וואטסאפ
- 📚 הדרכה
- ⚙️ הגדרות

### עיצוב:
- RTL מלא (עברית)
- צבעים: indigo (#6366f1) כצבע ראשי
- כרטיסים עם border-radius: 12px
- responsive (mobile-friendly)

---

## WhatsApp Cloud API

### שליחת תבנית:
```javascript
async function sendWaTemplate(phone, templateName, langCode, params) {
  // params[0] → header component
  // params[1+] → body components
}
```

### תבנית `first_message`:
- Header: {{1}} = שם
- Body: טקסט קבוע
- ⚠️ אין כפתור שיחה (נדרש Calling API)

### נקודות קצה:
- `POST /api/wa/send` — שליחת הודעה חופשית
- `POST /api/wa/send-template` — שליחת תבנית
- `POST /api/wa/broadcast` — שידור לרשימה
- `GET /api/wa/messages` — שיחות
- `GET /api/wa/scheduled` — הודעות מתוזמנות
- `POST /api/wa/schedule` — תזמון הודעה
- `POST /api/webhook/elementor` — webhook מאתר WordPress (ללא auth)

### WhatsApp Inbox (שיחות):
- רשימת כל השיחות לפי מספר טלפון
- מיפוי אוטומטי לאיש קשר ב-CRM
- שליחת תגובה ישירה
- שליחת תבנית מהשיחה

---

## סנכרון Google

### OAuth2 Flow:
- `/auth/google` → `/auth/callback`
- שמירת tokens ב-`data/tokens.json`
- רענון אוטומטי

### סנכרון דו-כיווני:
- **CRM → Google**: כל שינוי נדחף מיד
- **Google → CRM**: משיכה כל 5 דקות
- תמיכה במספר חשבונות Gmail

### אובייקטים מסונכרנים:
- אנשי קשר ↔ Google Contacts
- אירועים ↔ Google Calendar
- משימות ↔ Google Tasks

---

## WordPress Integration

### פולינג אוטומטי (כל 5 דקות):
- שולף הופעות/הרשמות חדשות מ-WP
- יוצר אנשי קשר חדשים אוטומטית
- שולח WhatsApp template אוטומטי ללידים חדשים

### Elementor Webhook:
- `POST /api/webhook/elementor` (ללא auth)
- מקבל לידים מטפסי יצירת קשר באתר

---

## הצעות מחיר — פרטי יישום

- בניית HTML דינמי עם CSS inline (להדפסה)
- לוגו + שם העסק בראש
- טבלת פריטים עם מחירים
- חתימה בסוף
- שליחה במייל דרך Resend
- PDF נשמר ב-`data/` (עם timestamp)

---

## מרכז הדרכה (`help.json`)

### מבנה מאמר:
```json
{
  "id", "type",      ← guide/qa
  "category",        ← contacts/orgs/tasks/quotes/whatsapp/settings/general
  "status",          ← published/pending
  "title", "content",
  "steps": [],       ← מדריכים בלבד
  "link", "tags",
  "createdAt", "updatedAt"
}
```

### פונקציונליות:
- חיפוש חופשי בכל המאמרים
- שאלת "שאל שאלה" — מחפש תשובה קיימת, אם לא מוצא שומר כ-pending
- ממשק ניהול: הוסף/ערוך/מחק מאמרים + כתיבת תשובה לשאלות ממתינות
- אכלוס מראש: 7 מדריכים + 3 שאלות ותשובות

---

## הגדרות (Settings)

### לשוניות:
1. **📄 הצעות מחיר** — ברירות מחדל לציטוט + ניהול חתימות
2. **🎤 מופעים ורשימות** — ניהול תבניות מופעים + רשימות מותאמות
3. **👥 משתמשים** — הוספה/עריכה/השבתה/מחיקה + בדיקת מייל
4. **🌐 חיבורים** — WordPress connection
5. **🔗 גוגל וסנכרון** — חיבור OAuth + סנכרון ידני
6. **ℹ️ אודות**

---

## Dockerfile

```dockerfile
FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

**חשוב:** `.dockerignore` לא כולל `.env` — הקובץ נכנס לimage:
```
node_modules
data
*.log
```

---

## Railway deployment

- פרויקט: `crm-shakuf`
- Volume: mount ב-`/app/data` לנתונים מתמידים
- `RAILWAY_STATIC_URL` מוגדר כ-variable
- PORT נקבע אוטומטית על ידי Railway (לא 3000)

### migrate-data.js:
סקריפט להעברת נתונים מקומיים ל-Railway:
```javascript
// שולח כל קובץ JSON בנפרד ל-POST /api/admin/import-data
// { secret: ADMIN_PASSWORD, files: { "filename.json": content } }
```

---

## אבטחה

- `requirePassword` middleware על כל ה-routes
- `express-session` + `session-file-store`
- passwords: `crypto.pbkdf2Sync` (salt:hash)
- reset tokens: `crypto.randomBytes(32)` עם תפוגה של שעה
- `/api/webhook/elementor` — פתוח לחיצוניים
- `/api/admin/import-data` — מוגן ב-secret

---

## Dependencies (package.json)

```json
{
  "express": "^4.18.2",
  "express-session": "^1.17.3",
  "session-file-store": "^1.5.0",
  "googleapis": "^134.0.0",
  "uuid": "^9.0.0",
  "dotenv": "^16.3.1",
  "nodemailer": "^8.0.5",
  "multer": "^2.1.1",
  "xlsx": "^0.18.5",
  "qrcode": "^1.5.3"
}
```

---

## פרטי בעל המערכת

- **שם**: ירון (טוני) אנטניר
- **אימייל**: tony@thezebra.co.il
- **טלפון**: 0525105100
- **אתר**: https://shakufbahazit.co.il
- **עסק**: מופעי סיפור "שקוף בחזית"
- **ספר**: "לא הייתי מקולקל, הייתי פצוע"
- **WhatsApp Business**: "שקוף בחזית" (שם מאושר)
