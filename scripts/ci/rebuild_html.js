'use strict';
// rebuild_html.js — 用归档 JSON 重新渲染某一天的 HTML（不重新抓取）。
// 用途：模板升级后，把已发布的那一天按新模板重生成，无需等下一次抓取。
// 用法：node scripts/ci/rebuild_html.js 2026-10-26

const fs = require('fs');
const path = require('path');
const { buildHtml } = require('../lib/render');

const ROOT = path.resolve(__dirname, '../..');
const date = process.argv[2];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('用法: node scripts/ci/rebuild_html.js YYYY-MM-DD');
  process.exit(1);
}

const histPath = path.join(ROOT, 'out', 'history', date + '.json');
if (!fs.existsSync(histPath)) {
  console.error('✗ 找不到归档 ' + histPath);
  process.exit(1);
}
const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));

function money(v) {
  if (v == null || isNaN(v)) return '--';
  const s = v >= 0 ? '+' : '-';
  const n = Math.abs(v);
  if (n >= 1e8) return s + (n / 1e8).toFixed(2) + '亿';
  if (n >= 1e4) return s + (n / 1e4).toFixed(2) + '万';
  return s + n.toFixed(2);
}

const rows = H.stocks.map((s) => ({
  code: s.code,
  name: s.name,
  lastDate: H.date,
  price: s.close,
  pct: s.pct,
  rank: s.rank,
  anpanToday: s.an,
  mingpanToday: s.ming,
  zongTodayRaw: s.zong,
  an30Raw: s.an30,
  ming30Raw: s.ming30,
  zong30Raw: s.zong30,
  anToday: money(s.an),
  mingToday: money(s.ming),
  zongToday: money(s.zong),
  an30: money(s.an30),
  ming30: money(s.ming30),
  zong30: money(s.zong30),
  hitDays: s.hitDays,
  totalDays: s.totalDays,
  floatMv: s.floatMv,
  industry: s.industry,
  concepts: s.concepts,
  aiScore: s.aiScore,
  strongLine: s.strongLine,
  fundSignal: s.fundSignal,
  comboAdvice: s.comboAdvice,
  value: s.value,
  conclusion: s.conclusion
}));

const meta = {
  dateLabel: H.date,
  dayWindow: (H.meta && H.meta.dayWindow) || '',
  generatedAt: H.generatedAt || new Date().toISOString(),
  hasClist: rows.some((r) => r.concepts && r.concepts !== '--'),
  stat: (H.meta && H.meta.stat) || {
    total: rows.length,
    pick: rows.filter((r) => String(r.conclusion).indexOf('入选（重点关注）') === 0).length,
    pickAll: rows.filter((r) => String(r.conclusion).indexOf('入选') === 0).length,
    avgAi: Math.round(rows.reduce((a, r) => a + (r.aiScore || 0), 0) / rows.length),
    avgVal: Math.round(rows.reduce((a, r) => a + (r.value || 0), 0) / rows.length)
  }
};

const out = path.join(ROOT, 'out', '暗盘资金全景表_' + date + '.html');
fs.writeFileSync(out, buildHtml(rows, meta));
console.log('✔ 已重建 ' + out + '（' + (fs.statSync(out).size / 1048576).toFixed(2) + ' MB，' + rows.length + ' 只）');
