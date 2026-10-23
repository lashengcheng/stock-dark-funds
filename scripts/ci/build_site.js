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

// 单调保护：绝不允许用更旧的快照覆盖已发布的新快照
// （盘中运行时 findLatestDarkDate 可能回溯到更早的交易日，曾导致站点从 10-22 倒退到 10-21）
if (published && dateStr < published && !process.env.FORCE_PUBLISH) {
  console.log('· 快照 ' + dateStr + ' 早于已发布版本 ' + published + '，拒绝回退发布');
  process.exit(0);
}

const latestCsv = latestHtml.replace(/\.html$/, '.csv');

fs.mkdirSync(DOCS, { recursive: true });

fs.copyFileSync(path.join(OUT, latestHtml), path.join(DOCS, 'index.html'));
console.log('✔ docs/index.html  ←  ' + latestHtml + ' (' +
  (fs.statSync(path.join(DOCS, 'index.html')).size / 1048576).toFixed(2) + ' MB)');

// 注入「数据日期 + 发布时间」角标：页面一眼能看出新鲜度，不用去翻 version.txt
{
  const dst = path.join(DOCS, 'index.html');
  const stamp = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const badge =
    '<div style="position:fixed;right:14px;bottom:14px;z-index:2147483647;' +
    'background:#1a2030;color:#e8ecf4;border:1px solid #333b55;border-radius:8px;' +
    'padding:8px 12px;font:12px/1.6 system-ui,-apple-system,\'Microsoft YaHei\',sans-serif;' +
    'opacity:.93;box-shadow:0 4px 14px rgba(0,0,0,.35)">' +
    '数据日期 <b style="color:#3b82f6">' + dateStr + '</b>' +
    ' · 发布 ' + stamp + '</div>';
  const html = fs.readFileSync(dst, 'utf8');
  if (html.includes('</body>')) {
    fs.writeFileSync(dst, html.replace('</body>', badge + '\n</body>'));
    console.log('✔ 已注入新鲜度角标');
  } else {
    console.log('· 未找到 </body>，跳过角标注入');
  }
}

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
