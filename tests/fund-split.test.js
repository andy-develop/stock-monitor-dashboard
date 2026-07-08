/**
 * 基金份额拆分归一化测试
 */
const assert = require('assert');
const { normalizeFundSplitKlines } = require('../src/fund-split');

function testNormalizePreSplitUnadjustedBar() {
    const klines = [{
        date: '2021-09-30',
        open: 1.593,
        close: 1.658,
        high: 1.798,
        low: 1.575,
    }];
    const result = normalizeFundSplitKlines('SH512890', klines);
    assert.ok(result[0].close < 1.05, '拆分前未复权收盘价应被折算到拆分后尺度');
    assert.ok(Math.abs(result[0].close - 0.829) < 0.01, '折算后收盘价应接近 0.829');
    console.log('✅ 拆分前未复权 K 线归一化测试通过');
}

function testKeepPreSplitAdjustedBar() {
    const klines = [{
        date: '2021-09-30',
        open: 0.797,
        close: 0.829,
        high: 0.899,
        low: 0.788,
    }];
    const result = normalizeFundSplitKlines('SH512890', klines);
    assert.deepStrictEqual(result, klines, '已在前复权尺度的历史 K 线不应重复折算');
    console.log('✅ 已前复权 K 线保持不变测试通过');
}

function testKeepRegistrationWeekBar() {
    const klines = [{
        date: '2021-10-21',
        open: 0.807,
        close: 0.82,
        high: 0.838,
        low: 0.803,
    }];
    const result = normalizeFundSplitKlines('SH512890', klines);
    assert.deepStrictEqual(result, klines, '权益登记周已在前复权尺度时不应被误折算');
    console.log('✅ 权益登记周 K 线保持不变测试通过');
}

function testNormalizeTransitionBar() {
    const klines = [{
        date: '2021-10-29',
        open: 0.837,
        close: 0.755,
        high: 0.87,
        low: 0.749,
    }];
    const result = normalizeFundSplitKlines('SH512890', klines);
    assert.ok(result[0].open < 0.8, '过渡期异常偏高的开盘价应被折算');
    assert.strictEqual(result[0].close, 0.755, '过渡期已处于拆分后尺度的收盘价应保持不变');
    console.log('✅ 拆分过渡期 K 线归一化测试通过');
}

function testOtherSymbolUnchanged() {
    const klines = [{ date: '2021-09-30', open: 10, close: 11, high: 12, low: 9 }];
    const result = normalizeFundSplitKlines('SH600519', klines);
    assert.deepStrictEqual(result, klines);
    console.log('✅ 非红利低波标的保持不变测试通过');
}

try {
    testNormalizePreSplitUnadjustedBar();
    testKeepPreSplitAdjustedBar();
    testKeepRegistrationWeekBar();
    testNormalizeTransitionBar();
    testOtherSymbolUnchanged();
    console.log('\n🎉 基金份额拆分测试全部通过');
} catch (e) {
    console.error('❌ 测试失败:', e.message);
    process.exit(1);
}
