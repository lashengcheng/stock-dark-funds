// fetch_all.js — 主脚本：股票代码.txt 全量 → 暗盘资金全景表 (CSV + HTML + JSON 归档)
// 用法:
//   node scripts/fetch_all.js                     # 当日快照（15:30 后运行；之前自动回退上一交易日）
//   node scripts/fetch_all.js --date 20261013     # 指定历史日期（行情取自日K线收盘；已有归档则跳过）
//   node scripts/fetch_all.js --limit 50          # 只跑前 50 只（验证用）
//   node scripts/fetch_all.js --days 5            # 只统计最近 5 个交易日
//   node scripts/fetch_all.js --refresh           # 忽略本地缓存强制重拉
// 产物: out/暗盘资金全景表_日期.csv / .html + out/history/日期.json（数值归档，供统计服务用）
'use strict';

const fs = require('fs');
const path = require('path');
const api = require('./lib/api');
const { buildHtml } = require('./lib/render');
const snap = require('./lib/snapshot');
const { fetchKlineBatch, quoteAt } = require('./lib/kline');

// ---------- CLI 参数 ----------
const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name) >= 0;
const optNum = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && /^\d+$/.test(args[i + 1]) ? parseInt(args[i + 1], 10) : dflt;
};
const optYmd = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && /^\d{8}$/.test(args[i + 1]) ? args[i + 1] : '';
};
const LIMIT = optNum('--limit', 0);        // 0=不限
const DAYS = optNum('--days', 30);
const REFRESH = flag('--refresh');
const DATE = optYmd('--date');             // YYYYMMDD：生成历史日期快照

function log(msg) { console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg); }

/** 校验 YYYYMMDD 是真实日历日期 */
function isValidYmd(s) {
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

async function main() {
  const t0 = Date.now();

  // 参数合法性：非法输入直接拒绝，避免静默产出错误日期标签/空窗口归档
  if (DAYS < 1) { console.error('✗ --days 必须 ≥ 1'); process.exit(1); }
  if (DATE) {
    if (!isValidYmd(DATE)) { console.error('✗ --date ' + DATE + ' 不是合法日历日期'); process.exit(1); }
    if (DATE > snap.todayYmd()) { console.error('✗ --date 不能是未来日期'); process.exit(1); }
    if (DATE === snap.todayYmd() && !snap.afterClose()) {
      console.error('✗ 当日未收盘（15:30 前）不能用 --date 指定今天（会污染当日暗盘缓存）；' +
        '直接运行 node scripts/fetch_all.js 会自动回退上一交易日');
      process.exit(1);
    }
  }

  // 运行互斥：防止定时任务与手动运行并发写文件
  if (!snap.acquireLock()) { console.error('✗ 已有另一个实例在运行（out/.lock），退出'); process.exit(1); }
  process.on('exit', () => snap.releaseLock());

  snap.ensureDir(snap.OUT_DIR); snap.ensureDir(snap.CACHE_DIR);
  const codes = snap.loadCodes(LIMIT);

  // 1) 快照日期
  let snapYmd;
  if (DATE) {
    // 传周末/非交易日时对齐到之前最近的工作日，保证 days[0] 与标签一致
    snapYmd = snap.dashToYmd(snap.recentTradeDays(1, DATE)[0]);
    if (snapYmd !== DATE) log('⚠ ' + snap.ymdToDash(DATE) + ' 非工作日，快照对齐至 ' + snap.ymdToDash(snapYmd));
  } else {
    const latest = await api.findLatestDarkDate();
    snapYmd = latest;
    log('最新暗盘交易日: ' + snap.ymdToDash(latest));
    if (snapYmd === snap.todayYmd() && !snap.afterClose()) {
      snapYmd = snap.prevWeekdayYmd(snapYmd);
      log('⚠ 未到 15:30，当日行情未收盘，快照回退至 ' + snap.ymdToDash(snapYmd));
    }
  }
  const dashDate = snap.ymdToDash(snapYmd);
  const isToday = snapYmd === snap.todayYmd();
  const source = isToday ? 'live' : 'backfill';

  // 历史日期：已有归档则跳过（防止补录数据覆盖当日实时归档；重建请先删除该 JSON）
  if (!isToday && !REFRESH && fs.existsSync(snap.historyPath(dashDate))) {
    log('⏭ ' + dashDate + ' 已有归档 out/history/' + dashDate + '.json，跳过（重建请先删除该文件）');
    process.exit(0);
  }

  const days = snap.recentTradeDays(DAYS, snapYmd);      // 降序，days[0]=快照日
  log(`读取代码 ${codes.length} 只（${LIMIT > 0 ? 'LIMIT=' + LIMIT + ' ' : ''}快照日 ${dashDate}，窗口 ${DAYS} 个交易日${REFRESH ? '，强制刷新' : ''}，模式 ${source}）`);

  // 2) 暗盘日数据（缓存优先；失败任务自动重试一轮）
  const { darkDayMaps, validDaysByMkt, status } = await snap.ensureDarkMaps({ days, codes, refresh: REFRESH, log });

  // 数据完整性闸门：窗口内仍有抓取失败 ⇒ 不写归档（缓存已保留，重跑可续传；次日 backfill 会补）
  const winErrors = Array.from(status.entries()).filter(([k, st]) => st === 'error').map(([k]) => k);
  if (winErrors.length) {
    log(`✗ 窗口内 ${winErrors.length} 个 (市场×日) 重试后仍失败（${winErrors.slice(0, 5).join(' ')}${winErrors.length > 5 ? ' …' : ''}），` +
        '不写归档防止错误数据被 skip-if-exists 锁死；直接重跑即可续传');
    process.exit(1);
  }
  // 快照日三个市场全空（且无错误）⇒ 休市日，不产出归档
  if (!['0', '1', '2'].some((m) => (darkDayMaps.get(m + '|' + days[0]) || new Map()).size > 0)) {
    log('◦ ' + dashDate + ' 无暗盘数据（休市日），不生成归档');
    process.exit(0);
  }

  // 3) 行情：当日=腾讯实时；历史=日K线收盘 + 实时行情提供名称/流通股本基准
  let quoteFor, quoteSource;
  if (isToday) {
    log('抓取腾讯实时行情（批量 50/请求）…');
    const quoteMap = await api.fetchQuotesBatch(codes, (got, total) => log(`  行情进度 ${got}/${total}`));
    log('行情获取成功: ' + quoteMap.size + '/' + codes.length);
    if (quoteMap.size < codes.length * 0.8) {
      log(`✗ 行情获取成功率不足 80%（${quoteMap.size}/${codes.length}），疑似网络故障，不写归档；稍后重跑`);
      process.exit(1);
    }
    quoteFor = (code) => quoteMap.get(code) || null;
    quoteSource = 'live';
  } else {
    log(`历史快照：行情取自腾讯日K线（${dashDate} 收盘），另拉实时行情用于名称/流通股本 …`);
    const klineMap = await fetchKlineBatch(codes, 160, (d, t) => log(`  K线进度 ${d}/${t}`));
    log('K线获取成功: ' + klineMap.size + '/' + codes.length);
    if (klineMap.size < codes.length * 0.8) {
      log(`✗ K线获取成功率不足 80%（${klineMap.size}/${codes.length}），` +
          '可能 --date 超出K线窗口(约8个月)或网络故障，不写归档');
      process.exit(1);
    }
    const liveMap = await api.fetchQuotesBatch(codes);
    log('实时行情（名称/股本基准）获取成功: ' + liveMap.size + '/' + codes.length);
    quoteFor = (code) => {
      const q = quoteAt(klineMap, code, dashDate);
      if (!q) return null;
      const lq = liveMap.get(code) || null;
      // 历史流通市值 ≈ 今日流通市值 × 历史收盘 / 今日现价（股本不变假设，评分分桶足够）
      let floatMv = null;
      if (lq && lq.floatMv && lq.price > 0) floatMv = lq.floatMv * q.close / lq.price;
      return { name: lq ? lq.name : '', price: q.close, pct: q.pct, floatMv };
    };
    quoteSource = 'kline';
  }

  // 4) 行业/概念（F10 ssbk，增量缓存）+ 行业板块涨跌幅（仅当日；历史日取不到，热度项按中性计）
  const { ssbkMap, fail: ssbkFail } = await snap.ensureSsbk(codes, { refresh: REFRESH, log });
  const boardZdf = isToday ? await snap.fetchBoardZdfBestEffort(log) : null;
  if (!isToday) log('历史快照：无当日行业板块涨跌幅，行业热度项按中性 5 分计');

  // 5) 汇总 + 输出
  const rows = snap.assembleRows({ codes, snapDate: dashDate, days, darkDayMaps, validDaysByMkt, quoteFor, ssbkMap, boardZdf });
  const stat = snap.rowsStat(rows);
  // 休市日识别：全天无涨跌（暗盘接口对休市日回声上一交易日数据，行情无当日K线）
  const marketOpen = rows.some((r) => r.pct != null && r.pct !== 0);
  if (!marketOpen) log('◦ ' + dashDate + ' 全天无涨跌，判定为休市日（暗盘数据为上一交易日回声）');
  const dayWindow = snap.windowLabel(days, validDaysByMkt);
  const meta = {
    dateLabel: dashDate,
    dayWindow,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    hasClist: ssbkMap.size > 0, // 保留字段名：表示行业/概念是否已获取
    stat
  };
  const csvPath = snap.writeCsvFile(dashDate, rows);
  const htmlPath = path.join(snap.OUT_DIR, '暗盘资金全景表_' + dashDate + '.html');
  fs.writeFileSync(htmlPath, buildHtml(rows, meta), 'utf8');
  const jsonPath = snap.writeHistoryJson(dashDate, rows, { source, dayWindow, validDays: validDaysByMkt, quoteSource, boardZdf, marketOpen, stat });

  const secs = Math.round((Date.now() - t0) / 1000);
  log('──────────────────────────────');
  log(`✅ 完成：${rows.length} 只 · 总耗时 ${Math.floor(secs / 60)}分${secs % 60}秒`);
  log(`   入选（重点关注）${stat.pick} 只 / 入选合计 ${stat.pickAll} 只 · 平均AI ${stat.avgAi} · 平均价值 ${stat.avgVal}`);
  log('   CSV : ' + csvPath);
  log('   HTML: ' + htmlPath);
  log('   JSON: ' + jsonPath + '（' + source + '）');
  if (ssbkFail > 0) log(`   ⚠ F10 所属板块有 ${ssbkFail} 只未获取（显示 --），重跑会只补缺失部分`);
  process.exit(0); // 干净退出，避免遗留定时器挂起进程
}

main().catch((e) => { console.error('运行失败:', e); process.exit(1); });
