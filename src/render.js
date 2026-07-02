/**
 * 渲染模块：生成静态看板 HTML
 */
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'index.html');

/**
 * 生成 dashboard 数据对象
 * @param {Object} params
 */
function buildDashboardData({
    stockCode,
    stockName,
    indexName,
    weekKlines,
    monthKlines,
    kdj,
    maResult,
    alerts,
    sellSignalResult,
}) {
    const displayLimit = 100;
    const latestWeek = weekKlines[weekKlines.length - 1];
    const latestMonth = monthKlines[monthKlines.length - 1];
    const latestJ = kdj.J[kdj.J.length - 1];

    return {
        stockName,
        stockCode,
        indexName,
        updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        alerts,
        weekData: {
            dates: weekKlines.slice(-displayLimit).map((k) => k.date),
            candlestick: weekKlines.slice(-displayLimit).map((k) => [k.open, k.close, k.low, k.high]),
            k: kdj.K.slice(-displayLimit),
            d: kdj.D.slice(-displayLimit),
            j: kdj.J.slice(-displayLimit),
            latestClose: latestWeek.close,
            latestJ,
        },
        monthData: {
            dates: monthKlines.slice(-displayLimit).map((k) => k.date),
            closes: monthKlines.slice(-displayLimit).map((k) => k.close),
            ma: maResult.ma.slice(-displayLimit),
            maPeriod: maResult.period,
            latestClose: latestMonth.close,
            latestMA: maResult.ma[maResult.ma.length - 1],
        },
        sellAlert: sellSignalResult.alert,
        sellSignalTriggered: sellSignalResult.triggered,
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

/**
 * 读取模板，注入数据，写入 dist
 * @param {Object} dashboardData
 * @param {string} distDir
 */
function renderHtml(dashboardData, distDir) {
    let htmlContent = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    htmlContent = htmlContent.replace(
        '// __DATA_PLACEHOLDER__',
        `window.DASHBOARD_DATA = ${JSON.stringify(dashboardData)};`
    );

    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    fs.writeFileSync(path.join(distDir, 'index.html'), htmlContent);
}

module.exports = {
    buildDashboardData,
    renderHtml,
};
