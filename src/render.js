/**
 * 渲染模块：生成静态看板 HTML
 */
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'index.html');

/**
 * 读取模板，注入多窗口数据，写入 dist
 * @param {Array} dashboardData
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
    renderHtml,
};
