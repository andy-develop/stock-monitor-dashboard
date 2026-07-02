/**
 * 主构建脚本：数据抓取 -> 指标计算 -> 页面构建
 */
const fs = require('fs');
const path = require('path');
const { getKlinesWithCache, saveLastRun } = require('./fetcher');
const { calculateKDJ, calculateAdaptiveMonthlyMA } = require('./indicators');
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

        const dashboardData = buildDashboardData({
            stockCode: STOCK_CODE,
            stockName: STOCK_NAME,
            indexName: INDEX_NAME,
            weekKlines,
            monthKlines,
            kdj: kdjResult,
            maResult,
            alerts,
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
        });

        console.log('✅ 构建完成，dist/index.html 生成成功');
    } catch (error) {
        console.error('❌ 构建失败:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
