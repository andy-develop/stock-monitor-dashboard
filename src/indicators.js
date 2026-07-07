/**
 * 技术指标计算模块
 */

/**
 * 计算 KDJ(9,3,3)
 * @param {Array<{open, close, high, low, date}>} klines
 * @returns {{K: number[], D: number[], J: number[]}}
 */
function calculateKDJ(klines) {
    if (!Array.isArray(klines) || klines.length < 9) {
        throw new Error('KDJ 计算需要至少 9 条 K 线');
    }

    const kArray = [];
    const dArray = [];
    const jArray = [];
    let lastK = 50;
    let lastD = 50;

    for (let i = 0; i < klines.length; i += 1) {
        if (i < 8) {
            kArray.push(50);
            dArray.push(50);
            jArray.push(50);
            continue;
        }

        const subset = klines.slice(i - 8, i + 1);
        const low9 = Math.min(...subset.map((k) => k.low));
        const high9 = Math.max(...subset.map((k) => k.high));
        const close = klines[i].close;

        const rsv = high9 === low9 ? 50 : ((close - low9) / (high9 - low9)) * 100;
        const k = (2 / 3) * lastK + (1 / 3) * rsv;
        const d = (2 / 3) * lastD + (1 / 3) * k;
        const j = 3 * k - 2 * d;

        kArray.push(Number(k.toFixed(2)));
        dArray.push(Number(d.toFixed(2)));
        jArray.push(Number(j.toFixed(2)));

        lastK = k;
        lastD = d;
    }

    return { K: kArray, D: dArray, J: jArray };
}

/**
 * 计算简单移动平均 MA
 * @param {Array<{close: number}>} klines
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calculateMA(klines, period) {
    if (!Number.isInteger(period) || period <= 0) {
        throw new Error('MA 周期必须是正整数');
    }

    const ma = [];
    for (let i = 0; i < klines.length; i += 1) {
        if (i < period - 1) {
            ma.push(null);
        } else {
            const sum = klines.slice(i - period + 1, i + 1).reduce((s, k) => s + k.close, 0);
            ma.push(Number((sum / period).toFixed(3)));
        }
    }
    return ma;
}

/**
 * 根据可用数据长度，自动选择可用的月线 MA 周期
 * @param {Array} monthKlines
 * @returns {{period: number|null, ma: (number|null)[]}}
 */
function calculateAdaptiveMonthlyMA(monthKlines) {
    const available = monthKlines.length;
    const candidates = [60, 48, 36, 24, 12];
    const period = candidates.find((p) => available >= p) || null;

    if (!period) {
        return { period: null, ma: [] };
    }

    return { period, ma: calculateMA(monthKlines, period) };
}

/**
 * 计算月线 MA60；数据不足 60 个月时，用上市首年 12 个月收盘价均值
 * 向前填充缺失月份，进行线性外推估算。
 * @param {Array<{close: number, date: string}>} monthKlines
 * @returns {{ma: (number|null)[], estimated: boolean, avgFirstYear: number|null}}
 */
function calculateEstimatedMA60(monthKlines) {
    if (!Array.isArray(monthKlines) || monthKlines.length === 0) {
        return { ma: [], estimated: false, avgFirstYear: null };
    }

    const realLength = monthKlines.length;
    if (realLength >= 60) {
        return { ma: calculateMA(monthKlines, 60), estimated: false, avgFirstYear: null };
    }

    const firstYearCount = Math.min(12, realLength);
    const firstYearKlines = monthKlines.slice(0, firstYearCount);
    const avgFirstYear = Number(
        (firstYearKlines.reduce((sum, k) => sum + k.close, 0) / firstYearCount).toFixed(3)
    );

    const missingCount = 60 - realLength;
    const paddedKlines = [];
    for (let i = 0; i < missingCount; i += 1) {
        paddedKlines.push({ close: avgFirstYear, date: '估算' });
    }
    paddedKlines.push(...monthKlines);

    const maPadded = calculateMA(paddedKlines, 60);
    const latestMA = maPadded[maPadded.length - 1];

    // 返回与真实 K 线对齐的 MA 数组，仅最新月份有值
    const ma = new Array(realLength).fill(null);
    ma[realLength - 1] = latestMA;

    return { ma, estimated: true, avgFirstYear };
}


/**
 * 计算 BOLL(20,2)
 * @param {Array<{close: number}>} klines
 * @returns {{upper: (number|null)[], middle: (number|null)[], lower: (number|null)[]}}
 */
function calculateBOLL(klines, period = 20, multiplier = 2) {
    if (!Number.isInteger(period) || period <= 0) {
        throw new Error('BOLL 周期必须是正整数');
    }

    const ma = calculateMA(klines, period);
    const upper = [];
    const lower = [];

    for (let i = 0; i < klines.length; i += 1) {
        if (i < period - 1) {
            upper.push(null);
            lower.push(null);
            continue;
        }

        const slice = klines.slice(i - period + 1, i + 1).map((k) => k.close);
        const mean = ma[i];
        const variance = slice.reduce((sum, val) => sum + (val - mean) ** 2, 0) / period;
        const std = Math.sqrt(variance);

        upper.push(Number((mean + multiplier * std).toFixed(3)));
        lower.push(Number((mean - multiplier * std).toFixed(3)));
    }

    return { upper, middle: ma, lower };
}

/**
 * 计算 RSI(period)
 * @param {Array<{close: number}>} klines
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calculateRSI(klines, period = 6) {
    if (!Number.isInteger(period) || period <= 0) {
        throw new Error('RSI 周期必须是正整数');
    }
    if (klines.length < period + 1) {
        throw new Error(`RSI 计算需要至少 ${period + 1} 条 K 线`);
    }

    const rsi = [];
    let avgGain = 0;
    let avgLoss = 0;

    // 第一个有效 RSI 基于前 period 个涨跌幅的简单平均
    for (let i = 1; i <= period; i += 1) {
        const change = klines[i].close - klines[i - 1].close;
        avgGain += Math.max(change, 0);
        avgLoss += Math.abs(Math.min(change, 0));
    }
    avgGain /= period;
    avgLoss /= period;

    for (let i = 0; i < klines.length; i += 1) {
        if (i < period) {
            rsi.push(null);
            continue;
        }

        if (i > period) {
            // Wilder 平滑
            const change = klines[i].close - klines[i - 1].close;
            const gain = Math.max(change, 0);
            const loss = Math.abs(Math.min(change, 0));
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }

        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi.push(Number((100 - 100 / (1 + rs)).toFixed(2)));
    }

    return rsi;
}


/**
 * 计算 N 周期最高价（滚动窗口）
 * @param {Array<{high: number}>} klines
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calculatePeriodHigh(klines, period) {
    if (!Number.isInteger(period) || period <= 0) {
        throw new Error('周期必须是正整数');
    }
    const result = [];
    for (let i = 0; i < klines.length; i += 1) {
        if (i < period - 1) {
            result.push(null);
            continue;
        }
        const highs = klines.slice(i - period + 1, i + 1).map((k) => k.high);
        result.push(Number(Math.max(...highs).toFixed(3)));
    }
    return result;
}

/**
 * 计算价格针对 MA 的偏离度
 * @param {Array<{close: number}>} klines
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calculatePriceMADeviation(klines, period) {
    const ma = calculateMA(klines, period);
    return ma.map((m, i) => {
        if (m === null || m === 0) return null;
        return Number(((klines[i].close - m) / m * 100).toFixed(2));
    });
}

/**
 * 计算价格相对 MA 的偏离度比率：收盘价 / MA - 1
 * @param {Array<{close: number}>} klines
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calculatePriceMADeviationRatio(klines, period) {
    const ma = calculateMA(klines, period);
    return ma.map((m, i) => {
        if (m === null || m === 0) return null;
        return Number((klines[i].close / m - 1).toFixed(4));
    });
}

/**
 * 计算两条 MA 之间的偏离度
 * @param {Array<{close: number}>} klines
 * @param {number} shortPeriod
 * @param {number} longPeriod
 * @returns {(number|null)[]}
 */
function calculateMADeviation(klines, shortPeriod, longPeriod) {
    const shortMA = calculateMA(klines, shortPeriod);
    const longMA = calculateMA(klines, longPeriod);
    return longMA.map((long, i) => {
        if (long === null || long === 0) return null;
        return Number(((shortMA[i] - long) / long * 100).toFixed(2));
    });
}

/**
 * 检测动能衰竭：连续 2 个交易日收盘价下跌且最低价走低
 * @param {Array<{close: number, low: number}>} klines
 * @returns {boolean[]}
 */
function detectMomentumExhaustion(klines) {
    const result = [];
    for (let i = 0; i < klines.length; i += 1) {
        if (i < 2) {
            result.push(false);
            continue;
        }
        const today = klines[i];
        const yesterday = klines[i - 1];
        const dayBefore = klines[i - 2];
        const day1Down = yesterday.close < dayBefore.close && yesterday.low < dayBefore.low;
        const day2Down = today.close < yesterday.close && today.low < yesterday.low;
        result.push(day1Down && day2Down);
    }
    return result;
}


/**
 * 计算最新动能衰竭细节：收盘价下跌和最低价下跌的连续天数
 * @param {Array<{close: number, low: number}>} klines
 * @returns {{ closeDays: number, lowDays: number }}
 */
function detectMomentumExhaustionDetails(klines) {
    if (klines.length < 3) {
        return { closeDays: 0, lowDays: 0 };
    }

    let closeDays = 0;
    for (let i = klines.length - 1; i >= 1; i -= 1) {
        if (klines[i].close < klines[i - 1].close) {
            closeDays += 1;
        } else {
            break;
        }
    }

    let lowDays = 0;
    for (let i = klines.length - 1; i >= 1; i -= 1) {
        if (klines[i].low < klines[i - 1].low) {
            lowDays += 1;
        } else {
            break;
        }
    }

    return { closeDays, lowDays };
}

module.exports = {
    calculateKDJ,
    calculateMA,
    calculateAdaptiveMonthlyMA,
    calculateEstimatedMA60,
    calculateBOLL,
    calculateRSI,
    calculatePeriodHigh,
    calculatePriceMADeviation,
    calculatePriceMADeviationRatio,
    calculateMADeviation,
    detectMomentumExhaustion,
    detectMomentumExhaustionDetails,
};
