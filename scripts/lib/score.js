// score.js — 评分层：忠实移植 HTML 页面（玄学24节气暗盘资金）的打分逻辑
// 打分规则（源自 inner.html fetchAnalysis，总分100）：
//   1) 涨跌得分 45分：+10%满 → -10%空；0%得22.5分
//   2) 暗盘+明盘总资金 35分：净流入+2亿满 → 净流出-2亿空；0得17.5分（用"今日总净流入"）
//   3) 行业热度 10分：行业涨≥3%满 / 跌≤-3%空（无行业数据得5分）
//   4) 流通盘 10分：≤30亿满10 / ≤80亿8 / ≤200亿6 / ≤500亿4 / >500亿2
'use strict';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 涨跌得分（0~45） */
function scorePct(pct) {
  if (pct >= 10) return 45;
  if (pct <= -10) return 0;
  return 22.5 + (pct / 10) * 22.5;
}

/** 资金得分（0~35），zong 为今日暗盘+明盘总净流入（元） */
function scoreFlow(zong) {
  const z = clamp(Number(zong) || 0, -2e8, 2e8);
  return 17.5 + (z / 2e8) * 17.5;
}

/** 行业热度得分（0~10），industryZdf 为行业板块当日涨跌幅（可能为 null） */
function scoreIndustry(industryZdf) {
  if (industryZdf == null || isNaN(Number(industryZdf))) return 5;
  const iz = clamp(Number(industryZdf), -3, 3);
  return 5 + (iz / 3) * 5;
}

/** 流通盘得分（2~10），floatMv 单位亿 */
function scoreSize(floatMv) {
  if (!floatMv || floatMv <= 0) return 5;
  if (floatMv <= 30) return 10;
  if (floatMv <= 80) return 8;
  if (floatMv <= 200) return 6;
  if (floatMv <= 500) return 4;
  return 2;
}

/** 综合计算：输入行情+资金+行业，输出评分与标签（与页面 renderAnalysis/renderSignalOverrides 一致） */
function evaluate({ pct, zongToday, industryZdf, floatMv }) {
  const totalScore = Math.round(clamp(
    scorePct(pct) + scoreFlow(zongToday) + scoreIndustry(industryZdf) + scoreSize(floatMv),
    0, 100));

  let strongLine;
  if (totalScore >= 60) strongLine = '大牛线上';
  else if (totalScore >= 40) strongLine = '小牛整理';
  else strongLine = '熊股震荡';

  // 资金面信号/综合建议阈值与页面 renderSignalOverrides 一致（±500万）
  const z = Number(zongToday) || 0;
  let fundSignal, comboAdvice;
  if (z >= 5000000) { fundSignal = '强势流入'; comboAdvice = '积极买入'; }
  else if (z >= 0) { fundSignal = '小幅流入'; comboAdvice = '持有观望'; }
  else if (z >= -5000000) { fundSignal = '小幅流出'; comboAdvice = '谨慎减仓'; }
  else { fundSignal = '大幅流出'; comboAdvice = '建议减仓'; }

  return { totalScore, strongLine, fundSignal, comboAdvice };
}

/**
 * 投资价值评分（0~100）与入选结论 —— 本批处理新增公式（原 CSV 工具公式未知，此处明确定义）：
 *   投资价值 = 0.45×AI评分 + 0.25×30日资金分 + 0.15×命中分 + 0.15×趋势分
 *     30日资金分: 30日总累计 ±2亿 → 0~100
 *     命中分:     命中天数/总天数 × 100
 *     趋势分:     当日涨跌幅 ±10% → 0~100
 *   入选结论: ≥80 入选（重点关注） / ≥65 入选 / ≥50 观察 / <50 不入选
 */
function evaluateValue({ totalScore, zong30, hitDays, totalDays, pct }) {
  const fund30Score = clamp(((Number(zong30) || 0) + 2e8) / 4e8, 0, 1) * 100;
  const hitScore = totalDays > 0 ? (hitDays / totalDays) * 100 : 0;
  const trendScore = clamp((pct + 10) / 20, 0, 1) * 100;
  const value = Math.round(
    0.45 * totalScore + 0.25 * fund30Score + 0.15 * hitScore + 0.15 * trendScore);

  let conclusion;
  if (value >= 80) conclusion = '入选（重点关注）';
  else if (value >= 65) conclusion = '入选';
  else if (value >= 50) conclusion = '观察';
  else conclusion = '不入选';

  return { value, conclusion };
}

/** 金额格式化（与页面 formatDarkMoney 一致）：+2.19亿 / -3826.80万 */
function formatMoney(v) {
  if (v == null || isNaN(v)) return '--';
  const s = v >= 0 ? '+' : '-';
  const n = Math.abs(v);
  if (n >= 1e8) return s + (n / 1e8).toFixed(2) + '亿';
  if (n >= 1e4) return s + (n / 1e4).toFixed(2) + '万';
  return s + n.toFixed(2);
}

module.exports = { evaluate, evaluateValue, formatMoney, clamp };
