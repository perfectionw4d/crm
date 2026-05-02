const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');
const RAILWAY_URL = 'crm-shakuf-production.up.railway.app';
const ADMIN_PASSWORD = process.argv[2] || 'Sp!derweb!308';

const FILES = [
  'contacts.json',
  'tasks.json',
  'orders.json',
  'orgs.json',
  'quotes.json',
  'quote-settings.json',
  'tokens.json',
  'standalone-shows.json',
  'signatures.json',
  'wa-messages.json',
  'userinfo.json',
];

function sendFile(filename, content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ secret: ADMIN_PASSWORD, files: { [filename]: content } });
    const options = {
      hostname: RAILWAY_URL,
      path: '/api/admin/import-data',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch(e) {
          reject(new Error(data.substring(0, 100)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  for (const f of FILES) {
    const fp = path.join(DATA_DIR, f);
    if (!fs.existsSync(fp)) { console.log(`⚠️  לא נמצא ${f}`); continue; }
    let content;
    try { content = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch(e) { console.log(`❌ שגיאה בקריאת ${f}: ${e.message}`); continue; }
    process.stdout.write(`📤 שולח ${f}... `);
    try {
      const result = await sendFile(f, content);
      const status = result.results?.[f];
      console.log(status === 'ok' ? '✅' : `❌ ${status}`);
    } catch(e) {
      console.log(`❌ ${e.message}`);
    }
  }
  console.log('\n🎉 סיום העברת נתונים!');
}

main();
