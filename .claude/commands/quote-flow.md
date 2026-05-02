---
description: צור הצעת מחיר חדשה במערכת — מדריך/חיקוי הזרימה
allowed-tools: Read, Bash(node:*), Bash(curl:*)
argument-hint: [שם הלקוח / איש קשר]
---

הסבר/צור הצעת מחיר עבור: $ARGUMENTS

### זרימת יצירת הצעת מחיר במערכת:

1. **endpoint:** `POST /api/quotes/generate` (server.js שורה ~1268)
2. **payload דוגמה:**
   ```json
   {
     "contactId": "abc12345",
     "showName": "שקוף בחזית",
     "price": 3000,
     "items": [...],
     "signatureId": "sig1",
     "validUntil": "2026-05-31"
   }
   ```
3. **מה קורה ב-backend:**
   - `quoteNumber` הבא נבחר אוטומטית (מתחיל מ-001).
   - HTML של הצעה נוצר בתוך `data/quotes-html/quote_<id>.html`.
   - רשומה נוספת ל-`data/quotes.json` עם `status: "draft"`.
   - אם נדרש — נשלח מייל דרך Resend.
4. **פרסום ב-WordPress:** `POST /api/quotes/:id/publish` יוצר עמוד תחת `/offers/<quoteNumber>/`.
5. **לקוח מאשר באתר:** `status` משתנה ל-`approved`. אז אפשר להמיר להזמנה.
6. **המרה להזמנה:** הצעה מאושרת + `POST /api/orders/generate` → רשומה ב-`orders.json`, `quoteId` מקושר חזרה.

### דברים שכדאי לבדוק:
- יש לאיש הקשר `phone` ו-`email` תקינים? (חשוב לשליחה).
- יש חתימה ברירת מחדל (`signatures.json` עם `isDefault: true`)?
- ה-`price` כולל מע"מ או לא? (`total = price * 1.18` ב-server.js — בדוק את הלוגיקה הספציפית).
- האם יש `quote-settings.json` עם ברירות מחדל? (תנאי תשלום, תוקף).

### אם צריך עזרה ספציפית עם המשתמש:
- שאל איזה מופע (יש `shows.json` עם תבניות).
- שאל אם רוצה לפרסם מיד או להשאיר draft.
- שאל אם לשלוח מייל אוטומטית.

### **אל תיצור הצעה אמיתית** במערכת (POST לשרת חי) ללא אישור מפורש.
