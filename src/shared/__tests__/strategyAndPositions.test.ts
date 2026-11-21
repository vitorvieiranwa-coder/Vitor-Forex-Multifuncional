import { describe, expect, it } from 'vitest';
import {
  calculatePositionSize,
  detectCorrelatedExposure,
  evaluateRiskStatus,
  evaluateTrackedSignal,
  evaluateTrendReversal,
} from '../positionMonitor';
import {
  classifyScore,
  evaluateStrategyForInstrument,
  evaluateTradingSession,
} from '../strategy';
import {
  Candle,
  DEFAULT_USER_SETTINGS,
  Quote,
  TradingSignalRecord,
} from '../types';

function makeSeries(
  count: number,
  start: number,
  step: number,
  stepSec: number
): Candle[] {
  const base = 1700000000;
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    const wiggle = i % 4 === 0 ? -step * 0.25 : step * 1.15;
    const open = p;
    const close = p + wiggle;
    const high = Math.max(open, close) + Math.abs(step) * 0.6;
    const low = Math.min(open, close) - Math.abs(step) * 0.5;
    out.push({
      time: base + i * stepSec,
      open,
      high,
      low,
      close,
      volume: 250,
    });
    p = close;
  }
  return out;
}

describe('Strategy, Scoring, TP/SL & Position Engine (Phases 3 & 4)', () => {
  it('classifies 0-100 scores according to strict thresholds', () => {
    expect(classifyScore(95)).toBe('SINAL_FORTE');
    expect(classifyScore(84)).toBe('SINAL_FAVORAVEL');
    expect(classifyScore(74)).toBe('EM_OBSERVACAO');
    expect(classifyScore(65)).toBe('SEM_ENTRADA');
  });

  it('evaluates XAU/USD using USD distance instead of Forex pip definition', () => {
    const h1 = makeSeries(90, 2600, 1.5, 3600);
    const m15 = makeSeries(90, 2680, 0.8, 900);
    const m5 = makeSeries(90, 2710, 0.4, 300);
    const m1 = makeSeries(90, 2730, 0.15, 60);
    const lastClose = m5[m5.length - 1].close;

    const quote: Quote = {
      instrument: 'XAU/USD',
      bid: lastClose,
      ask: lastClose + 0.35,
      mid: lastClose + 0.175,
      spread: 0.35,
      spreadPips: 0.35,
      changePct: 0.8,
      timestampUtc: '2026-11-20T14:00:00.000Z',
      ageMs: 100,
      source: 'Test',
      marketOpen: true,
    };

    const cand = evaluateStrategyForInstrument(
      {
        instrument: 'XAU/USD',
        quote,
        candlesByTf: { H1: h1, M15: m15, M5: m5, M1: m1 },
        volumeType: 'FUTURES_VOLUME',
        settings: DEFAULT_USER_SETTINGS,
      },
      'SCALPING',
      false
    );

    expect(cand).not.toBeNull();
    expect(cand!.direction).toBe('BUY');
    expect(cand!.takeProfit - cand!.recommendedEntry).toBeGreaterThan(2.0);
    expect(cand!.takeProfit - cand!.recommendedEntry).toBeLessThanOrEqual(8.0);
    expect(cand!.riskReward).toBeGreaterThanOrEqual(1.5);
    expect(cand!.intradayContext.sessionQuality).toBe('LONDON_NY_OVERLAP');
  });

  it('evaluates BUY position against Bid and prevents double-closing terminal signals', () => {
    const sig: TradingSignalRecord = {
      id: 'sig_1',
      userId: 'user_1',
      instrument: 'EUR/USD',
      direction: 'BUY',
      strategy: 'SCALPING',
      timeframe: 'M5',
      executionType: 'IMMEDIATE',
      status: 'POSICAO_ABERTA',
      score: 88,
      recommendedEntry: 1.1,
      actualEntry: 1.1,
      takeProfit: 1.1015,
      stopLoss: 1.099,
      observedSpread: 0.8,
      lots: 0.5,
      indicatorsSummary: 'Test',
      rationale: 'Test',
      sourceType: 'LIVE_SIGNAL',
      reversalAlertIssued: false,
    };

    const tpQuote: Quote = {
      instrument: 'EUR/USD',
      bid: 1.1016,
      ask: 1.1017,
      mid: 1.10165,
      spread: 0.0001,
      spreadPips: 1.0,
      changePct: 0.1,
      timestampUtc: new Date().toISOString(),
      ageMs: 0,
      source: 'Test',
      marketOpen: true,
    };

    const evalTp = evaluateTrackedSignal(sig, tpQuote);
    expect(evalTp?.newStatus).toBe('TP_ATINGIDO');
    expect(evalTp?.resultR).toBe(1.5);

    const terminalSig: TradingSignalRecord = { ...sig, status: 'TP_ATINGIDO' };
    expect(evaluateTrackedSignal(terminalSig, tpQuote)).toBeNull();
  });

  it('requires multi-indicator confluence (>=3) before issuing trend reversal alert', () => {
    const m5Bear = makeSeries(90, 1.12, -0.0004, 300);
    const m15Bear = makeSeries(90, 1.13, -0.0006, 900);

    const rev = evaluateTrendReversal(
      'BUY',
      'EUR/USD',
      { M5: m5Bear, M15: m15Bear },
      'TICK_VOLUME'
    );
    expect(rev.shouldRecommendExit).toBe(true);
    expect(rev.triggeredCount).toBeGreaterThanOrEqual(3);
    expect(rev.alertTitle).toBe('RECOMENDAÇÃO DE ENCERRAMENTO — EUR/USD — POSIÇÃO BUY');
  });

  it('calculates position size and enforces consecutive loss pause', () => {
    const sizing = calculatePositionSize('EUR/USD', 1.1, 1.099, 10000, 0.25);
    expect(sizing.riskAmountUsd).toBe(25);
    expect(sizing.stopDistancePipsOrPoints).toBe(10);
    expect(sizing.lots).toBe(0.25);

    const losses: TradingSignalRecord[] = [1, 2].map((i) => ({
      id: `s_${i}`,
      userId: 'u1',
      instrument: 'EUR/USD',
      direction: 'BUY',
      strategy: 'SCALPING',
      timeframe: 'M5',
      executionType: 'IMMEDIATE',
      status: 'SL_ATINGIDO',
      score: 82,
      recommendedEntry: 1.1,
      takeProfit: 1.1015,
      stopLoss: 1.099,
      observedSpread: 1,
      indicatorsSummary: 'x',
      rationale: 'x',
      sourceType: 'LIVE_SIGNAL',
      resultR: -1,
      reversalAlertIssued: false,
      closedAt: Date.now() + i,
    }));

    const risk = evaluateRiskStatus(losses, {
      referenceCapital: 10000,
      dailyLossLimitPercent: 1.0,
      maxOpenPositions: 3,
      maxConsecutiveLosses: 2,
      autoPauseOnLimit: true,
    });
    expect(risk.paused).toBe(true);
    expect(risk.consecutiveLosses).toBe(2);
  });

  it('enforces intraday session quality gates and blocks rollover dead zone', () => {
    const rollover = evaluateTradingSession('EUR/USD', new Date('2026-11-20T22:15:00.000Z'));
    expect(rollover.quality).toBe('ROLLOVER_DEAD_ZONE');
    expect(rollover.allowActionable).toBe(false);

    const overlap = evaluateTradingSession('EUR/USD', new Date('2026-11-20T14:00:00.000Z'));
    expect(overlap.quality).toBe('LONDON_NY_OVERLAP');
    expect(overlap.allowActionable).toBe(true);
    expect(overlap.minRequiredScore).toBe(80);

    const tokyoEur = evaluateTradingSession('EUR/USD', new Date('2026-11-20T03:00:00.000Z'));
    expect(tokyoEur.quality).toBe('TOKYO_SESSION');
    expect(tokyoEur.minRequiredScore).toBe(85);

    const tokyoJpy = evaluateTradingSession('EUR/JPY', new Date('2026-11-20T03:00:00.000Z'));
    expect(tokyoJpy.minRequiredScore).toBe(80);

    const h1 = makeSeries(90, 1.08, 0.0006, 3600);
    const m15 = makeSeries(90, 1.1, 0.0003, 900);
    const m5 = makeSeries(90, 1.11, 0.00015, 300);
    const m1 = makeSeries(90, 1.12, 0.00005, 60);
    const lastClose = m5[m5.length - 1].close;

    const rolloverCand = evaluateStrategyForInstrument(
      {
        instrument: 'EUR/USD',
        quote: {
          instrument: 'EUR/USD',
          bid: lastClose,
          ask: lastClose + 0.0001,
          mid: lastClose + 0.00005,
          spread: 0.0001,
          spreadPips: 1.0,
          changePct: 0.2,
          timestampUtc: '2026-11-20T22:15:00.000Z',
          ageMs: 0,
          source: 'Test',
          marketOpen: true,
        },
        candlesByTf: { H1: h1, M15: m15, M5: m5, M1: m1 },
        volumeType: 'TICK_VOLUME',
        settings: DEFAULT_USER_SETTINGS,
      },
      'INTRADAY',
      false
    );
    expect(rolloverCand).not.toBeNull();
    expect(rolloverCand!.intradayContext.sessionQuality).toBe('ROLLOVER_DEAD_ZONE');
    expect(rolloverCand!.actionable).toBe(false);
  });

  it('detects correlated exposure and provides +1.0R BE / +1.5R ATR trailing guidance', () => {
    const openEur: TradingSignalRecord = {
      id: 'sig_eur',
      userId: 'u1',
      instrument: 'EUR/USD',
      direction: 'BUY',
      strategy: 'INTRADAY',
      timeframe: 'M15',
      executionType: 'IMMEDIATE',
      status: 'POSICAO_ABERTA',
      score: 86,
      recommendedEntry: 1.08,
      actualEntry: 1.08,
      takeProfit: 1.083,
      stopLoss: 1.079,
      observedSpread: 0.9,
      lots: 0.2,
      indicatorsSummary: 'x',
      rationale: 'x',
      sourceType: 'LIVE_SIGNAL',
      reversalAlertIssued: false,
    };

    const corrGbp = detectCorrelatedExposure('GBP/USD', 'BUY', [openEur]);
    expect(corrGbp.hasRisk).toBe(true);
    expect(corrGbp.warnings.length).toBeGreaterThan(0);

    const corrOpp = detectCorrelatedExposure('GBP/USD', 'SELL', [openEur]);
    expect(corrOpp.hasRisk).toBe(false);

    // At +1.1R unrealized profit -> Break-Even guidance
    const beEval = evaluateTrackedSignal(openEur, {
      instrument: 'EUR/USD',
      bid: 1.0811,
      ask: 1.0812,
      mid: 1.08115,
      spread: 0.0001,
      spreadPips: 1.0,
      changePct: 0.1,
      timestampUtc: '2026-11-20T14:05:00.000Z',
      ageMs: 0,
      source: 'Test',
      marketOpen: true,
    });
    expect(beEval?.managementGuidance.breakEvenRecommended).toBe(true);
    expect(beEval?.managementGuidance.suggestedStopLoss).toBeGreaterThanOrEqual(1.08);

    // At +1.8R with bullish M5/M15 candles -> Trailing ATR guidance
    const bullM5 = makeSeries(90, 1.078, 0.00005, 300);
    const bullM15 = makeSeries(90, 1.076, 0.0001, 900);
    const trailEval = evaluateTrackedSignal(
      openEur,
      {
        instrument: 'EUR/USD',
        bid: 1.0818,
        ask: 1.0819,
        mid: 1.08185,
        spread: 0.0001,
        spreadPips: 1.0,
        changePct: 0.2,
        timestampUtc: '2026-11-20T14:15:00.000Z',
        ageMs: 0,
        source: 'Test',
        marketOpen: true,
      },
      { M5: bullM5, M15: bullM15 },
      'TICK_VOLUME'
    );
    expect(trailEval?.managementGuidance.trailingStopActive).toBe(true);
    expect(trailEval?.managementGuidance.suggestedStopLoss).toBeGreaterThan(1.08);
  });

  it('forces CONDITIONAL pullback when price is stretched and blocks when S/R obstacle is too close', () => {
    const h1 = makeSeries(90, 1.08, 0.0005, 3600);
    const m15 = makeSeries(90, 1.1, 0.00025, 900);
    const m5 = makeSeries(90, 1.11, 0.00015, 300);
    const m1 = makeSeries(90, 1.115, 0.00005, 60);

    // Put a strong swing high resistance just 4 pips above current M15 price (< 0.85 * SL)
    const lastM15Close = m15[m15.length - 1].close;
    const obstacleIdx = m15.length - 5;
    m15[obstacleIdx] = {
      ...m15[obstacleIdx],
      high: lastM15Close + 0.0004,
      close: lastM15Close + 0.0001,
    };
    m15[obstacleIdx - 1] = { ...m15[obstacleIdx - 1], high: lastM15Close + 0.0001 };
    m15[obstacleIdx - 2] = { ...m15[obstacleIdx - 2], high: lastM15Close + 0.00005 };
    m15[obstacleIdx + 1] = { ...m15[obstacleIdx + 1], high: lastM15Close + 0.0001 };
    m15[obstacleIdx + 2] = { ...m15[obstacleIdx + 2], high: lastM15Close + 0.00005 };

    const cand = evaluateStrategyForInstrument(
      {
        instrument: 'EUR/USD',
        quote: {
          instrument: 'EUR/USD',
          bid: lastM15Close,
          ask: lastM15Close + 0.0001,
          mid: lastM15Close + 0.00005,
          spread: 0.0001,
          spreadPips: 1.0,
          changePct: 0.25,
          timestampUtc: '2026-11-20T14:00:00.000Z',
          ageMs: 0,
          source: 'Test',
          marketOpen: true,
        },
        candlesByTf: { H1: h1, M15: m15, M5: m5, M1: m1 },
        volumeType: 'TICK_VOLUME',
        settings: DEFAULT_USER_SETTINGS,
      },
      'INTRADAY',
      false
    );

    expect(cand).not.toBeNull();
    expect(cand!.intradayContext.entryQuality).toBe('ESTICADO');
    expect(cand!.executionType).toBe('CONDITIONAL');
    expect(cand!.intradayContext.structuralClearanceOk).toBe(false);
    expect(cand!.actionable).toBe(false);
  });
});
