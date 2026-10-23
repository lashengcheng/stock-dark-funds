// kline.js — 腾讯日K线（不复权）：用于补录历史日期的收盘价/涨跌幅
// 接口: web.ifzq.gtimg.cn/appstock/app/kline/kline?param=sz002131,day,,,320,
// 返回 data[代码].day = [ [日期,开盘,收盘,最高,最低,成交量(手)], ... ]
'use strict';

const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function qqPrefix(code) { return /^6/.test(code) ? 'sh' : /^[48]/.test(code) ? 'bj' : 'sz'; }

function rawGet(url) {
  return new Promise((resolve, reject) => {
    const q = https.get(url, { timeout: 12000, headers: { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    q.on('timeout', () => q.destroy(new Error('timeout')));
    q.on('error', reject);
  });
}

function parseOne(txt, fullCode) {
  const j = JSON.parse(txt);
  const node = j.data && j.data[fullCode];
  const arr = node && (node.day || node.qfqday);
  if (!Array.isArray(arr)) return null;
  const map = new Map(); // date -> {open,close,high,low,vol}，按日期升序插入
  for (const row of arr.slice().sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1))) {
    // 排序一次（ISO 日期字符串字典序=时间序），quoteAt 直接用插入序免得每次查询重排
    if (!row || row.length < 6) continue;
    map.set(String(row[0]), {
      open: parseFloat(row[1]) || 0,
      close: parseFloat(row[2]) || 0,
      high: parseFloat(row[3]) || 0,
      low: parseFloat(row[4]) || 0,
      vol: parseFloat(row[5]) || 0
    });
  }
  return map;
}

/**
 * 批量拉取日K线。
 * @param {string[]} codes 6位代码数组
 * @param {number} count 拉取最近多少个交易日（默认120，约6个月）
 * @param {function} onProgress (完成数, 总数)
 * @returns {Map<code, Map<date,{open,close,high,low,vol}>>}
 */
async function fetchKlineBatch(codes, count, onProgress) {
  const result = new Map();
  const N = count || 120;
  let idx = 0, done = 0;
  async function runner() {
    while (idx < codes.length) {
      const code = codes[idx++];
      const full = qqPrefix(code) + code;
      const url = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=' + full + ',day,,,' + N + ',';
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const txt = await rawGet(url);
          const m = parseOne(txt, full);
          if (m && m.size) { result.set(code, m); ok = true; }
        } catch (e) { /* 重试一次 */ }
        if (!ok) await sleep(300);
      }
      done++;
      if (onProgress && done % 500 === 0) onProgress(done, codes.length);
      await sleep(40);
    }
  }
  await Promise.all([runner(), runner(), runner()]); // 并发 3
  return result;
}

/**
 * 从K线取某日行情（停牌无该日K线时回退到之前最近一个交易日，pct 记 0）。
 * @returns {{close,pct,open,high,low,vol,suspended}|null}
 */
function quoteAt(klineMap, code, dateStr) {
  const days = klineMap.get(code);
  if (!days || days.size === 0) return null;
  if (days.has(dateStr)) {
    const d = days.get(dateStr);
    // 前一交易日收盘 → 涨跌幅（parseOne 已按日期升序插入，无需再排序）
    const keys = Array.from(days.keys());
    const i = keys.indexOf(dateStr);
    if (i <= 0) return { close: d.close, pct: 0, open: d.open, high: d.high, low: d.low, vol: d.vol, suspended: false };
    const prev = days.get(keys[i - 1]);
    const pct = prev && prev.close ? (d.close - prev.close) / prev.close * 100 : 0;
    return { close: d.close, pct, open: d.open, high: d.high, low: d.low, vol: d.vol, suspended: false };
  }
  // 停牌：取 dateStr 之前最近的K线（插入序即升序）
  const keys = Array.from(days.keys());
  let last = null;
  for (const k of keys) { if (k < dateStr) last = k; else break; }
  if (!last) return null;
  const d = days.get(last);
  return { close: d.close, pct: 0, open: d.open, high: d.high, low: d.low, vol: d.vol, suspended: true };
}

module.exports = { fetchKlineBatch, quoteAt };
