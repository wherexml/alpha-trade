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
                <div class="title">币安Alpha自动买入</div>
                <button class="minimize-btn" id="minimize-btn">—</button>
            </div>
            <div class="content">
                <div class="input-row">
                    <label for="trade-amount">交易金额 (USDT):</label>
                    <input type="number" id="trade-amount" placeholder="输入金额" step="0.1" min="0.1">
                </div>
                <div class="input-row">
                    <label for="trade-count">买入次数限制:</label>
                    <input type="number" id="trade-count" placeholder="输入次数(0=无限制)" step="1" min="0" value="0">
                </div>
                <div class="status-display" id="status-display">等待开始</div>
                <div class="trade-counter" id="trade-counter">买入次数: 0/0</div>
                <div class="control-buttons">
                    <button class="control-btn start-btn" id="start-btn">开始买入</button>
                    <button class="control-btn stop-btn" id="stop-btn" style="display: none;">停止买入</button>
                </div>
                <div class="emergency-container">
                    <button class="control-btn emergency-btn" id="emergency-btn">紧急停止</button>
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

    async emergencyStop() {
        this.log('执行紧急停止...', 'error');
        
        // 立即停止所有交易活动
        this.isRunning = false;
        this.currentState = 'emergency_stop';
        
        if (this.orderCheckInterval) {
            clearInterval(this.orderCheckInterval);
            this.orderCheckInterval = null;
        }
            
            this.log('紧急停止完成', 'success');
        this.updateUI();
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
                await this.sleep(500); // 减少到500ms后开始下一轮

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
        
        // 2. 点击建议价格按钮
        await this.clickSuggestedPrice();
        
        // 3. 勾选反向订单
        await this.checkReverseOrder();
        
        // 4. 设置卖出价格（建议价格下浮1%）
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

    // 点击建议价格按钮
    async clickSuggestedPrice() {
        this.log('点击建议价格按钮...', 'info');
        
        // 查找建议价格按钮
        const suggestedPriceBtn = document.querySelector('div.border-0.border-b.border-dotted');
        if (!suggestedPriceBtn) {
            throw new Error('未找到建议价格按钮');
        }
        
        suggestedPriceBtn.click();
        await this.sleep(200);
        this.log('已点击建议价格按钮', 'success');
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

    // 设置卖出价格（建议价格下浮1%）
    async setSellPrice() {
        this.log('设置卖出价格...', 'info');
        
        // 获取建议价格
        const suggestedPriceText = document.querySelector('div.border-0.border-b.border-dotted');
        if (!suggestedPriceText) {
            throw new Error('未找到建议价格文本');
        }
        
        // 从建议价格文本中提取价格数字
        const priceText = suggestedPriceText.textContent;
        const priceMatch = priceText.match(/\$?([\d.]+)/);
        if (!priceMatch) {
            throw new Error('无法从建议价格文本中提取价格');
        }
        
        const suggestedPrice = parseFloat(priceMatch[1]);
        if (isNaN(suggestedPrice)) {
            throw new Error('建议价格格式无效');
        }
        
        // 计算下浮1%的价格
        const sellPrice = suggestedPrice * 0.99;
        const formattedPrice = sellPrice.toFixed(8); // 保留8位小数
        
        this.log(`建议价格: ${suggestedPrice}, 卖出价格: ${formattedPrice}`, 'info');
        
        // 查找卖出价格输入框
        const sellPriceInput = document.querySelector('input[placeholder="限价卖出"]');
        if (!sellPriceInput) {
            throw new Error('未找到卖出价格输入框');
        }
        
        // 设置卖出价格
        sellPriceInput.focus();
        sellPriceInput.select();
        sellPriceInput.value = '';
        
        // 模拟输入
        const inputEvent = new Event('input', { bubbles: true });
        const changeEvent = new Event('change', { bubbles: true });
        
        sellPriceInput.value = formattedPrice;
        sellPriceInput.dispatchEvent(inputEvent);
        sellPriceInput.dispatchEvent(changeEvent);
        
        await this.sleep(200);
        this.log(`卖出价格设置完成: ${formattedPrice}`, 'success');
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