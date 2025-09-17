# 插件工作流程概述

## 组成模块
- `manifest.json`：在币安 Alpha 交易页面注入 `trend.js`（趋势采集）和 `content.js`（主要逻辑），同时加载覆盖式样式 `styles.css`。
- `trend.js`：向 `window` 暴露 `TrendDetector`，定时抓取成交列表 DOM，计算趋势标签、信心分和相关指标。
- `content.js`：定义 `BinanceAutoTrader` 类，负责 UI、交易循环、趋势联动、配置读取等全部业务流程。

## 页面注入与初始化（`new BinanceAutoTrader()`）
1. 创建左下角浮动面板（交易金额、次数、日志区域、趋势提示、配置面板、智能交易按钮等）。
2. 绑定按钮交互：开始/停止、最小化、智能交易开关、配置读写、日志清空等，并允许拖动位置。
3. 初始化日志容器、状态栏、交易次数显示和每日统计面板。
4. 从 `chrome.storage.local` 加载用户配置与每日交易统计，同时更新 UI。
5. 调用 `setupMessageListener()` 监听来自扩展消息通道的 `start` 与 `stop` 命令。
6. 调用 `setupTrend()` 构造 `TrendDetector`，开始每 800ms 的成交趋势轮询，并在回调中调用 `renderTrend()`。
7. `renderTrend()` 更新界面趋势文字/颜色，记录信号到 `trendData`，计算三次最新信号对应的行动提示，并在开启智能模式时触发条件判定。

## 启动流程与运行模式
1. 用户点击“开始交易”按钮或通过扩展消息通道发送 `start` 命令触发 `startTrading()`：
   - 读取 UI 中的金额与次数限制，执行 `performSafetyChecks()`。
   - 根据智能交易开关状态设置 `sessionMode`：`smart` 代表择机买入，`manual` 代表连续买入循环。
   - 重置本次会话的计数器、强制停止标志和 UI 状态，并记录启动日志。
   - 手动模式立即进入 `runTradingLoop()`；智能模式则仅记录“等待趋势信号”，后续动作由趋势回调驱动。
2. `runTradingLoop()`（手动模式专用）在 `this.isRunning` 为真时持续执行：
   - 轮询前执行运行时安全检查，遇到异常则等待后重试。
   - 通过 `executeBuyWithRetry()` 调用 `executeBuy()` 完成一次下单（自动切换买入 tab、勾选反向订单、填写价格与成交额、处理确认弹窗）。
   - 使用 `waitForBuyComplete()` 和 `finalBuyConfirmation()` 监测委托是否成交。
   - 成功后累计 `currentTradeCount`、写入每日统计、刷新进度提示，若达到次数上限则调用 `stopTrading()`。
   - 每轮结束前按照 `tradeDelay` 秒延迟进入下一轮。
3. 智能模式在 `renderTrend()` 与 `analyzeTrend()` 更新信号时调用 `checkSmartTradingConditions()`：
   - 仅当会话正在运行且 `sessionMode === 'smart'` 时才处理信号。
   - 若未超出次数限制且通过防跌等待机制，依据最近 3 个信号的组合计算本次 `buyAmountRatio`（100%：[平缓/上涨, 上涨, 上涨]；50%：[平缓, 平缓, 平缓/上涨]）。
   - 满足条件即调用 `executeSmartBuy()` 执行一次下单：调整金额后复用 `executeBuy()`，下单成功后更新当日与会话计数，若达到上限则自动 `stopTrading()`，否则等待配置的智能延迟后继续监听信号。
4. `stopTrading()` 将 `isRunning` 与 `sessionMode` 置为 idle，清除倒计时与检测定时器，恢复 UI，并保留用户设定的次数上限。`currentTradeCount` 会在停止后归零，确保持久化的每日统计只累积成功的买入次数。

## 智能交易开关与趋势驱动
- “智能交易”按钮现在是一个模式开关，仅能在未运行时切换，内部通过 `toggleSmartTrading()` 打开或关闭。
- 开启智能模式会启动 `startTrendAnalysis()` 的 2 秒轮询，与 `TrendDetector` 的 800ms 推送共同写入 `trendData`。下降信号会记录位置并触发 `fallingSignalWaitCount`（默认 10）个信号的冷却期。
- 关闭开关会停止额外的趋势轮询并重置 `buyAmountRatio`，但不会影响历史信号或 UI 状态，方便用户重新选择模式后直接启动。
- 不论是否处于待机状态，只要开关打开就会持续更新趋势提示，但只有在会话运行且处于智能模式时才会触发自动买入。

## 数据持久化与配置
- `chrome.storage.local` 键值：
  - `userConfig`：交易金额、次数、延迟、卖出折价率、智能模式开关状态。
  - `dailyStats`：按 UTC 日期存储当天已完成买单数量。
- 初始化与保存流程：
  - `loadUserConfig()` 在 UI 创建后调用，写入输入框并刷新按钮态。
  - 配置面板保存时 `saveConfig()` 同步到 storage 及主 UI；取消仅关闭面板。
  - 每次完成交易后 `incrementDailyTradeCount()` 更新统计栏。

## 辅助功能
- 日志系统：`log()` 会在浮动面板累积至多 200 条记录，同时输出到控制台，配合 `clearLogs()` 清空。
- UI 辅助：可拖动、最小化、配置按钮、趋势行动提示（买入/停止/谨慎）。
- DOM 缓存：`getCachedElement()` 对关键输入/按钮做 5 秒缓存，减少频繁查询，并在需要时 `clearElementCache()`。
- 安全防护：
  - 交易金额自动下调缓冲、卖出价折价率。
  - `performRuntimeChecks()` 监测网络和页面 URL。
  - 多层确认弹窗点击逻辑避免误触充值按钮。

整体而言，插件以 `TrendDetector` 为信号源驱动 UI 与智能交易判定，`BinanceAutoTrader` 负责将信号转化为具体的下单、监控、统计与用户交互流程，所有操作都通过页面内的浮动面板完成。
