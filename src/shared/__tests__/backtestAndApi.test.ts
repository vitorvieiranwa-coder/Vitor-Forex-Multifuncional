import { describe, expect, it } from 'vitest';
import { MarketDataService } from '../../../server/providers/marketDataProvider';
import { runHistoricalBacktest } from '../backtest';
import { replayInstrumentDay, summarizeDayReplay } from '../dayReplay';
import { Candle, DEFAULT_USER_SETTINGS } from '../types';

describe('Backtesting & Real Market Feed Integration (Phases 5 & 6)', () => {
  it('runs zero-look-ahead backtest accounting for spread, slippage, and commissions', () => {
    const candles: Candle[] = [];
    let price = 1.08;
    const base = 1700000000;
    for (let i = 0; i < 400; i++) {
      const wave = Math.sin(i / 25) * 0.0005 + 0.00015;
      const open = price;
      const close = price + wave;
      candles.push({
        time: base + i * 300,
        open,
        high: Math.max(open, close) + 0.0003,
        low: Math.min(open, close) - 0.0003,
        close,
        volume: 150,
      });
      price = close;
    }

    const res = runHistoricalBacktest(
      candles,
      {
        instrument: 'EUR/USD',
        strategy: 'SCALPING',
        timeframe: 'M5',
        spreadPips: 1.0,
        slippagePips: 0.2,
        commissionPerLotUsd: 7,
        riskPercentPerTrade: 0.25,
        initialCapital: 10000,
        scalpingTargetPips: 10,
        intradayTargetPips: 20,
        xauScalpingDistance: 3.5,
        xauIntradayDistance: 7.0,
        minRiskReward: 1.5,
      },
      'Test Historical OHLC'
    );

    expect(res.candlesAnalyzed).toBe(400);
    expect(res.sourceLabel).toBe('Test Historical OHLC');
    expect(typeof res.netR).toBe('number');
    expect(typeof res.maxDrawdownR).toBe('number');

    const resBe = runHistoricalBacktest(
      candles,
      {
        instrument: 'EUR/USD',
        strategy: 'INTRADAY',
        timeframe: 'M15',
        spreadPips: 1.0,
        slippagePips: 0.2,
        commissionPerLotUsd: 7,
        riskPercentPerTrade: 0.25,
        initialCapital: 10000,
        scalpingTargetPips: 10,
        intradayTargetPips: 20,
        xauScalpingDistance: 3.5,
        xauIntradayDistance: 7.0,
        minRiskReward: 1.5,
        useBreakEvenAt1R: true,
      },
      'Test Historical OHLC (BE)'
    );
    expect(resBe.candlesAnalyzed).toBe(400);
    expect(Number.isFinite(resBe.netR)).toBe(true);
  });

  it('fetches real Bid/Ask quote and real OHLC candles from MarketDataService', async () => {
    const service = new MarketDataService();
    const quote = await service.getQuote('EUR/USD');
    const candles = await service.getCandles('EUR/USD', 'M5', 100);

    expect(quote).not.toBeNull();
    expect(quote!.bid).toBeGreaterThan(0);
    expect(quote!.ask).toBeGreaterThanOrEqual(quote!.bid);

    expect(candles).not.toBeNull();
    expect(candles!.candles.length).toBeGreaterThan(50);
  }, 15000);

  it('replays 2026-11-20 real OHLC history causally and summarizes results cleanly', async () => {
    const service = new MarketDataService();
    const [m5, m15, h1] = await Promise.all([
      service.getCandles('GBP/USD', 'M5', 2000),
      service.getCandles('GBP/USD', 'M15', 1000),
      service.getCandles('GBP/USD', 'H1', 1000),
    ]);

    expect(m5).not.toBeNull();
    expect(m15).not.toBeNull();
    expect(h1).not.toBeNull();

    const sigs = replayInstrumentDay({
      instrument: 'GBP/USD',
      strategy: 'INTRADAY',
      targetDateUtc: '2026-11-20',
      m5Candles: m5!.candles,
      m15Candles: m15!.candles,
      h1Candles: h1!.candles,
      volumeType: m5!.volumeType,
      sourceLabel: m5!.source,
      settings: DEFAULT_USER_SETTINGS,
      useBreakEvenAt1R: true,
    });

    const summary = summarizeDayReplay('2026-11-20', sigs);
    expect(summary.targetDateUtc).toBe('2026-11-20');
    expect(Number.isFinite(summary.netR)).toBe(true);
    for (const s of summary.signals) {
      expect(s.id).toMatch(/^[a-zA-Z0-9_\-]+$/);
      expect(s.sourceType).toBe('BACKTEST_HISTORICAL');
      expect(s.score).toBeGreaterThanOrEqual(80);
    }
  }, 15000);
});
