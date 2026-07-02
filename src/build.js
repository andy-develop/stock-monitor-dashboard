/**
 * 主构建脚本：数据抓取 -> 指标计算 -> 页面构建
 */
const fs = require('fs');
const path = require('path');
const { getKlinesWithCache, saveLastRun } = require('./fetcher');
const { calculateKDJ, calculateAdaptiveMonthlyMA, calculateBOLL, calculateRSI } = require('./indicators');
const { buildDashboardData, renderHtml } = require('./render');

// 配置
const STOCK_CODE = 'SH512890'; // 红利低波ETF华泰柏瑞，跟踪 H30269 指数
const STOCK_NAME = '红利低波ETF华泰柏瑞';
const INDEX_NAME = '中证红利低波动指数 (H30269)';

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

function evaluateAlerts({ latestWeekClose, latestJ, latestMonthClose, latestMA, maPeriod }) {
    const alerts = [];

    // 周K线 KDJ：始终列出，触发则 danger，否则 success
    const weekTriggered = latestJ < 1;
    alerts.push({
        type: weekTriggered ? 'danger' : 'success',
        title: weekTriggered ? '⚠️ 周K线 KDJ 预警' : '✅ 周K线 KDJ 正常',
        chartKey: 'week',
        metrics: [
            { label: '最新周收盘价', value: latestWeekClose },
            { label: '最新周 J 值', value: latestJ },
        ],
        reason: weekTriggered
            ? `当前周K线计算的 J 值为 ${latestJ}，已跌破安全阈值 1。`
            : `当前周K线计算的 J 值为 ${latestJ}，未跌破安全阈值 1。`,
    });

    // 月K线 MA：始终列出（数据可用时），触发则 danger，否则 success
    const maAvailable = latestMA !== null && latestMA !== undefined;
    const monthTriggered = maAvailable && latestMonthClose < latestMA;
    alerts.push({
        type: monthTriggered ? 'danger' : 'success',
        title: monthTriggered ? `⚠️ 月K线 MA${maPeriod} 破位预警` : `✅ 月K线 MA${maPeriod} 正常`,
        chartKey: 'month',
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


function evaluateSellSignals({ weekKlines, boll, rsi }) {
    const latestIndex = weekKlines.length - 1;
    const prevIndex = weekKlines.length - 2;

    const latestClose = weekKlines[latestIndex].close;
    const prevClose = weekKlines[prevIndex].close;
    const latestUpperBoll = boll.upper[latestIndex];
    const latestRSI = rsi[latestIndex];
    const prevRSI = rsi[prevIndex];
    const twoWeeksAgoRSI = rsi[weekKlines.length - 3];

    // 1. 冲得高：当前或上周收盘价在布林上轨上方
    const highEnough = latestClose > latestUpperBoll || prevClose > latestUpperBoll;

    // 2. 冲不动了：RSI(6) 曾经 > 70，且当前 RSI 拐头跌破 70
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

    const alert = {
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
    };

    return {
        triggered,
        alert,
        bollData: { upper: boll.upper, middle: boll.middle, lower: boll.lower },
        rsiData: rsi,
    };
}

async function main() {
    try {
        console.log(`开始获取 ${STOCK_NAME} (${STOCK_CODE}) 数据...`);

        const weekKlines = await getKlinesWithCache(STOCK_CODE, 'week', 200);
        const monthKlines = await getKlinesWithCache(STOCK_CODE, 'month', 100);

        console.log(`周线数据：${weekKlines.length} 条`);
        console.log(`月线数据：${monthKlines.length} 条`);

        if (weekKlines.length < 9) {
            throw new Error('周线数据不足，无法计算 KDJ');
        }

        const kdjResult = calculateKDJ(weekKlines);
        const maResult = calculateAdaptiveMonthlyMA(monthKlines);
        const bollResult = calculateBOLL(weekKlines, 20, 2);
        const rsiResult = calculateRSI(weekKlines, 6);

        const latestJ = kdjResult.J[kdjResult.J.length - 1];
        const latestMonth = monthKlines[monthKlines.length - 1];
        const latestMA = maResult.ma[maResult.ma.length - 1];
        const latestWeek = weekKlines[weekKlines.length - 1];

        const alerts = evaluateAlerts({
            latestWeekClose: latestWeek.close,
            latestJ,
            latestMonthClose: latestMonth.close,
            latestMA,
            maPeriod: maResult.period,
        });

        const sellSignalResult = evaluateSellSignals({
            weekKlines,
            boll: bollResult,
            rsi: rsiResult,
        });

        const dashboardData = buildDashboardData({
            stockCode: STOCK_CODE,
            stockName: STOCK_NAME,
            indexName: INDEX_NAME,
            weekKlines,
            monthKlines,
            kdj: kdjResult,
            maResult,
            alerts,
            sellSignalResult,
        });

        renderHtml(dashboardData, DIST_DIR);
        copyEcharts();

        saveLastRun({
            updateTime: dashboardData.updateTime,
            stockCode: STOCK_CODE,
            weekCount: weekKlines.length,
            monthCount: monthKlines.length,
            maPeriod: maResult.period,
            latestJ,
            latestMonthClose: latestMonth.close,
            latestMA,
            alerts,
            sellSignal: {
                triggered: sellSignalResult.triggered,
                alert: sellSignalResult.alert,
            },
        });

        console.log('✅ 构建完成，dist/index.html 生成成功');
    } catch (error) {
        console.error('❌ 构建失败:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
