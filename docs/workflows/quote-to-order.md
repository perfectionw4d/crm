# זרימה: הצעת מחיר → אישור → הזמנת עבודה

> מסמך תיעוד מקצה-לקצה של הזרימה העיקרית של ה-CRM.

## סקירה

זוהי הזרימה הכי חשובה במערכת — הדרך מליד פוטנציאלי לקבלת תשלום. כל שלב מתועד באוטומציה.

```
ליד → איש קשר חם → הצעת מחיר → פרסום ב-WP → אישור לקוח → הזמנת עבודה → חתימה → ביצוע
```

---

## 1. כניסת ליד

**מקורות:**
- WordPress (Elementor) → `POST /api/webhook/elementor`
- Google Contacts sync → `POST /api/sync/contacts`
- WhatsApp בוט → flow אוטומטי
- הזנה ידנית → `POST /api/contacts`

**תוצאה:** רשומה ב-`contacts.json` עם `status: "lead"`.

**אוטומציה:** אם הגיע מ-Elementor → נשלח WhatsApp template `first_message` תוך דקה.

---

## 2. טיפוח הליד

המשתמש (ירון) משנה את ה-status באופן ידני:
- `lead` → `cold` (אין תגובה)
- `lead` → `warm` (יש שיחה ראשונית)
- `warm` → `hot` (מתעניין באופן רציני)
- `hot` → `booked` (אישור עקרוני)

**כלים שזמינים בכרטיס איש קשר:**
- שיחות (`conversations[]`) — תיעוד שיחות טלפון/whatsapp/מייל.
- משימות (`tasks.json`) — מעקב follow-up.
- WhatsApp ישיר מהכרטיס.
- מיילים אחרונים מ-Gmail.

---

## 3. יצירת הצעת מחיר

**endpoint:** `POST /api/quotes/generate`

**מה קורה:**
1. נבחר `quoteNumber` הבא (מקסימום קיים + 1, padded ל-3 ספרות).
2. נוצר קובץ `data/quotes-html/quote_<id>.html` (HTML עם CSS inline להדפסה).
3. רשומה ב-`quotes.json` עם:
   - `status: "draft"`
   - `wpUrl` — placeholder עד פרסום.
   - `contactId` — קישור לכרטיס איש הקשר.

**ברירות מחדל:** מ-`quote-settings.json`:
- תנאי תשלום
- תוקף ההצעה
- חתימה (מ-`signatures.json` עם `isDefault: true`)

**שליחת המייל:** דרך Resend, מצורף לינק ל-PDF או ל-WP.

---

## 4. פרסום ב-WordPress

**endpoint:** `POST /api/quotes/:id/publish`

**מה קורה:**
1. ה-HTML נדחף לאתר WordPress דרך API מותאם (משתמש ב-`WP_API_KEY`).
2. נוצר עמוד תחת `https://shakufbahazit.co.il/offers/<quoteNumber>/`.
3. ה-`wpPublished: true` ו-`wpUrl` מתעדכנים ב-`quotes.json`.

**מה הלקוח רואה:** דף הצעה ציבורית, עם כפתור "אשר הצעה" שמשנה את ה-status ל-`approved`.

---

## 5. אישור לקוח

הלקוח לוחץ על הכפתור באתר. WordPress שולח callback ל-CRM (דרך `WP_API_KEY`):
- `quote.status: "approved"`
- אופציונלי — נשלחת התראת WhatsApp לירון.

---

## 6. המרה להזמנת עבודה

**endpoint:** `POST /api/orders/generate` עם `quoteId`.

**מה קורה:**
1. `orderNumber` נוצר מ-`DDMMYY` + מונה רץ של היום (למשל `2104261`).
2. רשומה ב-`orders.json` עם `status: "pending"`.
3. קישור דו-כיווני: `quote.orderId` ו-`order.quoteId`.
4. ההזמנה מתפרסמת אוטומטית תחת `/orders/<orderNumber>/`.

---

## 7. חתימה דיגיטלית

הלקוח חותם בעמוד WordPress (canvas → base64 PNG).
**endpoint:** `PUT /api/orders/:id/status` עם `signature` ב-payload.

**תוצאה:**
- `order.status: "signed"`
- `order.signedAt: "<ISO timestamp>"`
- `order.signature: "data:image/png;base64,..."`

**הערה:** קובץ `orders.json` תופח כי כל חתימה היא ~10-30KB base64. אם זה יהפוך לבעיה, אפשר לפצל את החתימות לקבצים נפרדים.

---

## 8. ביצוע ומעקב

המופע מתבצע. אחרי המופע:
- `order.status: "completed"` (ידני בכרטיס).
- אופציונלי — תיעוד ב-`contact.showHistory[]`.
- שליחת מייל תודה / שאלון משוב (לא אוטומטי כיום — אופציה לשיפור).

---

## תקלות נפוצות

### "ה-quote לא מתפרסם ב-WordPress"
- בדוק `WP_API_KEY` ו-`WP_URL` ב-`.env`.
- בדוק `/api/wp/ping` שמחזיר 200.
- וודא שה-WP plugin שמקבל את ההצעה פעיל.

### "מייל לא נשלח"
- בדוק `RESEND_API_KEY` ב-`.env`.
- בדוק שה-`from` (`crm@thezebra.co.il`) מאומת ב-Resend.
- בלוג: `console.log` בקוד `sendEmail()`.

### "הצעה דופלקטה"
- בדוק שאין שתי רשומות עם אותו `quoteNumber`.
- אם יש — מחק את הישנה ועדכן את כל המקומות שמתייחסים אליה.
