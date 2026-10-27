'use strict';
// publish_history.js — 把 out/history/*.json 转成前端按日期翻页用的数据文件。
// 输入：out/history/YYYY-MM-DD.json（数值型原始归档）
// 输出：docs/data/YYYY-MM-DD.json（前端表格行结构）+ docs/data/index.json（可用日期，降序）
//
// 结构与 render.js 的 toClientRows 完全一致，保证"当天页面"和"历史翻页"列口径相同。
// index.json 会与 docs/data 下已存在的文件取并集，避免 CI 缓存里历史不全时把旧日期丢掉。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const HIST = path.join(ROOT, 'out', 'history');
const DATA = path.join(ROOT, 'docs', 'data');

// 保留最近多少个交易日（0 = 不限制）
const KEEP = parseInt(process.env.HISTORY_DAYS || '0', 10);

const num = (v, d) => (v == null || isNaN(v) ? null : Number(Number(v).toFixed(d)));

/** 归档里的单只股票 → 前端行结构 */
function histToRow(dateStr, s) {
  return {
    code: s.code,
    name: s.name || '',
    lastDate: dateStr,
    price: num(s.close, 2),
    pct: num(s.pct, 2),
    rank: s.rank || 0,
    anpanToday: s.an,
    mingpanToday: s.ming,
    zongTodayRaw: s.zong,
    an30Raw: s.an30,
    ming30Raw: s.ming30,
    zong30Raw: s.zong30,
    hitRate: s.totalDays ? num(s.hitDays / s.totalDays, 3) : 0,
    hitLabel: s.hitDays + '/' + s.totalDays,
    floatMv: num(s.floatMv, 2),
    industry: s.industry || '',
    concepts: s.concepts || '',
    aiScore: s.aiScore,
    strongLine: s.strongLine,
    fundSignal: s.fundSignal,
    comboAdvice: s.comboAdvice,
    value: s.value,
    conclusion: s.conclusion
  };
}

function main() {
  if (!fs.existsSync(HIST)) {
    console.error('✗ out/history 不存在');
    process.exit(1);
  }
  fs.mkdirSync(DATA, { recursive: true });

  // 1) 本次可用的归档日期（降序）
  let dates = fs.readdirSync(HIST)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
    .reverse();

  if (KEEP > 0) dates = dates.slice(0, KEEP);

  let written = 0;
  const okDates = [];
  for (const d of dates) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(HIST, d + '.json'), 'utf8'));
    } catch (e) {
      console.warn('· 跳过损坏的归档 ' + d + '：' + e.message);
      continue;
    }
    // 休市日（暗盘回声数据）不进翻页，避免和前一交易日重复
    if (j.meta && j.meta.marketOpen === false) {
      console.log('· 跳过休市日 ' + d);
      continue;
    }
    const rows = (j.stocks || []).map((s) => histToRow(d, s));
    if (!rows.length) continue;
    fs.writeFileSync(path.join(DATA, d + '.json'), JSON.stringify(rows));
    written++;
    okDates.push(d);
  }

  // 2) index.json：与 docs/data 现有文件取并集（CI 缓存可能缺旧日期）
  const existing = fs.readdirSync(DATA)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''));
  const all = Array.from(new Set(okDates.concat(existing))).sort().reverse();

  // 3) 超出保留窗口的文件从本地删除；工作流里的 `git add -A` 会把这些删除一并提交
  if (KEEP > 0 && all.length > KEEP) {
    const drop = all.slice(KEEP);
    drop.forEach((d) => {
      const p = path.join(DATA, d + '.json');
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    console.log('· 清理超出 ' + KEEP + ' 天的数据：' + drop.length + ' 个');
    all.length = KEEP;
  }

  const index = {
    dates: all,
    latest: all[0] || null,
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(DATA, 'index.json'), JSON.stringify(index, null, 2));

  console.log('✔ 写入 ' + written + ' 个日期数据，索引共 ' + all.length + ' 个交易日');
  console.log('  范围：' + (all[all.length - 1] || '-') + ' ~ ' + (all[0] || '-'));
  const totalMB = all.reduce((sum, d) => {
    const p = path.join(DATA, d + '.json');
    return sum + (fs.existsSync(p) ? fs.statSync(p).size : 0);
  }, 0) / 1048576;
  console.log('  数据总量：' + totalMB.toFixed(1) + ' MB');
}

main();
