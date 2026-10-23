'use strict';
// probe.js — CI 连通性探测
// 目的：确认 GitHub Actions 运行器能否访问三个上游数据源。
// 判定标准：收到任何 HTTP 响应（含 4xx/5xx）即视为"网络可达"；只有超时/连接错误才算不可达。
// 结果写入 probe.json，供 status.js 汇总；本脚本自身永不失败（探测失败不应阻断后续步骤）。

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

/** 取 Asia/Shanghai 的 YYYYMMDD（CI 运行器默认 UTC，必须显式换算） */
function ymdShanghai() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  return p.replace(/-/g, '');
}

const TARGETS = [
  {
    name: '腾讯行情 qt.gtimg.cn',
    url: 'https://qt.gtimg.cn/q=sh000001,sz000001',
    validate: (t) => /v_(sh|sz)000001=/.test(t)
  },
  {
    name: '东财暗盘 quotederivates',
    url: 'https://quotederivates.eastmoney.com/datacenter/darktrade?version=100&date=' + ymdShanghai() +
      '&NumPerPage=5&sortflag=6&desc=1&market=1&label=' + encodeURIComponent('个股') + '&StartPage=1',
    validate: (t) => { try { return JSON.parse(t).errid === 0; } catch (e) { return false; } }
  },
  {
    name: '东财F10 emweb',
    url: 'https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=SZ000001',
    validate: (t) => t.length > 0
  },
  {
    name: '腾讯日K web.ifzq',
    url: 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=sh000001,day,,,5,',
    validate: (t) => t.length > 0
  }
];

function probeOne(target) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get(target.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': 'https://data.eastmoney.com/'
      },
      timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          name: target.name,
          status: res.statusCode,
          ms: Date.now() - started,
          reachable: true,
          valid: target.validate(body),
          sample: body.slice(0, 120).replace(/\s+/g, ' ')
        });
      });
      res.on('error', (e) => resolve({
        name: target.name, status: null, ms: Date.now() - started,
        reachable: false, valid: false, error: e.message
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout 15s')));
    req.on('error', (e) => resolve({
      name: target.name, status: null, ms: Date.now() - started,
      reachable: false, valid: false, error: e.message
    }));
  });
}

(async () => {
  const results = [];
  for (const t of TARGETS) {
    const r = await probeOne(t);
    results.push(r);
    const mark = r.valid ? 'OK  ' : (r.reachable ? 'WARN' : 'FAIL');
    console.log('[' + mark + '] ' + r.name +
      '  status=' + r.status + '  ' + r.ms + 'ms' +
      (r.error ? '  ' + r.error : '') +
      (r.sample ? '\n        ' + r.sample.slice(0, 100) : ''));
  }

  const payload = {
    checkedAt: new Date().toISOString(),
    runner: process.env.RUNNER_OS || 'unknown',
    allReachable: results.every((r) => r.reachable),
    allValid: results.every((r) => r.valid),
    results
  };
  fs.writeFileSync(path.join(ROOT, 'probe.json'), JSON.stringify(payload, null, 2));

  if (!payload.allReachable) {
    console.log('\n⚠ 有数据源不可达。若为 GitHub 运行器被墙/限流，需要改用"本地抓取 + 推送"方案。');
  }
  process.exit(0); // 探测只报告，不阻断
})();
