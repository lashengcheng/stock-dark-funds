// snapshot.js — 共享核心：交易日/暗盘缓存/板块缓存/行汇总/归档输出
// 被 fetch_all.js（当日或指定日期快照）与 backfill.js（补录）共用，保证两条路径评分口径完全一致
'use strict';

const fs = require('fs');
const path = require('path');
const api = require('./api');
const { evaluate, evaluateValue, formatMoney } = require('./score');
const { buildCsv } = require('./render');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'out');
const CACHE_DIR = path.join(OUT_DIR, 'cache');
const HISTORY_DIR = path.join(OUT_DIR, 'history');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// ---------- 日期工具 ----------
function parseYmd(s) {
  s = String(s).replace(/-/g, '');
  return [+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8)];
}
function ymdToDash(s) {
  s = String(s).replace(/-/g, '');
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}
function dashToYmd(s) { return String(s).replace(/-/g, ''); }
function fmtYmd(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
function todayYmd() { return fmtYmd(new Date()); }

/** 最近 n 个工作日（含 endYmd），降序 ['2026-10-14', ...] */
function recentTradeDays(n, endYmd) {
  const out = [];
  const [y, m, d] = parseYmd(endYmd);
  const dt = new Date(y, m - 1, d);
  let guard = 0;
  while (out.length < n && guard++ < 400) {
    const w = dt.getDay();
    if (w >= 1 && w <= 5) {
      out.push(fmtYmd(dt).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
    }
    dt.setDate(dt.getDate() - 1);
  }
  return out;
}

/** 上一个工作日（YYYYMMDD） */
function prevWeekdayYmd(ymd) {
  const [y, m, d] = parseYmd(ymd);
  const dt = new Date(y, m - 1, d);
  do { dt.setDate(dt.getDate() - 1); } while (dt.getDay() === 0 || dt.getDay() === 6);
  return fmtYmd(dt);
}

/** 是否已过收盘数据稳定时间（15:30） */
function afterClose() {
  const n = new Date();
  return n.getHours() > 15 || (n.getHours() === 15 && n.getMinutes() >= 30);
}

// ---------- 市场划分 ----------
/** 代码 → 市场编号：6开头=1沪 4/8开头=2北 其余=0深（与原页面 getDarkMarketCode 一致） */
function marketOf(code) {
  if (/^6/.test(code)) return '1';
  if (/^[48]/.test(code)) return '2';
  return '0';
}
const MKT_NAME = { '0': '深', '1': '沪', '2': '北' };

// ---------- 暗盘日数据（带磁盘缓存，可断点续跑） ----------
function darkCachePath(mkt, ymd) {
  return path.join(CACHE_DIR, 'dark_' + mkt + '_' + ymd.replace(/-/g, '') + '.json');
}

/** 加载缓存。targets 为当前目标集：仅在"榜单翻完整"或"目标集被上次缓存覆盖"时可用 */
function loadDarkCache(mkt, ymd, targets, refresh) {
  if (refresh) return null;
  const p = darkCachePath(mkt, ymd);
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || !j.entries) return null;
    if (!j.listComplete) {
      // 提前停止的缓存：仅当其覆盖的目标集 ⊇ 当前目标集时可用
      if (!j.targetsCovered) return null;
      const covered = new Set(j.targetsCovered);
      for (const c of targets) if (!covered.has(c)) return null;
    }
    return new Map(j.entries.map(([c, v]) => [c, { anpan: v[0], mingpan: v[1], zong: v[2], rank: v[3] }]));
  } catch (e) { /* 缓存损坏视为无缓存 */ }
  return null;
}

function saveDarkCache(mkt, ymd, map, listComplete, targets) {
  const entries = [];
  for (const [c, v] of map) entries.push([c, [v.anpan, v.mingpan, v.zong, v.rank]]);
  writeJsonAtomic(darkCachePath(mkt, ymd), JSON.stringify({
    ymd: ymd.replace(/-/g, ''), market: mkt, listComplete,
    targetsCovered: listComplete ? null : Array.from(targets),
    entries
  }));
}

/** 原子写 JSON：先写临时文件再替换，避免并发/中途崩溃留下截断文件 */
function writeJsonAtomic(p, data) {
  const tmp = p + '.tmp' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.copyFileSync(tmp, p); // Windows 上 rename 覆盖已存在文件偶发失败，退回复制
    fs.unlinkSync(tmp);
  }
}

// ---------- 运行互斥（防止定时任务与手动运行并发写同一批文件） ----------
const LOCK_PATH = path.join(OUT_DIR, '.lock');
function acquireLock() {
  try {
    const st = fs.statSync(LOCK_PATH);
    if (Date.now() - st.mtimeMs < 3 * 3600 * 1000) return false; // 3 小时内有实例在跑
  } catch (e) { /* 无锁文件 */ }
  ensureDir(OUT_DIR);
  fs.writeFileSync(LOCK_PATH, process.pid + ' ' + new Date().toISOString());
  return true;
}
function releaseLock() { try { fs.unlinkSync(LOCK_PATH); } catch (e) { /* 已不存在 */ } }

/** 简单工作池：并发执行任务 */
async function runPool(tasks, concurrency, workerFn) {
  let idx = 0;
  const results = new Array(tasks.length);
  async function runner() {
    while (idx < tasks.length) {
      const my = idx++;
      results[my] = await workerFn(tasks[my], my);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner));
  return results;
}

/**
 * 确保窗口内每个 (市场×交易日) 的暗盘数据就绪（磁盘缓存优先，缺则抓取）。
 * @returns {{darkDayMaps, validDaysByMkt, status, targetsByMkt}}
 *   status: Map 'mkt|date' -> cached(缓存有数据) | ok(新抓有数据) | empty(成功但空=休市) | error(抓取失败)
 */
async function ensureDarkMaps({ days, codes, refresh = false, quiet = false, log = () => {} }) {
  const targetsByMkt = { '0': new Set(), '1': new Set(), '2': new Set() };
  for (const c of codes) targetsByMkt[marketOf(c)].add(c);
  const tasks = [];
  for (const mkt of ['0', '1', '2']) {
    if (targetsByMkt[mkt].size === 0) continue;
    for (const ds of days) tasks.push({ mkt, ds });
  }
  let done = 0;
  const darkDayMaps = new Map();   // key: mkt|date -> Map(code -> {anpan,mingpan,zong,rank})
  const validDaysByMkt = { '0': new Set(), '1': new Set(), '2': new Set() }; // 实际取到非空榜单的交易日
  const status = new Map();
  if (!quiet) log(`暗盘数据：${tasks.length} 个 (市场×交易日) 任务，并发 4 …`);

  async function processTask({ mkt, ds }) {
    const key = mkt + '|' + ds;
    let map = loadDarkCache(mkt, ds, targetsByMkt[mkt], refresh);
    let st;
    if (map) {
      st = map.size > 0 ? 'cached' : 'empty'; // 缓存里也可能存的是"当日空榜单"（休市）
    } else {
      try {
        const r = await api.fetchDarkDay(mkt, dashToYmd(ds), targetsByMkt[mkt]);
        map = r.map;
        saveDarkCache(mkt, ds, map, r.listComplete, targetsByMkt[mkt]);
        st = map.size > 0 ? 'ok' : 'empty';
      } catch (e) {
        log(`✗ ${MKT_NAME[mkt]} ${ds} 抓取失败: ${e.message}`);
        map = new Map();
        st = 'error';
      }
    }
    if (map.size > 0) validDaysByMkt[mkt].add(ds); // 空=节假日/失败，不计入命中分母
    darkDayMaps.set(key, map);
    status.set(key, st);
    done++;
    if (!quiet) {
      const hitCnt = Array.from(targetsByMkt[mkt]).filter((c) => map.has(c)).length;
      log(`✔ [${done}/${tasks.length}] ${MKT_NAME[mkt]}市 ${ds} 榜单${map.size}只${st === 'cached' ? '(缓存)' : ''}，目标命中 ${hitCnt}/${targetsByMkt[mkt].size}`);
    }
  }

  await runPool(tasks, 4, processTask);

  // 失败任务 15 秒后重试一轮（成功的天已落盘缓存，重试只补失败天）
  const failed = tasks.filter((t) => status.get(t.mkt + '|' + t.ds) === 'error');
  if (failed.length) {
    log(`⚠ ${failed.length} 个 (市场×日) 任务失败，15 秒后重试一轮 …`);
    await api.sleep(15000);
    await runPool(failed, 4, processTask);
  }
  return { darkDayMaps, validDaysByMkt, status, targetsByMkt };
}

// ---------- 行业/概念（F10 ssbk，增量缓存） ----------
async function ensureSsbk(codes, { refresh = false, log = () => {} } = {}) {
  const cachePath = path.join(CACHE_DIR, 'ssbk_all.json');
  const ssbkMap = new Map(); // code -> {industry, concepts}
  if (!refresh && fs.existsSync(cachePath)) {
    try {
      const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      for (const [c, v] of Object.entries(j || {})) ssbkMap.set(c, v);
    } catch (e) { /* 缓存损坏则重拉 */ }
  }
  const missing = codes.filter((c) => !ssbkMap.has(c));
  if (missing.length === 0) {
    log(`F10 所属板块：缓存命中 ${ssbkMap.size} 只，无需抓取`);
    return { ssbkMap, fail: 0 };
  }
  log(`F10 所属板块：缓存 ${ssbkMap.size} 只，需抓取 ${missing.length} 只（并发 3）…`);
  let done = 0, fail = 0;
  const save = () => {
    const obj = {}; for (const [c, v] of ssbkMap) obj[c] = v;
    writeJsonAtomic(cachePath, JSON.stringify(obj)); // 增量落盘
  };
  await runPool(missing, 3, async (code) => {
    try {
      ssbkMap.set(code, await api.fetchF10Ssbk(code));
    } catch (e) {
      fail++;
      if (fail <= 3) log(`  F10 ${code} 失败: ${e.message}`);
    }
    if (++done % 300 === 0) {
      save();
      log(`  F10 进度 ${done}/${missing.length}（失败 ${fail}）`);
    }
  });
  save();
  log(`F10 所属板块完成：共 ${ssbkMap.size} 只（本轮失败 ${fail}）`);
  return { ssbkMap, fail };
}

/** 行业板块涨跌幅（评分行业热度项；push2 限流时返回 null，该项按中性 5 分计） */
async function fetchBoardZdfBestEffort(log) {
  for (const waitMs of [0, 15000]) {
    if (waitMs) await api.sleep(waitMs);
    try {
      const m = await api.fetchIndustryBoardZdf();
      if (m) { log('行业板块涨跌幅获取成功: ' + m.size + ' 个板块'); return m; }
    } catch (e) { /* 稍后重试一次 */ }
  }
  log('行业板块涨跌幅未获取（push2 限流），评分中行业热度项按中性 5 分计');
  return null;
}

// ---------- 汇总 ----------
/**
 * 组装表格行（与当日实时路径完全相同的评分口径）。
 * @param quoteFor (code) => {name, price, pct, floatMv} | null —— 当日=腾讯实时，历史=日K线收盘
 */
function assembleRows({ codes, snapDate, days, darkDayMaps, validDaysByMkt, quoteFor, ssbkMap, boardZdf }) {
  const rows = [];
  for (const code of codes) {
    const mkt = marketOf(code);
    const q = quoteFor(code) || null;
    const info = ssbkMap.get(code) || null;

    // 快照日暗盘
    const todayMap = darkDayMaps.get(mkt + '|' + days[0]) || new Map();
    const td = todayMap.get(code) || null;

    // 30日累计与命中（只统计实际取到非空榜单的交易日）
    const validDays = validDaysByMkt[mkt];
    let an30 = 0, ming30 = 0, zong30 = 0, hitDays = 0;
    for (const ds of validDays) {
      const dm = darkDayMaps.get(mkt + '|' + ds);
      if (!dm) continue;
      const rec = dm.get(code);
      if (rec && (rec.anpan !== 0 || rec.mingpan !== 0)) {
        hitDays++;
        an30 += rec.anpan; ming30 += rec.mingpan; zong30 += rec.zong;
      }
    }

    const pct = q ? q.pct : 0;
    const floatMv = q ? q.floatMv : null;
    const industry = info ? info.industry : '';
    const concepts = info ? info.concepts : '';
    const industryZdf = (boardZdf && industry && boardZdf.has(industry)) ? boardZdf.get(industry) : null;

    const ev = evaluate({ pct, zongToday: td ? td.zong : 0, industryZdf, floatMv: floatMv || 0 });
    const val = evaluateValue({ totalScore: ev.totalScore, zong30, hitDays, totalDays: validDays.size, pct });

    rows.push({
      code,
      name: (q && q.name) || '',
      lastDate: snapDate,
      price: q ? q.price : null,
      pct: q ? pct : null,
      rank: td ? td.rank : 0,
      anpanToday: td ? td.anpan : 0, mingpanToday: td ? td.mingpan : 0, zongTodayRaw: td ? td.zong : 0,
      an30Raw: an30, ming30Raw: ming30, zong30Raw: zong30,
      anToday: formatMoney(td ? td.anpan : 0), mingToday: formatMoney(td ? td.mingpan : 0), zongToday: formatMoney(td ? td.zong : 0),
      an30: formatMoney(an30), ming30: formatMoney(ming30), zong30: formatMoney(zong30),
      hitDays, totalDays: validDays.size,
      floatMv: floatMv || null,
      industry: industry || '', concepts: concepts || '',
      aiScore: ev.totalScore, strongLine: ev.strongLine,
      fundSignal: ev.fundSignal, comboAdvice: ev.comboAdvice,
      value: val.value, conclusion: val.conclusion
    });
  }
  rows.sort((a, b) => b.value - a.value || b.aiScore - a.aiScore);
  return rows;
}

function rowsStat(rows) {
  return {
    total: rows.length,
    pick: rows.filter((r) => r.conclusion === '入选（重点关注）').length,
    pickAll: rows.filter((r) => String(r.conclusion).indexOf('入选') === 0).length,
    avgAi: Math.round(rows.reduce((s, r) => s + r.aiScore, 0) / (rows.length || 1)),
    avgVal: Math.round(rows.reduce((s, r) => s + r.value, 0) / (rows.length || 1))
  };
}

function windowLabel(days, validDaysByMkt) {
  return days[days.length - 1] + ' ~ ' + days[0] +
    '（有效交易日 深' + validDaysByMkt['0'].size + '/沪' + validDaysByMkt['1'].size + '/北' + validDaysByMkt['2'].size + '）';
}

// ---------- 归档输出 ----------
function historyPath(dashDate) { return path.join(HISTORY_DIR, dashDate + '.json'); }

/** 写结构化历史归档（数值型原始字段，供后续统计服务评估预测准确性） */
function writeHistoryJson(dashDate, rows, info) {
  ensureDir(HISTORY_DIR);
  const doc = {
    date: dashDate,
    generatedAt: new Date().toISOString(),
    source: info.source,               // live=当日实时生成 | backfill=事后补录
    meta: {
      codes: rows.length,
      dayWindow: info.dayWindow,
      validDays: { sz: info.validDays['0'].size, sh: info.validDays['1'].size, bj: info.validDays['2'].size },
      quoteSource: info.quoteSource,   // live=腾讯实时 | kline=日K线收盘
      hasBoardZdf: !!info.boardZdf,    // 行业热度项是否有当日板块涨跌幅（false 时该项按中性5分计）
      marketOpen: info.marketOpen !== false, // false=休市日（暗盘数据是上一交易日的回声，行情无当日K线）
      stat: info.stat
    },
    stocks: rows.map((r) => ({
      code: r.code,
      name: r.name || '',
      close: r.price != null ? +r.price.toFixed(2) : null,   // 快照日收盘价
      pct: r.pct != null ? +r.pct.toFixed(2) : null,          // 快照日涨跌幅 %
      rank: r.rank || 0,                                       // 当日该市场暗盘总榜排名
      an: Math.round(r.anpanToday), ming: Math.round(r.mingpanToday), zong: Math.round(r.zongTodayRaw),        // 当日暗/明/总净流入(元)
      an30: Math.round(r.an30Raw), ming30: Math.round(r.ming30Raw), zong30: Math.round(r.zong30Raw),            // 窗口累计(元)
      hitDays: r.hitDays, totalDays: r.totalDays,
      floatMv: r.floatMv != null ? +r.floatMv.toFixed(2) : null, // 流通市值(亿)，历史日为近似值
      industry: r.industry || '', concepts: r.concepts || '',
      aiScore: r.aiScore, strongLine: r.strongLine,
      fundSignal: r.fundSignal, comboAdvice: r.comboAdvice,
      value: r.value, conclusion: r.conclusion
    }))
  };
  writeJsonAtomic(historyPath(dashDate), JSON.stringify(doc));
  return historyPath(dashDate);
}

function writeCsvFile(dashDate, rows) {
  const p = path.join(OUT_DIR, '暗盘资金全景表_' + dashDate + '.csv');
  fs.writeFileSync(p, buildCsv(rows), 'utf8');
  return p;
}

function loadCodes(limit) {
  let codes = fs.readFileSync(path.join(ROOT, '股票代码.txt'), 'utf8')
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d{6}$/.test(s));
  codes = Array.from(new Set(codes));
  if (limit > 0) codes = codes.slice(0, limit);
  return codes;
}

// ---------- 非交易日名单（暗盘接口当日无数据 ⇒ 节假日/休市） ----------
function nonTradingPath() { return path.join(HISTORY_DIR, '_nontrading.json'); }
function loadNonTrading() {
  try { return JSON.parse(fs.readFileSync(nonTradingPath(), 'utf8')) || []; } catch (e) { return []; }
}
function saveNonTrading(arr) {
  ensureDir(HISTORY_DIR);
  fs.writeFileSync(nonTradingPath(), JSON.stringify(Array.from(new Set(arr)).sort()), 'utf8');
}

module.exports = {
  ROOT, OUT_DIR, CACHE_DIR, HISTORY_DIR,
  ensureDir, parseYmd, ymdToDash, dashToYmd, todayYmd, fmtYmd,
  recentTradeDays, prevWeekdayYmd, afterClose,
  marketOf, MKT_NAME,
  loadDarkCache, saveDarkCache, runPool,
  writeJsonAtomic, acquireLock, releaseLock,
  ensureDarkMaps, ensureSsbk, fetchBoardZdfBestEffort,
  assembleRows, rowsStat, windowLabel,
  historyPath, writeHistoryJson, writeCsvFile, loadCodes,
  loadNonTrading, saveNonTrading
};
