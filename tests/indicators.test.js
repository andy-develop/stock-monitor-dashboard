/**
 * 指标计算单元测试
 */
const assert = require('assert');
const { calculateKDJ, calculateMA } = require('../src/indicators');

// 构造 10 条测试 K 线
const testKlines = [
    { date: '2024-01-01', open: 10, close: 11, high: 12, low: 9 },
    { date: '2024-01-02', open: 11, close: 12, high: 13, low: 10 },
    { date: '2024-01-03', open: 12, close: 11, high: 13, low: 11 },
    { date: '2024-01-04', open: 11, close: 10, high: 11, low: 9 },
    { date: '2024-01-05', open: 10, close: 11, high: 12, low: 10 },
    { date: '2024-01-06', open: 11, close: 12, high: 13, low: 11 },
    { date: '2024-01-07', open: 12, close: 13, high: 14, low: 12 },
    { date: '2024-01-08', open: 13, close: 12, high: 13, low: 11 },
    { date: '2024-01-09', open: 12, close: 11, high: 12, low: 10 },
    { date: '2024-01-10', open: 11, close: 10, high: 11, low: 9 },
];

function testCalculateMA() {
    const ma5 = calculateMA(testKlines, 5);
    assert.strictEqual(ma5.length, testKlines.length, 'MA 长度应等于 K 线长度');
    assert.strictEqual(ma5[3], null, '第 4 条应为 null');

    const valid = ma5.slice(4);
    assert.ok(valid.every((v) => typeof v === 'number'), '有效 MA 应为数字');

    const last5 = testKlines.slice(-5).map((k) => k.close);
    const expected = Number((last5.reduce((a, b) => a + b, 0) / 5).toFixed(3));
    assert.strictEqual(ma5[ma5.length - 1], expected, '最后一条 MA5 计算错误');
    console.log('✅ calculateMA 测试通过');
}

function testCalculateKDJ() {
    const result = calculateKDJ(testKlines);
    assert.strictEqual(result.K.length, testKlines.length, 'K 数组长度错误');
    assert.strictEqual(result.D.length, testKlines.length, 'D 数组长度错误');
    assert.strictEqual(result.J.length, testKlines.length, 'J 数组长度错误');
    assert.deepStrictEqual(
        [result.K[0], result.D[0], result.J[0]],
        [50, 50, 50],
        '前 8 条应为初始值 50'
    );
    assert.ok(
        typeof result.K[8] === 'number' && typeof result.J[8] === 'number',
        '第 9 条应开始为有效数字'
    );
    console.log('✅ calculateKDJ 测试通过');
}

function testErrorHandling() {
    assert.throws(() => calculateKDJ([]), /至少 9 条/);
    assert.throws(() => calculateMA(testKlines, 0), /正整数/);
    console.log('✅ 异常处理测试通过');
}

try {
    testCalculateMA();
    testCalculateKDJ();
    testErrorHandling();
    console.log('\n🎉 所有测试通过');
} catch (e) {
    console.error('❌ 测试失败:', e.message);
    process.exit(1);
}
