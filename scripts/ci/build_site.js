'use strict';
// build_site.js — 把最新一次快照装配成可直接托管的静态站点（docs/）。
// 输入：out/暗盘资金全景表_YYYY-MM-DD.html / .csv
// 输出：docs/index.html（最新快照）、docs/latest.csv、docs/version.txt、docs/.nojekyll

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'out');
const DOCS = path.join(ROOT, 'docs');

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

if (!fs.existsSync(OUT)) fail('out/ 不存在，fetch_all.js 可能没有产出');

// 文件名形如「暗盘资金全景表_2026-10-22.html」，按名字排序即按日期排序
const htmls = fs.readdirSync(OUT)
  .filter((f) => /^暗盘资金全景表_\d{4}-\d{2}-\d{2}\.html$/.test(f))
  .sort();

// 已发布快照日期（version.txt 第一行）
let published = null;
try {
  published = fs.readFileSync(path.join(DOCS, 'version.txt'), 'utf8').split(/\r?\n/)[0].trim();
} catch (e) { /* 首次运行还没有 docs/ */ }

// 本次没有产出（盘中回退 + 归档已存在 ⇒ fetch_all 直接跳过）：保留已发布页面，不算失败
if (!htmls.length) {
  if (published && fs.existsSync(path.join(DOCS, 'index.html'))) {
    console.log('· 本次无新快照（盘中回退且归档已存在），保留已发布页面 ' + published);
    process.exit(0);
  }
  fail('out/ 下没有「暗盘资金全景表_日期.html」，且 docs/ 也没有已发布页面');
}

const latestHtml = htmls[htmls.length - 1];
const dateStr = latestHtml.match(/(\d{4}-\d{2}-\d{2})/)[1];

// 幂等：同一天已发布过就不再重复提交（一天跑 4 次，只有新日期才真正更新站点）
if (dateStr === published && !process.env.FORCE_PUBLISH) {
  console.log('· 快照 ' + dateStr + ' 与已发布版本一致，跳过发布（FORCE_PUBLISH=1 可强制重发）');
  process.exit(0);
}

const latestCsv = latestHtml.replace(/\.html$/, '.csv');

fs.mkdirSync(DOCS, { recursive: true });

fs.copyFileSync(path.join(OUT, latestHtml), path.join(DOCS, 'index.html'));
console.log('✔ docs/index.html  ←  ' + latestHtml + ' (' +
  (fs.statSync(path.join(DOCS, 'index.html')).size / 1048576).toFixed(2) + ' MB)');

if (fs.existsSync(path.join(OUT, latestCsv))) {
  fs.copyFileSync(path.join(OUT, latestCsv), path.join(DOCS, 'latest.csv'));
  console.log('✔ docs/latest.csv   ←  ' + latestCsv);
} else {
  console.log('· 未找到同名 CSV，跳过');
}

// 记录当前发布的快照日期，便于外部核对"页面是不是最新的"
fs.writeFileSync(path.join(DOCS, 'version.txt'), dateStr + '\n' + new Date().toISOString() + '\n');
console.log('✔ docs/version.txt  ←  ' + dateStr);

// 关闭 GitHub Pages 的 Jekyll 处理（避免下划线目录被忽略，也加快发布）
fs.writeFileSync(path.join(DOCS, '.nojekyll'), '');
console.log('✔ docs/.nojekyll');

console.log('\n发布快照日期：' + dateStr);
