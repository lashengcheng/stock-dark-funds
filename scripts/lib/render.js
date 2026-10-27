// render.js — 输出层：生成 CSV（带BOM，Excel 友好）与可排序 HTML 表格
'use strict';

const CSV_COLUMNS = [
  '代码', '名称', '最新交易日', '现价', '涨跌幅(%)', '真实暗盘排名',
  '今日暗盘', '今日明盘', '今日总净流入',
  '30日暗盘累计', '30日明盘累计', '30日总累计', '命中天数/总',
  '流通市值(亿)', '行业', '概念', 'AI评分', '强弱线', '资金面信号', '综合建议',
  '投资价值评分', '入选结论'
];

/** rows: assembleRows 产出的对象数组（按投资价值降序） */
function buildCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const vals = [
      r.code, r.name, r.lastDate,
      r.price != null ? r.price.toFixed(2) : '--',
      r.pct != null ? r.pct.toFixed(2) : '--',
      r.rank || '--',
      r.anToday, r.mingToday, r.zongToday,
      r.an30, r.ming30, r.zong30,
      r.hitDays + '/' + r.totalDays,
      r.floatMv != null ? r.floatMv.toFixed(2) : '--',
      r.industry || '--',
      r.concepts || '--',
      r.aiScore, r.strongLine, r.fundSignal, r.comboAdvice,
      r.value, r.conclusion
    ];
    // 名称/行业/概念等含逗号可能：统一包引号转义
    lines.push(vals.map((v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 把内部行对象转成前端表格使用的精简结构。
 * 同时被 buildHtml（内嵌到页面）和 publish_history.js（生成按日期的 JSON）复用，
 * 保证"当天页面"和"历史翻页"两边的列口径完全一致。
 */
function toClientRows(rows) {
  return rows.map((r) => ({
    code: r.code, name: r.name || '', lastDate: r.lastDate, price: r.price, pct: r.pct, rank: r.rank || 0,
    anpanToday: r.anpanToday, mingpanToday: r.mingpanToday, zongTodayRaw: r.zongTodayRaw,
    an30Raw: r.an30Raw, ming30Raw: r.ming30Raw, zong30Raw: r.zong30Raw,
    hitRate: r.totalDays ? r.hitDays / r.totalDays : 0, hitLabel: r.hitDays + '/' + r.totalDays,
    floatMv: r.floatMv, industry: r.industry || '', concepts: r.concepts || '',
    aiScore: r.aiScore, strongLine: r.strongLine, fundSignal: r.fundSignal, comboAdvice: r.comboAdvice,
    value: r.value, conclusion: r.conclusion
  }));
}

/** 生成 HTML（样式沿用原页面的暗色主题变量，涨红跌绿） */
function buildHtml(rows, meta) {
  const upClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
  const body = rows.map((r, i) => {
    return '<tr>' +
      `<td class="num">${i + 1}</td>` +
      `<td class="code">${esc(r.code)}</td>` +
      `<td class="name">${esc(r.name || '--')}</td>` +
      `<td class="num">${esc(r.lastDate)}</td>` +
      `<td class="num">${r.price != null ? r.price.toFixed(2) : '--'}</td>` +
      `<td class="num ${upClass(r.pct)}">${r.pct != null ? (r.pct >= 0 ? '+' : '') + r.pct.toFixed(2) : '--'}</td>` +
      `<td class="num">${r.rank || '--'}</td>` +
      `<td class="num ${upClass(r.anpanToday)}">${esc(r.anToday)}</td>` +
      `<td class="num ${upClass(r.mingpanToday)}">${esc(r.mingToday)}</td>` +
      `<td class="num ${upClass(r.zongTodayRaw)}">${esc(r.zongToday)}</td>` +
      `<td class="num ${upClass(r.an30Raw)}">${esc(r.an30)}</td>` +
      `<td class="num ${upClass(r.ming30Raw)}">${esc(r.ming30)}</td>` +
      `<td class="num ${upClass(r.zong30Raw)}">${esc(r.zong30)}</td>` +
      `<td class="num">${r.hitDays}/${r.totalDays}</td>` +
      `<td class="num">${r.floatMv != null ? r.floatMv.toFixed(2) : '--'}</td>` +
      `<td>${esc(r.industry || '--')}</td>` +
      `<td class="concept" title="${esc(r.concepts || '')}">${esc(r.concepts ? (r.concepts.length > 30 ? r.concepts.slice(0, 30) + '…' : r.concepts) : '--')}</td>` +
      `<td class="num">${r.aiScore}</td>` +
      `<td>${esc(r.strongLine)}</td>` +
      `<td>${esc(r.fundSignal)}</td>` +
      `<td>${esc(r.comboAdvice)}</td>` +
      `<td class="num val">${r.value}</td>` +
      `<td class="${String(r.conclusion).indexOf('入选') === 0 ? 'pick' : (r.conclusion === '观察' ? 'watch' : 'pass')}">${esc(r.conclusion)}</td>` +
      '</tr>';
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>暗盘资金全景表 ${esc(meta.dateLabel)}</title>
<style>
:root{--bg:#0f1420;--panel:#1a2030;--panel2:#242b40;--text:#e8ecf4;--muted:#8892a8;
--up:#ef4444;--down:#22c55e;--flat:#b0b8c8;--accent:#3b82f6;--border:#333b55}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;padding:16px}
h1{font-size:20px;margin-bottom:4px}
.meta{color:var(--muted);margin-bottom:12px;line-height:1.7}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 16px;min-width:120px}
.stat b{font-size:18px;display:block}
.stat span{color:var(--muted);font-size:12px}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:5}
input#flt{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 10px;width:240px;font-size:13px}
select{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;margin-left:8px}
table{border-collapse:collapse;width:100%;background:var(--panel);border-radius:10px;overflow:hidden}
th{position:sticky;top:40px;background:var(--panel2);cursor:pointer;user-select:none;white-space:nowrap;padding:8px 8px;text-align:right;border-bottom:1px solid var(--border)}
th:first-child,td:first-child,th.txt,td.txt{text-align:left}
th:hover{color:var(--accent)}
td{padding:6px 8px;border-bottom:1px solid #222940;white-space:nowrap;text-align:right}
td.name,td.code,td.concept,td.txt{text-align:left}
tr:hover td{background:#1e2740}
.up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--flat)}
td.val{font-weight:700}
.pick{color:#f59e0b;font-weight:700}.watch{color:#eab308}.pass{color:var(--muted)}
.foot{color:var(--muted);font-size:12px;margin-top:14px;line-height:1.8}
.datebar{display:none;gap:8px;align-items:center;margin:0 0 12px;flex-wrap:wrap}
.datebar.on{display:flex}
.datebar button,.datebar select{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer}
.datebar button:hover:not(:disabled),.datebar select:hover{border-color:var(--accent)}
.datebar button:disabled{opacity:.35;cursor:default}
.datebar .lbl{color:var(--muted);font-size:13px}
</style>
</head>
<body>
<h1>暗盘资金全景表 · ${esc(meta.dateLabel)}</h1>
<div class="meta">
  股票数：${rows.length}　|　交易日窗口：${esc(meta.dayWindow)}　|　数据生成时间：${esc(meta.generatedAt)}<br>
  行情：腾讯 qt.gtimg.cn　|　暗盘/明盘资金：东方财富 quotederivates darktrade　|　行业/概念：东方财富 F10 所属板块（${meta.hasClist ? '已获取' : '未获取，列为 --'}）
</div>
<div class="stats">
  <div class="stat"><b>${meta.stat.total}</b><span>总股票数</span></div>
  <div class="stat"><b style="color:var(--up)">${meta.stat.pick}</b><span>入选（重点关注）</span></div>
  <div class="stat"><b style="color:#f59e0b">${meta.stat.pickAll}</b><span>入选合计</span></div>
  <div class="stat"><b>${meta.stat.avgAi}</b><span>平均AI评分</span></div>
  <div class="stat"><b>${meta.stat.avgVal}</b><span>平均投资价值</span></div>
</div>
<div class="datebar" id="datebar">
  <span class="lbl">日期</span>
  <button id="prevDay" type="button">‹ 前一日</button>
  <select id="dateSel"></select>
  <button id="nextDay" type="button">后一日 ›</button>
  <span id="dateHint" style="color:var(--muted);font-size:12px"></span>
</div>
<div class="bar">
  <input id="flt" type="text" placeholder="筛选：代码 / 名称 / 行业 / 概念 / 结论…">
  <select id="selConclusion">
    <option value="">全部结论</option>
    <option>入选（重点关注）</option><option>入选</option><option>观察</option><option>不入选</option>
  </select>
  <span style="color:var(--muted);margin-left:8px">点击表头排序，再次点击反转</span>
</div>
<table id="tbl">
<thead><tr>
  <th class="txt">#</th><th class="txt" data-k="code">代码</th><th class="txt" data-k="name">名称</th>
  <th data-k="lastDate">最新交易日</th><th data-k="price">现价</th><th data-k="pct">涨跌幅(%)</th>
  <th data-k="rank">暗盘排名</th><th data-k="anpanToday">今日暗盘</th><th data-k="mingpanToday">今日明盘</th>
  <th data-k="zongTodayRaw">今日总净流入</th><th data-k="an30Raw">30日暗盘累计</th><th data-k="ming30Raw">30日明盘累计</th>
  <th data-k="zong30Raw">30日总累计</th><th data-k="hitRate">命中/总</th><th data-k="floatMv">流通市值(亿)</th>
  <th class="txt" data-k="industry">行业</th><th class="txt" data-k="concepts">概念</th>
  <th data-k="aiScore">AI评分</th><th class="txt" data-k="strongLine">强弱线</th>
  <th class="txt" data-k="fundSignal">资金面信号</th><th class="txt" data-k="comboAdvice">综合建议</th>
  <th data-k="value">投资价值</th><th class="txt" data-k="conclusion">入选结论</th>
</tr></thead>
<tbody>${body}</tbody>
</table>
<div class="foot">
  评分公式（与原页面一致）：AI评分 = 涨跌(45) + 今日暗盘+明盘资金(35) + 行业热度(10) + 流通盘(10)。<br>
  投资价值 = 0.45×AI评分 + 0.25×30日资金分(±2亿→0~100) + 0.15×命中分 + 0.15×趋势分；结论：≥80入选（重点关注）／≥65入选／≥50观察／&lt;50不入选。<br>
  命中天数 = 30个交易日中该股出现在暗盘榜单（暗/明资金非全0）的天数。金额单位：元（格式化为 亿/万）。
</div>
<script>
var DATA = ${JSON.stringify(toClientRows(rows)).replace(/</g, '\\u003c')};
var curDate = '${meta.dateLabel}';
var sortKey = 'value', sortDir = -1;
function money(v){ if(v==null||isNaN(v))return '--'; var s=v>=0?'+':'-',n=Math.abs(v);
  if(n>=1e8)return s+(n/1e8).toFixed(2)+'亿'; if(n>=1e4)return s+(n/1e4).toFixed(2)+'万'; return s+n.toFixed(2); }
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function upCls(v){return v>0?'up':v<0?'down':'flat'}
function render(list){
  var tb = document.getElementById('tbl').tBodies[0];
  tb.innerHTML = list.map(function(r,i){
    return '<tr>'+
    '<td class="num">'+(i+1)+'</td><td class="code">'+esc(r.code)+'</td><td class="name">'+esc(r.name||'--')+'</td>'+
    '<td class="num">'+esc(r.lastDate)+'</td>'+
    '<td class="num">'+(r.price!=null?r.price.toFixed(2):'--')+'</td>'+
    '<td class="num '+upCls(r.pct)+'">'+(r.pct!=null?((r.pct>=0?'+':'')+r.pct.toFixed(2)):'--')+'</td>'+
    '<td class="num">'+(r.rank||'--')+'</td>'+
    '<td class="num '+upCls(r.anpanToday)+'">'+money(r.anpanToday)+'</td>'+
    '<td class="num '+upCls(r.mingpanToday)+'">'+money(r.mingpanToday)+'</td>'+
    '<td class="num '+upCls(r.zongTodayRaw)+'">'+money(r.zongTodayRaw)+'</td>'+
    '<td class="num '+upCls(r.an30Raw)+'">'+money(r.an30Raw)+'</td>'+
    '<td class="num '+upCls(r.ming30Raw)+'">'+money(r.ming30Raw)+'</td>'+
    '<td class="num '+upCls(r.zong30Raw)+'">'+money(r.zong30Raw)+'</td>'+
    '<td class="num">'+r.hitLabel+'</td>'+
    '<td class="num">'+(r.floatMv!=null?r.floatMv.toFixed(2):'--')+'</td>'+
    '<td>'+esc(r.industry||'--')+'</td>'+
    '<td class="concept" title="'+esc(r.concepts)+'">'+esc(r.concepts?(r.concepts.length>30?r.concepts.slice(0,30)+'…':r.concepts):'--')+'</td>'+
    '<td class="num">'+r.aiScore+'</td><td>'+esc(r.strongLine)+'</td><td>'+esc(r.fundSignal)+'</td><td>'+esc(r.comboAdvice)+'</td>'+
    '<td class="num val">'+r.value+'</td>'+
    '<td class="'+(String(r.conclusion).indexOf('入选')===0?'pick':(r.conclusion==='观察'?'watch':'pass'))+'">'+esc(r.conclusion)+'</td></tr>';
  }).join('');
}
function apply(){
  var q = document.getElementById('flt').value.trim().toLowerCase();
  var cc = document.getElementById('selConclusion').value;
  var list = DATA.filter(function(r){
    if(cc && r.conclusion!==cc) return false;
    if(!q) return true;
    return (r.code+' '+r.name+' '+r.industry+' '+r.concepts+' '+r.conclusion+' '+r.strongLine).toLowerCase().indexOf(q)>=0;
  });
  list.sort(function(a,b){
    var x=a[sortKey], y=b[sortKey];
    if(typeof x==='string'||typeof y==='string'){ x=String(x); y=String(y); return x.localeCompare(y)*sortDir; }
    x=Number(x)||0; y=Number(y)||0; return (x-y)*sortDir;
  });
  render(list);
}
document.querySelectorAll('th[data-k]').forEach(function(th){
  th.addEventListener('click', function(){
    var k=th.getAttribute('data-k');
    if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;}
    apply();
  });
});
document.getElementById('flt').addEventListener('input', apply);
document.getElementById('selConclusion').addEventListener('change', apply);
apply();

// ── 日期翻页 ────────────────────────────────────────────────────────────────
// data/index.json 由 scripts/ci/publish_history.js 生成，dates 为降序（最新在前）。
// 切换日期时拉取 data/<date>.json 重绘表格，并同步标题、统计卡与右下角角标。
(function(){
  var bar=document.getElementById('datebar');
  var sel=document.getElementById('dateSel');
  var prev=document.getElementById('prevDay');
  var next=document.getElementById('nextDay');
  var hint=document.getElementById('dateHint');
  if(!bar||!sel) return;
  var DATES=[];

  function idx(d){ return DATES.indexOf(d); }
  function sync(){
    var i=idx(curDate);
    prev.disabled = (i < 0) || (i >= DATES.length-1);  // 前一日 = 更旧 = 索引更大
    next.disabled = (i <= 0);                          // 后一日 = 更新 = 索引更小
    sel.value = curDate;
  }
  function refreshStats(rows){
    var bs=document.querySelectorAll('.stats .stat b');
    if(bs.length<5) return;
    var total=rows.length,pick=0,pickAll=0,sa=0,sv=0;
    rows.forEach(function(r){
      var c=String(r.conclusion||'');
      if(c.indexOf('入选')===0) pickAll++;
      if(c.indexOf('入选（重点关注）')===0) pick++;
      sa+=Number(r.aiScore)||0; sv+=Number(r.value)||0;
    });
    bs[0].textContent=total; bs[1].textContent=pick; bs[2].textContent=pickAll;
    bs[3].textContent=total?Math.round(sa/total):0;
    bs[4].textContent=total?Math.round(sv/total):0;
  }
  function setDateLabel(d){
    var h1=document.querySelector('h1');
    if(h1) h1.textContent='暗盘资金全景表 · '+d;
    var b=document.getElementById('wb-data-date');
    if(b) b.textContent=d;
  }
  function load(d){
    if(!d||d===curDate) return;
    hint.textContent='加载中 '+d+' …';
    fetch('data/'+d+'.json',{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(rows){
      DATA=rows; curDate=d;
      setDateLabel(d); refreshStats(rows);
      hint.textContent='已切换到 '+d+'（'+rows.length+' 只）';
      apply(); sync();
    }).catch(function(e){
      hint.textContent='加载失败：'+d+'（'+e.message+'）';
    });
  }
  fetch('data/index.json',{cache:'no-store'}).then(function(r){
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }).then(function(j){
    DATES=(j&&j.dates)||[];
    if(!DATES.length) return;
    if(idx(curDate)<0) DATES.unshift(curDate);
    sel.innerHTML=DATES.map(function(d){
      return '<option value="'+d+'"'+(d===curDate?' selected':'')+'>'+d+'</option>';
    }).join('');
    bar.classList.add('on'); sync();
    hint.textContent='共 '+DATES.length+' 个交易日可查';
  }).catch(function(){ /* 无历史目录时静默隐藏 */ });

  sel.addEventListener('change', function(){ load(sel.value); });
  prev.addEventListener('click', function(){ var i=idx(curDate); if(i>=0&&i<DATES.length-1) load(DATES[i+1]); });
  next.addEventListener('click', function(){ var i=idx(curDate); if(i>0) load(DATES[i-1]); });
})();
</script>
</body>
</html>`;
}

module.exports = { CSV_COLUMNS, buildCsv, buildHtml, toClientRows };
