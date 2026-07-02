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
 */
function evaluateEtfSellSignals({ weekKlines, boll, rsi }) {
    const latestIndex = weekKlines.length - 1;
    const prevIndex = weekKlines.length - 2;

    const latestClose = weekKlines[latestIndex].close;
    const prevClose = weekKlines[prevIndex].close;
    const latestUpperBoll = boll.upper[latestIndex];
    const latestRSI = rsi[latestIndex];
    const prevRSI = rsi[prevIndex];
    const twoWeeksAgoRSI = rsi[weekKlines.length - 3];

    const highEnough = latestClose > latestUpperBoll || prevClose > latestUpperBoll;
    const prevRSIHigh = prevRSI > 70;
    const twoWeeksAgoHigh = twoWeeksAgoRSI !== null && twoWeeksAgoRSI > 70;
    const rsiTurnedDown = latestRSI < 70 && (prevRSIHigh || twoWeeksAgoHigh);
    const triggered = highEnough && rsiTurnedDown;

    let type;
    let title;
    let reason;
    if (triggered) {
        type = 'danger';
        title = '⚠️ 卖出信号：冲高且动能不足';
        reason = `当前或上周收盘价已站上 BOLL(20,2) 上轨（${latestUpperBoll}），同时 RSI(6) 从超买区拐头向下，当前为 ${latestRSI}，建议关注卖出机会。`;
    } else {
        type = 'success';
        title = '✅ 暂无卖出信号';
        reason = `当前收盘价 ${latestClose} 位于 BOLL(20,2) 上轨（${latestUpperBoll}）下方，RSI(6) 为 ${latestRSI}，未同时满足“冲高”与“RSI 拐头”条件。`;
    }

    return {
        triggered,
        alert: {
            type,
            title,
            chartKeys: ['boll', 'rsi'],
            metrics: [
                { label: '最新周收盘价', value: latestClose },
                { label: 'BOLL 上轨', value: latestUpperBoll },
                { label: '最新周 RSI(6)', value: latestRSI },
                { label: '上周周 RSI(6)', value: prevRSI },
            ],
            reason,
        },
        bollData: { upper: boll.upper, middle: boll.middle, lower: boll.lower },
        rsiData: rsi,
    };
}

/**
 * 格力电器：买入机会（三阶段底部监控）
 */
function evaluateGreeBuyOpportunities({ latestClose }) {
    const alerts = [];

    // 历史铁底 < 30：大红
    const ironBottom = latestClose < 30;
    alerts.push({
        type: ironBottom ? 'danger' : 'success',
        title: ironBottom ? '🔴 历史铁底' : '✅ 未触及历史铁底',
        metrics: [{ label: '当前股价', value: latestClose }, { label: '历史铁底阈值', value: 30 }],
        reason: ironBottom
            ? `当前股价 ${latestClose} 已跌破历史铁底 30 元，处于极端低估区域。`
            : `当前股价 ${latestClose} 高于历史铁底 30 元。`,
    });

    // 悲观情绪底 < 32：浅红（但未跌破 30 时）
    const pessimisticBottom = latestClose < 32;
    alerts.push({
        type: pessimisticBottom ? 'warning' : 'success',
        title: pessimisticBottom ? '🟠 悲观情绪底' : '✅ 未触及悲观情绪底',
        metrics: [{ label: '当前股价', value: latestClose }, { label: '悲观情绪底阈值', value: 32 }],
        reason: pessimisticBottom
            ? `当前股价 ${latestClose} 已跌破悲观情绪底 32 元，市场情绪偏悲观。`
            : `当前股价 ${latestClose} 高于悲观情绪底 32 元。`,
    });

    // 价值底 < 36：黄
    const valueBottom = latestClose < 36;
    alerts.push({
        type: valueBottom ? 'yellow' : 'success',
        title: valueBottom ? '🟡 价值底' : '✅ 未触及价值底',
        metrics: [{ label: '当前股价', value: latestClose }, { label: '价值底阈值', value: 36 }],
        reason: valueBottom
            ? `当前股价 ${latestClose} 已跌破价值底 36 元，低于管理层认可的价值中枢 38.61 元。`
            : `当前股价 ${latestClose} 高于价值底 36 元，管理层认可的价值中枢为 38.61 元。`,
    });

    return alerts;
}

/**
 * 格力电器：卖出机会（三个信号）
 */
function evaluateGreeSellSignals({ dayKlines, ma5, ma20 }) {
    const latestIndex = dayKlines.length - 1;
    const latestClose = dayKlines[latestIndex].close;

    const periodHigh10 = calculatePeriodHigh(dayKlines, 10);
    const latestHigh10 = periodHigh10[latestIndex];

    const priceDev20 = calculatePriceMADeviation(dayKlines, 20);
    const maDev5_20 = calculateMADeviation(dayKlines, 5, 20);
    const momentumExhaustion = detectMomentumExhaustion(dayKlines);

    const latestPriceDev20 = priceDev20[latestIndex];
    const latestMADev5_20 = maDev5_20[latestIndex];
    const latestMomentumExhaustion = momentumExhaustion[latestIndex];

    // 信号 1：近10日最高点回撤 4%
    const signal1 = latestHigh10 !== null && latestClose < latestHigh10 * (1 - 0.04);

    // 信号 2：均线偏离度
    const signal2 = (latestMADev5_20 !== null && latestMADev5_20 > 7)
        || (latestPriceDev20 !== null && latestPriceDev20 > 10);

    // 信号 3：动能衰竭
    const signal3 = latestMomentumExhaustion;

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
                { label: '近10日高点回撤 > 4%', triggered: signal1, value: latestHigh10 ? `回撤 ${((1 - latestClose / latestHigh10) * 100).toFixed(2)}%` : '-' },
                { label: '均线偏离度超限', triggered: signal2, value: `MA5/MA20=${latestMADev5_20}%, 价格/MA20=${latestPriceDev20}%` },
                { label: '连续2日下跌且低点走低', triggered: signal3, value: latestMomentumExhaustion ? '是' : '否' },
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

async function buildGreeWindow() {
    const code = 'SZ000651';
    const name = '格力电器';
    const indexName = '消费类股票';

    console.log(`开始获取 ${name} (${code}) 数据...`);
    const dayKlines = await getKlinesWithCache(code, 'day', 300);
    console.log(`  日线数据：${dayKlines.length} 条`);

    if (dayKlines.length < 30) throw new Error('日线数据不足，无法计算均线');

    const ma5 = calculateMA(dayKlines, 5);
    const ma20 = calculateMA(dayKlines, 20);

    const buyAlerts = evaluateGreeBuyOpportunities({ latestClose: dayKlines[dayKlines.length - 1].close });
    const sellSignalResult = evaluateGreeSellSignals({ dayKlines, ma5, ma20 });

    return {
        id: 'gree',
        stockName: name,
        stockCode: code,
        indexName,
        updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        buySectionTitle: '买入机会',
        sellSectionTitle: '卖出机会',
        buyAlerts,
        sellAlert: sellSignalResult.alert,
        dayData: sellSignalResult.dayData,
    };
}

async function main() {
    try {
        const etfWindow = await buildEtfWindow();
        const greeWindow = await buildGreeWindow();

        const dashboardData = [etfWindow, greeWindow];

        renderHtml(dashboardData, DIST_DIR);
        copyEcharts();

        saveLastRun({
            updateTime: etfWindow.updateTime,
            windows: [
                { id: etfWindow.id, stockCode: etfWindow.stockCode, alerts: etfWindow.buyAlerts, sellAlert: etfWindow.sellAlert },
                { id: greeWindow.id, stockCode: greeWindow.stockCode, buyAlerts: greeWindow.buyAlerts, sellAlert: greeWindow.sellAlert },
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
