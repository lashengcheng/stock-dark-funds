// daily_job.js — Windows 任务计划的每日入口（也可手动随时运行）
// 流程：
//   1) 已过 15:30 → 跑当日 fetch_all（未到点则跳过，等定时或下次补）
//   2) 跑 backfill 补漏（电脑没开机/上次失败漏掉的交易日，含首次启用时的历史建仓）
// 日志: out/logs/job_日期.log（当日追加）；调度器输出另存 out/logs/scheduler.log
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'out', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const now = new Date();
const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
  String(now.getDate()).padStart(2, '0');
const logPath = path.join(LOG_DIR, 'job_' + stamp + '.log');
const fd = fs.openSync(logPath, 'a');
function log(msg) {
  fs.writeSync(fd, '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg + '\n');
}

function run(script, scriptArgs) {
  log('▶ node ' + script + ' ' + scriptArgs.join(' '));
  const r = spawnSync(process.execPath, [path.join(ROOT, script)].concat(scriptArgs), {
    stdio: ['ignore', fd, fd],   // 子进程输出直接写入当日日志
    cwd: ROOT
  });
  if (r.status === 0) log('✔ 完成 (' + script + ')');
  else log('✗ 失败 (' + script + ') 退出码 ' + r.status + (r.error ? ' ' + r.error.message : ''));
  return r.status === 0;
}

log('========== 每日任务开始 ==========');
const afterClose = now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 30);
let ok = true;
if (afterClose) {
  ok = run('scripts/fetch_all.js', []) && ok;
} else {
  log('未到 15:30，跳过当日快照（当日 17:00 定时或下次开机补）');
}
ok = run('scripts/backfill.js', ['--lookback', '30']) && ok;
log('========== 每日任务结束 ' + (ok ? '（全部成功）' : '（有失败步骤，见上）') + ' ==========');
fs.closeSync(fd);
process.exit(ok ? 0 : 1); // 失败时任务计划显示非成功，便于发现
