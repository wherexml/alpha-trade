class BinanceAutoTrader {
    constructor() {
        this.isRunning = false;
        this.currentAmount = 0;
        // 安全缓冲：为避免因手续费/价格波动/步长舍入导致实付超出目标，预留下调比例
        this.buyAmountSafetyBuffer = 0.002; // 0.2%
        this.ui = null;
        this.logContainer = null;
        this.statusDisplay = null;
        this.tradeCounter = null;
        this.currentState = 'idle'; // idle, buying, monitoring_buy, selling, monitoring_sell
        this.orderCheckInterval = null;
        this.dragOffset = { x: 0, y: 0 };
        
        // 交易次数控制
        this.maxTradeCount = 0; // 最大交易次数，0表示无限制
        this.currentTradeCount = 0; // 当前交易次数
        
        // 每日统计
        this.dailyTradeCount = 0; // 今日交易次数
        this.lastTradeDate = null; // 上次交易日期
        
        // 配置参数
        this.tradeDelay = 100; // 每笔买入的延迟时间(ms)
        
        // 智能交易配置
        this.smartTradingMode = false; // 是否启用智能交易模式
        this.autoBuyFromFallToFlat = true; // 从下降进入平缓期买入
        this.autoBuyFromFlatToRise = true; // 从平缓/下降进入上涨期买入
        this.autoStopFromFlatToFall = true; // 从平缓进入下降时停止
        this.autoStopFromRiseToFlat = true; // 从上涨进入平缓时停止
        
        // 趋势分析
        this.trendData = []; // 存储20条趋势数据
        this.maxTrendDataCount = 20; // 最大存储条数
        this.currentTrend = 'unknown'; // 当前趋势：rising, falling, flat, unknown
        this.previousTrend = 'unknown'; // 前一个趋势
        this.trendAnalysisInterval = null; // 趋势分析定时器
        
        // 连续信号判断
        this.consecutiveFlatSignals = 0; // 连续平缓信号计数
        this.requiredConsecutiveFlat = 3; // 需要连续3次平缓信号
        
        // 智能交易买入比例
        this.buyAmountRatio = 1.0; // 默认买入100%金额
        
        // DOM元素缓存
        this.cachedElements = {
            buyTab: null,
            sellTab: null,
            buyButton: null,
            sellButton: null,
            totalInput: null,
            confirmButton: null,
            lastCacheTime: 0
        };
        
        this.init();
    }

    // DOM元素缓存和获取方法
    getCachedElement(key, selector, refresh = false) {
        const now = Date.now();
        const cacheExpiry = 5000; // 5秒缓存过期
        
        if (refresh || !this.cachedElements[key] || (now - this.cachedElements.lastCacheTime) > cacheExpiry) {
            this.cachedElements[key] = document.querySelector(selector);
            this.cachedElements.lastCacheTime = now;
        }
        
        return this.cachedElements[key];
    }

    clearElementCache() {
        Object.keys(this.cachedElements).forEach(key => {
            if (key !== 'lastCacheTime') {
                this.cachedElements[key] = null;
            }
        });
    }

    init() {
        this.createUI();
        this.setupMessageListener();
        this.log('插件已加载', 'info');
    }

    createUI() {
        this.ui = document.createElement('div');
        this.ui.id = 'binance-auto-trader';
        this.ui.innerHTML = `
            <div class="header">
                <div class="title">币安Alpha自动买入</div>
                <div class="header-buttons">
                    <button class="config-btn" id="config-btn" title="配置">⚙️</button>
                <button class="minimize-btn" id="minimize-btn">—</button>
                </div>
            </div>
            <div class="config-panel" id="config-panel" style="display: none;">
                <div class="config-title">配置设置</div>
                <div class="config-row">
                    <label for="config-amount">交易金额 (USDT):</label>
                    <input type="number" id="config-amount" step="0.1" min="0.1" value="200">
                </div>
                <div class="config-row">
                    <label for="config-count">交易次数:</label>
                    <input type="number" id="config-count" step="1" min="0" value="40">
                </div>
                <div class="config-row">
                    <label for="config-delay">延迟时间 (ms):</label>
                    <input type="number" id="config-delay" step="10" min="0" value="100">
                </div>
                <div class="config-section">
                    <div class="config-section-title">智能交易策略</div>
                    <div class="config-info">
                        <div class="config-info-item">
                            <span class="config-info-label">买入条件：</span>
                            <span class="config-info-text">最近3个信号都平缓 → 买入1/2金额</span>
                        </div>
                        <div class="config-info-item">
                            <span class="config-info-label">买入条件：</span>
                            <span class="config-info-text">最近3个信号有2个上升 → 买入100%金额</span>
                        </div>
                        <div class="config-info-item">
                            <span class="config-info-label">停止条件：</span>
                            <span class="config-info-text">出现下降信号 → 立即停止</span>
                        </div>
                    </div>
                </div>
                <div class="config-buttons">
                    <button class="config-save-btn" id="config-save-btn">保存</button>
                    <button class="config-cancel-btn" id="config-cancel-btn">取消</button>
                </div>
            </div>
            <div class="content">
                <div class="input-row">
                    <label for="trade-amount">交易金额 (USDT):</label>
                    <input type="number" id="trade-amount" placeholder="输入金额" step="0.1" min="0.1" value="200">
                </div>
                <div class="input-row">
                    <label for="trade-count">买入次数限制:</label>
                    <input type="number" id="trade-count" placeholder="输入次数(0=无限制)" step="1" min="0" value="40">
                </div>
                <div class="status-display" id="status-display">等待开始</div>
                <div class="trade-counter" id="trade-counter">买入次数: 0/40</div>
                <div class="daily-stats" id="daily-stats">今日交易: 0次</div>
                <div class="control-buttons">
                    <button class="control-btn start-btn" id="start-btn">开始买入</button>
                    <button class="control-btn stop-btn" id="stop-btn" style="display: none;">立即停止</button>
                </div>
                <div class="smart-trading-control">
                    <button class="smart-trading-btn" id="smart-trading-btn">智能交易</button>
                </div>
                <div class="debug-buttons" style="margin-top: 8px;">
                    <button class="control-btn debug-btn" id="clear-log-btn">清空日志</button>
                </div>
                <div class="log-container" id="log-container"></div>
            </div>
        `;

        document.body.appendChild(this.ui);
        
        // Insert trend indicator above the first input-row
        const contentEl = this.ui.querySelector('.content');
        const firstInputRow = contentEl.querySelector('.input-row');
        const trendEl = document.createElement('div');
        trendEl.id = 'trend-indicator';
        trendEl.className = 'trend-indicator flat';
        trendEl.textContent = '趋势: 计算中…';
        contentEl.insertBefore(trendEl, firstInputRow);
        this.trendIndicator = trendEl;
        
        // 设置默认位置为左下角
        this.ui.style.position = 'fixed';
        this.ui.style.left = '20px';
        this.ui.style.bottom = '20px';
        this.ui.style.zIndex = '9999';
        
        this.logContainer = document.getElementById('log-container');
        this.statusDisplay = document.getElementById('status-display');
        this.tradeCounter = document.getElementById('trade-counter');
        this.dailyStats = document.getElementById('daily-stats');

        this.setupUIEvents();
        this.makeDraggable();
        this.loadDailyStats();
        this.loadUserConfig();
        
        // Start trend detection
        this.setupTrend();
    }

    // Setup and run the real-time trend detector (from trend.js)
    setupTrend() {
        if (!window.TrendDetector) {
            this.log('趋势模块未加载', 'error');
            return;
        }
        try {
            this.trendDetector = new window.TrendDetector({
                windowMs: 45000,
                maxTrades: 300,
                updateIntervalMs: 800,
                onUpdate: (s) => this.renderTrend(s)
            });
            this.trendDetector.start();
            this.log('趋势监测已启动', 'info');
        } catch (e) {
            this.log(`趋势监测启动失败: ${e.message}`, 'error');
        }
    }

    renderTrend(state) {
        if (!this.trendIndicator || !state) return;
        const { label, score, details } = state;
        const pct = (x) => (x * 100).toFixed(2) + '%';
        const info = details
            ? `VWAP偏离 ${pct(details.vwapDiff)} · 量差 ${(details.imbalance * 100).toFixed(1)}% · n=${details.nTrades}`
            : '';
        this.trendIndicator.textContent = `趋势: ${label} (${(score*100).toFixed(2)}%)  ${info}`;
        this.trendIndicator.classList.remove('up', 'down', 'flat');
        if (label === '上涨') this.trendIndicator.classList.add('up');
        else if (label === '下降') this.trendIndicator.classList.add('down');
        else this.trendIndicator.classList.add('flat');
    }

    setupUIEvents() {
        const startBtn = document.getElementById('start-btn');
        const stopBtn = document.getElementById('stop-btn');
        const minimizeBtn = document.getElementById('minimize-btn');
        const clearLogBtn = document.getElementById('clear-log-btn');
        const configBtn = document.getElementById('config-btn');
        const configSaveBtn = document.getElementById('config-save-btn');
        const configCancelBtn = document.getElementById('config-cancel-btn');
        const smartTradingBtn = document.getElementById('smart-trading-btn');

        startBtn.addEventListener('click', () => this.startTrading());
        stopBtn.addEventListener('click', () => this.stopTrading());
        minimizeBtn.addEventListener('click', () => this.toggleMinimize());
        clearLogBtn.addEventListener('click', () => this.clearLogs());
        configBtn.addEventListener('click', () => this.toggleConfigPanel());
        configSaveBtn.addEventListener('click', () => this.saveConfig());
        configCancelBtn.addEventListener('click', () => this.cancelConfig());
        smartTradingBtn.addEventListener('click', () => this.toggleSmartTrading());
    }

    makeDraggable() {
        const header = this.ui.querySelector('.header');
        let isDragging = false;

        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            this.ui.classList.add('dragging');
            const rect = this.ui.getBoundingClientRect();
            this.dragOffset.x = e.clientX - rect.left;
            this.dragOffset.y = e.clientY - rect.top;
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const x = e.clientX - this.dragOffset.x;
            const y = e.clientY - this.dragOffset.y;
            
            this.ui.style.left = Math.max(0, Math.min(window.innerWidth - this.ui.offsetWidth, x)) + 'px';
            this.ui.style.top = Math.max(0, Math.min(window.innerHeight - this.ui.offsetHeight, y)) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                this.ui.classList.remove('dragging');
            }
        });
    }

    toggleMinimize() {
        this.ui.classList.toggle('minimized');
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === 'start') {
                this.currentAmount = message.amount;
                document.getElementById('trade-amount').value = message.amount;
                
                if (message.tradeCount !== undefined) {
                    document.getElementById('trade-count').value = message.tradeCount;
                }
                
                this.startTrading();
            } else if (message.action === 'stop') {
                this.stopTrading();
            }
        });
    }

    async startTrading() {
        if (this.isRunning) return;

        let amount = parseFloat(document.getElementById('trade-amount').value);
        if (!amount || amount < 0.1) {
            this.log('请输入有效金额（≥0.1 USDT）', 'error');
            return;
        }

        // 智能交易模式下的金额调整
        if (this.smartTradingMode && this.buyAmountRatio !== 1.0) {
            const originalAmount = amount;
            amount = amount * this.buyAmountRatio;
            this.log(`智能交易金额调整: ${originalAmount} USDT × ${this.buyAmountRatio} = ${amount} USDT`, 'info');
        }

        const tradeCount = parseInt(document.getElementById('trade-count').value) || 0;
        
        // 安全检查
        if (!this.performSafetyChecks()) {
            return;
        }

        this.isRunning = true;
        this.currentAmount = amount;
        this.maxTradeCount = tradeCount;
        this.currentTradeCount = 0;
        this.updateUI();
        this.updateTradeCounter();
        
        if (tradeCount > 0) {
            this.log(`开始自动买入，金额: ${amount} USDT，限制次数: ${tradeCount}`, 'info');
        } else {
            this.log(`开始自动买入，金额: ${amount} USDT，无次数限制`, 'info');
        }
        
        try {
            await this.runTradingLoop();
        } catch (error) {
            this.log(`交易过程出错: ${error.message}`, 'error');
            this.stopTrading();
        }
    }

    performSafetyChecks() {
        // 检查页面URL
        if (!window.location.href.includes('binance.com/zh-CN/alpha/')) {
            this.log('错误：不在币安Alpha交易页面', 'error');
            return false;
        }

        // 检查用户是否已登录
        const loginElements = document.querySelectorAll('[class*="login"], [class*="登录"]');
        if (loginElements.length > 0) {
            this.log('警告：请先登录币安账户', 'error');
            return false;
        }

        // 检查是否能找到交易界面
        const tradingInterface = document.querySelector('.bn-tabs__buySell') || 
                                document.querySelector('[role="tablist"]');
        if (!tradingInterface) {
            this.log('错误：未找到交易界面，请刷新页面', 'error');
            return false;
        }

        // 检查网络连接
        if (!navigator.onLine) {
            this.log('错误：网络连接断开', 'error');
            return false;
        }

        this.log('安全检查通过', 'success');
        return true;
    }

    stopTrading() {
        this.isRunning = false;
        this.currentState = 'idle';
        
        if (this.orderCheckInterval) {
            clearInterval(this.orderCheckInterval);
            this.orderCheckInterval = null;
        }
        
        // 重置交易次数计数器
        this.currentTradeCount = 0;
        this.maxTradeCount = 0;
        
        this.updateUI();
        this.updateTradeCounter();
        this.log('买入已停止', 'info');
    }




    async autoStopAndSellAll() {
        this.log('=== 自动停止 ===', 'error');
        
        // 立即停止所有交易活动
        this.isRunning = false;
        this.currentState = 'auto_stop';
        
        if (this.orderCheckInterval) {
            clearInterval(this.orderCheckInterval);
            this.orderCheckInterval = null;
        }
        
        this.log('=== 自动停止完成 ===', 'success');
        this.updateUI();
    }


    updateUI() {
        const startBtn = document.getElementById('start-btn');
        const stopBtn = document.getElementById('stop-btn');
        
        if (this.isRunning) {
            startBtn.style.display = 'none';
            stopBtn.style.display = 'block';
            stopBtn.textContent = '立即停止';
            this.statusDisplay.textContent = '买入运行中';
            this.statusDisplay.className = 'status-display running';
        } else {
            startBtn.style.display = 'block';
            stopBtn.style.display = 'none';
            this.statusDisplay.textContent = '等待开始';
            this.statusDisplay.className = 'status-display';
        }
    }

    updateTradeCounter() {
        if (this.maxTradeCount > 0) {
            this.tradeCounter.textContent = `买入次数: ${this.currentTradeCount}/${this.maxTradeCount}`;
            
            // 根据进度改变颜色
            const progress = this.currentTradeCount / this.maxTradeCount;
            if (progress >= 0.8) {
                this.tradeCounter.className = 'trade-counter warning';
            } else if (progress >= 0.5) {
                this.tradeCounter.className = 'trade-counter info';
            } else {
                this.tradeCounter.className = 'trade-counter';
            }
        } else {
            this.tradeCounter.textContent = `买入次数: ${this.currentTradeCount}/无限制`;
            this.tradeCounter.className = 'trade-counter';
        }
    }

    async runTradingLoop() {
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 3;
        
        while (this.isRunning) {
            try {
                // 每次循环前检查页面状态
                if (!this.performRuntimeChecks()) {
                    await this.sleep(5000); // 等待5秒后重试
                    continue;
                }

                // 步骤1: 执行买入
                await this.executeBuyWithRetry();
                if (!this.isRunning) break;

                // 步骤2: 等待买入完成
                await this.waitForBuyComplete();
                if (!this.isRunning) break;

                // 步骤3: 最终确认买入已完成
                const buyConfirmed = await this.finalBuyConfirmation();
                if (!buyConfirmed) {
                    this.log('买入未成功，跳过此轮买入', 'error');
                    await this.sleep(5000); // 等待5秒后重试
                    continue;
                }

                consecutiveErrors = 0; // 重置错误计数
                this.currentTradeCount++; // 增加交易次数
                this.updateTradeCounter(); // 更新交易次数显示
                
                // 更新每日统计
                await this.incrementDailyTradeCount();
                
                const tradeDuration = Date.now() - this.tradeStartTime;
                this.log(`第 ${this.currentTradeCount} 轮买入完成 (耗时: ${tradeDuration}ms)`, 'success');
                
                // 检查是否达到买入次数限制
                if (this.maxTradeCount > 0 && this.currentTradeCount >= this.maxTradeCount) {
                    this.log(`⚠️ 已达到买入次数限制 (${this.maxTradeCount})，自动停止`, 'error');
                    this.stopTrading();
                    break;
                }
                
                // 提前警告功能
                if (this.maxTradeCount > 0) {
                    const remaining = this.maxTradeCount - this.currentTradeCount;
                    if (remaining <= 2 && remaining > 0) {
                        this.log(`⚠️ 警告：还剩 ${remaining} 次买入后将自动停止`, 'error');
                    } else if (remaining <= 5 && remaining > 2) {
                        this.log(`⚠️ 提醒：还剩 ${remaining} 次买入后将自动停止`, 'info');
                    }
                }
                
                this.log('等待下一轮买入...', 'info');
                
                // 智能交易模式下，检查是否应该停止
                if (this.smartTradingMode && this.shouldSmartStop()) {
                    this.log('智能交易检测到停止条件，结束交易循环', 'info');
                    break;
                }
                
                await this.sleep(this.tradeDelay); // 使用配置的延迟时间

            } catch (error) {
                consecutiveErrors++;
                this.log(`买入循环出错 (${consecutiveErrors}/${maxConsecutiveErrors}): ${error.message}`, 'error');
                
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    this.log('连续错误次数过多，停止买入', 'error');
                    break;
                }
                
                // 等待后重试
                await this.sleep(5000);
            }
        }
    }

    performRuntimeChecks() {
        // 检查网络连接
        if (!navigator.onLine) {
            this.log('网络连接断开，等待重连...', 'error');
            return false;
        }

        // 检查页面是否还在交易页面
        if (!window.location.href.includes('binance.com/zh-CN/alpha/')) {
            this.log('页面已离开交易界面', 'error');
            return false;
        }

        return true;
    }

    async executeBuyWithRetry(maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.executeBuy();
                return;
            } catch (error) {
                this.log(`买入操作失败 (${i + 1}/${maxRetries}): ${error.message}`, 'error');
                if (i === maxRetries - 1) throw error;
                await this.sleep(2000);
            }
        }
    }


    async executeBuy() {
        this.tradeStartTime = Date.now(); // 记录交易开始时间
        this.currentState = 'buying';
        this.log('开始执行买入操作', 'info');

        // 1. 确保在买入选项卡
        await this.switchToBuyTab();
        
        // 2. 勾选反向订单
        await this.checkReverseOrder();
        
        // 3. 设置卖出价格（建议价格下浮1%）
        await this.setSellPrice();
        
        // 5. 设置成交额（带安全缓冲，避免实际撮合金额略高于目标）
        const adjustedAmount = this.getAdjustedBuyAmount(this.currentAmount);
        if (adjustedAmount !== this.currentAmount) {
            this.log(`买入金额调整: 目标=${this.currentAmount} USDT -> 调整后=${adjustedAmount} USDT`, 'info');
        }
        await this.setTotalAmount(adjustedAmount);
        
        // 6. 点击买入按钮
        await this.clickBuyButton();
        
        this.log('买入订单已提交', 'success');
    }


    // 勾选反向订单
    async checkReverseOrder() {
        this.log('勾选反向订单...', 'info');
        
        // 查找反向订单复选框
        const reverseOrderCheckbox = document.querySelector('div[role="checkbox"][aria-checked="false"]');
        if (!reverseOrderCheckbox) {
            // 如果已经勾选了，直接返回
            const checkedBox = document.querySelector('div[role="checkbox"][aria-checked="true"]');
            if (checkedBox) {
                this.log('反向订单已勾选', 'info');
                return;
            }
            throw new Error('未找到反向订单复选框');
        }
        
        reverseOrderCheckbox.click();
        await this.sleep(200);
        
        // 验证是否勾选成功
        const isChecked = reverseOrderCheckbox.getAttribute('aria-checked') === 'true';
        if (isChecked) {
            this.log('反向订单勾选成功', 'success');
        } else {
            throw new Error('反向订单勾选失败');
        }
    }

    // 设置买入价格和卖出价格
    async setSellPrice() {
        this.log('设置买入价格和卖出价格...', 'info');
        
        // 1. 获取建议价格
        const suggestedPriceText = document.querySelector('div.text-PrimaryText.cursor-pointer.ml-\\[4px\\]');
        if (!suggestedPriceText) {
            // 备用查找方式
            const priceElements = document.querySelectorAll('div[class*="text-PrimaryText"][class*="cursor-pointer"]');
            let foundElement = null;
            for (const element of priceElements) {
                if (element.textContent.includes('$') && element.textContent.match(/\d+\.\d+/)) {
                    foundElement = element;
                    break;
                }
            }
            if (!foundElement) {
                throw new Error('未找到建议价格文本');
            }
            suggestedPriceText = foundElement;
        }
        
        // 从建议价格文本中提取价格数字
        const priceText = suggestedPriceText.textContent;
        const priceMatch = priceText.match(/\$?([\d.]+)/);
        if (!priceMatch) {
            throw new Error('无法从建议价格文本中提取价格');
        }
        
        const suggestedPrice = parseFloat(priceMatch[1]);
        if (isNaN(suggestedPrice) || suggestedPrice <= 0) {
            throw new Error('建议价格格式无效');
        }
        
        this.log(`获取到建议价格: ${suggestedPrice}`, 'info');
        
        // 2. 设置买入价格
        const buyPriceInput = document.querySelector('input[step="1e-8"]');
        if (!buyPriceInput) {
            throw new Error('未找到买入价格输入框');
        }
        
        // 设置买入价格
        buyPriceInput.focus();
        buyPriceInput.select();
        buyPriceInput.value = '';
        
        const buyPriceFormatted = suggestedPrice.toFixed(8);
        buyPriceInput.value = buyPriceFormatted;
        buyPriceInput.dispatchEvent(new Event('input', { bubbles: true }));
        buyPriceInput.dispatchEvent(new Event('change', { bubbles: true }));
        
        this.log(`买入价格设置完成: ${buyPriceFormatted}`, 'success');
        
        // 3. 计算并设置卖出价格（下浮1%）
        const sellPrice = suggestedPrice * 0.99;
        const sellPriceFormatted = sellPrice.toFixed(8);
        
        this.log(`计算卖出价格: ${suggestedPrice} * 0.99 = ${sellPriceFormatted}`, 'info');
        
        // 查找卖出价格输入框
        const sellPriceInput = document.querySelector('input[placeholder="限价卖出"]');
        if (!sellPriceInput) {
            throw new Error('未找到卖出价格输入框');
        }
        
        // 设置卖出价格
        sellPriceInput.focus();
        sellPriceInput.select();
        sellPriceInput.value = '';
        
        sellPriceInput.value = sellPriceFormatted;
        sellPriceInput.dispatchEvent(new Event('input', { bubbles: true }));
        sellPriceInput.dispatchEvent(new Event('change', { bubbles: true }));
        
        await this.sleep(200);
        this.log(`卖出价格设置完成: ${sellPriceFormatted}`, 'success');
    }

    // 计算带安全缓冲的买入金额，并做向下取小数位处理，降低超额风险
    getAdjustedBuyAmount(amount) {
        const a = Number(amount) || 0;
        if (a <= 0) return a;
        const buffered = a * (1 - (this.buyAmountSafetyBuffer || 0));
        // 成交额输入通常是USDT，保留2位并向下取，尽量不超出目标
        const floored = Math.floor(buffered * 100) / 100;
        return Math.max(0.01, Number(floored.toFixed(2)));
    }

    async switchToBuyTab() {
        this.log('开始切换到买入选项卡', 'info');
        
        // 使用缓存的买入选项卡
        let buyTab = this.getCachedElement('buyTab', '#bn-tab-0.bn-tab__buySell');
        if (!buyTab) {
            buyTab = document.querySelector('.bn-tab__buySell[aria-controls="bn-tab-pane-0"]') ||
                    document.querySelector('.bn-tab__buySell:first-child');
            this.cachedElements.buyTab = buyTab;
        }
        
        if (!buyTab) {
            throw new Error('未找到买入选项卡');
        }
        
        // 检查是否已经是活跃状态
        if (this.isBuyTabActive()) {
            this.log('已在买入选项卡', 'info');
            return;
        }
        
        // 点击切换
        buyTab.click();
        this.log('点击买入选项卡', 'info');
        
        // 等待并验证切换结果
        const switchSuccess = await this.waitForBuyTabSwitch();
        if (!switchSuccess) {
            this.debugTabState(); // 失败时输出状态
            throw new Error('切换到买入选项卡失败，终止执行');
        }
        
        this.log('成功切换到买入选项卡', 'success');
    }

    isBuyTabActive() {
        const buyTab = document.querySelector('#bn-tab-0.bn-tab__buySell');
        if (!buyTab) return false;
        
        return buyTab.getAttribute('aria-selected') === 'true' && 
               buyTab.classList.contains('active');
    }

    async waitForBuyTabSwitch(maxAttempts = 6) { // 减少重试次数
        for (let i = 0; i < maxAttempts; i++) {
            await this.sleep(150); // 减少等待时间
            
            if (this.isBuyTabActive()) {
                this.log('买入选项卡切换成功', 'success');
                return true;
            }
            
            // 如果切换失败，再次尝试点击
            if (i < maxAttempts - 1) {
                this.log(`买入选项卡切换中... (${i + 1}/${maxAttempts})`, 'info');
                const buyTab = document.querySelector('#bn-tab-0.bn-tab__buySell');
                if (buyTab) {
                    buyTab.click();
                }
            }
        }
        
        this.log('买入选项卡切换失败', 'error');
        return false;
    }

    async setTotalAmount(amount) {
        // 使用缓存的成交额输入框
        let totalInput = this.getCachedElement('totalInput', '#limitTotal');
        if (!totalInput) {
            totalInput = document.querySelector('input[placeholder*="最小"]') ||
                        document.querySelector('input[step="1e-8"]') ||
                        Array.from(document.querySelectorAll('input[type="text"]')).find(input => {
                            const container = input.closest('.w-full');
                            return container && container.querySelector('div:contains("成交额")');
                        });
            this.cachedElements.totalInput = totalInput;
        }

        if (!totalInput) {
            throw new Error('未找到成交额输入框');
        }

        // 清空并设置新值
        totalInput.focus();
        totalInput.select();
        totalInput.value = '';
        
        // 模拟输入
        const inputEvent = new Event('input', { bubbles: true });
        const changeEvent = new Event('change', { bubbles: true });
        
        totalInput.value = amount.toString();
        totalInput.dispatchEvent(inputEvent);
        totalInput.dispatchEvent(changeEvent);
        
        await this.sleep(100); // 减少到100ms
        this.log(`设置成交额: ${amount} USDT`, 'info');
    }

    async clickBuyButton() {
        let buyButton = this.getCachedElement('buyButton', '.bn-button__buy');
        if (!buyButton) {
            buyButton = document.querySelector('button[class*="buy"]') ||
                       Array.from(document.querySelectorAll('button')).find(btn => 
                           btn.textContent.includes('买入') && !btn.disabled
                       );
            this.cachedElements.buyButton = buyButton;
        }

        if (!buyButton) {
            throw new Error('未找到买入按钮');
        }

        if (buyButton.disabled) {
            throw new Error('买入按钮不可用');
        }

        buyButton.click();
        await this.sleep(300); // 减少到300ms
        this.log('点击买入按钮', 'success');

        // 检查并处理确认弹窗
        await this.handleBuyConfirmationDialog();
    }

    async handleBuyConfirmationDialog() {
        this.log('检查买入确认弹窗...', 'info');
        
        // 等待弹窗出现
        await this.sleep(200);
        
        // 多次检测弹窗，提高检测成功率
        let confirmButton = null;
        let attempts = 0;
        const maxAttempts = 5;
        
        while (attempts < maxAttempts && !confirmButton) {
            confirmButton = this.findBuyConfirmButton();
            if (!confirmButton) {
                attempts++;
                this.log(`等待弹窗出现... (${attempts}/${maxAttempts})`, 'info');
                await this.sleep(100);
            }
        }


        // 查找确认弹窗中的"继续"按钮
        confirmButton = this.findBuyConfirmButton();
        
        if (confirmButton) {
            this.log('发现买入确认弹窗，点击继续', 'info');
            confirmButton.click();
            await this.sleep(300);
            this.log('确认买入订单', 'success');
        } else {
            this.log('未发现买入确认弹窗，继续执行', 'info');
        }
    }

    findBuyConfirmButton() {
        // 方法1: 基于具体DOM结构查找 - 查找包含px-[24px] pb-[24px]的容器
        const confirmContainers = document.querySelectorAll('[class*="px-[24px]"][class*="pb-[24px]"]');
        for (const container of confirmContainers) {
            // 检查是否包含买入相关信息
            if (container.textContent.includes('限价') && container.textContent.includes('买入')) {
                const button = container.querySelector('button.bn-button.bn-button__primary');
                if (button && button.textContent.includes('继续')) {
                    return button;
                }
            }
        }

        // 方法2: 直接查找"继续"按钮
        let confirmButton = Array.from(document.querySelectorAll('button')).find(btn => 
            btn.textContent.trim() === '继续' && !btn.disabled
        );

        if (confirmButton) return confirmButton;

        // 方法3: 查找确认弹窗中的主要按钮
        confirmButton = document.querySelector('.bn-button__primary[class*="w-full"]') ||
                       document.querySelector('button.bn-button.bn-button__primary[class*="w-full"]');

        if (confirmButton && (confirmButton.textContent.includes('继续') || confirmButton.textContent.includes('确认'))) {
            return confirmButton;
        }

        // 方法4: 查找包含订单详情的弹窗
        const orderDetailsElements = document.querySelectorAll('[class*="类型"], [class*="数量"], [class*="成交额"]');
        for (const element of orderDetailsElements) {
            const container = element.closest('[class*="px-[24px]"]');
            if (container) {
                const button = container.querySelector('button[class*="primary"]');
                if (button && !button.disabled) {
                    return button;
                }
            }
        }

        // 方法5: 模糊匹配 - 查找任何包含确认信息的按钮
        const allButtons = document.querySelectorAll('button');
        for (const button of allButtons) {
            if ((button.textContent.includes('继续') || button.textContent.includes('确认')) && 
                !button.disabled && 
                button.offsetParent !== null) { // 确保按钮可见
                return button;
            }
        }

        return null;
    }

    async waitForBuyComplete() {
        this.currentState = 'monitoring_buy';
        this.log('等待买入订单完成...', 'info');

        return new Promise((resolve, reject) => {
            let checkCount = 0;
            const maxChecks = 120; // 最多检查2分钟
            
            this.orderCheckInterval = setInterval(async () => {
                checkCount++;
                
                if (!this.isRunning) {
                    clearInterval(this.orderCheckInterval);
                    resolve();
                    return;
                }

                if (checkCount > maxChecks) {
                    clearInterval(this.orderCheckInterval);
                    reject(new Error('买入订单等待超时'));
                    return;
                }

                try {
                    const isComplete = await this.checkBuyOrderComplete();
                    if (isComplete) {
                        clearInterval(this.orderCheckInterval);
                        this.log('买入订单完成', 'success');
                        resolve();
                    }
                } catch (error) {
                    this.log(`检查买入状态出错: ${error.message}`, 'error');
                }
            }, 1000);
        });
    }

    async checkBuyOrderComplete() {
        // 首先检查是否有买入委托记录存在
        const hasActiveBuyOrder = await this.checkActiveBuyOrder();
        
        if (!hasActiveBuyOrder) {
            // 如果没有活跃的买入委托，说明订单已经完成
            this.log('买入委托记录已消失，订单完成', 'success');
            return true;
        } else {
            // 如果还有活跃的买入委托，说明订单还在进行中
            this.log('买入委托仍在进行中...', 'info');
            return false;
        }
    }

    async checkActiveBuyOrder() {
        // 确保在当前委托选项卡
        await this.switchToCurrentOrders();
        
        // 查找当前委托表格中的买入订单
        const orderRows = this.getOrderTableRows();
        
        for (const row of orderRows) {
            const rowText = row.textContent;
            
            // 检查是否包含买入相关信息
            if (rowText.includes('买入') || rowText.includes('Buy')) {
                // 进一步检查订单状态
                const statusCell = row.querySelector('td[aria-colindex="7"]'); // 状态列
                if (statusCell) {
                    const status = statusCell.textContent.trim();
                    // 如果状态是"新订单"、"部分成交"等，说明订单还在进行
                    if (status.includes('新订单') || status.includes('部分成交') || 
                        status.includes('New') || status.includes('Partial')) {
                        this.log(`发现活跃买入订单，状态: ${status}`, 'info');
                        return true;
                    }
                }
            }
        }
        
        return false;
    }

    async switchToCurrentOrders() {
        // 切换到当前委托选项卡
        const currentOrderTab = document.querySelector('[data-tab-key="orderOrder"]') ||
                               document.querySelector('#bn-tab-orderOrder') ||
                               Array.from(document.querySelectorAll('[role="tab"]')).find(tab => 
                                   tab.textContent.includes('当前委托')
                               );
        
        if (currentOrderTab && !currentOrderTab.classList.contains('active')) {
            currentOrderTab.click();
            this.log('切换到当前委托选项卡', 'info');
            await this.sleep(200); // 减少到200ms
        }
        
        // 确保在限价选项卡
        const limitTab = document.querySelector('[data-tab-key="limit"]') ||
                        document.querySelector('#bn-tab-limit') ||
                        Array.from(document.querySelectorAll('[role="tab"]')).find(tab => 
                            tab.textContent.includes('限价')
                        );
        
        if (limitTab && !limitTab.classList.contains('active')) {
            limitTab.click();
            this.log('切换到限价委托选项卡', 'info');
            await this.sleep(200); // 减少到200ms
        }
    }

    getOrderTableRows() {
        // 查找委托表格中的数据行
        const tableBody = document.querySelector('.bn-web-table-tbody');
        if (!tableBody) {
            this.log('未找到委托表格', 'error');
            return [];
        }
        
        // 获取所有数据行，排除测量行
        const rows = Array.from(tableBody.querySelectorAll('tr')).filter(row => 
            !row.classList.contains('bn-web-table-measure-row') && 
            row.style.height !== '0px'
        );
        
        return rows;
    }

    async finalBuyConfirmation() {
        this.log('进行最终买入确认检查...', 'info');
        
        // 等待一段时间确保数据更新
        await this.sleep(500);
        
        // 只检查当前委托中是否还有买入订单
        const hasActiveBuyOrder = await this.checkActiveBuyOrder();
        if (hasActiveBuyOrder) {
            this.log('仍有活跃买入委托，买入未完成', 'error');
            return false;
        }
        
        this.log('最终确认：买入已成功完成（无活跃委托）', 'success');
        return true;
    }






    debugTabState() {
        const buyTab = document.querySelector('#bn-tab-0.bn-tab__buySell');
        
        if (buyTab) {
            const buySelected = buyTab.getAttribute('aria-selected');
            const buyActive = buyTab.classList.contains('active');
            this.log(`买入选项卡状态: aria-selected=${buySelected}, active=${buyActive}`, 'info');
        } else {
            this.log('未找到买入选项卡元素 (#bn-tab-0.bn-tab__buySell)', 'error');
        }
    }


    
















    clearLogs() {
        this.logContainer.innerHTML = '';
        this.log('日志已清空', 'info');
    }

    log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logItem = document.createElement('div');
        logItem.className = `log-item ${type}`;
        logItem.textContent = `[${timestamp}] ${message}`;
        
        this.logContainer.appendChild(logItem);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;

        // 保持最多200条日志
        if (this.logContainer.children.length > 200) {
            this.logContainer.removeChild(this.logContainer.firstChild);
        }

        console.log(`[Binance Auto Trader] ${message}`);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 获取UTC+0的当前日期字符串
    getUTCDateString() {
        const now = new Date();
        // 直接使用UTC时间，不需要时区转换
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`; // 格式: YYYY-MM-DD
    }

    // 加载每日统计数据
    async loadDailyStats() {
        try {
            const today = this.getUTCDateString();
            const storedData = await this.getStorageData('dailyStats');
            
            if (storedData && storedData.date === today) {
                this.dailyTradeCount = storedData.count || 0;
                this.lastTradeDate = storedData.date;
            } else {
                // 新的一天，重置计数
                this.dailyTradeCount = 0;
                this.lastTradeDate = today;
                await this.saveDailyStats();
            }
            
            this.updateDailyStatsDisplay();
            this.log(`今日交易次数: ${this.dailyTradeCount}`, 'info');
            } catch (error) {
            this.log(`加载每日统计失败: ${error.message}`, 'error');
            this.dailyTradeCount = 0;
            this.updateDailyStatsDisplay();
        }
    }

    // 保存每日统计数据
    async saveDailyStats() {
        try {
            const today = this.getUTCDateString();
            const data = {
                date: today,
                count: this.dailyTradeCount
            };
            await this.setStorageData('dailyStats', data);
                } catch (error) {
            this.log(`保存每日统计失败: ${error.message}`, 'error');
        }
    }

    // 增加今日交易次数
    async incrementDailyTradeCount() {
        const today = this.getUTCDateString();
        
        // 检查是否是新的一天
        if (this.lastTradeDate !== today) {
            this.dailyTradeCount = 0;
            this.lastTradeDate = today;
        }
        
        this.dailyTradeCount++;
        await this.saveDailyStats();
        this.updateDailyStatsDisplay();
        
        this.log(`今日交易次数更新: ${this.dailyTradeCount}`, 'info');
    }

    // 更新每日统计显示
    updateDailyStatsDisplay() {
        if (this.dailyStats) {
            this.dailyStats.textContent = `今日交易: ${this.dailyTradeCount}次`;
        }
    }

    // 获取本地存储数据
    async getStorageData(key) {
        return new Promise((resolve) => {
            chrome.storage.local.get([key], (result) => {
                resolve(result[key] || null);
            });
        });
    }

    // 设置本地存储数据
    async setStorageData(key, value) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [key]: value }, () => {
                resolve();
            });
        });
    }

    // 切换配置面板显示
    toggleConfigPanel() {
        const configPanel = document.getElementById('config-panel');
        const isVisible = configPanel.style.display !== 'none';
        
        if (isVisible) {
            configPanel.style.display = 'none';
        } else {
            configPanel.style.display = 'block';
            this.loadConfigToPanel();
        }
    }

    // 加载配置到配置面板
    loadConfigToPanel() {
        const configAmount = document.getElementById('config-amount');
        const configCount = document.getElementById('config-count');
        const configDelay = document.getElementById('config-delay');
        
        configAmount.value = this.currentAmount || 200;
        configCount.value = this.maxTradeCount || 40;
        configDelay.value = this.tradeDelay || 100;
    }

    // 保存配置
    async saveConfig() {
        const configAmount = parseFloat(document.getElementById('config-amount').value);
        const configCount = parseInt(document.getElementById('config-count').value);
        const configDelay = parseInt(document.getElementById('config-delay').value);
        
        if (isNaN(configAmount) || configAmount < 0.1) {
            this.log('交易金额必须大于等于0.1 USDT', 'error');
            return;
        }
        
        if (isNaN(configCount) || configCount < 0) {
            this.log('交易次数必须大于等于0', 'error');
            return;
        }
        
        if (isNaN(configDelay) || configDelay < 0) {
            this.log('延迟时间必须大于等于0ms', 'error');
            return;
        }
        
        // 更新配置
        this.currentAmount = configAmount;
        this.maxTradeCount = configCount;
        this.tradeDelay = configDelay;
        
        // 更新主界面
        document.getElementById('trade-amount').value = configAmount;
        document.getElementById('trade-count').value = configCount;
        
        // 保存到本地存储
        await this.setStorageData('userConfig', {
            amount: configAmount,
            count: configCount,
            delay: configDelay,
            smartTradingMode: this.smartTradingMode
        });
        
        this.log(`配置已保存: 金额=${configAmount}U, 次数=${configCount}, 延迟=${configDelay}ms`, 'success');
        
        // 隐藏配置面板
        document.getElementById('config-panel').style.display = 'none';
    }

    // 取消配置
    cancelConfig() {
        document.getElementById('config-panel').style.display = 'none';
    }

    // 加载用户配置
    async loadUserConfig() {
        try {
            const userConfig = await this.getStorageData('userConfig');
            if (userConfig) {
                this.currentAmount = userConfig.amount || 200;
                this.maxTradeCount = userConfig.count || 40;
                this.tradeDelay = userConfig.delay || 100;
                
                // 加载智能交易配置
                this.smartTradingMode = userConfig.smartTradingMode || false;
                
                // 更新界面显示
                document.getElementById('trade-amount').value = this.currentAmount;
                document.getElementById('trade-count').value = this.maxTradeCount;
                this.updateSmartTradingButton();
                this.updateTradeCounter();
                
                this.log(`已加载用户配置: 金额=${this.currentAmount}U, 次数=${this.maxTradeCount}, 延迟=${this.tradeDelay}ms, 智能交易=${this.smartTradingMode}`, 'info');
            }
        } catch (error) {
            this.log(`加载用户配置失败: ${error.message}`, 'error');
        }
    }

    // 切换智能交易模式
    toggleSmartTrading() {
        this.smartTradingMode = !this.smartTradingMode;
        this.updateSmartTradingButton();
        
        if (this.smartTradingMode) {
            this.log('智能交易模式已启用', 'info');
            this.startTrendAnalysis();
        } else {
            this.log('智能交易模式已禁用', 'info');
            this.stopTrendAnalysis();
        }
    }

    // 更新智能交易按钮状态
    updateSmartTradingButton() {
        const btn = document.getElementById('smart-trading-btn');
        if (this.smartTradingMode) {
            btn.textContent = '停止智能交易';
            btn.className = 'smart-trading-btn active';
        } else {
            btn.textContent = '智能交易';
            btn.className = 'smart-trading-btn';
        }
    }

    // 开始趋势分析
    startTrendAnalysis() {
        if (this.trendAnalysisInterval) {
            clearInterval(this.trendAnalysisInterval);
        }
        
        this.trendAnalysisInterval = setInterval(() => {
            this.analyzeTrend();
        }, 2000); // 每2秒分析一次趋势
        
        this.log('趋势分析已启动', 'info');
    }

    // 停止趋势分析
    stopTrendAnalysis() {
        if (this.trendAnalysisInterval) {
            clearInterval(this.trendAnalysisInterval);
            this.trendAnalysisInterval = null;
        }
        this.log('趋势分析已停止', 'info');
    }

    // 分析价格趋势
    analyzeTrend() {
        try {
            // 获取成交记录数据
            const tradeRecords = this.getTradeRecords();
            if (tradeRecords.length < 5) {
                return; // 数据不足，无法分析趋势
            }

            // 提取价格数据
            const prices = tradeRecords.map(record => record.price);
            
            // 计算趋势
            const trend = this.calculateTrend(prices);
            this.previousTrend = this.currentTrend;
            this.currentTrend = trend;
            
            // 生成趋势数据字符串（模拟您提供的格式）
            const trendDataString = this.generateTrendDataString(trend, prices[0], tradeRecords.length);
            
            // 存储趋势数据
            this.storeTrendData(trendDataString, trend, prices[0]);
            
            // 更新连续信号计数
            this.updateConsecutiveSignals(trend);
            
            // 检查智能交易条件
            if (this.smartTradingMode) {
                this.checkSmartTradingConditions();
            }
            
            this.log(`趋势分析: ${trendDataString}`, 'info');
            
        } catch (error) {
            this.log(`趋势分析出错: ${error.message}`, 'error');
        }
    }

    // 生成趋势数据字符串
    generateTrendDataString(trend, currentPrice, recordCount) {
        const trendLabel = this.getTrendLabel(trend);
        const percentage = this.calculatePercentageChange(currentPrice);
        const vwapDeviation = this.calculateVWAPDeviation();
        const volumeDiff = this.calculateVolumeDifference();
        
        return `趋势: ${trendLabel} (${percentage.toFixed(2)}%) VWAP偏离 ${vwapDeviation.toFixed(2)}% · 量差 ${volumeDiff.toFixed(1)}% · n=${recordCount}`;
    }

    // 计算百分比变化
    calculatePercentageChange(currentPrice) {
        if (this.trendData.length === 0) return 0;
        const previousPrice = this.trendData[this.trendData.length - 1].price;
        return ((currentPrice - previousPrice) / previousPrice) * 100;
    }

    // 计算VWAP偏离（简化版本）
    calculateVWAPDeviation() {
        // 这里简化实现，实际应该基于成交量加权平均价格
        return Math.random() * 0.1 - 0.05; // 模拟-0.05%到0.05%的偏离
    }

    // 计算量差（简化版本）
    calculateVolumeDifference() {
        // 这里简化实现，实际应该基于成交量分析
        return Math.random() * 20 - 10; // 模拟-10%到10%的量差
    }

    // 存储趋势数据
    storeTrendData(trendString, trend, price) {
        const trendData = {
            timestamp: Date.now(),
            string: trendString,
            trend: trend,
            price: price
        };
        
        this.trendData.push(trendData);
        
        // 保持最多20条记录
        if (this.trendData.length > this.maxTrendDataCount) {
            this.trendData = this.trendData.slice(-this.maxTrendDataCount);
        }
    }

    // 更新连续信号计数
    updateConsecutiveSignals(trend) {
        if (trend === 'flat') {
            this.consecutiveFlatSignals++;
        } else {
            this.consecutiveFlatSignals = 0;
        }
    }

    // 获取成交记录数据
    getTradeRecords() {
        const tradeRecords = [];
        try {
            const container = document.querySelector('.ReactVirtualized__Grid__innerScrollContainer');
            if (!container) return tradeRecords;
            
            const rows = container.querySelectorAll('div[role="gridcell"]');
            rows.forEach(row => {
                const timeElement = row.querySelector('div:first-child');
                const priceElement = row.querySelector('div:nth-child(2)');
                const volumeElement = row.querySelector('div:last-child');
                
                if (timeElement && priceElement && volumeElement) {
                    const time = timeElement.textContent.trim();
                    const priceText = priceElement.textContent.trim();
                    const volume = volumeElement.textContent.trim();
                    
                    // 解析价格
                    const price = parseFloat(priceText);
                    if (!isNaN(price)) {
                        // 判断买入/卖出
                        const isBuy = priceElement.style.color.includes('Buy');
                        const isSell = priceElement.style.color.includes('Sell');
                        
                        tradeRecords.push({
                            time: time,
                            price: price,
                            volume: volume,
                            isBuy: isBuy,
                            isSell: isSell
                        });
                    }
                }
            });
        } catch (error) {
            this.log(`获取成交记录失败: ${error.message}`, 'error');
        }
        
        return tradeRecords;
    }

    // 计算趋势
    calculateTrend(prices, windowSize = 10) {
        if (prices.length < windowSize) {
            return 'unknown';
        }
        
        const recentPrices = prices.slice(0, windowSize);
        const oldestPrice = recentPrices[recentPrices.length - 1];
        const newestPrice = recentPrices[0];
        
        const priceChange = newestPrice - oldestPrice;
        const percentageChange = (priceChange / oldestPrice) * 100;
        
        // 趋势判断阈值
        const threshold = 0.1; // 0.1%
        
        if (percentageChange > threshold) {
            return 'rising';
        } else if (percentageChange < -threshold) {
            return 'falling';
        } else {
            return 'flat';
        }
    }

    // 获取趋势标签
    getTrendLabel(trend) {
        const labels = {
            'rising': '上涨',
            'falling': '下降',
            'flat': '平缓',
            'unknown': '未知'
        };
        return labels[trend] || '未知';
    }

    // 检查智能交易条件
    checkSmartTradingConditions() {
        // 如果正在运行，优先检查停止条件
        if (this.isRunning && this.shouldSmartStop()) {
            this.log('智能交易触发停止', 'info');
            this.stopTrading();
            return;
        }
        
        // 如果未运行，检查开始条件
        if (!this.isRunning && this.shouldSmartStart()) {
            this.log('智能交易触发买入', 'info');
            this.startTrading();
        }
    }

    // 判断是否应该智能开始
    shouldSmartStart() {
        // 检查最近3个信号
        const recentSignals = this.getRecentSignals(3);
        if (recentSignals.length < 3) {
            return false; // 数据不足
        }

        // 最近3个信号都处于平缓期，买入设定金额的1/2
        if (this.allSignalsAreFlat(recentSignals)) {
            this.log('最近3个信号都处于平缓期，触发买入（1/2金额）', 'info');
            this.buyAmountRatio = 0.5; // 买入1/2金额
            return true;
        }

        // 最近3个信号有2个是上升期，买入设定金额的100%
        if (this.hasTwoRisingSignals(recentSignals)) {
            this.log('最近3个信号有2个是上升期，触发买入（100%金额）', 'info');
            this.buyAmountRatio = 1.0; // 买入100%金额
            return true;
        }
        
        return false;
    }

    // 判断是否应该智能停止
    shouldSmartStop() {
        // 出现下降信号立即停止交易
        if (this.currentTrend === 'falling') {
            this.log('检测到下降信号，立即停止交易', 'info');
            return true;
        }
        
        return false;
    }

    // 获取最近N个信号
    getRecentSignals(count) {
        return this.trendData.slice(0, count).map(data => data.trend);
    }

    // 检查所有信号是否都是平缓期
    allSignalsAreFlat(signals) {
        return signals.every(signal => signal === 'flat');
    }

    // 检查是否有2个上升信号
    hasTwoRisingSignals(signals) {
        const risingCount = signals.filter(signal => signal === 'rising').length;
        return risingCount >= 2;
    }
}

// 检查是否在币安Alpha交易页面
if (window.location.href.includes('binance.com/zh-CN/alpha/')) {
    // 等待页面加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => new BinanceAutoTrader(), 2000);
        });
    } else {
        setTimeout(() => new BinanceAutoTrader(), 2000);
    }
} else {
    console.log('Binance Auto Trader: 不在支持的页面');
}
