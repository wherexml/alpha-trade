// Lightweight real-time trend detector for Binance Alpha trade tape
// Exposes: window.TrendDetector

(function () {
  class TrendDetector {
    constructor(options = {}) {
      this.windowMs = options.windowMs ?? 45000; // sliding window length
      this.maxTrades = options.maxTrades ?? 300; // max trades kept
      this.updateIntervalMs = options.updateIntervalMs ?? 800; // polling interval
      this.onUpdate = options.onUpdate ?? (() => {});
      this.timer = null;
      this.trades = []; // {ts, price, vol, side, key}
      this.seen = new Set();
      this.lastUpdateAt = 0;
      this.threshold = options.threshold ?? 0.003; // decision threshold
      this.minReturn = options.minReturn ?? 0.0002; // minimal absolute return
    }

    start() {
      this.stop();
      this.tick();
      this.timer = setInterval(() => this.tick(), this.updateIntervalMs);
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }

    tick() {
      try {
        this.collectFromDOM();
        const state = this.computeState();
        this.onUpdate(state);
      } catch (e) {
        // Silent to avoid user noise; diagnostics in console for developers
        console.debug('[TrendDetector] tick error:', e);
      }
    }

    // Heuristic: locate the trade list by finding a ReactVirtualized inner container
    // whose children look like [time, price, volume]
    findTradeContainer() {
      const containers = document.querySelectorAll('.ReactVirtualized__Grid__innerScrollContainer');
      for (const c of containers) {
        const rows = Array.from(c.children).slice(0, 10);
        if (rows.length < 3) continue;
        let ok = 0;
        for (const r of rows) {
          const cells = r.children;
          if (cells && cells.length >= 3) {
            const t = (cells[0]?.textContent || '').trim();
            const p = (cells[1]?.textContent || '').trim();
            const v = (cells[2]?.textContent || '').trim();
            if (/^\d{2}:\d{2}:\d{2}$/.test(t) && /\d/.test(p) && /[KM]|\d/.test(v)) ok++;
          }
        }
        if (ok >= Math.max(3, Math.floor(rows.length * 0.6))) return c;
      }
      return null;
    }

    parseVol(volStr) {
      const s = String(volStr).replace(/[,\s]/g, '');
      const m = s.match(/([0-9]*\.?[0-9]+)/);
      if (!m) return 0;
      let x = parseFloat(m[1]);
      if (s.toUpperCase().includes('M')) x *= 1e6;
      else if (s.toUpperCase().includes('K')) x *= 1e3;
      return x;
    }

    parseTimeToMs(timeStr) {
      // timeStr: HH:MM:SS (local day)
      const m = timeStr.match(/^(\d{2}):(\d{2}):(\d{2})$/);
      if (!m) return Date.now();
      const now = new Date();
      now.setHours(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), 0);
      return now.getTime();
    }

    collectFromDOM() {
      const c = this.findTradeContainer();
      if (!c) return;
      const rows = Array.from(c.children);
      // Order by CSS top so we read chronological order if needed
      rows.sort((a, b) => {
        const ta = parseFloat(String(a.style.top || '0').replace('px', '')) || 0;
        const tb = parseFloat(String(b.style.top || '0').replace('px', '')) || 0;
        return ta - tb;
      });

      const newly = [];
      for (const r of rows) {
        const cells = r.children;
        if (!cells || cells.length < 3) continue;
        const timeStr = (cells[0]?.textContent || '').trim();
        const priceStr = (cells[1]?.textContent || '').trim();
        const volStr = (cells[2]?.textContent || '').trim();
        if (!/\d/.test(priceStr)) continue;
        const key = `${timeStr}|${priceStr}|${volStr}`;
        if (this.seen.has(key)) continue;

        const styleAttr = cells[1]?.getAttribute('style') || '';
        const side = /Buy/i.test(styleAttr) ? 1 : /Sell/i.test(styleAttr) ? -1 : 0;
        const price = parseFloat(priceStr);
        const vol = this.parseVol(volStr);
        const tsMs = this.parseTimeToMs(timeStr);
        if (!isFinite(price) || !isFinite(vol) || vol <= 0) continue;

        newly.push({ ts: tsMs, price, vol, side, key });
      }

      // Deduplicate and append in time order
      newly.sort((a, b) => a.ts - b.ts);
      for (const t of newly) {
        this.trades.push(t);
        this.seen.add(t.key);
      }

      // Keep within window and maxTrades
      const now = Date.now();
      const cutoff = now - this.windowMs;
      this.trades = this.trades.filter(t => t.ts >= cutoff);
      if (this.trades.length > this.maxTrades) this.trades.splice(0, this.trades.length - this.maxTrades);
    }

    computeState() {
      const n = this.trades.length;
      if (n < 6) return { label: '平缓', score: 0, confidence: 0, details: null };

      const first = this.trades[0];
      const last = this.trades[n - 1];
      const dt = (last.ts - first.ts) / 1000 || 1; // seconds

      let sumW = 0, sumPV = 0;
      let buyVol = 0, sellVol = 0;
      for (const t of this.trades) {
        sumW += t.vol;
        sumPV += t.price * t.vol;
        if (t.side > 0) buyVol += t.vol; else if (t.side < 0) sellVol += t.vol;
      }
      const vwap = sumPV / (sumW || 1);

      // Linear regression of price over time (seconds since first)
      let Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
      for (const t of this.trades) {
        const x = (t.ts - first.ts) / 1000; // seconds
        const y = t.price;
        Sx += x; Sy += y; Sxx += x * x; Sxy += x * y;
      }
      const denom = (n * Sxx - Sx * Sx) || 1;
      const slope = (n * Sxy - Sx * Sy) / denom; // price per second
      const slopeNorm = slope / (last.price || 1);

      const vwapDiff = (last.price - vwap) / (vwap || 1);
      const totalVol = buyVol + sellVol || 1;
      const imbalance = (buyVol - sellVol) / totalVol; // [-1,1]

      const score = 0.6 * slopeNorm + 0.25 * vwapDiff + 0.15 * imbalance;
      const ret = (last.price - first.price) / (first.price || 1);

      let label = '平缓';
      const th = this.threshold;
      const rmin = this.minReturn;
      if (score > th && Math.abs(ret) >= rmin) label = '上涨';
      else if (score < -th && Math.abs(ret) >= rmin) label = '下降';

      const confidence = Math.max(0, Math.min(1, Math.abs(score) / (th * 2)));

      return {
        label,
        score,
        confidence,
        details: {
          lastPrice: last.price,
          vwap,
          vwapDiff,
          slopeNorm,
          imbalance,
          windowSec: dt,
          nTrades: n,
        }
      };
    }
  }

  window.TrendDetector = TrendDetector;
})();

