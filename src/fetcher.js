/**
 * 数据获取模块：封装 stock-api，增加校验与本地缓存
 */
const fs = require('fs');
const path = require('path');
const { stocks } = require('stock-api');
const { normalizeFundSplitKlines } = require('./fund-split');

const DATA_DIR = path.join(__dirname, '../data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const LAST_RUN_FILE = path.join(DATA_DIR, 'last-run.json');
const KLINE_ADJUST = 'qfq';
const KLINE_CACHE_VERSION = 'v3';

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function readJson(filePath, defaultValue = []) {
    if (!fs.existsSync(filePath)) return defaultValue;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.warn(`读取缓存失败 ${filePath}: ${e.message}`);
        return defaultValue;
    }
}

function writeJson(filePath, data) {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function validateKlines(klines, label, maxStalenessDays = 7) {
    if (!Array.isArray(klines) || klines.length === 0) {
        throw new Error(`${label} 数据为空`);
    }

    const last = klines[klines.length - 1];
    if (!last || typeof last.close !== 'number' || !last.date) {
        throw new Error(`${label} 数据结构异常: ${JSON.stringify(last)}`);
    }

    const lastDate = new Date(last.date);
    if (Number.isNaN(lastDate.getTime())) {
        throw new Error(`${label} 最新日期格式异常: ${last.date}`);
    }

    const daysAgo = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo > maxStalenessDays) {
        console.warn(`${label} 最新数据距今 ${daysAgo.toFixed(1)} 天，可能已过期`);
    }

    // 检查连续性：不允许中间缺项超过一个合理范围（周K不应跨周，月K不应跨月）
    for (let i = 1; i < klines.length; i += 1) {
        if (typeof klines[i].close !== 'number' || typeof klines[i - 1].close !== 'number') {
            throw new Error(`${label} 第 ${i} 条数据价格缺失`);
        }
    }
}

/**
 * 获取 K 线，带本地缓存合并（若 API 失败可用缓存兜底）
 * @param {string} code
 * @param {'day'|'week'|'month'} period
 * @param {number} count
 * @returns {Promise<Array>}
 */
const API_MAX_COUNT = 2000; // stock-api 返回空数组当 count > 2000

async function fetchKlinesWithFallback(code, period, count, adjust) {
    const batch = await stocks.auto.getKlines(code, { period, count, adjust });
    if (!batch || batch.length === 0) {
        if (adjust !== 'none') {
            console.warn(`${code} ${period}K线 adjust=${adjust} 返回空，回退到 adjust=none`);
            return stocks.auto.getKlines(code, { period, count, adjust: 'none' });
        }
    }
    return batch || [];
}

async function fetchKlinesPaginated(code, period, count, adjust) {
    if (count <= API_MAX_COUNT) {
        return fetchKlinesWithFallback(code, period, count, adjust);
    }
    // 分页：先取最近 API_MAX_COUNT 条，再往前翻
    const all = [];
    let remaining = count;
    let lastDate = null;
    while (remaining > 0) {
        const fetchCount = Math.min(remaining, API_MAX_COUNT);
        const batch = await fetchKlinesWithFallback(code, period, fetchCount, adjust);
        if (!batch || batch.length === 0) break;
        if (lastDate) {
            // 过滤掉已获取的（按日期去重）
            const filtered = batch.filter((k) => new Date(k.date) < new Date(lastDate));
            if (filtered.length === 0) break;
            all.unshift(...filtered);
            lastDate = filtered[0].date;
        } else {
            all.unshift(...batch);
            lastDate = batch[0].date;
        }
        remaining -= batch.length;
        if (batch.length < fetchCount) break; // 没有更多历史数据了
    }
    return all;
}

async function getKlinesWithCache(code, period, count = 200) {
    const cacheKey = `${code}_${period}_${KLINE_ADJUST}_${KLINE_CACHE_VERSION}`;
    const cache = readJson(HISTORY_FILE, {});
    const cachedKlines = cache[cacheKey] || [];

    let freshKlines;
    try {
        freshKlines = await fetchKlinesPaginated(code, period, count, KLINE_ADJUST);
        validateKlines(freshKlines, `${period}K线`);
    } catch (e) {
        console.error(`获取 ${period}K线失败: ${e.message}`);
        if (cachedKlines.length > 0) {
            console.warn(`使用本地缓存 ${period}K线，共 ${cachedKlines.length} 条`);
            return cachedKlines;
        }
        throw e;
    }

    // 合并缓存与最新数据，去重并按日期排序
    const mergedMap = new Map();
    [...cachedKlines, ...freshKlines].forEach((k) => {
        mergedMap.set(k.date, k);
    });
    const merged = Array.from(mergedMap.values()).sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    const normalized = normalizeFundSplitKlines(code, merged);

    cache[cacheKey] = normalized;
    writeJson(HISTORY_FILE, cache);

    return normalized;
}

function loadLastRun() {
    return readJson(LAST_RUN_FILE, {});
}

function saveLastRun(data) {
    writeJson(LAST_RUN_FILE, data);
}

module.exports = {
    getKlinesWithCache,
    loadLastRun,
    saveLastRun,
    validateKlines,
    KLINE_ADJUST,
};
