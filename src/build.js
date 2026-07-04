/**
 * 主构建脚本：数据抓取 -> 指标计算 -> 页面构建
 */
const fs = require('fs');
const path = require('path');
const { getKlinesWithCache, saveLastRun } = require('./fetcher');
const {
    calculateKDJ,
    calculateAdaptiveMonthlyMA,
    calculateBOLL,
    calculateRSI,
    calculateMA,
    calculatePeriodHigh,
    calculatePriceMADeviation,
    calculateMADeviation,
    detectMomentumExhaustion,
    detectMomentumExhaustionDetails,
} = require('./indicators');
const { renderHtml } = require('./render');

const DIST_DIR = path.join(__dirname, '../dist');
const ECHARTS_SRC = path.join(__dirname, '../node_modules/echarts/dist/echarts.min.js');
const ECHARTS_DEST = path.join(DIST_DIR, 'echarts.min.js');

function copyEcharts() {
    if (!fs.existsSync(ECHARTS_SRC)) {
        throw new Error(`ECharts 未找到，请先运行 npm install: ${ECHARTS_SRC}`);
    }
    fs.copyFileSync(ECHARTS_SRC, ECHARTS_DEST);
    console.log(`已复制 ECharts 到 ${path.relative(__dirname, ECHARTS_DEST)}`);
}

/**
 * ETF：买入信号评估
 */
function evaluateEtfBuyAlerts({ latestWeekClose, latestJ, latestMonthClose, latestMA, maPeriod }) {
    const alerts = [];

    const weekTriggered = latestJ < 1;
    alerts.push({
        type: weekTriggered ? 'danger' : 'success',
        title: weekTriggered ? '⚠️ 周K线 KDJ 预警' : '✅ 周K线 KDJ 正常',
        chartKeys: ['week'],
        metrics: [
            { label: '最新周收盘价', value: latestWeekClose },
            { label: '最新周 J 值', value: latestJ },
        ],
        reason: weekTriggered
            ? `当前周K线计算的 J 值为 ${latestJ}，已跌破安全阈值 1。`
            : `当前周K线计算的 J 值为 ${latestJ}，未跌破安全阈值 1。`,
    });

    const maAvailable = latestMA !== null && latestMA !== undefined;
    const monthTriggered = maAvailable && latestMonthClose < latestMA;
    alerts.push({
        type: monthTriggered ? 'danger' : 'success',
        title: monthTriggered ? `⚠️ 月K线 MA${maPeriod} 破位预警` : `✅ 月K线 MA${maPeriod} 正常`,
        chartKeys: ['month'],
        metrics: [
            { label: '最新月收盘价', value: latestMonthClose },
            { label: maPeriod ? `MA${maPeriod}` : 'MA', value: maAvailable ? latestMA : '数据不足' },
        ],
        reason: monthTriggered
            ? `当前月K线收盘价 ${latestMonthClose} 已跌破 ${maPeriod}月均线 (${latestMA})。`
            : maAvailable
                ? `当前月K线收盘价 ${latestMonthClose} 位于 ${maPeriod}月均线 (${latestMA}) 之上。`
                : '月线数据不足，无法计算 MA。',
    });

    return alerts;
}

/**
 * ETF：卖出信号评估（BOLL + RSI 同时满足）
 * BOLL 条件：最近 5 周内周线收盘价曾突破 BOLL(20,2) 上轨
 * RSI 条件：最近 10 周内 RSI(6) 曾经超过 70，且当前 RSI(6) < 70
 *
 * 可选附加条件（传入 dayKlines / dayMA60 时启用）：
 * 日 K 线最近 2 日收盘价低于 MA60，且此前连续 18 日收盘价高于 MA60
 */
function evaluateEtfSellSignals({ weekKlines, boll, rsi, dayKlines = null, dayMA60 = null }) {
    const latestIndex = weekKlines.length - 1;

    const latestClose = weekKlines[latestIndex].close;
    const latestUpperBoll = boll.upper[latestIndex];
    const latestRSI = rsi[latestIndex];

    // 最近 5 周内是否有收盘价突破 BOLL 上轨
    let highEnough = false;
    let weeksSinceBreak = null;
    for (let i = 0; i < 5; i++) {
        const idx = weekKlines.length - 5 + i;
        if (idx < 0) continue;
        if (weekKlines[idx].close > boll.upper[idx]) {
            highEnough = true;
            weeksSinceBreak = 5 - i - 1; // 0=当前周, 1=前1周...
            break;
        }
    }

    // 最近 10 周（含当前）的 RSI 中是否有超过 70 的记录
    const recentRSI = rsi.slice(-10);
    const maxRecentRSI = recentRSI.reduce((max, val) => (val !== null && val > max ? val : max), -Infinity);
    const rsiWasHigh = maxRecentRSI > 70;
    const rsiTurnedDown = latestRSI !== null && latestRSI < 70;
    const weeklyTriggered = highEnough && rsiWasHigh && rsiTurnedDown;

    // 日线 MA60 破位条件
    let dailyTriggered = false;
    let dailyConditionText = '未启用';
    let latestDayClose = null;
    let latestDayMA60 = null;
    if (dayKlines && dayMA60 && dayKlines.length >= 20) {
        latestDayClose = dayKlines[dayKlines.length - 1].close;
        latestDayMA60 = dayMA60[dayMA60.length - 1];

        const last20Closes = dayKlines.slice(-20).map((k) => k.close);
        const last20MA60 = dayMA60.slice(-20);
        const last2Below = last20Closes[18] < last20MA60[18] && last20Closes[19] < last20MA60[19];
        const prior18Above = last20Closes.slice(0, 18).every((c, i) => c > last20MA60[i]);
        dailyTriggered = last2Below && prior18Above;
        dailyConditionText = dailyTriggered ? '是' : '否';
    }

    const triggered = weeklyTriggered || dailyTriggered;

    let type;
    let title;
    let reason;
    if (triggered) {
        type = 'danger';
        title = '⚠️ 卖出信号：冲高或日线破位';
        if (weeklyTriggered && dailyTriggered) {
            const breakText = weeksSinceBreak === 0 ? '本周' : `${weeksSinceBreak} 周前`;
            reason = `${breakText}收盘价曾突破 BOLL(20,2) 上轨，且 RSI(6) 从超买区回落至 ${latestRSI}；同时日线最近 2 日收盘价低于 MA60，而此前 18 日均高于 MA60。两个维度均触发卖出信号，建议高度关注。`;
        } else if (weeklyTriggered) {
            const breakText = weeksSinceBreak === 0 ? '本周' : `${weeksSinceBreak} 周前`;
            reason = `${breakText}收盘价曾突破 BOLL(20,2) 上轨，且最近 10 周内 RSI(6) 曾达到 ${maxRecentRSI}（超过 70），当前回落至 ${latestRSI}，建议关注卖出机会。`;
        } else {
            reason = `日线出现破位信号：最近 2 日收盘价低于 MA60（最新收盘 ${latestDayClose} / MA60 ${latestDayMA60}），而此前连续 18 日收盘价均高于 MA60，建议关注卖出机会。`;
        }
    } else {
        type = 'success';
        title = '✅ 暂无卖出信号';
        reason = `周线：最近 5 周内收盘价${highEnough ? '' : '未'}突破 BOLL(20,2) 上轨，最近 10 周 RSI(6) 最高为 ${maxRecentRSI === -Infinity ? '-' : maxRecentRSI}，当前为 ${latestRSI}；${dayKlines ? `日线 MA60 破位条件：${dailyConditionText}。` : ''}未触发卖出条件。`;
    }

    const metrics = [
        { label: '最新周收盘价', value: latestClose },
        { label: 'BOLL 上轨', value: latestUpperBoll },
        { label: '近5周是否突破上轨', value: highEnough ? (weeksSinceBreak === 0 ? '是（本周）' : `是（${weeksSinceBreak} 周前）`) : '否' },
        { label: '最新周 RSI(6)', value: latestRSI },
        { label: '近10周 RSI(6) 最高', value: maxRecentRSI === -Infinity ? '-' : maxRecentRSI },
    ];
    if (dayKlines) {
        metrics.push({ label: '日线 MA60 破位', value: dailyConditionText });
        metrics.push({ label: '最新日收盘 / MA60', value: latestDayClose !== null && latestDayMA60 !== null ? `${latestDayClose} / ${latestDayMA60}` : '数据不足' });
    }

    return {
        triggered,
        alert: {
            type,
            title,
            chartKeys: ['boll', 'rsi'],
            metrics,
            reason,
        },
        bollData: { upper: boll.upper, middle: boll.middle, lower: boll.lower },
        rsiData: rsi,
    };
}

/**
 * 沪深300：买入信号评估（月线 BOLL 下轨 + KDJ J<0 + 股价 < MA20）
 */
function evaluateHs300BuySignals({ monthKlines, boll, kdj, ma20 }) {
    const latestIndex = monthKlines.length - 1;
    const latestMonth = monthKlines[latestIndex];
    const latestClose = latestMonth.close;
    const latestLow = latestMonth.low;
    const latestJ = kdj.J[latestIndex];
    const latestLower = boll.lower[latestIndex];
    const latestMA20 = ma20[latestIndex];

    const conditionBoll = latestClose <= latestLower || latestLow <= latestLower;
    const conditionJ = latestJ < 0;
    const conditionMA = latestMA20 !== null && latestClose < latestMA20;
    const triggered = conditionBoll && conditionJ && conditionMA;

    let title;
    let reason;
    if (triggered) {
        title = '⚠️ 买入信号：月线超跌三条件共振';
        reason = `当前月线收盘价 ${latestClose} 已触及 BOLL(20,2) 下轨（${latestLower}），月 KDJ 的 J 值为 ${latestJ}（负值），且收盘价低于 MA20（${latestMA20}），三条件同时满足，建议关注买入机会。`;
    } else {
        title = '✅ 暂无买入信号';
        reason = `当前月线收盘价 ${latestClose}，BOLL(20,2) 下轨 ${latestLower}，月 KDJ 的 J 值 ${latestJ}，MA20 ${latestMA20}，未同时满足“月线触及布林下轨 + J<0 + 收盘价低于 MA20”。`;
    }

    return {
        triggered,
        alert: {
            type: triggered ? 'danger' : 'success',
            title,
            chartKeys: ['monthBoll', 'monthKdj', 'month'],
            metrics: [
                { label: '最新月收盘价', value: latestClose },
                { label: 'BOLL(20,2) 下轨', value: latestLower },
                { label: '月 KDJ 的 J 值', value: latestJ },
                { label: 'MA20', value: latestMA20 !== null ? latestMA20 : '数据不足' },
            ],
            reason,
            signalDetails: [
                { label: '月线触及布林下轨', triggered: conditionBoll, value: `收盘 ${latestClose} / 下轨 ${latestLower}` },
                { label: '月 KDJ 的 J 值 < 0', triggered: conditionJ, value: `J = ${latestJ}` },
                { label: '收盘价 < MA20', triggered: conditionMA, value: `收盘 ${latestClose} / MA20 ${latestMA20}` },
            ],
        },
        bollData: { upper: boll.upper, middle: boll.middle, lower: boll.lower },
        kdjData: { k: kdj.K, d: kdj.D, j: kdj.J },
        ma20,
    };
}

/**
 * 创业板：买入信号评估（月线 MA60 下方超跌 + 月线跌破 BOLL 下轨）
 */
function evaluateChiNextBuySignals({ monthKlines, ma60, boll }) {
    const latestIndex = monthKlines.length - 1;
    const latestMonth = monthKlines[latestIndex];
    const latestClose = latestMonth.close;
    const latestMA60 = ma60[latestIndex];
    const latestLower = boll.lower[latestIndex];

    const maAvailable = latestMA60 !== null && latestMA60 !== 0;
    const deviation = maAvailable ? ((latestMA60 - latestClose) / latestMA60) * 100 : null;
    const conditionMA = maAvailable && latestClose < latestMA60 * 0.96;
    const conditionBoll = latestClose < latestLower;
    const triggered = conditionMA && conditionBoll;

    let title;
    let reason;
    if (triggered) {
        title = '⚠️ 买入信号：月线超跌双条件共振';
        reason = `当前月线收盘价 ${latestClose} 低于 MA60（${latestMA60}）且跌幅达 ${deviation.toFixed(2)}%，同时跌破 BOLL(20,2) 下轨（${latestLower}），双条件同时满足，建议关注买入机会。`;
    } else {
        title = '✅ 暂无买入信号';
        const deviationText = deviation !== null
            ? (deviation > 0 ? `低于 MA60 ${deviation.toFixed(2)}%` : `高于 MA60 ${Math.abs(deviation).toFixed(2)}%`)
            : '数据不足';
        reason = `当前月线收盘价 ${latestClose}，MA60 ${maAvailable ? latestMA60 : '数据不足'}（${deviationText}），BOLL(20,2) 下轨 ${latestLower}，未同时满足“低于 MA60 超 4%”且“跌破布林下轨”。`;
    }

    return {
        triggered,
        alert: {
            type: triggered ? 'danger' : 'success',
            title,
            chartKeys: ['month', 'monthBoll'],
            metrics: [
                { label: '最新月收盘价', value: latestClose },
                { label: 'MA60', value: maAvailable ? latestMA60 : '数据不足' },
                { label: 'MA60 偏离', value: deviation !== null ? `${deviation.toFixed(2)}%` : '数据不足' },
                { label: 'BOLL(20,2) 下轨', value: latestLower },
            ],
            reason,
            signalDetails: [
                { label: '收盘价 < MA60 且跌幅 > 4%', triggered: conditionMA, value: `收盘 ${latestClose} / MA60 ${latestMA60}${deviation !== null ? ` (${deviation.toFixed(2)}%)` : ''}` },
                { label: '收盘价跌破 BOLL 下轨', triggered: conditionBoll, value: `收盘 ${latestClose} / 下轨 ${latestLower}` },
            ],
        },
        bollData: { upper: boll.upper, middle: boll.middle, lower: boll.lower },
        ma60,
    };
}

/**
 * 月线 MA60 + 周线 BOLL 下轨买入信号评估（月K线低于MA60 + 周K线下穿布林下轨）
 */
function evaluateMonthMA60WeekBollBuySignals({ stockName, monthKlines, ma60, weekKlines, weekBoll }) {
    const latestMonthIndex = monthKlines.length - 1;
    const latestMonthClose = monthKlines[latestMonthIndex].close;
    const latestMA60 = ma60[latestMonthIndex];

    const latestWeekIndex = weekKlines.length - 1;
    const latestWeekClose = weekKlines[latestWeekIndex].close;
    const latestWeekLower = weekBoll.lower[latestWeekIndex];

    const maAvailable = latestMA60 !== null && latestMA60 !== 0;
    const conditionMA = maAvailable && latestMonthClose < latestMA60;
    const conditionBoll = latestWeekClose < latestWeekLower;
    const triggered = conditionMA && conditionBoll;

    let title;
    let reason;
    if (triggered) {
        title = '⚠️ 买入信号：月K低于MA60且周K下穿布林下轨';
        reason = `当前${stockName}月线收盘价 ${latestMonthClose} 低于 MA60（${latestMA60}），且周线收盘价 ${latestWeekClose} 跌破 BOLL(20,2) 下轨（${latestWeekLower}），双条件同时满足，建议关注买入机会。`;
    } else {
        title = '✅ 暂无买入信号';
        const maText = maAvailable
            ? (latestMonthClose < latestMA60 ? '低于 MA60' : `高于 MA60 ${((latestMonthClose - latestMA60) / latestMA60 * 100).toFixed(2)}%`)
            : '数据不足';
        reason = `当前${stockName}月线收盘价 ${latestMonthClose}，MA60 ${maAvailable ? latestMA60 : '数据不足'}（${maText}）；周线收盘价 ${latestWeekClose}，BOLL(20,2) 下轨 ${latestWeekLower}。未同时满足“月K线低于MA60”且“周K线下穿布林下轨”。`;
    }

    return {
        triggered,
        alert: {
            type: triggered ? 'danger' : 'success',
            title,
            chartKeys: ['month', 'boll'],
            metrics: [
                { label: '最新月收盘价', value: latestMonthClose },
                { label: 'MA60', value: maAvailable ? latestMA60 : '数据不足' },
                { label: '最新周收盘价', value: latestWeekClose },
                { label: '周 BOLL(20,2) 下轨', value: latestWeekLower },
            ],
            reason,
            signalDetails: [
                { label: '月K线收盘价 < MA60', triggered: conditionMA, value: `收盘 ${latestMonthClose} / MA60 ${latestMA60}` },
                { label: '周K线收盘价 < BOLL 下轨', triggered: conditionBoll, value: `收盘 ${latestWeekClose} / 下轨 ${latestWeekLower}` },
            ],
        },
        ma60,
        weekBollData: { upper: weekBoll.upper, middle: weekBoll.middle, lower: weekBoll.lower },
    };
}

/**
 * 消费类股票：买入机会（三阶段底部监控）
 */
function evaluateConsumerBuyOpportunities({ latestClose, thresholds, valueHint }) {
    const { value: valueThreshold, pessimistic: pessimisticThreshold, iron: ironThreshold } = thresholds;
    const alerts = [];

    // 历史铁底：大红
    const ironBottom = latestClose < ironThreshold;
    alerts.push({
        type: ironBottom ? 'danger' : 'success',
        title: ironBottom ? '🔴 历史铁底' : '✅ 未触及历史铁底',
        metrics: [{ label: '当前股价', value: latestClose }, { label: '历史铁底阈值', value: ironThreshold }],
        reason: ironBottom
            ? `当前股价 ${latestClose} 已跌破历史铁底 ${ironThreshold} 元，处于极端低估区域。`
            : `当前股价 ${latestClose} 高于历史铁底 ${ironThreshold} 元。`,
    });

    // 悲观情绪底：浅红
    const pessimisticBottom = latestClose < pessimisticThreshold;
    alerts.push({
        type: pessimisticBottom ? 'warning' : 'success',
        title: pessimisticBottom ? '🟠 悲观情绪底' : '✅ 未触及悲观情绪底',
        metrics: [{ label: '当前股价', value: latestClose }, { label: '悲观情绪底阈值', value: pessimisticThreshold }],
        reason: pessimisticBottom
            ? `当前股价 ${latestClose} 已跌破悲观情绪底 ${pessimisticThreshold} 元，市场情绪偏悲观。`
            : `当前股价 ${latestClose} 高于悲观情绪底 ${pessimisticThreshold} 元。`,
    });

    // 价值底：黄
    const valueBottom = latestClose < valueThreshold;
    alerts.push({
        type: valueBottom ? 'yellow' : 'success',
        title: valueBottom ? '🟡 价值底' : '✅ 未触及价值底',
        metrics: [{ label: '当前股价', value: latestClose }, { label: '价值底阈值', value: valueThreshold }],
        reason: valueBottom
            ? `当前股价 ${latestClose} 已跌破价值底 ${valueThreshold} 元${valueHint ? `，${valueHint}` : ''}。`
            : `当前股价 ${latestClose} 高于价值底 ${valueThreshold} 元${valueHint ? `，${valueHint}` : ''}。`,
    });

    return alerts;
}

/**
 * 格力电器：卖出机会（三个信号）
 */
function evaluateConsumerSellSignals({ dayKlines, ma5, ma20 }) {
    const latestIndex = dayKlines.length - 1;
    const latestClose = dayKlines[latestIndex].close;

    const periodHigh10 = calculatePeriodHigh(dayKlines, 10);
    const latestHigh10 = periodHigh10[latestIndex];

    const priceDev20 = calculatePriceMADeviation(dayKlines, 20);
    const maDev5_20 = calculateMADeviation(dayKlines, 5, 20);
    const momentumExhaustion = detectMomentumExhaustion(dayKlines);
    const momentumDetails = detectMomentumExhaustionDetails(dayKlines);

    const latestPriceDev20 = priceDev20[latestIndex];
    const latestMADev5_20 = maDev5_20[latestIndex];
    const latestMomentumExhaustion = momentumExhaustion[latestIndex];

    // 信号 1：近10日最高点回撤 4%
    const signal1 = latestHigh10 !== null && latestClose < latestHigh10 * (1 - 0.04);

    // 信号 2：均线偏离度
    const signal2 = (latestMADev5_20 !== null && latestMADev5_20 > 7)
        || (latestPriceDev20 !== null && latestPriceDev20 > 10);

    // 信号 3：动能衰竭（收盘价或最低价连续 2 日走低）
    const signal3 = momentumDetails.closeDays >= 2 || momentumDetails.lowDays >= 2;

    const triggeredCount = [signal1, signal2, signal3].filter(Boolean).length;

    let type;
    let title;
    let reason;
    if (triggeredCount >= 3) {
        type = 'danger';
        title = '🔴 卖出机会：三信号共振';
        reason = `当前 ${triggeredCount} 个卖出信号同时满足：近10日高点回撤超 4%、均线偏离度超限、动能衰竭，建议高度关注。`;
    } else if (triggeredCount === 2) {
        type = 'warning';
        title = '🟠 卖出机会：两信号触发';
        reason = `当前有 ${triggeredCount} 个卖出信号满足，需警惕股价调整风险。`;
    } else if (triggeredCount === 1) {
        type = 'yellow';
        title = '🟡 卖出机会：一信号触发';
        reason = '当前有 1 个卖出信号满足，建议持续观察。';
    } else {
        type = 'success';
        title = '✅ 暂无卖出机会';
        reason = '当前 3 个卖出信号均未触发，股价暂未出现明显卖出风险。';
    }

    return {
        triggeredCount,
        alert: {
            type,
            title,
            chartKeys: ['day'],
            metrics: [
                { label: '当前股价', value: latestClose },
                { label: '近10日最高价', value: latestHigh10 },
                { label: '5/20日均线偏离度', value: `${latestMADev5_20}%` },
                { label: '股价/20日均线偏离度', value: `${latestPriceDev20}%` },
            ],
            reason,
            signalDetails: [
                { label: '近10日高点回撤 > 4%', triggered: signal1, value: latestHigh10 ? `当前 ${((1 - latestClose / latestHigh10) * 100).toFixed(2)}%` : '-' },
                { label: 'MA5/MA20 > 7% 或 价格/MA20 > 10%', triggered: signal2, value: `MA5/MA20 ${latestMADev5_20}% / 价格/MA20 ${latestPriceDev20}%` },
                { label: 'Close_t < Close_{t-1} 或 Low_t < Low_{t-1}', triggered: signal3, value: `收盘价下跌 ${momentumDetails.closeDays} 天 / 最低价走低 ${momentumDetails.lowDays} 天` },
            ],
        },
        dayData: {
            dates: dayKlines.slice(-100).map((k) => k.date),
            candlestick: dayKlines.slice(-100).map((k) => [k.open, k.close, k.low, k.high]),
            ma5: ma5.slice(-100),
            ma20: ma20.slice(-100),
            periodHigh10: periodHigh10.slice(-100),
            priceDeviation20: priceDev20.slice(-100),
            maDeviation5_20: maDev5_20.slice(-100),
            momentumExhaustion: momentumExhaustion.slice(-100),
        },
    };
}

async function buildEtfWindow() {
    const code = 'SH512890';
    const name = '红利低波ETF华泰柏瑞';
    const indexName = '中证红利低波动指数 (H30269)';

    console.log(`开始获取 ${name} (${code}) 数据...`);
    const weekKlines = await getKlinesWithCache(code, 'week', 200);
    const monthKlines = await getKlinesWithCache(code, 'month', 100);
    console.log(`  周线数据：${weekKlines.length} 条`);
    console.log(`  月线数据：${monthKlines.length} 条`);

    if (weekKlines.length < 9) throw new Error('周线数据不足，无法计算 KDJ');

    const kdjResult = calculateKDJ(weekKlines);
    const maResult = calculateAdaptiveMonthlyMA(monthKlines);
    const bollResult = calculateBOLL(weekKlines, 20, 2);
    const rsiResult = calculateRSI(weekKlines, 6);

    const latestJ = kdjResult.J[kdjResult.J.length - 1];
    const latestMonth = monthKlines[monthKlines.length - 1];
    const latestMA = maResult.ma[maResult.ma.length - 1];
    const latestWeek = weekKlines[weekKlines.length - 1];

    const buyAlerts = evaluateEtfBuyAlerts({
        latestWeekClose: latestWeek.close,
        latestJ,
        latestMonthClose: latestMonth.close,
        latestMA,
        maPeriod: maResult.period,
    });

    const sellSignalResult = evaluateEtfSellSignals({
        weekKlines,
        boll: bollResult,
        rsi: rsiResult,
    });

    const displayLimit = 100;

    return {
        id: 'etf',
        stockName: name,
        stockCode: code,
        indexName,
        updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        buySectionTitle: '买入信号',
        sellSectionTitle: '卖出信号',
        buyAlerts,
        sellAlert: sellSignalResult.alert,
        weekData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            k: kdjResult.K.slice(-displayLimit),
            d: kdjResult.D.slice(-displayLimit),
            j: kdjResult.J.slice(-displayLimit),
        },
        monthData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            closes: monthKlines.slice(-displayLimit).map((k) => k.close),
            ma: maResult.ma.slice(-displayLimit),
            maPeriod: maResult.period,
        },
        bollData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            upper: sellSignalResult.bollData.upper.slice(-displayLimit),
            middle: sellSignalResult.bollData.middle.slice(-displayLimit),
            lower: sellSignalResult.bollData.lower.slice(-displayLimit),
        },
        rsiData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            values: sellSignalResult.rsiData.slice(-displayLimit),
        },
    };
}

async function buildHs300Window() {
    const code = 'SH510300';
    const name = '沪深300ETF华泰柏瑞';
    const indexName = '沪深300指数 (CSI 300)';

    console.log(`开始获取 ${name} (${code}) 数据...`);
    const weekKlines = await getKlinesWithCache(code, 'week', 200);
    const monthKlines = await getKlinesWithCache(code, 'month', 100);
    const dayKlines = await getKlinesWithCache(code, 'day', 300);
    console.log(`  周线数据：${weekKlines.length} 条`);
    console.log(`  月线数据：${monthKlines.length} 条`);
    console.log(`  日线数据：${dayKlines.length} 条`);

    if (weekKlines.length < 9) throw new Error('周线数据不足，无法计算 KDJ');
    if (monthKlines.length < 20) throw new Error('月线数据不足，无法计算 MA20 / BOLL(20,2)');

    // 卖出指标：周线 BOLL + RSI，日线 MA60 破位
    const bollWeek = calculateBOLL(weekKlines, 20, 2);
    const rsiWeek = calculateRSI(weekKlines, 6);
    const ma60Day = calculateMA(dayKlines, 60);

    // 买入指标：月线 BOLL + KDJ + MA20
    const bollMonth = calculateBOLL(monthKlines, 20, 2);
    const kdjMonth = calculateKDJ(monthKlines);
    const ma20Month = calculateMA(monthKlines, 20);

    const buySignalResult = evaluateHs300BuySignals({
        monthKlines,
        boll: bollMonth,
        kdj: kdjMonth,
        ma20: ma20Month,
    });

    const sellSignalResult = evaluateEtfSellSignals({
        weekKlines,
        boll: bollWeek,
        rsi: rsiWeek,
        dayKlines,
        dayMA60: ma60Day,
    });

    const displayLimit = 100;

    return {
        id: 'hs300',
        stockName: name,
        stockCode: code,
        indexName,
        updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        buySectionTitle: '买入信号',
        sellSectionTitle: '卖出信号',
        buyAlerts: [buySignalResult.alert],
        sellAlert: sellSignalResult.alert,
        weekData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
        },
        monthData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            closes: monthKlines.slice(-displayLimit).map((k) => k.close),
            ma: ma20Month.slice(-displayLimit),
            maPeriod: 20,
        },
        bollData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            upper: sellSignalResult.bollData.upper.slice(-displayLimit),
            middle: sellSignalResult.bollData.middle.slice(-displayLimit),
            lower: sellSignalResult.bollData.lower.slice(-displayLimit),
        },
        rsiData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            values: sellSignalResult.rsiData.slice(-displayLimit),
        },
        monthBollData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: monthKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            upper: buySignalResult.bollData.upper.slice(-displayLimit),
            middle: buySignalResult.bollData.middle.slice(-displayLimit),
            lower: buySignalResult.bollData.lower.slice(-displayLimit),
        },
        monthKdjData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: monthKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            k: buySignalResult.kdjData.k.slice(-displayLimit),
            d: buySignalResult.kdjData.d.slice(-displayLimit),
            j: buySignalResult.kdjData.j.slice(-displayLimit),
        },
    };
}

async function buildChiNextWindow() {
    const code = 'SZ159915';
    const name = '创业板ETF易方达';
    const indexName = '创业板指 (ChiNext)';

    console.log(`开始获取 ${name} (${code}) 数据...`);
    const weekKlines = await getKlinesWithCache(code, 'week', 200);
    const monthKlines = await getKlinesWithCache(code, 'month', 100);
    const dayKlines = await getKlinesWithCache(code, 'day', 300);
    console.log(`  周线数据：${weekKlines.length} 条`);
    console.log(`  月线数据：${monthKlines.length} 条`);
    console.log(`  日线数据：${dayKlines.length} 条`);

    if (weekKlines.length < 9) throw new Error('周线数据不足，无法计算 KDJ');
    if (monthKlines.length < 20) throw new Error('月线数据不足，无法计算 MA60 / BOLL(20,2)');

    // 卖出指标：周线 BOLL + RSI，日线 MA60 破位
    const bollWeek = calculateBOLL(weekKlines, 20, 2);
    const rsiWeek = calculateRSI(weekKlines, 6);
    const ma60Day = calculateMA(dayKlines, 60);

    // 买入指标：月线 MA60 超跌 + BOLL 下轨
    const bollMonth = calculateBOLL(monthKlines, 20, 2);
    const ma60Month = calculateMA(monthKlines, 60);

    const buySignalResult = evaluateChiNextBuySignals({
        monthKlines,
        ma60: ma60Month,
        boll: bollMonth,
    });

    const sellSignalResult = evaluateEtfSellSignals({
        weekKlines,
        boll: bollWeek,
        rsi: rsiWeek,
        dayKlines,
        dayMA60: ma60Day,
    });

    const displayLimit = 100;

    return {
        id: 'chinext',
        stockName: name,
        stockCode: code,
        indexName,
        updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        buySectionTitle: '买入信号',
        sellSectionTitle: '卖出信号',
        buyAlerts: [buySignalResult.alert],
        sellAlert: sellSignalResult.alert,
        weekData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
        },
        monthData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            closes: monthKlines.slice(-displayLimit).map((k) => k.close),
            ma: ma60Month.slice(-displayLimit),
            maPeriod: 60,
        },
        bollData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            upper: sellSignalResult.bollData.upper.slice(-displayLimit),
            middle: sellSignalResult.bollData.middle.slice(-displayLimit),
            lower: sellSignalResult.bollData.lower.slice(-displayLimit),
        },
        rsiData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            values: sellSignalResult.rsiData.slice(-displayLimit),
        },
        monthBollData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: monthKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            upper: buySignalResult.bollData.upper.slice(-displayLimit),
            middle: buySignalResult.bollData.middle.slice(-displayLimit),
            lower: buySignalResult.bollData.lower.slice(-displayLimit),
        },
    };
}

async function buildConsumerWindow({ id, code, name, thresholds, valueHint, hint }) {
    const indexName = '消费类股票';

    console.log(`开始获取 ${name} (${code}) 数据...`);
    const dayKlines = await getKlinesWithCache(code, 'day', 300);
    console.log(`  日线数据：${dayKlines.length} 条`);

    if (dayKlines.length < 30) throw new Error('日线数据不足，无法计算均线');

    const ma5 = calculateMA(dayKlines, 5);
    const ma20 = calculateMA(dayKlines, 20);

    const buyAlerts = evaluateConsumerBuyOpportunities({
        latestClose: dayKlines[dayKlines.length - 1].close,
        thresholds,
        valueHint,
    });
    const sellSignalResult = evaluateConsumerSellSignals({ dayKlines, ma5, ma20 });

    return {
        id,
        stockName: name,
        stockCode: code,
        indexName,
        hint,
        updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        buySectionTitle: '买入机会',
        sellSectionTitle: '卖出机会',
        buyAlerts,
        sellAlert: sellSignalResult.alert,
        dayData: sellSignalResult.dayData,
    };
}

async function buildGreeWindow() {
    return buildConsumerWindow({
        id: 'gree',
        code: 'SZ000651',
        name: '格力电器',
        thresholds: { value: 36, pessimistic: 32, iron: 30 },
        valueHint: '管理层认可的价值中枢为 38.61 元',
        hint: '提示：2026.06.17 管理层认可价值中枢是 38.61 元',
    });
}

async function buildShuanghuiWindow() {
    return buildConsumerWindow({
        id: 'shuanghui',
        code: 'SZ000895',
        name: '双汇发展',
        thresholds: { value: 23, pessimistic: 22, iron: 20 },
    });
}

async function buildDeejWindow() {
    return buildConsumerWindow({
        id: 'deej',
        code: 'SZ000423',
        name: '东阿阿胶',
        thresholds: { value: 45, pessimistic: 42, iron: 40 },
    });
}

async function buildSanquanWindow() {
    return buildConsumerWindow({
        id: 'sanquan',
        code: 'SZ002216',
        name: '三全食品',
        thresholds: { value: 11, pessimistic: 10, iron: 8 },
    });
}

async function buildShenhuaWindow() {
    const code = 'SH601088';
    const name = '中国神华';
    const indexName = '煤炭 · 高股息红利';

    console.log(`开始获取 ${name} (${code}) 数据...`);
    const weekKlines = await getKlinesWithCache(code, 'week', 200);
    const monthKlines = await getKlinesWithCache(code, 'month', 100);
    console.log(`  周线数据：${weekKlines.length} 条`);
    console.log(`  月线数据：${monthKlines.length} 条`);

    if (weekKlines.length < 20) throw new Error('周线数据不足，无法计算 BOLL(20,2)');
    if (monthKlines.length < 60) throw new Error('月线数据不足，无法计算 MA60');

    const weekBoll = calculateBOLL(weekKlines, 20, 2);
    const ma60Month = calculateMA(monthKlines, 60);

    const buySignalResult = evaluateMonthMA60WeekBollBuySignals({
        stockName: name,
        monthKlines,
        ma60: ma60Month,
        weekKlines,
        weekBoll,
    });

    const displayLimit = 100;

    return {
        id: 'shenhua',
        stockName: name,
        stockCode: code,
        indexName,
        updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        buySectionTitle: '买入信号',
        sellSectionTitle: '卖出信号',
        buyAlerts: [buySignalResult.alert],
        sellAlert: null,
        weekData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
        },
        monthData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            closes: monthKlines.slice(-displayLimit).map((k) => k.close),
            ma: ma60Month.slice(-displayLimit),
            maPeriod: 60,
        },
        bollData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            upper: buySignalResult.weekBollData.upper.slice(-displayLimit),
            middle: buySignalResult.weekBollData.middle.slice(-displayLimit),
            lower: buySignalResult.weekBollData.lower.slice(-displayLimit),
        },
    };
}


async function buildThsWindow() {
    const code = 'SZ300033';
    const name = '同花顺';
    const indexName = '金融科技 · 证券信息服务';
    const hint = '提示：买入信号仅在实控人仍为易峥时有效';

    console.log(`开始获取 ${name} (${code}) 数据...`);
    const weekKlines = await getKlinesWithCache(code, 'week', 200);
    const monthKlines = await getKlinesWithCache(code, 'month', 100);
    console.log(`  周线数据：${weekKlines.length} 条`);
    console.log(`  月线数据：${monthKlines.length} 条`);

    if (weekKlines.length < 20) throw new Error('周线数据不足，无法计算 BOLL(20,2)');
    if (monthKlines.length < 60) throw new Error('月线数据不足，无法计算 MA60');

    const weekBoll = calculateBOLL(weekKlines, 20, 2);
    const ma60Month = calculateMA(monthKlines, 60);

    const buySignalResult = evaluateMonthMA60WeekBollBuySignals({
        stockName: name,
        monthKlines,
        ma60: ma60Month,
        weekKlines,
        weekBoll,
    });

    const displayLimit = 100;

    return {
        id: 'ths',
        stockName: name,
        stockCode: code,
        indexName,
        hint,
        updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        buySectionTitle: '买入信号',
        sellSectionTitle: '卖出信号',
        buyAlerts: [buySignalResult.alert],
        sellAlert: null,
        weekData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
        },
        monthData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            closes: monthKlines.slice(-displayLimit).map((k) => k.close),
            ma: ma60Month.slice(-displayLimit),
            maPeriod: 60,
        },
        bollData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            upper: buySignalResult.weekBollData.upper.slice(-displayLimit),
            middle: buySignalResult.weekBollData.middle.slice(-displayLimit),
            lower: buySignalResult.weekBollData.lower.slice(-displayLimit),
        },
    };
}

async function buildChinaMobileWindow() {
    const code = 'SH600941';
    const name = '中国移动';
    const indexName = '通信运营 · 高股息红利';

    console.log(`开始获取 ${name} (${code}) 数据...`);
    const weekKlines = await getKlinesWithCache(code, 'week', 200);
    const monthKlines = await getKlinesWithCache(code, 'month', 100);
    console.log(`  周线数据：${weekKlines.length} 条`);
    console.log(`  月线数据：${monthKlines.length} 条`);

    if (weekKlines.length < 20) throw new Error('周线数据不足，无法计算 BOLL(20,2)');

    const displayLimit = 100;
    const weekBoll = calculateBOLL(weekKlines, 20, 2);

    // 月线不足 60 条时无法计算 MA60，买入信号暂不显示
    if (monthKlines.length < 60) {
        return {
            id: 'chinamobile',
            stockName: name,
            stockCode: code,
            indexName,
            updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            buySectionTitle: '买入信号',
            sellSectionTitle: '卖出信号',
            buyAlerts: [{
                type: 'yellow',
                title: '⏸️ 买入信号待启用',
                chartKeys: [],
                metrics: [
                    { label: '当前月线数据条数', value: monthKlines.length },
                    { label: '所需月线数据条数', value: 60 },
                ],
                reason: `中国移动上市时间较短，当前月线数据仅 ${monthKlines.length} 条，不足 60 条，暂无法计算 MA60。当数据满足 60 个月后将自动显示买入信号。`,
            }],
            sellAlert: null,
            weekData: {
                dates: weekKlines.slice(-displayLimit).map((k) => k.date),
                candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            },
            bollData: {
                dates: weekKlines.slice(-displayLimit).map((k) => k.date),
                candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
                upper: weekBoll.upper.slice(-displayLimit),
                middle: weekBoll.middle.slice(-displayLimit),
                lower: weekBoll.lower.slice(-displayLimit),
            },
        };
    }

    const ma60Month = calculateMA(monthKlines, 60);

    const buySignalResult = evaluateMonthMA60WeekBollBuySignals({
        stockName: name,
        monthKlines,
        ma60: ma60Month,
        weekKlines,
        weekBoll,
    });

    return {
        id: 'chinamobile',
        stockName: name,
        stockCode: code,
        indexName,
        updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        buySectionTitle: '买入信号',
        sellSectionTitle: '卖出信号',
        buyAlerts: [buySignalResult.alert],
        sellAlert: null,
        weekData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
        },
        monthData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            closes: monthKlines.slice(-displayLimit).map((k) => k.close),
            ma: ma60Month.slice(-displayLimit),
            maPeriod: 60,
        },
        bollData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            upper: buySignalResult.weekBollData.upper.slice(-displayLimit),
            middle: buySignalResult.weekBollData.middle.slice(-displayLimit),
            lower: buySignalResult.weekBollData.lower.slice(-displayLimit),
        },
    };
}
async function main() {
    try {
        const etfWindow = await buildEtfWindow();
        const hs300Window = await buildHs300Window();
        const chinextWindow = await buildChiNextWindow();
        const greeWindow = await buildGreeWindow();
        const shuanghuiWindow = await buildShuanghuiWindow();
        const deejWindow = await buildDeejWindow();
        const sanquanWindow = await buildSanquanWindow();
        const shenhuaWindow = await buildShenhuaWindow();
        const thsWindow = await buildThsWindow();
        const chinamobileWindow = await buildChinaMobileWindow();

        const dashboardData = [etfWindow, hs300Window, chinextWindow, greeWindow, shuanghuiWindow, deejWindow, sanquanWindow, shenhuaWindow, thsWindow, chinamobileWindow];

        renderHtml(dashboardData, DIST_DIR);
        copyEcharts();

        saveLastRun({
            updateTime: etfWindow.updateTime,
            windows: [
                { id: etfWindow.id, stockCode: etfWindow.stockCode, alerts: etfWindow.buyAlerts, sellAlert: etfWindow.sellAlert },
                { id: hs300Window.id, stockCode: hs300Window.stockCode, alerts: hs300Window.buyAlerts, sellAlert: hs300Window.sellAlert },
                { id: chinextWindow.id, stockCode: chinextWindow.stockCode, alerts: chinextWindow.buyAlerts, sellAlert: chinextWindow.sellAlert },
                { id: greeWindow.id, stockCode: greeWindow.stockCode, buyAlerts: greeWindow.buyAlerts, sellAlert: greeWindow.sellAlert },
                { id: shuanghuiWindow.id, stockCode: shuanghuiWindow.stockCode, buyAlerts: shuanghuiWindow.buyAlerts, sellAlert: shuanghuiWindow.sellAlert },
                { id: deejWindow.id, stockCode: deejWindow.stockCode, buyAlerts: deejWindow.buyAlerts, sellAlert: deejWindow.sellAlert },
                { id: sanquanWindow.id, stockCode: sanquanWindow.stockCode, buyAlerts: sanquanWindow.buyAlerts, sellAlert: sanquanWindow.sellAlert },
                { id: shenhuaWindow.id, stockCode: shenhuaWindow.stockCode, buyAlerts: shenhuaWindow.buyAlerts, sellAlert: shenhuaWindow.sellAlert },
                { id: thsWindow.id, stockCode: thsWindow.stockCode, buyAlerts: thsWindow.buyAlerts, sellAlert: thsWindow.sellAlert },
                { id: chinamobileWindow.id, stockCode: chinamobileWindow.stockCode, buyAlerts: chinamobileWindow.buyAlerts, sellAlert: chinamobileWindow.sellAlert },
            ],
        });

        console.log('✅ 构建完成，dist/index.html 生成成功');
    } catch (error) {
        console.error('❌ 构建失败:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
