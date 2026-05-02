# הוראות git — הכנת הפרויקט ל-Claude Code

> מסמך זה מתעד את הצעדים שירון צריך להריץ ב-Windows (PowerShell או cmd) כדי להכין את הפרויקט לעבודה עם Claude Code.

---

## 1. בדיקת מצב נוכחי

פתח PowerShell בתיקיית הפרויקט:
```powershell
cd "$env:USERPROFILE\OneDrive\מסמכים\Claude\Projects\crm"
```

בדוק את מצב git:
```powershell
git status
```

אם יש שינויים לא מוקצים (untracked) או שינויים לא מקודמים (modified) — נטפל בהם.

---

## 2. ודא ש-`.gitignore` כולל את הקבצים הרגישים

הקובץ הקיים אמור להכיל:
```
node_modules/
data/
.env
*.log
```

הוסף גם (אם לא קיימים):
```powershell
@"
.env
.env.*
data/
node_modules/
*.log
data/sessions/
CRM-Backups/
backups/
*.bak
*.bak-*
.DS_Store
Thumbs.db
"@ | Out-File -FilePath .gitignore -Encoding UTF8 -Force
```

⚠️ **חשוב:** וודא שלא נכנס בטעות `.env` כי יש בו secrets!

---

## 3. בדוק שאין secrets שכבר נכנסו לhistory

```powershell
git log --all --full-history -- .env 2>$null
```

אם יש hits — צריך לטפל לפני push (אבל אין צורך עכשיו, כי מאתר רק מקומי).

---

## 4. הוסף את הקבצים החדשים שיצרתי

אלו הקבצים שנוספו:
- `CLAUDE.md` — מסמך הקשר ראשי לClaude Code
- `.claude/settings.json` — הגדרות פרויקט
- `.claude/commands/new-endpoint.md` — slash command
- `.claude/commands/migrate-schema.md` — slash command
- `.claude/commands/test-flow.md` — slash command
- `.claude/commands/quote-flow.md` — slash command
- `docs/workflows/quote-to-order.md` — תיעוד זרימה
- `docs/workflows/whatsapp-broadcast.md` — תיעוד זרימה
- `docs/workflows/google-sync.md` — תיעוד זרימה
- `docs/git-setup.md` — המסמך הזה

הוסף הכל:
```powershell
git add CLAUDE.md .claude/ docs/
git status   # ← בדוק שהרשימה נראית הגיונית
```

---

## 5. צור commit נקי

```powershell
git commit -m "docs: add CLAUDE.md and project documentation for Claude Code

- Add comprehensive CLAUDE.md with architecture, JSON schemas, conventions
- Add .claude/settings.json with project permissions
- Add custom slash commands (new-endpoint, migrate-schema, test-flow, quote-flow)
- Add workflow docs: quote-to-order, whatsapp-broadcast, google-sync
- Prepare project for Claude Code workflows"
```

---

## 6. (אופציונלי) צור branch לעבודה עם Claude Code

מומלץ ליצור branch נפרד למקרה שתרצה לחזור אחורה:
```powershell
git checkout -b claude-code-setup
```

ואחרי שהכל עובד — merge ל-main:
```powershell
git checkout main
git merge claude-code-setup
```

---

## 7. (אופציונלי) Push לrepo מרוחק

אם יש לך GitHub remote:
```powershell
git remote -v   # ← בדוק שיש remote
git push origin main   # או claude-code-setup
```

⚠️ לפני push:
- ודא ש-`.env` לא בpush.
- ודא ש-`data/` לא בpush.
- בדוק `git log` שאין הודעות שמכילות secrets.

---

## 8. התקן Claude Code

```powershell
npm install -g @anthropic-ai/claude-code
```

ואז בתוך תיקיית הפרויקט:
```powershell
cd "$env:USERPROFILE\OneDrive\מסמכים\Claude\Projects\crm"
claude
```

ב-session הראשון Claude Code יקרא את `CLAUDE.md` אוטומטית ויהיה לו את כל ההקשר.

---

## דברים שכדאי לדעת לגבי Claude Code

1. **slash commands** — תוכל להריץ `/new-endpoint`, `/migrate-schema`, וכו' ישירות ב-Claude Code.
2. **`/init`** — Claude Code לא יצטרך אותו כי כבר יש `CLAUDE.md`.
3. **autonomy mode** — אפשר להפעיל `claude --autonomy=high` למשימות גדולות, אבל ההגדרות ב-`.claude/settings.json` שלנו מגבילות פעולות מסוכנות (אין `git push`, אין `rm -rf`).
4. **MCP servers** — אם תרצה לחבר Claude Code ל-Slack/Asana/Linear וכד', צריך להגדיר MCP. לא נדרש כרגע.

---

## במקרה של בעיה

- בדוק את `CLAUDE.md` — שם תמצא את כל הarchitecture.
- בדוק `docs/workflows/` — שם תמצא הסבר לזרימות העיקריות.
- אם Claude Code לא מבין משהו — הוא יוכל לקרוא את `CRM-PROMPT.md` (יותר מקיף, יותר ארוך).
- אם נדרש שינוי ב-`.env` — Claude Code יבקש אישור מפורש (`ask` ב-settings.json).
