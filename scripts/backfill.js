// backfill.js — 补录漏掉的交易日归档（电脑没开机/任务失败/服务首次启用时）
// 用法:
//   node scripts/backfill.js                    # 回看最近 30 个工作日，补缺失归档
//   node scripts/backfill.js --lookback 10      # 只回看 10 个工作日
//   node scripts/backfill.js --limit 50         # 只跑前 50 只（验证用）
//   node scripts/backfill.js --days 30          # 每个快照的资金累计窗口（与 fetch_all 保持一致）
// 原理：暗盘历史数据接口永久可查；行情用腾讯日K线取"补录日收盘价"，
//       与当日实时路径共用 snapshot.js 的评分口径。
// 产物: out/history/日期.json + out/暗盘资金全景表_日期.csv（不生成 HTML，体积考虑）
'use strict';

const fs = require('fs');
const api = require('./lib/api');
const snap = require('./lib/snapshot');
const { fetchKlineBatch, quoteAt } = require('./lib/kline');

// ---------- CLI 参数 ----------
const args = process.argv.slice(2);
const optNum = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && /^\d+$/.test(args[i + 1]) ? parseInt(args[i + 1], 10) : dflt;
};
const LOOKBACK = optNum('--lookback', 30);  // 回看工作日数
const LIMIT = optNum('--limit', 0);         // 0=不限
const DAYS = optNum('--days', 30);          // 资金累计窗口

function log(msg) { console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg); }

async function main() {
  const t0 = Date.now();
  if (!snap.acquireLock()) { console.error('✗ 已有另一个实例在运行（out/.lock），退出'); process.exit(1); }
  process.on('exit', () => snap.releaseLock());
  snap.ensureDir(snap.OUT_DIR); snap.ensureDir(snap.CACHE_DIR); snap.ensureDir(snap.HISTORY_DIR);
  const codes = snap.loadCodes(LIMIT);

  // 1) 找缺失的交易日（不含今天——今天由 fetch_all 负责）
  const yesterday = snap.prevWeekdayYmd(snap.todayYmd());
  const candidates = snap.recentTradeDays(LOOKBACK, yesterday); // 降序
  const nonTrading = new Set(snap.loadNonTrading());
  const missing = candidates.filter((d) => !fs.existsSync(snap.historyPath(d)) && !nonTrading.has(d));
  log(`补录检查：回看 ${LOOKBACK} 个工作日（${candidates[candidates.length - 1]} ~ ${candidates[0]}），` +
      `缺归档 ${missing.length} 天${missing.length ? '：' + missing.join(', ') : ''}`);
  if (missing.length === 0) { log('✅ 无缺档'); process.exit(0); }

  // 2) 共享数据一次拉齐：K线（覆盖全部待补日期）+ 实时行情（名称/流通股本）+ F10
  log('拉取日K线（最近 160 个交易日，全部待补日共用）…');
  const klineMap = await fetchKlineBatch(codes, 160, (d, t) => log(`  K线进度 ${d}/${t}`));
  log('K线获取成功: ' + klineMap.size + '/' + codes.length);
  if (klineMap.size < codes.length * 0.8) {
    log(`✗ K线获取成功率不足 80%（${klineMap.size}/${codes.length}），疑似网络故障，中止补录；稍后重跑`);
    process.exit(1);
  }
  const liveMap = await api.fetchQuotesBatch(codes, (got, total) => log(`  行情进度 ${got}/${total}`));
  log('实时行情（名称/股本基准）获取成功: ' + liveMap.size + '/' + codes.length);
  if (liveMap.size < codes.length * 0.8) {
    log(`✗ 实时行情获取成功率不足 80%（${liveMap.size}/${codes.length}），中止补录；稍后重跑`);
    process.exit(1);
  }
  const { ssbkMap } = await snap.ensureSsbk(codes, { log });

  const quoteForAt = (dashDate) => (code) => {
    const q = quoteAt(klineMap, code, dashDate);
    if (!q) return null;
    const lq = liveMap.get(code) || null;
    let floatMv = null;
    if (lq && lq.floatMv && lq.price > 0) floatMv = lq.floatMv * q.close / lq.price;
    return { name: lq ? lq.name : '', price: q.close, pct: q.pct, floatMv };
  };

  // 3) 从旧到新逐日补录
  let skipped = 0;
  for (const d of missing.slice().reverse()) {
    log('── 补录 ' + d + ' ──');
    const days = snap.recentTradeDays(DAYS, d);
    const { darkDayMaps, validDaysByMkt, status } = await snap.ensureDarkMaps({ days, codes, quiet: true, log });

    // 完整性闸门：窗口内仍有抓取失败 ⇒ 跳过该日（缓存已保留，下次补录只补失败天）
    const winErrors = Array.from(status.values()).filter((st) => st === 'error').length;
    if (winErrors > 0) {
      log(`✗ ${d} 窗口内 ${winErrors} 个 (市场×日) 重试后仍失败，留待下次补录`);
      skipped++;
      continue;
    }
    // 判定是否交易日：三市场当日全空且无错误 ⇒ 休市，记名单
    const hasData = ['0', '1', '2'].some((m) => (darkDayMaps.get(m + '|' + d) || new Map()).size > 0);
    if (!hasData) {
      nonTrading.add(d); snap.saveNonTrading(Array.from(nonTrading));
      log('◦ ' + d + ' 无暗盘数据（节假日/休市），记入非交易日名单');
      continue;
    }

    const rows = snap.assembleRows({ codes, snapDate: d, days, darkDayMaps, validDaysByMkt, quoteFor: quoteForAt(d), ssbkMap, boardZdf: null });
    const stat = snap.rowsStat(rows);
    // 休市日识别：全天无涨跌（暗盘接口对休市日回声上一交易日数据）
    const marketOpen = rows.some((r) => r.pct != null && r.pct !== 0);
    if (!marketOpen) log('◦ ' + d + ' 全天无涨跌，判定为休市日（暗盘数据为上一交易日回声）');
    const dayWindow = snap.windowLabel(days, validDaysByMkt);
    const jsonPath = snap.writeHistoryJson(d, rows, { source: 'backfill', dayWindow, validDays: validDaysByMkt, quoteSource: 'kline', boardZdf: null, marketOpen, stat });
    const csvPath = snap.writeCsvFile(d, rows);
    log(`✅ ${d}：${rows.length} 只，入选(重点) ${stat.pick} / 入选合计 ${stat.pickAll}，已归档 JSON+CSV`);
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  log('──────────────────────────────');
  log(`✅ 补录完成：共 ${missing.length} 个待补日（跳过 ${skipped} 个失败日） · 总耗时 ${Math.floor(secs / 60)}分${secs % 60}秒`);
  process.exit(skipped > 0 ? 1 : 0); // 有失败日时返回非零，调度日志可见
}

main().catch((e) => { console.error('运行失败:', e); process.exit(1); });
