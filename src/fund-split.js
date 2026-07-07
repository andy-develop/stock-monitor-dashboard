/**
 * 基金份额拆分归一化
 * 用于修正数据源在拆分日前后价格尺度不一致的问题。
 */

const FUND_SPLIT_RULES = {
    SH512890: {
        name: '红利低波ETF华泰柏瑞',
        cutoffDate: '2021-10-21',
        transitionEndDate: '2021-11-30',
        splitFactor: 0.8002 / 1.6004,
        preSplitCloseThreshold: 1.05,
        transitionFieldThreshold: 0.8002 * 1.02,
    },
};

function roundPrice(value) {
    return Number(value.toFixed(3));
}

function scaleBar(bar, factor) {
    return {
        ...bar,
        open: roundPrice(bar.open * factor),
        close: roundPrice(bar.close * factor),
        high: roundPrice(bar.high * factor),
        low: roundPrice(bar.low * factor),
    };
}

/**
 * 对存在份额拆分历史的基金 K 线做价格尺度归一化
 * @param {string} code
 * @param {Array<{date: string, open: number, close: number, high: number, low: number}>} klines
 * @returns {Array}
 */
function normalizeFundSplitKlines(code, klines) {
    const rule = FUND_SPLIT_RULES[code];
    if (!rule || !Array.isArray(klines)) {
        return klines;
    }

    return klines.map((bar) => {
        if (bar.date < rule.cutoffDate) {
            if (bar.close > rule.preSplitCloseThreshold) {
                return scaleBar(bar, rule.splitFactor);
            }
            return bar;
        }

        if (bar.date <= rule.transitionEndDate) {
            const fix = (value) => (
                value > rule.transitionFieldThreshold
                    ? roundPrice(value * rule.splitFactor)
                    : value
            );
            return {
                ...bar,
                open: fix(bar.open),
                close: fix(bar.close),
                high: fix(bar.high),
                low: fix(bar.low),
            };
        }

        return bar;
    });
}

module.exports = {
    normalizeFundSplitKlines,
    FUND_SPLIT_RULES,
};
