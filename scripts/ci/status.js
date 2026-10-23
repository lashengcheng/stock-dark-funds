'use strict';
// status.js — 汇总本次 CI 运行结果，写 status.json（提交回仓库，作为可远程读取的运行健康度）
// 设计意图：GitHub Actions 的日志无法从外部 API 直接读取，把关键结果落成仓库文件，
// 出问题时打开 status.json 就能看到失败原因与日志尾巴。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function tailLines(p, n) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-n);
  } catch (e) { return []; }
}

const now = new Date();
const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(now);

const probe = readJson(path.join(ROOT, 'probe.json'));

// 当天归档（fetch 成功时才会存在）
const historyPath = path.join(ROOT, 'out', 'history', shanghaiDate + '.json');
const history = readJson(historyPath);

let publishedDate = null;
try {
  publishedDate = fs.readFileSync(path.join(ROOT, 'docs', 'version.txt'), 'utf8').split(/\r?\n/)[0].trim();
} catch (e) { /* docs 尚未生成 */ }

const status = {
  generatedAt: now.toISOString(),
  shanghaiDate,
  fetchOutcome: process.env.FETCH_OUTCOME || 'unknown',
  publishedSnapshot: publishedDate,
  isUpToDate: publishedDate === shanghaiDate,
  upstream: probe ? {
    allReachable: probe.allReachable,
    allValid: probe.allValid,
    results: (probe.results || []).map((r) => ({
      name: r.name, status: r.status, ms: r.ms, reachable: r.reachable, valid: r.valid,
      error: r.error || undefined
    }))
  } : null,
  snapshot: history ? {
    date: history.date,
    source: history.source,
    marketOpen: history.meta && history.meta.marketOpen,
    quoteSource: history.meta && history.meta.quoteSource,
    stat: history.meta && history.meta.stat
  } : null,
  fetchLogTail: tailLines(path.join(ROOT, 'fetch.log'), 30)
};

fs.writeFileSync(path.join(ROOT, 'status.json'), JSON.stringify(status, null, 2));

console.log('status.json 已生成：');
console.log('  日期        ' + shanghaiDate);
console.log('  fetch       ' + status.fetchOutcome);
console.log('  已发布快照  ' + (publishedDate || '（无）'));
console.log('  上游可达    ' + (probe ? (probe.allReachable ? '全部可达' : '存在不可达') : '未探测'));
if (status.snapshot && status.snapshot.stat) {
  console.log('  入选        ' + status.snapshot.stat.pick + ' 重点 / ' +
    status.snapshot.stat.pickAll + ' 合计（共 ' + status.snapshot.stat.total + ' 只）');
}
