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
                <div class="title">币安Alpha自动交易</div>
                <button class="minimize-btn" id="minimize-btn">—</button>
            </div>
            <div class="content">
                <div class="input-row">
                    <label for="trade-amount">交易金额 (USDT):</label>
                    <input type="number" id="trade-amount" placeholder="输入金额" step="0.1" min="0.1">
                </div>
                <div class="input-row">
                    <label for="trade-count">交易次数限制:</label>
                    <input type="number" id="trade-count" placeholder="输入次数(0=无限制)" step="1" min="0" value="0">
                </div>
                <div class="status-display" id="status-display">等待开始</div>
                <div class="trade-counter" id="trade-counter">交易次数: 0/0</div>
                <div class="control-buttons">
                    <button class="control-btn start-btn" id="start-btn">开始交易</button>
                    <button class="control-btn stop-btn" id="stop-btn" style="display: none;">停止交易</button>
                </div>
                <div class="emergency-container">
                    <button class="control-btn emergency-btn" id="emergency-btn">安全停止交易</button>
                </div>
                <div class="debug-buttons" style="margin-top: 8px;">
                    <button class="control-btn debug-btn" id="clear-log-btn">清空日志</button>
                </div>
                <div class="log-container" id="log-container"></div>
            </div>
        `;

        document.body.appendChild(this.ui);
        this.logContainer = document.getElementById('log-container');
        this.statusDisplay = document.getElementById('status-display');
        this.tradeCounter = document.getElementById('trade-counter');

        this.setupUIEvents();
        this.makeDraggable();
    }

    setupUIEvents() {
        const startBtn = document.getElementById('start-btn');
        const stopBtn = document.getElementById('stop-btn');
        const emergencyBtn = document.getElementById('emergency-btn');
        const minimizeBtn = document.getElementById('minimize-btn');
        const clearLogBtn = document.getElementById('clear-log-btn');

        startBtn.addEventListener('click', () => this.startTrading());
        stopBtn.addEventListener('click', () => this.stopTrading());
        emergencyBtn.addEventListener('click', () => this.emergencyStop());
        minimizeBtn.addEventListener('click', () => this.toggleMinimize());
        clearLogBtn.addEventListener('click', () => this.clearLogs());
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
            } else if (message.action === 'emergency_stop') {
                this.emergencyStop();
            }
        });
    }

    async startTrading() {
        if (this.isRunning) return;

        const amount = parseFloat(document.getElementById('trade-amount').value);
        if (!amount || amount < 0.1) {
            this.log('请输入有效金额（≥0.1 USDT）', 'error');
            return;
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
            this.log(`开始自动交易，金额: ${amount} USDT，限制次数: ${tradeCount}`, 'info');
        } else {
            this.log(`开始自动交易，金额: ${amount} USDT，无次数限制`, 'info');
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
        this.log('交易已停止', 'info');
    }

    async emergencyStop() {
        this.log('执行紧急停止...', 'error');
        
        // 1. 立即停止所有交易活动
        this.isRunning = false;
        this.currentState = 'emergency_stop';
        
        if (this.orderCheckInterval) {
            clearInterval(this.orderCheckInterval);
            this.orderCheckInterval = null;
        }
        
        try {
            // 2. 切换到卖出标签
            await this.emergencySwitchToSell();
            
            // 3. 卖出所有当前代币
            await this.emergencySellAll();
            
            this.log('紧急停止完成', 'success');
        } catch (error) {
            this.log(`紧急停止过程出错: ${error.message}`, 'error');
        }
        
        this.updateUI();
    }

    async emergencySwitchToSell() {
        this.log('紧急切换到卖出标签...', 'info');
        
        try {
            await this.switchToSellTab();
            this.log('成功切换到卖出标签', 'success');
        } catch (error) {
            this.log(`切换到卖出标签失败: ${error.message}`, 'error');
            throw error;
        }
    }

    async emergencySellAll() {
        this.log('开始紧急卖出所有代币...', 'info');
        
        try {
            // 直接尝试卖出（不检查余额）
            // 设置最大数量
            await this.setMaxQuantityForSell();
            
            // 点击卖出按钮
            await this.clickSellButton();
            
            this.log('紧急卖出订单已提交', 'success');
            
            // 等待卖出完成（使用重试逻辑确保紧急卖出成功）
            await this.waitForSellCompleteWithRetry();
            
            this.log('紧急卖出完成', 'success');
        } catch (error) {
            this.log(`紧急卖出失败: ${error.message}`, 'error');
            throw error;
        }
    }

    async autoStopAndSellAll() {
        this.log('=== 自动停止并安全卖出 ===', 'error');
        
        // 1. 立即停止所有交易活动
        this.isRunning = false;
        this.currentState = 'auto_stop';
        
        if (this.orderCheckInterval) {
            clearInterval(this.orderCheckInterval);
            this.orderCheckInterval = null;
        }
        
        try {
            // 2. 强制切换到卖出标签
            this.log('强制切换到卖出标签...', 'info');
            await this.switchToSellTab();
            
            // 3. 检查并卖出所有当前代币
            this.log('检查代币余额并执行安全卖出...', 'info');
            await this.safeSellAllTokens();
            
            this.log('=== 自动停止完成，所有代币已安全卖出 ===', 'success');
        } catch (error) {
            this.log(`自动停止过程出错: ${error.message}`, 'error');
            this.log('为确保安全，请手动检查并卖出剩余代币', 'error');
        }
        
        this.updateUI();
    }

    async safeSellAllTokens() {
        this.log('开始安全卖出所有代币...', 'info');
        
        try {
            // 直接尝试卖出（不检查余额）
            this.log('开始卖出操作...', 'info');
            
            // 设置最大数量
            await this.setMaxQuantityForSell();
            
            // 点击卖出按钮
            await this.clickSellButton();
            
            this.log('安全卖出订单已提交', 'success');
            
            // 等待卖出完成（使用重试逻辑确保安全卖出成功）
            await this.waitForSellCompleteWithRetry();
            
            this.log('✅ 所有代币已成功卖出', 'success');
            
        } catch (error) {
            this.log(`安全卖出失败: ${error.message}`, 'error');
            this.log('⚠️ 请立即手动卖出所有代币以避免损失', 'error');
            throw error;
        }
    }

    updateUI() {
        const startBtn = document.getElementById('start-btn');
        const stopBtn = document.getElementById('stop-btn');
        
        if (this.isRunning) {
            startBtn.style.display = 'none';
            stopBtn.style.display = 'block';
            this.statusDisplay.textContent = '交易运行中';
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
            this.tradeCounter.textContent = `交易次数: ${this.currentTradeCount}/${this.maxTradeCount}`;
            
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
            this.tradeCounter.textContent = `交易次数: ${this.currentTradeCount}/无限制`;
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

                // 步骤2.5: 最终确认买入已完成
                const buyConfirmed = await this.finalBuyConfirmation();
                if (!buyConfirmed) {
                    this.log('买入未成功，跳过此轮卖出', 'error');
                    await this.sleep(5000); // 等待5秒后重试
                    continue;
                }

                // 步骤3: 执行卖出
                const sellSuccess = await this.executeSellWithRetry();
                if (!this.isRunning) break;
                
                if (!sellSuccess) {
                    this.log('卖出操作失败，跳过此轮交易', 'error');
                    await this.sleep(2000); // 等待2秒后重试
                    continue;
                }

                // 步骤4: 等待卖出完成（使用重试逻辑）
                await this.waitForSellCompleteWithRetry();
                if (!this.isRunning) break;

                consecutiveErrors = 0; // 重置错误计数
                this.currentTradeCount++; // 增加交易次数
                this.updateTradeCounter(); // 更新交易次数显示
                
                const tradeDuration = Date.now() - this.tradeStartTime;
        this.log(`第 ${this.currentTradeCount} 轮交易完成 (耗时: ${tradeDuration}ms)`, 'success');
                
                // 检查是否达到交易次数限制
                if (this.maxTradeCount > 0 && this.currentTradeCount >= this.maxTradeCount) {
                    this.log(`⚠️ 已达到交易次数限制 (${this.maxTradeCount})，自动停止并执行安全卖出`, 'error');
                    await this.autoStopAndSellAll();
                    break;
                }
                
                // 提前警告功能
                if (this.maxTradeCount > 0) {
                    const remaining = this.maxTradeCount - this.currentTradeCount;
                    if (remaining <= 2 && remaining > 0) {
                        this.log(`⚠️ 警告：还剩 ${remaining} 次交易后将自动停止`, 'error');
                    } else if (remaining <= 5 && remaining > 2) {
                        this.log(`⚠️ 提醒：还剩 ${remaining} 次交易后将自动停止`, 'info');
                    }
                }
                
                this.log('等待下一轮交易...', 'info');
                await this.sleep(500); // 减少到500ms后开始下一轮

            } catch (error) {
                consecutiveErrors++;
                this.log(`交易循环出错 (${consecutiveErrors}/${maxConsecutiveErrors}): ${error.message}`, 'error');
                
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    this.log('连续错误次数过多，停止交易', 'error');
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

    async executeSellWithRetry(maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.executeSell();
                return true; // 返回成功标记
            } catch (error) {
                this.log(`卖出操作失败 (${i + 1}/${maxRetries}): ${error.message}`, 'error');
                if (i === maxRetries - 1) {
                    this.log('所有卖出重试都失败，跳过此轮交易', 'error');
                    return false; // 返回失败标记
                }
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
        
        // 2. 设置成交额（带安全缓冲，避免实际撮合金额略高于目标）
        const adjustedAmount = this.getAdjustedBuyAmount(this.currentAmount);
        if (adjustedAmount !== this.currentAmount) {
            this.log(`买入金额调整: 目标=${this.currentAmount} USDT -> 调整后=${adjustedAmount} USDT`, 'info');
        }
        await this.setTotalAmount(adjustedAmount);
        
        // 3. 点击买入按钮
        await this.clickBuyButton();
        
        this.log('买入订单已提交', 'success');
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


    async executeSell() {
        this.currentState = 'selling';
        this.log('开始执行卖出操作', 'info');

        // 1. 切换到卖出选项卡
        await this.switchToSellTab();
        
        // 2. 直接设置最大数量（不设置成交额）
        const setQuantitySuccess = await this.setMaxQuantityForSell();
        if (!setQuantitySuccess) {
            throw new Error('设置卖出数量失败');
        }
        
        // 3. 点击卖出按钮
        await this.clickSellButton();
        
        this.log('卖出订单已提交', 'success');
    }

    async switchToSellTab() {
        this.log('开始切换到卖出选项卡', 'info');
        
        // 使用缓存的卖出选项卡
        let sellTab = this.getCachedElement('sellTab', '#bn-tab-1.bn-tab__buySell');
        if (!sellTab) {
            sellTab = document.querySelector('.bn-tab__buySell[aria-controls="bn-tab-pane-1"]') ||
                     document.querySelector('.bn-tab__buySell:nth-child(2)');
            this.cachedElements.sellTab = sellTab;
        }
        
        if (!sellTab) {
            throw new Error('未找到卖出选项卡');
        }
        
        // 检查是否已经是活跃状态
        if (this.isSellTabActive()) {
            this.log('已在卖出选项卡', 'info');
            return;
        }
        
        // 点击切换
        sellTab.click();
        this.log('点击卖出选项卡', 'info');
        
        // 等待并验证切换结果
        const switchSuccess = await this.waitForSellTabSwitch();
        if (!switchSuccess) {
            this.debugTabState(); // 失败时输出状态
            throw new Error('切换到卖出选项卡失败，终止执行');
        }
        
        this.log('成功切换到卖出选项卡', 'success');
    }

    isSellTabActive() {
        const sellTab = document.querySelector('#bn-tab-1.bn-tab__buySell');
        if (!sellTab) return false;
        
        return sellTab.getAttribute('aria-selected') === 'true' && 
               sellTab.classList.contains('active');
    }

    async waitForSellTabSwitch(maxAttempts = 6) { // 减少重试次数
        for (let i = 0; i < maxAttempts; i++) {
            await this.sleep(150); // 减少等待时间
            
            if (this.isSellTabActive()) {
                this.log('卖出选项卡切换成功', 'success');
                return true;
            }
            
            // 如果切换失败，再次尝试点击
            if (i < maxAttempts - 1) {
                this.log(`卖出选项卡切换中... (${i + 1}/${maxAttempts})`, 'info');
                const sellTab = document.querySelector('#bn-tab-1.bn-tab__buySell');
                if (sellTab) {
                    sellTab.click();
                }
            }
        }
        
        this.log('卖出选项卡切换失败', 'error');
        return false;
    }

    debugTabState() {
        const buyTab = document.querySelector('#bn-tab-0.bn-tab__buySell');
        const sellTab = document.querySelector('#bn-tab-1.bn-tab__buySell');
        
        if (buyTab) {
            const buySelected = buyTab.getAttribute('aria-selected');
            const buyActive = buyTab.classList.contains('active');
            this.log(`买入选项卡状态: aria-selected=${buySelected}, active=${buyActive}`, 'info');
        } else {
            this.log('未找到买入选项卡元素 (#bn-tab-0.bn-tab__buySell)', 'error');
        }
        
        if (sellTab) {
            const sellSelected = sellTab.getAttribute('aria-selected');
            const sellActive = sellTab.classList.contains('active');
            this.log(`卖出选项卡状态: aria-selected=${sellSelected}, active=${sellActive}`, 'info');
        } else {
            this.log('未找到卖出选项卡元素 (#bn-tab-1.bn-tab__buySell)', 'error');
        }
    }

    async setMaxQuantityForSell() {
        this.log('开始设置最大卖出数量...', 'info');
        
        // 先清理缓存，确保获取最新元素
        this.clearElementCache();
        
        const maxRetries = 5; // 最多重试5次
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            this.log(`第 ${attempt} 次尝试设置最大数量...`, 'info');
            
            // 方法1: 点击100%按钮
            const maxButtons = [
                ...Array.from(document.querySelectorAll('button')).filter(btn => 
                    btn.textContent.includes('100%') && btn.offsetParent !== null
                ),
                ...Array.from(document.querySelectorAll('div')).filter(div => 
                    div.textContent.includes('100%') && div.onclick && div.offsetParent !== null
                )
            ];
            
            if (maxButtons.length > 0) {
                this.log(`找到1${maxButtons.length}个100%按钮`, 'info');
                maxButtons[0].click();
                await this.sleep(300); // 稍微增加等待时间
                
                if (await this.verifySliderValue()) {
                    this.log('✅ 100%按钮设置成功', 'success');
                    return true;
                }
            }
            
            // 方法2: 直接操作滑杆
            const slider = document.querySelector('.bn-slider');
            if (slider) {
                this.log(`找到滑杆，当前值: ${slider.value}`, 'info');
                
                // 多种方式设置滑杆值
                slider.value = '100';
                slider.setAttribute('aria-valuenow', '100');
                slider.setAttribute('aria-valuetext', '100 units');
                
                // 触发多个事件
                const events = ['input', 'change', 'blur', 'focus'];
                events.forEach(eventType => {
                    slider.dispatchEvent(new Event(eventType, { bubbles: true }));
                });
                
                // 也试试触发鼠标事件
                slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                
                await this.sleep(300);
                
                if (await this.verifySliderValue()) {
                    this.log('✅ 滑杆直接设置成功', 'success');
                    return true;
                }
            }
            
            // 方法3: 点击滑杆的100%点
            const sliderSteps = document.querySelectorAll('.bn-slider-track-step');
            if (sliderSteps.length > 0) {
                const lastStep = sliderSteps[sliderSteps.length - 1]; // 最后一个应该是100%
                this.log(`点击滑杆100%点`, 'info');
                lastStep.click();
                await this.sleep(300);
                
                if (await this.verifySliderValue()) {
                    this.log('✅ 滑杆点击设置成功', 'success');
                    return true;
                }
            }
            
            this.log(`第 ${attempt} 次尝试失败，滑杆值: ${slider ? slider.value : '未找到滑杆'}`, 'error');
            
            if (attempt < maxRetries) {
                await this.sleep(500); // 等待后重试
            }
        }
        
        this.log('❌ 所有方法都无法设置滑杆到100%', 'error');
        return false;
    }

    async setMaxQuantityForSellOnce() {
        this.log('尝试设置最大卖出数量（仅一次）...', 'info');
        
        // 先清理缓存，确保获取最新元素
        this.clearElementCache();
        
        this.log('第 1 次尝试设置最大数量...', 'info');
        
        // 方法1: 点击100%按钮
        const maxButtons = [
            ...Array.from(document.querySelectorAll('button')).filter(btn => 
                btn.textContent.includes('100%') && btn.offsetParent !== null
            ),
            ...Array.from(document.querySelectorAll('div')).filter(div => 
                div.textContent.includes('100%') && div.onclick && div.offsetParent !== null
            )
        ];
        
        if (maxButtons.length > 0) {
            this.log(`找到${maxButtons.length}个100%按钮`, 'info');
            maxButtons[0].click();
            await this.sleep(300);
            
            if (await this.verifySliderValue()) {
                this.log('✅ 100%按钮设置成功', 'success');
                return true;
            }
        }
        
        // 方法2: 直接操作滑杆
        const slider = document.querySelector('.bn-slider');
        if (slider) {
            this.log(`找到滑杆，当前值: ${slider.value}`, 'info');
            
            // 多种方式设置滑杆值
            slider.value = '100';
            slider.setAttribute('aria-valuenow', '100');
            slider.setAttribute('aria-valuetext', '100 units');
            
            // 触发多个事件
            const events = ['input', 'change', 'blur', 'focus'];
            events.forEach(eventType => {
                slider.dispatchEvent(new Event(eventType, { bubbles: true }));
            });
            
            // 也试试触发鼠标事件
            slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            
            await this.sleep(300);
            
            if (await this.verifySliderValue()) {
                this.log('✅ 滑杆直接设置成功', 'success');
                return true;
            }
        }
        
        // 方法3: 点击滑杆的100%点
        const sliderSteps = document.querySelectorAll('.bn-slider-track-step');
        if (sliderSteps.length > 0) {
            const lastStep = sliderSteps[sliderSteps.length - 1]; // 最后一个应该是100%
            this.log(`点击滑杆100%点`, 'info');
            lastStep.click();
            await this.sleep(300);
            
            if (await this.verifySliderValue()) {
                this.log('✅ 滑杆点击设置成功', 'success');
                return true;
            }
        }
        
        this.log(`第 1 次尝试失败，滑杆值: ${slider ? slider.value : '未找到滑杆'}`, 'error');
        this.log('❌ 取消委托后首次设置滑杆失败', 'error');
        return false;
    }
    
    async verifySliderValue() {
        const slider = document.querySelector('.bn-slider');
        if (!slider) {
            this.log('未找到滑杆元素', 'error');
            return false;
        }
        
        const currentValue = slider.value;
        const ariaValue = slider.getAttribute('aria-valuenow');
        
        this.log(`滑杆当前值: value=${currentValue}, aria-valuenow=${ariaValue}`, 'info');
        
        // 检查滑杆是否在100%
        if (currentValue === '100' || ariaValue === '100') {
            // 再检查卖出按钮是否可用
            const sellButton = document.querySelector('.bn-button__sell') ||
                              Array.from(document.querySelectorAll('button')).find(btn => 
                                  btn.textContent.includes('卖出')
                              );
            
            if (sellButton && !sellButton.disabled) {
                this.log('✅ 滑杆已设置为100%，卖出按钮可用', 'success');
                return true;
            } else {
                this.log('滑杆是100%但卖出按钮不可用', 'error');
                return false;
            }
        }
        
        this.log(`滑杆值不是100%，当前: ${currentValue}`, 'error');
        return false;
    }

    async clickSellButton() {
        // 先检查滑杆是否在100%
        if (!await this.verifySliderValue()) {
            throw new Error('滑杆不在100%，不能点击卖出');
        }
        
        let sellButton = this.getCachedElement('sellButton', '.bn-button__sell');
        if (!sellButton) {
            sellButton = document.querySelector('button[class*="sell"]') ||
                        Array.from(document.querySelectorAll('button')).find(btn => 
                            btn.textContent.includes('卖出')
                        );
            this.cachedElements.sellButton = sellButton;
        }

        if (!sellButton) {
            throw new Error('未找到卖出按钮');
        }

        if (sellButton.disabled) {
            throw new Error('卖出按钮被禁用');
        }

        this.log(`点击卖出按钮: "${sellButton.textContent.trim()}"`, 'info');
        
        sellButton.click();
        await this.sleep(200); // 等待点击效果
        
        // 检查并处理确认弹窗（必须出现）
        const confirmationSuccess = await this.waitForSellConfirmationDialog();
        if (!confirmationSuccess) {
            throw new Error('卖出确认弹窗未出现，订单失败');
        }
        
        this.log('卖出订单确认成功', 'success');
    }

    async waitForSellConfirmationDialog() {
        this.log('检查卖出确认弹窗...', 'info');
        
        // 等待弹窗出现
        await this.sleep(200);
        
        // 多次检测弹窗，提高检测成功率（参考买入逻辑）
        let confirmButton = null;
        let attempts = 0;
        const maxAttempts = 5;
        
        while (attempts < maxAttempts && !confirmButton) {
            confirmButton = this.findSellConfirmButton();
            if (!confirmButton) {
                attempts++;
                this.log(`等待卖出弹窗出现... (${attempts}/${maxAttempts})`, 'info');
                await this.sleep(100);
            }
        }

        // 查找确认弹窗中的"继续"按钮
        confirmButton = this.findSellConfirmButton();
        
        if (confirmButton) {
            this.log('发现卖出确认弹窗，点击继续', 'info');
            
            // 添加5次重试点击弹窗继续的逻辑，每次等待100ms（参考买入逻辑优化）
            let clickSuccess = false;
            for (let retry = 0; retry < 5; retry++) {
                try {
                    confirmButton.click();
                    await this.sleep(100);
                    
                    // 检查弹窗是否已消失，表示点击成功
                    const stillVisible = this.findSellConfirmButton();
                    if (!stillVisible) {
                        clickSuccess = true;
                        this.log('确认卖出订单', 'success');
                        return true;
                    }
                } catch (error) {
                    this.log(`第${retry + 1}次点击确认按钮失败: ${error.message}`, 'error');
                }
                
                if (retry < 4) { // 不是最后一次重试
                    this.log(`第${retry + 1}次点击未成功，100ms后重试...`, 'info');
                }
            }
            
            if (!clickSuccess) {
                this.log('❌ 5次重试点击确认按钮都失败', 'error');
                return false;
            }
        } else {
            this.log('未发现卖出确认弹窗，继续执行', 'info');
        }
        
        return true;
    }

    findSellConfirmButton() {
        // 方法1: 基于具体DOM结构查找 - 查找包含px-[24px] pb-[24px]的容器
        const confirmContainers = document.querySelectorAll('[class*="px-[24px]"][class*="pb-[24px]"]');
        for (const container of confirmContainers) {
            // 检查是否包含卖出相关信息
            if (container.textContent.includes('限价') && container.textContent.includes('卖出')) {
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

        // 方法4: 模糊匹配 - 查找任何包含确认信息的按钮
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

    async waitForSellCompleteWithRetry() {
        this.currentState = 'monitoring_sell';
        this.log('开始卖出订单监控（支持自动重试）...', 'info');
        
        const maxRetryAttempts = 3; // 最多重试3次
        let retryCount = 0;
        
        while (retryCount < maxRetryAttempts && this.isRunning) {
            try {
                // 每次尝试等待4秒
                const sellCompleted = await this.waitForSellCompleteOnce();
                
                if (sellCompleted) {
                    this.log('卖出订单成功完成', 'success');
                    return;
                }
                
                // 如果4秒内没有完成，执行重试逻辑
                retryCount++;
                this.log(`卖出订单4秒内未完成，开始第${retryCount}次重试...`, 'info');
                
                // 取消所有当前委托
                await this.cancelAllOrders();
                
                // 等待取消完成
                await this.sleep(200);
                
                // 重新执行卖出（不包括切换标签，因为已经在卖出标签了）
                await this.retrySellOrder();
                
            } catch (error) {
                this.log(`卖出重试过程出错: ${error.message}`, 'error');
                retryCount++;
                
                if (retryCount >= maxRetryAttempts) {
                    throw new Error(`卖出重试达到最大次数(${maxRetryAttempts})，失败`);
                }
                
                await this.sleep(500); // 出错后等待更久一点
            }
        }
        
        throw new Error('卖出订单重试失败');
    }

    async waitForSellCompleteOnce() {
        this.log('等待卖出订单完成（4秒超时）...', 'info');

        return new Promise((resolve, reject) => {
            let checkCount = 0;
            const maxChecks = 16; // 4秒内最多检查16次（每250ms一次）
            
            const checkInterval = setInterval(async () => {
                checkCount++;
                
                if (!this.isRunning) {
                    clearInterval(checkInterval);
                    resolve(false);
                    return;
                }

                try {
                    const isComplete = await this.checkSellOrderComplete();
                    if (isComplete) {
                        clearInterval(checkInterval);
                        this.log('卖出订单在4秒内完成', 'success');
                        resolve(true);
                        return;
                    }
                    
                    if (checkCount >= maxChecks) {
                        clearInterval(checkInterval);
                        this.log('卖出订单4秒内未完成，需要重试', 'info');
                        resolve(false);
                        return;
                    }
                } catch (error) {
                    this.log(`检查卖出状态出错: ${error.message}`, 'error');
                    clearInterval(checkInterval);
                    reject(error);
                }
            }, 250); // 每250ms检查一次
        });
    }


    async checkSellOrderComplete() {
        // 检查是否有卖出委托记录存在
        const hasActiveSellOrder = await this.checkActiveSellOrder();
        
        if (!hasActiveSellOrder) {
            this.log('卖出委托记录已消失，订单完成', 'success');
            return true;
        } else {
            // 如果还有活跃的卖出委托，说明订单还在进行中
            this.log('卖出委托仍在进行中...', 'info');
            return false;
        }
    }

    async checkActiveSellOrder() {
        // 确保在当前委托选项卡
        await this.switchToCurrentOrders();
        
        // 查找当前委托表格中的卖出订单
        const orderRows = this.getOrderTableRows();
        
        for (const row of orderRows) {
            const rowText = row.textContent;
            
            // 检查是否包含卖出相关信息
            if (rowText.includes('卖出') || rowText.includes('Sell')) {
                // 进一步检查订单状态
                const statusCell = row.querySelector('td[aria-colindex="7"]'); // 状态列
                if (statusCell) {
                    const status = statusCell.textContent.trim();
                    // 如果状态是"新订单"、"部分成交"等，说明订单还在进行
                    if (status.includes('新订单') || status.includes('部分成交') || 
                        status.includes('New') || status.includes('Partial')) {
                        this.log(`发现活跃卖出订单，状态: ${status}`, 'info');
                        return true;
                    }
                }
            }
        }
        
        return false;
    }

    async cancelAllOrders() {
        this.log('开始取消所有当前委托...', 'info');
        
        try {
            // 先确保在当前委托选项卡
            await this.switchToCurrentOrders();
            
            // 查找"全部取消"按钮
            const cancelAllButton = await this.findCancelAllButton();
            
            if (cancelAllButton) {
                this.log('找到全部取消按钮，点击取消所有委托', 'info');
                cancelAllButton.click();
                
                // 等待确认弹窗出现并点击确认
                const confirmSuccess = await this.handleCancelConfirmDialog();
                if (!confirmSuccess) {
                    throw new Error('取消委托确认弹窗处理失败');
                }
                
                // 等待取消生效
                await this.sleep(500);
                
                // 验证是否成功取消
                const ordersRemain = await this.checkIfOrdersRemain();
                if (!ordersRemain) {
                    this.log('✅ 成功取消所有委托', 'success');
                    return true;
                } else {
                    this.log('⚠️ 取消委托可能未完全生效', 'info');
                    return true; // 仍然返回true，因为按钮已点击
                }
            } else {
                this.log('未找到全部取消按钮，可能没有活跃委托', 'info');
                return true;
            }
        } catch (error) {
            this.log(`取消委托失败: ${error.message}`, 'error');
            throw error;
        }
    }

    async findCancelAllButton() {
        // 方法1：根据用户提供的具体选择器查找
        let cancelButton = document.querySelector('th[aria-colindex="8"] .text-TextLink');
        if (cancelButton && cancelButton.textContent.includes('全部取消')) {
            return cancelButton;
        }

        // 方法2：查找表头中的全部取消按钮
        const tableHeaders = document.querySelectorAll('th.bn-web-table-cell');
        for (const header of tableHeaders) {
            const textLink = header.querySelector('.text-TextLink');
            if (textLink && textLink.textContent.includes('全部取消')) {
                return textLink;
            }
        }

        // 方法3：更广泛的查找
        const allCancelButtons = Array.from(document.querySelectorAll('.text-TextLink, button, div')).filter(btn => 
            btn.textContent.includes('全部取消') && 
            btn.offsetParent !== null // 确保元素可见
        );

        if (allCancelButtons.length > 0) {
            return allCancelButtons[0];
        }

        // 方法4：查找包含"取消"的链接或按钮
        const cancelElements = Array.from(document.querySelectorAll('[class*="cursor-pointer"]')).filter(el => 
            el.textContent.includes('全部取消')
        );

        if (cancelElements.length > 0) {
            return cancelElements[0];
        }

        return null;
    }

    async handleCancelConfirmDialog() {
        this.log('等待取消确认弹窗出现...', 'info');
        
        const maxWaitTime = 3000; // 最多等待3秒
        const checkInterval = 200; // 每200ms检查一次
        const maxChecks = maxWaitTime / checkInterval;
        
        for (let i = 0; i < maxChecks; i++) {
            await this.sleep(checkInterval);
            
            const confirmButton = this.findCancelConfirmButton();
            if (confirmButton) {
                this.log('✅ 发现取消确认弹窗，点击确认', 'success');
                confirmButton.click();
                await this.sleep(300);
                this.log('✅ 已确认取消所有订单', 'success');
                return true;
            }
            
            this.log(`等待确认弹窗... (${i + 1}/${maxChecks})`, 'info');
        }
        
        this.log('❌ 等待超时，未发现取消确认弹窗', 'error');
        return false;
    }

    findCancelConfirmButton() {
        // 方法1：根据用户提供的具体DOM结构查找
        const modalConfirm = document.querySelector('.bn-modal-confirm');
        if (modalConfirm) {
            // 检查是否包含"确定取消全部订单？"文本
            if (modalConfirm.textContent.includes('确定取消全部订单')) {
                const confirmButton = modalConfirm.querySelector('.bn-modal-confirm-actions button.bn-button__primary');
                if (confirmButton && confirmButton.textContent.includes('确认')) {
                    return confirmButton;
                }
            }
        }

        // 方法2：查找包含确认取消文本的弹窗
        const confirmDialogs = Array.from(document.querySelectorAll('.bn-modal-confirm, [class*="modal"], [class*="dialog"]'));
        for (const dialog of confirmDialogs) {
            if (dialog.textContent.includes('确定取消全部订单') || 
                dialog.textContent.includes('取消全部') ||
                dialog.textContent.includes('确认取消')) {
                const confirmButton = dialog.querySelector('button.bn-button__primary') ||
                                    dialog.querySelector('button[class*="primary"]') ||
                                    Array.from(dialog.querySelectorAll('button')).find(btn => 
                                        btn.textContent.includes('确认') && !btn.disabled
                                    );
                if (confirmButton) {
                    return confirmButton;
                }
            }
        }

        // 方法3：查找任何包含"确认"文本的主要按钮
        const allButtons = Array.from(document.querySelectorAll('button.bn-button__primary, button[class*="primary"]'));
        for (const button of allButtons) {
            if (button.textContent.includes('确认') && 
                button.offsetParent !== null && // 确保按钮可见
                button.closest('[class*="modal"], [class*="dialog"], .bn-modal-confirm')) { // 确保在弹窗中
                return button;
            }
        }

        // 方法4：更广泛的查找 - 任何可见的确认按钮
        const visibleConfirmButtons = Array.from(document.querySelectorAll('button')).filter(btn => 
            btn.textContent.includes('确认') && 
            btn.offsetParent !== null && 
            !btn.disabled &&
            // 确保按钮在弹窗或模态框中
            (btn.closest('[class*="modal"]') || btn.closest('[class*="dialog"]') || btn.closest('[class*="confirm"]'))
        );

        if (visibleConfirmButtons.length > 0) {
            return visibleConfirmButtons[0];
        }

        return null;
    }

    async checkIfOrdersRemain() {
        await this.sleep(100); // 等待界面更新
        
        const orderRows = this.getOrderTableRows();
        
        // 检查是否还有活跃的卖出订单
        for (const row of orderRows) {
            const rowText = row.textContent;
            if (rowText.includes('卖出') || rowText.includes('Sell')) {
                const statusCell = row.querySelector('td[aria-colindex="7"]');
                if (statusCell) {
                    const status = statusCell.textContent.trim();
                    if (status.includes('新订单') || status.includes('部分成交') || 
                        status.includes('New') || status.includes('Partial')) {
                        return true; // 还有活跃订单
                    }
                }
            }
        }
        
        return false; // 没有活跃订单
    }

    async retrySellOrder() {
        this.log('重新执行卖出订单...', 'info');
        
        try {
            // 不需要切换标签，因为已经在卖出标签了
            
            // 重新设置最大数量，但只尝试一次
            const setQuantitySuccess = await this.setMaxQuantityForSellOnce();
            if (!setQuantitySuccess) {
                // 如果第1次尝试失败，直接跳过当前卖出逻辑
                this.log('❌ 取消委托后第1次设置滑杆失败，跳过当前卖出逻辑，进入下一轮买入', 'error');
                throw new Error('取消委托后设置滑杆失败，跳过卖出');
            }
            
            // 重新点击卖出按钮
            await this.clickSellButton();
            
            this.log('重新提交卖出订单成功', 'success');
        } catch (error) {
            this.log(`重新执行卖出订单失败: ${error.message}`, 'error');
            throw error;
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