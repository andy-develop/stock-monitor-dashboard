# 红利低波 ETF 自动化监控看板

基于 `stock-api` 与 GitHub Actions 的免费 CI/CD 算力，对**中证红利低波动指数 (H30269)** 的代理标的 **红利低波ETF华泰柏瑞 (SH512890)** 进行技术指标监控。

当触发预警条件时，自动生成包含可视化图表的静态监控看板，并部署至 **GitHub Pages**。

---

## 监控指标

| 指标 | 周期 | 预警条件 |
|---|---|---|
| KDJ(9,3,3) | 周线 | 最新周 K 线的 `J < 1` |
| MA | 月线 | 最新月 K 线收盘价跌破可用周期的均线（优先 MA60，数据不足时自动降级为 MA48 / MA36 / MA24 / MA12） |

> **为什么用 SH512890 代理 H30269？**
> `H30269` 是指数代码，`stock-api` 仅支持股票/ETF 代码（`SH`/`SZ`/`HK`/`US` 前缀）。`SH512890` 是跟踪 H30269 的 ETF，且 2019 年上市，历史月 K 超过 60 个月，可满足 MA60 计算需求。

---

## 目录结构

```text
├── .github/
│   └── workflows/
│       └── deploy.yml       # GitHub Actions 自动化工作流
├── src/
│   ├── index.html           # 看板前端模板
│   ├── build.js             # 构建入口
│   ├── fetcher.js           # 数据获取与缓存
│   ├── indicators.js        # 指标计算
│   └── render.js            # 页面渲染
├── tests/
│   └── indicators.test.js   # 单元测试
├── data/
│   ├── history.json         # K 线本地缓存（自动生成）
│   └── last-run.json        # 上次运行记录（自动生成）
├── package.json
├── package-lock.json
└── README.md
```

---

## 本地开发

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 构建看板
npm run build

# 本地预览
npx serve dist
```

---

## GitHub Pages 部署

1. 在 GitHub 创建仓库并推送代码。
2. 进入仓库 **Settings** -> **Pages** -> **Build and deployment**，选择 **GitHub Actions**。
3. 在 **Actions** 标签页手动触发 `Deploy Stock Monitor Dashboard` 工作流，或等待工作日 UTC 08:00 自动触发。

---

## 注意事项

- 触发时间：GitHub Actions `schedule` 不保证精确执行，通常会有一定延迟。
- 数据源：`stock-api` 使用腾讯/新浪/东方财富公开接口，不保证实时性与持续可用性。脚本内置本地缓存，API 失败时会回退到缓存数据。
- 节假日：工作流按工作日 cron 运行，A 股休市时数据源通常返回最近交易日数据。
