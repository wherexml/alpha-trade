document.addEventListener('DOMContentLoaded', function() {
    const amountInput = document.getElementById('amount');
    const tradeCountInput = document.getElementById('tradeCount');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const emergencyBtn = document.getElementById('emergencyBtn');
    const statusDiv = document.getElementById('status');

    loadSettings();

    startBtn.addEventListener('click', function() {
        const amount = parseFloat(amountInput.value);
        const tradeCount = parseInt(tradeCountInput.value) || 0;
        
        if (!amount || amount < 0.1) {
            alert('请输入有效的交易金额（最小0.1 USDT）');
            return;
        }

        saveSettings();
        sendMessageToContentScript({
            action: 'start',
            amount: amount,
            tradeCount: tradeCount
        });
        
        startBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        
        if (tradeCount > 0) {
            updateStatus(`启动中...（限制${tradeCount}次）`, 'active');
        } else {
            updateStatus('启动中...（无限制）', 'active');
        }
    });

    stopBtn.addEventListener('click', function() {
        sendMessageToContentScript({
            action: 'stop'
        });
        
        startBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        updateStatus('已停止', '');
    });

    emergencyBtn.addEventListener('click', function() {
        if (confirm('确定要执行紧急停止吗？\n这将立即停止所有交易活动，切换到卖出标签并卖出所有代币。')) {
            sendMessageToContentScript({
                action: 'emergency_stop'
            });
            
            startBtn.style.display = 'block';
            stopBtn.style.display = 'none';
            updateStatus('紧急停止执行中...', 'error');
        }
    });

    function sendMessageToContentScript(message) {
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, message);
            }
        });
    }

    function updateStatus(text, className) {
        statusDiv.textContent = text;
        statusDiv.className = 'status ' + className;
    }

    function saveSettings() {
        const settings = {
            amount: amountInput.value,
            tradeCount: tradeCountInput.value
        };
        chrome.storage.local.set({binanceAutoTradeSettings: settings});
    }

    function loadSettings() {
        chrome.storage.local.get(['binanceAutoTradeSettings'], function(result) {
            if (result.binanceAutoTradeSettings) {
                amountInput.value = result.binanceAutoTradeSettings.amount || '';
                tradeCountInput.value = result.binanceAutoTradeSettings.tradeCount || '0';
            }
        });
    }

    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
        if (message.action === 'updateStatus') {
            updateStatus(message.status, message.className || '');
        }
    });

    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs[0] && tabs[0].url.includes('binance.com/zh-CN/alpha/')) {
            updateStatus('已连接到交易页面', 'active');
        } else {
            updateStatus('请打开币安Alpha交易页面', 'error');
        }
    });
});