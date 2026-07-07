/**
 * 修正偏离度计算中的“插针”K 线
 * 场景：单日暴涨/暴跌后下一交易日快速回吐，净涨跌幅很小（典型于节后情绪盘）
 */

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
 * 识别并修正快速回吐的插针 K 线
 * @param {Array<{date: string, open: number, close: number, high: number, low: number}>} klines
 * @param {{ jumpThreshold?: number, revertRatio?: number, netMoveThreshold?: number }} [options]
 * @returns {Array}
 */
function sanitizeRevertingSpikeKlines(klines, options = {}) {
    const jumpThreshold = options.jumpThreshold ?? 0.15;
    const revertRatio = options.revertRatio ?? 0.5;
    const netMoveThreshold = options.netMoveThreshold ?? 0.05;

    if (!Array.isArray(klines) || klines.length < 3) {
        return klines;
    }

    const result = klines.map((bar) => ({ ...bar }));

    for (let i = 1; i < result.length - 1; i += 1) {
        const prev = result[i - 1].close;
        const curr = result[i].close;
        const next = result[i + 1].close;

        if (!prev || !curr || !next) {
            continue;
        }

        const jump = curr / prev - 1;
        if (Math.abs(jump) < jumpThreshold) {
            continue;
        }

        const move = curr - prev;
        const revert = curr - next;
        const revertedFraction = move !== 0 ? revert / move : 0;
        if (revertedFraction < revertRatio) {
            continue;
        }

        const netMove = Math.abs(next / prev - 1);
        if (netMove > netMoveThreshold) {
            continue;
        }

        const fixedClose = roundPrice((prev + next) / 2);
        const factor = fixedClose / curr;
        result[i] = scaleBar(result[i], factor);
    }

    return result;
}

module.exports = {
    sanitizeRevertingSpikeKlines,
};
