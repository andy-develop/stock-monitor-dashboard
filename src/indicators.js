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

module.exports = {
    calculateKDJ,
    calculateMA,
    calculateAdaptiveMonthlyMA,
    calculateBOLL,
    calculateRSI,
};
