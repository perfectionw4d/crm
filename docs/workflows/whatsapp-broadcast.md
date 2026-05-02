# זרימה: WhatsApp Broadcast

> שליחת הודעת template לרשימת אנשי קשר.

## סקירה

ה-CRM שולח broadcast דרך **WhatsApp Cloud API** (Meta), לא Baileys. כל הודעה ל-template מאושר נכנסת לתעריפי Meta הרגילים.

```
בחירת רשימה → בחירת template → התאמת פרמטרים → שליחה איטרטיבית → תיעוד
```

---

## 1. הכנה

**דרישות מוקדמות:**
- `WA_ACCESS_TOKEN` תקף (פג כל 60 יום אם זה Token זמני, אחרת לא — בודק חודשי).
- `WA_PHONE_NUMBER_ID` — מספר העסק המאושר.
- ה-template חייב להיות מאושר על ידי Meta (סטטוס "Approved").

**templates זמינים כרגע:**
- `first_message` — header = שם הלקוח, body קבוע.

---

## 2. בחירת רשימה

**דרך הUI:**
- לשונית 📲 וואטסאפ → "broadcast חדש".
- אפשרויות:
  - כל אנשי הקשר עם `phone` תקין.
  - לפי `status` (למשל כל ה-`warm`).
  - לפי `tag` (למשל "ליד-וואטסאפ").
  - בחירה ידנית.

**ה-payload נבנה ב-frontend:** `[contactId1, contactId2, ...]`.

---

## 3. שליחה

**endpoint:** `POST /api/wa/broadcast`

**payload:**
```json
{
  "contactIds": ["abc123", "def456"],
  "templateName": "first_message",
  "languageCode": "he",
  "params": [
    { "type": "header", "value": "{{name}}" }
  ]
}
```

`{{name}}` הוא placeholder — מוחלף ב-`contact.name` עבור כל איש קשר.

**מה קורה ב-backend:**
1. **איטרטיבית** (לא parallel — כדי לכבד rate limit של 80 הודעות/שנייה).
2. עבור כל איש קשר:
   - נרמול טלפון (`normPhoneCrm()` → `972...`).
   - שליחה ל-`https://graph.facebook.com/v18.0/{phoneNumberId}/messages`.
   - תיעוד ב-`wa-messages.json` כ-`status: "sent"` או `"failed"`.
3. **דוח שליחה** מוחזר עם מספר הצלחות וכישלונות.

---

## 4. הודעות מתוזמנות

**endpoint:** `POST /api/wa/scheduled` עם `scheduledAt`.

**מה קורה:**
- הרשומה נכנסת ל-`scheduled-wa.json`.
- cron פנימי ב-`server.js` סורק כל דקה.
- בזמן המתוזמן — שליחה אוטומטית (אותו flow כמו broadcast רגיל).

**ביטול:** `DELETE /api/wa/scheduled/:id`.

---

## 5. תגובות נכנסות

**Webhook:** Meta שולח POST ל-`/api/wa/webhook` (אם מוגדר).
**עיבוד:**
- ההודעה נכנסת ל-`wa-messages.json`.
- מנסה למפות ל-`contactId` לפי טלפון.
- אם לא נמצא → רשומה חדשה ב-`contacts.json` עם `status: "lead"` ו-`source: "WhatsApp בוט"`.
- אם יש bot flow מוגדר → הפעלה אוטומטית.

---

## תקלות נפוצות

### "ההודעה לא נשלחת"
- בדוק שה-token לא פג: `GET /api/wa/status`.
- בדוק שהמספר במספר נמצא ב-Meta business account (לא רק ב-CRM).
- בדוק שה-template מאושר (ב-Meta Business Suite).

### "rate limit"
- Meta מגביל ל-80 הודעות/שנייה.
- אם broadcast גדול (>500 איש) — שקול להוסיף `setTimeout(50)` בין שליחות.

### "טלפון לא תקין"
- `normPhoneCrm()` מוסיף `972` אם חסר. בדוק שאין +0 (דהיינו `+972052...` במקום `+972052...`).
- מספרים שאינם ישראליים — צריך טיפול ידני, אין כיום support מלא.

### "תבנית לא קיימת"
- שם ה-template חייב להיות בדיוק כפי שמופיע ב-Meta.
- שפה (`he` למקרה זה) חייבת להיות נכונה — אם רישמתם ב-`he_IL` זה לא יעבוד עם `he`.
