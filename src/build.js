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

function evaluateAlerts({ latestJ, latestMonthClose, latestMA, maPeriod }) {
    const alerts = [];

    if (latestJ < 1) {
        alerts.push({
            type: 'danger',
            title: '⚠️ 周K线 KDJ 预警',
            reason: `当前周K线计算的 J 值为 **${latestJ}**，已跌破安全阈值 1。`,
        });
    }

    if (latestMA !== null && latestMA !== undefined && latestMonthClose < latestMA) {
        alerts.push({
            type: 'danger',
            title: `⚠️ 月K线 MA${maPeriod} 破位预警`,
            reason: `当前月K线收盘价 **${latestMonthClose}** 已跌破 ${maPeriod}月均线 (**${latestMA}**)。`,
        });
    }

    if (alerts.length === 0) {
        alerts.push({
            type: 'success',
            title: '✅ 运行状态正常',
            reason: '各项监控指标均在安全范围内，未触发预警。',
        });
    }

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

        const alerts = evaluateAlerts({
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
