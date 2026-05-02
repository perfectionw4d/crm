#!/usr/bin/env python3
import sys, json, os, base64
from weasyprint import HTML

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def logo_b64():
    p = os.path.join(SCRIPT_DIR, 'logo.png')
    if os.path.exists(p):
        with open(p,'rb') as f:
            return 'data:image/png;base64,' + base64.b64encode(f.read()).decode()
    return ''

def fmt(val):
    try: return f'{float(val):,.0f} ש"ח'
    except: return str(val)

def draw_quote(data, out):
    logo   = logo_b64()
    shows  = data.get('shows', [])
    travel = float(data.get('travelCost', 0) or 0)
    inc_vat= data.get('includeVat', False)

    shows_total = sum(float(s.get('price',0) or 0) for s in shows)
    subtotal    = shows_total + travel
    vat_amt     = round(subtotal * 0.18) if inc_vat else 0
    grand_total = subtotal + vat_amt

    def drow(lbl, val):
        if not val: return ''
        return f'<tr><td class="lbl">{lbl}</td><td class="val">{val}</td></tr>'

    desc_html  = ''.join(f'<p class="desc">{l}</p>' for l in data.get('description','').split('\n') if l.strip())
    notes_html = ''.join(f'<p class="note">{l}</p>' for l in data.get('notes','').split('\n') if l.strip())

    # shows rows
    show_rows = ''
    for i, s in enumerate(shows):
        loc = s.get('locationName','') or ('מיקום עדיין לא נסגר' if not s.get('locationKnown') else '')
        if s.get('locationAddress'):
            loc += f', {s["locationAddress"]}'
        show_rows += f'''
        <tr>
          <td style="font-weight:600;color:#2d4a7a">{s.get("showName","")}</td>
          <td>{s.get("eventDate","")} {s.get("eventTime","")}</td>
          <td style="color:{"#94a3b8" if "לא נסגר" in loc else "#334155"};font-style:{"italic" if "לא נסגר" in loc else "normal"}">{loc}</td>
          <td style="text-align:center">{s.get("participants","") or "—"}</td>
          <td style="text-align:right;font-weight:600">{fmt(s.get("price",0))}</td>
        </tr>'''

    vat_row = f'<tr><td>מע"מ (18%)</td><td class="amt">{fmt(vat_amt)}</td></tr>' if inc_vat else ''
    travel_row = f'<tr><td>עלויות נסיעה</td><td class="amt">{fmt(travel)}</td></tr>' if travel else ''

    html = f'''<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800&display=swap');
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{font-family:Heebo,Arial,sans-serif;direction:rtl;color:#1e293b;font-size:12.5px;line-height:1.5;background:white}}
@page {{size:A4;margin:0}}
.page{{width:210mm;padding:0;display:flex;flex-direction:column;min-height:297mm}}
.hdr{{background:linear-gradient(135deg,#2d4a7a,#1e3a6e);color:white;padding:14px 22px;display:flex;justify-content:space-between;align-items:center}}
.hdr .title{{font-size:24px;font-weight:800}}.hdr .sub{{font-size:10.5px;opacity:.8;margin-top:3px}}
.hdr-logo{{max-height:62px;max-width:160px;background:white;border-radius:5px;padding:4px 6px}}
.body{{padding:16px 22px;flex:1}}
.igrid{{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}}
.ibox{{background:#f8fafc;border-radius:7px;padding:10px 12px;border:1px solid #e2e8f0}}
.ibox .lbl2{{font-size:9.5px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}}
.ibox .nm{{font-size:13px;font-weight:700;color:#2d4a7a;margin-bottom:2px}}
.ibox .sb{{font-size:11px;color:#475569;line-height:1.6}}
.stitle{{font-size:12.5px;font-weight:700;color:#2d4a7a;border-right:4px solid #2d4a7a;padding-right:7px;margin:12px 0 7px}}
.purpose-box{{background:#f0f4fa;border-radius:7px;padding:9px 13px;margin-bottom:12px;font-size:12px;color:#334155;border-right:3px solid #2d4a7a}}
.shows-tbl{{width:100%;border-collapse:collapse;margin:7px 0;font-size:12px}}
.shows-tbl thead tr{{background:#2d4a7a;color:white}}
.shows-tbl thead td{{padding:8px 10px;font-weight:600;font-size:11.5px}}
.shows-tbl tbody tr:nth-child(even){{background:#f8fafc}}
.shows-tbl tbody td{{padding:7px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top}}
.ptbl{{width:100%;border-collapse:collapse;margin:7px 0;font-size:12.5px}}
.ptbl thead tr{{background:#2d4a7a;color:white}}
.ptbl thead td{{padding:8px 12px;font-weight:600}}
.ptbl tbody tr:nth-child(even){{background:#f0f4fa}}
.ptbl tbody td{{padding:7px 12px;border-bottom:1px solid #e2e8f0}}
.ptbl tfoot tr{{background:#2d4a7a;color:white}}
.ptbl tfoot td{{padding:9px 12px;font-weight:700;font-size:13.5px}}
.amt{{text-align:right;font-weight:500;white-space:nowrap}}
.desc{{font-size:11.5px;color:#334155;margin:2px 0}}
.pay-box{{background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 12px;margin:9px 0;font-size:11.5px;color:#1e40af}}
.pay-box .ptitle{{font-weight:700;margin-bottom:2px;font-size:12px}}
.note{{font-size:11.5px;color:#475569;margin:2px 0}}
.valid{{font-size:11.5px;color:#92400e;background:#fef3c7;border-radius:5px;padding:4px 8px;margin:7px 0;display:inline-block}}
.sigs{{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:16px;padding-top:10px;border-top:1px solid #e2e8f0;page-break-inside:avoid}}
.sigb{{text-align:center}}.sigline{{border-bottom:1.5px solid #94a3b8;margin-bottom:5px;height:32px}}
.siglbl{{font-size:10px;color:#64748b}}.signm{{font-size:11.5px;font-weight:700;color:#2d4a7a;margin-top:1px}}
.ftr{{background:#2d4a7a;color:rgba(255,255,255,.85);text-align:center;padding:7px;font-size:10.5px;margin-top:auto}}
</style></head>
<body><div class="page">

<div class="hdr">
  <div><div class="title">הצעת מחיר</div><div class="sub">מס׳ {data.get("quoteNumber","001")} &nbsp;|&nbsp; {data.get("quoteDate","")}</div></div>
  {'<img class="hdr-logo" src="'+logo+'">' if logo else ''}
</div>

<div class="body">
  <div class="igrid">
    <div class="ibox">
      <div class="lbl2">לכבוד</div>
      <div class="nm">{data.get("contactName","")}</div>
      <div class="sb">{data.get("organization","")}{("<br>" + data.get("contactPhone","")) if data.get("contactPhone") else ""}{("<br>" + data.get("contactEmail","")) if data.get("contactEmail") else ""}</div>
    </div>
    <div class="ibox">
      <div class="lbl2">מאת</div>
      <div class="nm">ירון אנטניר</div>
      <div class="sb">שקוף בחזית | סיפורים מהבמה ומהלב<br>050-8581935 | yaron@shakufbahazit.co.il<br>www.shakufbahazit.co.il</div>
    </div>
  </div>

  {f'<div class="purpose-box"><strong>מטרת האירוע:</strong> {data.get("eventPurpose","")}</div>' if data.get("eventPurpose") else ""}
  {f'<div style="margin:5px 0 10px">{desc_html}</div>' if desc_html else ''}

  <div class="stitle">פירוט מופעים</div>
  <table class="shows-tbl">
    <thead><tr><td>מופע</td><td>תאריך ושעה</td><td>מיקום</td><td style="text-align:center">משתתפים</td><td style="text-align:right">מחיר</td></tr></thead>
    <tbody>{show_rows}</tbody>
  </table>

  <div class="stitle">תמחור</div>
  <table class="ptbl">
    <thead><tr><td>פירוט</td><td class="amt">סכום</td></tr></thead>
    <tbody>
      <tr><td>סה"כ שכר הופעות</td><td class="amt">{fmt(shows_total)}</td></tr>
      {travel_row}
      {vat_row}
    </tbody>
    <tfoot><tr><td>סה"כ לתשלום</td><td class="amt">{fmt(grand_total)}</td></tr></tfoot>
  </table>

  {f'<div class="pay-box"><div class="ptitle">תנאי תשלום</div>{data.get("paymentTerms","")}</div>' if data.get("paymentTerms") else ""}
  {f'<div class="stitle">הערות</div><div style="margin-bottom:7px">{notes_html}</div>' if notes_html else ""}
  {f'<div class="valid">הצעה זו בתוקף עד: <strong>{data.get("validUntil","")}</strong></div>' if data.get("validUntil") else ""}

  <div class="sigs">
    <div class="sigb"><div class="sigline"></div><div class="siglbl">חתימה ואישור לקוח</div></div>
    <div class="sigb"><div class="sigline"></div><div class="signm">ירון אנטניר</div><div class="siglbl">שקוף בחזית</div></div>
  </div>
</div>

<div class="ftr">שקוף בחזית &nbsp;|&nbsp; ירון אנטניר &nbsp;|&nbsp; 050-8581935 &nbsp;|&nbsp; www.shakufbahazit.co.il</div>
</div></body></html>'''

    HTML(string=html).write_pdf(out)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: generate_quote.py <json_data> <output_path>'); sys.exit(1)
    draw_quote(json.loads(sys.argv[1]), sys.argv[2])
    print('ok')
