'use strict';
// trigger_github.js — 外部触发兜底
//
// 背景：GitHub 自带的 schedule 在本仓库实测完全不触发（一整天 0 次，含 10:00/12:00/14:00/16:00/16:50）。
// 官方文档也说明定时事件在高负载（整点）时可能被直接丢弃且不补跑。
// 因此由本地计划任务在收盘后调用本脚本，主动 workflow_dispatch 一次。
//
// token 来源优先级：环境变量 GH_TOKEN > 项目根目录 .gh-token（首行）
// .gh-token 已在 .gitignore 中，不会被提交。
//
// 用法：
//   node scripts/ci/trigger_github.js            # 触发一次
//   node scripts/ci/trigger_github.js --check    # 只看站点当前版本，不触发

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '../..');
const OWNER = process.env.GH_OWNER || 'lashengcheng';
const REPO = process.env.GH_REPO || 'stock-dark-funds';
const WORKFLOW = process.env.GH_WORKFLOW || 'daily.yml';

function readToken() {
  if (process.env.GH_TOKEN && process.env.GH_TOKEN.trim()) return process.env.GH_TOKEN.trim();
  const p = path.join(ROOT, '.gh-token');
  if (fs.existsSync(p)) {
    const t = fs.readFileSync(p, 'utf8').split(/\r?\n/)[0].trim();
    if (t) return t;
  }
  throw new Error('未找到 token：请设置环境变量 GH_TOKEN，或在项目根目录放 .gh-token 文件');
}

function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method,
      timeout: 30000,
      headers: Object.assign({
        'User-Agent': 'stock-dark-funds-trigger',
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }, payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout 30s')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

(async () => {
  const token = readToken();
  const today = shanghaiToday();

  // --check：只读当前已发布版本
  if (process.argv.includes('--check')) {
    const r = await request('GET', `/repos/${OWNER}/${REPO}/contents/docs/version.txt`, token);
    if (r.status !== 200) { console.error('查询失败 HTTP ' + r.status + ' ' + r.body.slice(0, 200)); process.exit(1); }
    const j = JSON.parse(r.body);
    const ver = Buffer.from(j.content, 'base64').toString('utf8').split(/\r?\n/)[0].trim();
    console.log('今天: ' + today + ' | 站点已发布: ' + ver + ' | ' + (ver === today ? '已是最新' : '需要更新'));
    process.exit(0);
  }

  // 已经发布过就不重复触发
  try {
    const r = await request('GET', `/repos/${OWNER}/${REPO}/contents/docs/version.txt`, token);
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      const ver = Buffer.from(j.content, 'base64').toString('utf8').split(/\r?\n/)[0].trim();
      if (ver === today) {
        console.log('· ' + today + ' 已发布，无需触发');
        process.exit(0);
      }
      console.log('· 站点停留在 ' + ver + '，准备触发 ' + today + ' 的更新');
    }
  } catch (e) {
    console.log('· 读取版本失败（继续触发）：' + e.message);
  }

  const r = await request('POST', `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, token, { ref: 'main' });
  if (r.status === 204) {
    console.log('✅ 已触发 GitHub Actions（' + OWNER + '/' + REPO + ' ' + WORKFLOW + '）');
    process.exit(0);
  }
  console.error('✗ 触发失败 HTTP ' + r.status + '：' + r.body.slice(0, 300));
  process.exit(1);
})().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
