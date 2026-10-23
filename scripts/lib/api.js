// api.js — 数据接口层：腾讯行情(批量/GBK)、东财暗盘资金(darktrade)、东财 clist(行业/概念)
// 所有函数均带超时与重试；对限流接口做指数退避。
'use strict';

const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 底层 HTTPS GET，返回 Buffer */
function rawGet(url, referer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const q = https.get(url, {
      timeout: timeoutMs || 10000,
      headers: {
        'User-Agent': UA,
        'Referer': referer || 'https://quote.eastmoney.com/',
        'Accept': '*/*'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject); // 响应流中途出错（ECONNRESET等）必须捕获，否则进程崩溃
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        resolve(Buffer.concat(chunks));
      });
    });
    q.on('timeout', () => q.destroy(new Error('timeout')));
    q.on('error', reject);
  });
}

/** 带重试的 GET（返回 utf8 文本）。retry=0 表示只试一次 */
async function getText(url, opt) {
  opt = opt || {};
  const retries = opt.retries != null ? opt.retries : 2;
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const buf = await rawGet(url, opt.referer, opt.timeoutMs);
      return buf.toString('utf8');
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(400 * (i + 1) + Math.random() * 200);
    }
  }
  throw lastErr;
}

/** GBK 解码（Node 22 自带全量 ICU） */
function gbkDecode(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return buf.toString('utf8'); }
}

// ============ 腾讯行情（批量，最稳定） ============
// 字段索引（与 HTML 内 parseQQQuote 一致并扩展）：
// arr[1]名称 [3]现价 [4]昨收 [5]今开 [6]成交量(手) [33]最高 [34]最低 [37]成交额(万)
// [38]换手率 [43]振幅 [44]流通市值(亿) [45]总市值(亿) —— 已用 f116/f117 交叉验证
function parseQQLine(line) {
  const m = line.match(/v_(?:sh|sz|bj)(\d{6})="([^"]*)"/);
  if (!m) return null;
  const a = m[2].split('~');
  const price = parseFloat(a[3]);
  const prev = parseFloat(a[4]);
  if (!price || !prev) return null;
  const chg = price - prev;
  return {
    code: m[1],
    name: a[1] || '',
    price, prev, chg,
    pct: prev ? (chg / prev) * 100 : 0,
    open: parseFloat(a[5]) || 0,
    high: parseFloat(a[33]) || 0,
    low: parseFloat(a[34]) || 0,
    vol: parseFloat(a[6]) || 0,
    turnover: parseFloat(a[37]) || 0,
    turnoverRate: parseFloat(a[38]) || 0,
    floatMv: parseFloat(a[44]) || 0,  // 亿
    totalMv: parseFloat(a[45]) || 0   // 亿
  };
}

/**
 * 批量拉取行情。codes: ['000686', ...]（纯6位代码）
 * 返回 Map<code, quoteObj>。每批 50 个代码，批间小间隔。
 */
async function fetchQuotesBatch(codes, onProgress) {
  const result = new Map();
  const CHUNK = 50;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const chunk = codes.slice(i, i + CHUNK);
    const qq = chunk.map((c) => (/^6/.test(c) ? 'sh' : /^[48]/.test(c) ? 'bj' : 'sz') + c).join(',');
    let txt = '';
    try {
      const buf = await rawGet('https://qt.gtimg.cn/q=' + qq, 'https://gu.qq.com/', 10000);
      txt = gbkDecode(buf);
    } catch (e) {
      // 重试一次
      try {
        await sleep(500);
        const buf2 = await rawGet('https://qt.gtimg.cn/q=' + qq, 'https://gu.qq.com/', 10000);
        txt = gbkDecode(buf2);
      } catch (e2) {
        console.error(`  行情批次 ${chunk[0]}..${chunk[chunk.length - 1]} 失败: ${e2.message}`);
        continue;
      }
    }
    for (const line of txt.split(';')) {
      const q = parseQQLine(line.trim());
      if (q) result.set(q.code, q);
    }
    if (onProgress && (i / CHUNK) % 10 === 0) onProgress(Math.min(i + CHUNK, codes.length), codes.length);
    await sleep(80);
  }
  return result;
}

// ============ 东财暗盘资金 darktrade（核心接口） ============
// 行结构（JSON 对象键）: "4"=代码 "6"=暗盘(元) "7"=明盘(元) "8"=总(元) "16"=名称；顶层 "2"=总数
/**
 * 拉取某市场某日的一页暗盘数据。
 * @param {string} marketCode '0'深 '1'沪 '2'北
 * @param {string} ymd 'YYYYMMDD'
 * @returns {{total:number, rows:Array<{code,anpan,mingpan,zong,name}>}} 失败抛错
 */
async function fetchDarkPage(marketCode, ymd, page) {
  const url = 'https://quotederivates.eastmoney.com/datacenter/darktrade?version=100&date=' + ymd +
    '&NumPerPage=100&sortflag=6&desc=1&market=' + marketCode +
    '&label=' + encodeURIComponent('个股') + '&StartPage=' + page;
  const txt = await getText(url, { referer: 'https://data.eastmoney.com/', retries: 3, timeoutMs: 12000 });
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('darktrade 非JSON响应'); }
  if (!j || j.errid !== 0 || !Array.isArray(j.data)) throw new Error('darktrade errid=' + (j && j.errid));
  const rows = j.data.map((r) => {
    const code = String(r['4'] || '').replace(/[^\d]/g, '').slice(0, 6);
    const an = parseFloat(r['6']); const ming = parseFloat(r['7']);
    return {
      code,
      anpan: isNaN(an) ? 0 : an,
      mingpan: isNaN(ming) ? 0 : ming,
      zong: (isNaN(an) ? 0 : an) + (isNaN(ming) ? 0 : ming),
      name: r['16'] || ''
    };
  }).filter((r) => r.code);
  return { total: Number(j['2']) || 0, rows };
}

/**
 * 拉取某市场某日全量暗盘榜（分页直到翻完或目标代码全部找到）。
 * @param {Set<string>} targets 该市场的目标代码集合（用于提前停止）
 * @param {function} onPage (pageIdx, totalPages) 进度回调
 * @returns {{map: Map<code,{anpan,mingpan,zong,rank}>, listComplete: boolean}}
 *   listComplete=true 表示翻完了整个榜单（缓存可服务任意目标集）；
 *   false 表示因目标全找到而提前停止（缓存只对该目标集有效）。
 */
async function fetchDarkDay(marketCode, ymd, targets, onPage) {
  const map = new Map();
  const found = new Set();
  const PER_PAGE = 100;
  const MAX_PAGES = 120; // 12000 只，保险上限
  let listComplete = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { total, rows } = await fetchDarkPage(marketCode, ymd, page);
    rows.forEach((r, idx) => {
      if (!map.has(r.code)) {
        map.set(r.code, { anpan: r.anpan, mingpan: r.mingpan, zong: r.zong, rank: (page - 1) * PER_PAGE + idx + 1 });
        if (targets.has(r.code)) found.add(r.code);
      }
    });
    if (onPage) onPage(page, Math.ceil(total / PER_PAGE));
    if (rows.length < PER_PAGE) { listComplete = true; break; } // 翻完了
    if (targets.size > 0 && found.size >= targets.size) break;  // 目标全找到
    await sleep(60);
  }
  return { map, listComplete };
}

/** 探测最近有数据的暗盘交易日：从今天往回找最近 n 个工作日 */
async function findLatestDarkDate() {
  const days = [];
  const d = new Date();
  while (days.length < 6) {
    const w = d.getDay();
    if (w >= 1 && w <= 5) {
      const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
      days.push(ymd);
    }
    d.setDate(d.getDate() - 1);
  }
  for (const ymd of days) {
    // 上游偶发返回"空页"（不是报错）—— 若直接据此判定当天无数据，就会回退到上一交易日，
    // 收盘后这种误判会导致整天不出数据（2026-10-23 实测：17:21 返回 10-22，17:24 又返回 10-23）。
    // 因此对每个候选日重试两次，把偶发空页和真正的无数据区分开。
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { rows } = await fetchDarkPage('0', ymd, 1);
        if (rows.length > 0) return ymd;
        if (attempt === 3) break;
        await sleep(2000);
      } catch (e) {
        if (attempt === 3) break;
        await sleep(2000);
      }
    }
  }
  return days[0];
}

// ============ 东财 clist（行业/概念，批量；易限流，失败返回 null） ============
/**
 * 尝试批量拉取沪深A股的 名称/行业/概念/地区/市值。
 * @returns {Map<code, {name,industry,region,concepts,floatMv,totalMv}> | null}
 */
async function fetchClistInfo() {
  const fsParam = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
  const fields = 'f12,f14,f100,f102,f103,f116,f117';
  const map = new Map();
  const PZ = 500; // 服务端可能截断为100，用 total 判断是否翻完
  for (let pn = 1; pn <= 80; pn++) {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn + '&pz=' + PZ +
      '&po=1&np=1&fltt=2&invt=2&fid=f12&fs=' + fsParam + '&fields=' + fields + '&_=' + Date.now();
    let j;
    try {
      const txt = await getText(url, { referer: 'https://quote.eastmoney.com/center/gridlist.html', retries: 1, timeoutMs: 8000 });
      j = JSON.parse(txt);
    } catch (e) {
      return null; // 限流/超时 → 整体放弃（调用方可稍后重试）
    }
    if (!j || !j.data) return null; // 限流时常返回字面 null：本次尝试整体失败，由调用方稍后重试
    const diff = j.data.diff || [];
    const total = Number(j.data.total) || 0;
    if (!Array.isArray(diff) || diff.length === 0) break;
    for (const it of diff) {
      map.set(String(it.f12), {
        name: it.f14 || '',
        industry: (it.f100 && it.f100 !== '-') ? it.f100 : '',
        region: (it.f102 && it.f102 !== '-') ? it.f102 : '',
        concepts: (it.f103 && it.f103 !== '-') ? it.f103 : '',
        floatMv: parseFloat(it.f117) || 0,  // 亿
        totalMv: parseFloat(it.f116) || 0
      });
    }
    if (total > 0 && map.size >= total) break; // 已翻完
    await sleep(300);
  }
  return map.size ? map : null;
}

// ============ 东财 F10 所属板块（emweb 域名，与 push2 限流桶隔离） ============
// CoreConception/PageAjax 返回 ssbk=所属板块数组（BOARD_RANK 排序：第1条为行业，其后为关联行业/地区等）
// 与原 records_002131_screen.csv 的 行业/概念 列格式完全一致。
/**
 * 拉取单股所属板块。
 * @returns {{industry:string, concepts:string}} concepts 为前4个板块名"、"连接（与旧表一致）；失败抛错
 */
async function fetchF10Ssbk(code) {
  const mkt = /^6/.test(code) ? 'SH' : /^[48]/.test(code) ? 'BJ' : 'SZ';
  const url = 'https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=' + mkt + code;
  const txt = await getText(url, { referer: 'https://emweb.securities.eastmoney.com/', retries: 1, timeoutMs: 10000 });
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('F10 非JSON响应'); }
  const ssbk = (j && Array.isArray(j.ssbk)) ? j.ssbk : [];
  if (!ssbk.length) throw new Error('F10 ssbk 为空');
  const names = ssbk
    .slice()
    .sort((a, b) => (Number(a.BOARD_RANK) || 99) - (Number(b.BOARD_RANK) || 99))
    .map((x) => String(x.BOARD_NAME || '').trim())
    .filter(Boolean);
  if (!names.length) throw new Error('F10 板块名全空');
  return { industry: names[0], concepts: names.slice(0, 4).join('、') };
}

/** 行业板块当日涨跌幅（用于评分中的"行业热度"项）。失败返回 null */
async function fetchIndustryBoardZdf() {
  const map = new Map();
  for (const t of ['2', '3']) { // t:2 行业板块 t:3 概念板块（概念板块名也可与行业匹配兜底）
    let j;
    try {
      const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=600&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:' + t + '&fields=f12,f14,f3&_=' + Date.now();
      const txt = await getText(url, { referer: 'https://quote.eastmoney.com/', retries: 1, timeoutMs: 8000 });
      j = JSON.parse(txt);
    } catch (e) {
      return map.size ? map : null;
    }
    if (!j || !j.data) continue; // 空响应：跳过该板块类型
    const diff = j.data.diff || [];
    for (const it of diff) map.set(String(it.f14), Number(it.f3) || 0);
    if (!diff.length) break;
    await sleep(200);
  }
  return map.size ? map : null;
}

module.exports = {
  sleep, getText, gbkDecode,
  fetchQuotesBatch, fetchDarkPage, fetchDarkDay, findLatestDarkDate,
  fetchClistInfo, fetchIndustryBoardZdf, fetchF10Ssbk
};
