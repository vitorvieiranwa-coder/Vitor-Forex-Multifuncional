import { describe, expect, it } from 'vitest';
import {
  calculateADX,
  calculateATR,
  calculateBollingerBands,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateVWAP,
  computeIndicatorSnapshot,
  detectBreakoutAndFalseBreakout,
  detectCandlePatterns,
} from '../indicators';
import { Candle } from '../types';

function makeTrendingCandles(count: number, start = 1.08, step = 0.0005): Candle[] {
  const out: Candle[] = [];
  let price = start;
  const baseTime = 1700000000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step;
    const high = Math.max(open, close) + Math.abs(step) * 0.4;
    const low = Math.min(open, close) - Math.abs(step) * 0.3;
    out.push({
      time: baseTime + i * 300,
      open,
      high,
      low,
      close,
      volume: 100 + i,
    });
    price = close;
  }
  return out;
}

describe('Technical Indicator Engine (Phase 2)', () => {
  it('computes EMA 9, 21, 50 accurately in an uptrend', () => {
    const candles = makeTrendingCandles(80);
    const closes = candles.map((c) => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);

    const last = closes.length - 1;
    expect(ema9[last]).toBeGreaterThan(ema21[last]);
    expect(ema21[last]).toBeGreaterThan(ema50[last]);
  });

  it('computes Wilder RSI(14) bounded in [0, 100]', () => {
    const upCandles = makeTrendingCandles(40, 1.08, 0.0004);
    const rsiUp = calculateRSI(upCandles.map((c) => c.close), 14);
    expect(rsiUp[39]).toBeGreaterThan(70);
    expect(rsiUp[39]).toBeLessThanOrEqual(100);

    const downCandles = makeTrendingCandles(40, 1.12, -0.0004);
    const rsiDown = calculateRSI(downCandles.map((c) => c.close), 14);
    expect(rsiDown[39]).toBeLessThan(30);
    expect(rsiDown[39]).toBeGreaterThanOrEqual(0);
  });

  it('computes MACD(12,26,9), ATR(14), ADX(14) and Bollinger Bands', () => {
    const candles = makeTrendingCandles(90, 1.08, 0.0003);
    const closes = candles.map((c) => c.close);

    const macd = calculateMACD(closes, 12, 26, 9);
    expect(macd.macdLine[89]).toBeGreaterThan(0);
    expect(Number.isFinite(macd.histogram[89])).toBe(true);

    const atr = calculateATR(candles, 14);
    expect(atr[89]).toBeGreaterThan(0);

    const adx = calculateADX(candles, 14);
    expect(adx.adx[89]).toBeGreaterThan(20);
    expect(adx.plusDI[89]).toBeGreaterThan(adx.minusDI[89]);

    const bb = calculateBollingerBands(closes, 20, 2);
    expect(bb.upper[89]).toBeGreaterThan(bb.middle[89]);
    expect(bb.middle[89]).toBeGreaterThan(bb.lower[89]);
  });

  it('handles VWAP volume nature transparently when volume is absent', () => {
    const noVol = makeTrendingCandles(30).map((c) => ({ ...c, volume: 0 }));
    const res = calculateVWAP(noVol, 'TICK_VOLUME');
    expect(res.volumeType).toBe('NO_VOLUME_DATA');
    expect(res.values.every((v) => v === null)).toBe(true);

    const withVol = makeTrendingCandles(30);
    const resOk = calculateVWAP(withVol, 'FUTURES_VOLUME');
    expect(resOk.volumeType).toBe('FUTURES_VOLUME');
    expect(resOk.values[29]).not.toBeNull();
  });

  it('distinguishes confirmed breakouts from false breakouts and detects candle patterns', () => {
    const candles = makeTrendingCandles(10, 1.1, 0.0001);
    const falseBull: Candle = {
      time: 1700005000,
      open: 1.1015,
      high: 1.1030,
      low: 1.1008,
      close: 1.1009,
      volume: 100,
    };
    const status = detectBreakoutAndFalseBreakout(
      [...candles, falseBull],
      [1.1],
      [1.102]
    );
    expect(status).toBe('FALSE_BULL_BREAKOUT');

    const hammer: Candle = {
      time: 1700005300,
      open: 1.1010,
      high: 1.1012,
      low: 1.0980,
      close: 1.1011,
      volume: 100,
    };
    const pa = detectCandlePatterns([candles[0], hammer]);
    expect(pa.patterns).toContain('Pin Bar Alta / Martelo');
    expect(pa.bias).toBe('BULLISH');
  });

  it('excludes unclosed latest bar when closedCandlesOnly = true (zero look-ahead)', () => {
    const candles = makeTrendingCandles(70, 1.08, 0.0003);
    const snapClosed = computeIndicatorSnapshot(candles, 'TICK_VOLUME', true);
    expect(snapClosed).not.toBeNull();
    expect(snapClosed!.candleTime).toBe(candles[candles.length - 2].time);
    expect(snapClosed!.indicatorDirections.rsi).toBe('SUBIDA');
    expect(snapClosed!.indicatorDirections.adx).toBe('SUBIDA');

    const downCandles = makeTrendingCandles(70, 1.15, -0.0003);
    const snapDown = computeIndicatorSnapshot(downCandles, 'TICK_VOLUME', true);
    expect(snapDown!.indicatorDirections.rsi).toBe('DESCIDA');
    expect(snapDown!.indicatorDirections.adx).toBe('DESCIDA');
  });
});
