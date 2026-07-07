/**
 * 插针 K 线归一化测试
 */
const assert = require('assert');
const { sanitizeRevertingSpikeKlines } = require('../src/kline-spike');

function testFixChinextHolidaySpike() {
    const klines = [
        { date: '2024-09-27', open: 1.713, close: 1.86, high: 1.89, low: 1.713 },
        { date: '2024-09-30', open: 2, close: 2.232, high: 2.232, low: 1.928 },
        { date: '2024-10-08', open: 2.678, close: 2.678, high: 2.678, low: 2.29 },
        { date: '2024-10-09', open: 2.41, close: 2.242, high: 2.478, low: 2.238 },
    ];
    const result = sanitizeRevertingSpikeKlines(klines);
    assert.ok(result[2].close < 2.3, '节后情绪插针收盘价应被平滑');
    assert.strictEqual(result[1].close, 2.232, '真实趋势上涨日不应被修改');
    console.log('✅ 创业板 ETF 节后插针修正测试通过');
}

function testKeepSustainedMove() {
    const klines = [
        { date: '2024-09-26', open: 1.604, close: 1.686, high: 1.686, low: 1.595 },
        { date: '2024-09-27', open: 1.713, close: 1.86, high: 1.89, low: 1.713 },
        { date: '2024-09-30', open: 2, close: 2.232, high: 2.232, low: 1.928 },
        { date: '2024-10-08', open: 2.678, close: 2.678, high: 2.678, low: 2.29 },
    ];
    const result = sanitizeRevertingSpikeKlines(klines);
    assert.strictEqual(result[2].close, 2.232, '持续上涨中的上涨日不应被误判为插针');
    console.log('✅ 持续上涨 K 线保持不变测试通过');
}

function testShortSeriesUnchanged() {
    const klines = [{ date: '2024-10-08', open: 1, close: 1.2, high: 1.2, low: 1 }];
    const result = sanitizeRevertingSpikeKlines(klines);
    assert.deepStrictEqual(result, klines);
    console.log('✅ 短序列保持不变测试通过');
}

try {
    testFixChinextHolidaySpike();
    testKeepSustainedMove();
    testShortSeriesUnchanged();
    console.log('\n🎉 插针 K 线测试全部通过');
} catch (e) {
    console.error('❌ 测试失败:', e.message);
    process.exit(1);
}
