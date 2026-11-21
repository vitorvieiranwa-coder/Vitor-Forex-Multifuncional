import { calculatePositionSize, evaluateTrendReversal } from './positionMonitor';
import { evaluateStrategyForInstrument } from './strategy';
import {
  Candle,
  DEFAULT_USER_SETTINGS,
  INSTRUMENTS,
  InstrumentId,
  Quote,
  SignalDirection,
  SignalStatus,
  StrategyType,
  Timeframe,
  UserSettings,
  VolumeNature,
  formatPrice,
  fromPipsOrPoints,
} from './types';

export interface HistoricalReplaySignal {
  id: string;
  instrument: InstrumentId;
  direction: SignalDirection;
  strategy: StrategyType;
  timeframe: Timeframe;
  executionType: 'IMMEDIATE' | 'CONDITIONAL';
  status: Extract<
    SignalStatus,
    'TP_ATINGIDO' | 'SL_ATINGIDO' | 'ENCERRADO_MANUALMENTE' | 'INVALIDADO' | 'EXPIRADO'
  >;
  score: number;
  recommendedEntry: number;
  actualEntry?: number;
  takeProfit: number;
  stopLoss: number;
  observedSpread: number;
  lots: number;
  indicatorsSummary: string;
  rationale: string;
  sourceType: 'BACKTEST_HISTORICAL';
  closeReason: string;
  resultR: number;
  resultMonetary: number;
  reversalAlertIssued: boolean;
  emittedAtUtc: string;
  closedAtUtc: string;
  exitPrice?: number;
}

export interface DayReplaySummary {
  targetDateUtc: string;
  totalSignals: number;
  executedTrades: number;
  wins: number;
  losses: number;
  breakEvens: number;
  expiredOrInvalidated: number;
  netR: number;
  netMonetaryUsd: number;
  byInstrument: Array<{
    instrument: InstrumentId;
    signals: number;
    executed: number;
    wins: number;
    losses: number;
    netR: number;
    netMonetaryUsd: number;
  }>;
  signals: HistoricalReplaySignal[];
}

const TYPICAL_SPREAD_PIPS: Record<InstrumentId, number> = {
  'EUR/USD': 1.0,
  'GBP/USD': 1.2,
  'EUR/JPY': 1.4,
  'GBP/JPY': 1.8,
  'XAU/USD': 0.35,
};

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 120);
}

/**
 * Replays a full historical UTC trading day strictly causally (zero look-ahead)
 * for one instrument and strategy using real M5/M15/H1 OHLC candles.
 */
export function replayInstrumentDay(params: {
  instrument: InstrumentId;
  strategy: StrategyType;
  targetDateUtc: string; // e.g. '2026-11-20'
  m5Candles: Candle[];
  m15Candles: Candle[];
  h1Candles: Candle[];
  volumeType: VolumeNature;
  sourceLabel: string;
  settings?: Pick<
    UserSettings,
    | 'riskPercentPerTrade'
    | 'referenceCapital'
    | 'scalpingTargetPips'
    | 'intradayTargetPips'
    | 'xauScalpingDistance'
    | 'xauIntradayDistance'
    | 'minRiskReward'
  >;
  useBreakEvenAt1R?: boolean;
}): HistoricalReplaySignal[] {
  const {
    instrument,
    strategy,
    targetDateUtc,
    m5Candles,
    m15Candles,
    h1Candles,
    volumeType,
    sourceLabel,
    useBreakEvenAt1R = true,
  } = params;
  const settings = params.settings ?? DEFAULT_USER_SETTINGS;

  const spec = INSTRUMENTS[instrument];
  const spreadPips = TYPICAL_SPREAD_PIPS[instrument];
  const spreadAbs = fromPipsOrPoints(instrument, spreadPips);
  const slippageAbs = fromPipsOrPoints(instrument, spec.isMetal ? 0.1 : 0.2);

  const sortedM5 = [...m5Candles].sort((a, b) => a.time - b.time);
  const sortedM15 = [...m15Candles].sort((a, b) => a.time - b.time);
  const sortedH1 = [...h1Candles].sort((a, b) => a.time - b.time);

  const dayStartSec = Math.floor(Date.parse(`${targetDateUtc}T00:00:00.000Z`) / 1000);
  const dayEndSec = dayStartSec + 86400;

  const targetBars = sortedM5.filter((c) => c.time >= dayStartSec && c.time < dayEndSec);
  if (targetBars.length === 0) return [];

  const results: HistoricalReplaySignal[] = [];

  let activeTrade: {
    id: string;
    emittedAtUtc: string;
    direction: SignalDirection;
    executionType: 'IMMEDIATE' | 'CONDITIONAL';
    recommendedEntry: number;
    entryPrice: number;
    takeProfit: number;
    stopLoss: number;
    initialStopLoss: number;
    initialRiskDist: number;
    movedToBreakEven: boolean;
    score: number;
    lots: number;
    indicatorsSummary: string;
    rationale: string;
  } | null = null;

  let pendingOrder: {
    id: string;
    emittedAtUtc: string;
    direction: SignalDirection;
    recommendedEntry: number;
    takeProfit: number;
    stopLoss: number;
    score: number;
    lots: number;
    indicatorsSummary: string;
    rationale: string;
    expiresAtTime: number;
  } | null = null;

  let lastEvaluatedM15Time = 0;

  for (let idx = 0; idx < targetBars.length; idx++) {
    const bar = targetBars[idx];
    const barIso = new Date(bar.time * 1000).toISOString();

    const m5Slice = sortedM5.filter((c) => c.time <= bar.time);
    const m15Slice = sortedM15.filter((c) => c.time <= bar.time);
    const h1Slice = sortedH1.filter((c) => c.time <= bar.time);

    // 1. Check pending conditional order
    if (!activeTrade && pendingOrder) {
      const bidLow = bar.low;
      const bidHigh = bar.high;
      const askLow = bar.low + spreadAbs;
      const askHigh = bar.high + spreadAbs;

      const invalidated =
        pendingOrder.direction === 'BUY'
          ? bidLow <= pendingOrder.stopLoss
          : askHigh >= pendingOrder.stopLoss;

      if (invalidated) {
        results.push({
          id: pendingOrder.id,
          instrument,
          direction: pendingOrder.direction,
          strategy,
          timeframe: strategy === 'SCALPING' ? 'M5' : 'M15',
          executionType: 'CONDITIONAL',
          status: 'INVALIDADO',
          score: pendingOrder.score,
          recommendedEntry: pendingOrder.recommendedEntry,
          takeProfit: pendingOrder.takeProfit,
          stopLoss: pendingOrder.stopLoss,
          observedSpread: spreadPips,
          lots: pendingOrder.lots,
          indicatorsSummary: pendingOrder.indicatorsSummary,
          rationale: pendingOrder.rationale,
          sourceType: 'BACKTEST_HISTORICAL',
          closeReason: `[${barIso.slice(11, 16)} UTC] Sinal condicionado invalidado antes da execução (SL atingido).`,
          resultR: 0,
          resultMonetary: 0,
          reversalAlertIssued: false,
          emittedAtUtc: pendingOrder.emittedAtUtc,
          closedAtUtc: barIso,
        });
        pendingOrder = null;
      } else if (bar.time > pendingOrder.expiresAtTime) {
        results.push({
          id: pendingOrder.id,
          instrument,
          direction: pendingOrder.direction,
          strategy,
          timeframe: strategy === 'SCALPING' ? 'M5' : 'M15',
          executionType: 'CONDITIONAL',
          status: 'EXPIRADO',
          score: pendingOrder.score,
          recommendedEntry: pendingOrder.recommendedEntry,
          takeProfit: pendingOrder.takeProfit,
          stopLoss: pendingOrder.stopLoss,
          observedSpread: spreadPips,
          lots: pendingOrder.lots,
          indicatorsSummary: pendingOrder.indicatorsSummary,
          rationale: pendingOrder.rationale,
          sourceType: 'BACKTEST_HISTORICAL',
          closeReason: `[${barIso.slice(11, 16)} UTC] Ordem condicionada expirou sem pullback até ao nível previsto.`,
          resultR: 0,
          resultMonetary: 0,
          reversalAlertIssued: false,
          emittedAtUtc: pendingOrder.emittedAtUtc,
          closedAtUtc: barIso,
        });
        pendingOrder = null;
      } else {
        const filled =
          pendingOrder.direction === 'BUY'
            ? askLow <= pendingOrder.recommendedEntry
            : bidHigh >= pendingOrder.recommendedEntry;

        if (filled) {
          const entryPrice = pendingOrder.recommendedEntry;
          activeTrade = {
            id: pendingOrder.id,
            emittedAtUtc: pendingOrder.emittedAtUtc,
            direction: pendingOrder.direction,
            executionType: 'CONDITIONAL',
            recommendedEntry: pendingOrder.recommendedEntry,
            entryPrice,
            takeProfit: pendingOrder.takeProfit,
            stopLoss: pendingOrder.stopLoss,
            initialStopLoss: pendingOrder.stopLoss,
            initialRiskDist: Math.abs(entryPrice - pendingOrder.stopLoss),
            movedToBreakEven: false,
            score: pendingOrder.score,
            lots: pendingOrder.lots,
            indicatorsSummary: pendingOrder.indicatorsSummary,
            rationale: pendingOrder.rationale,
          };
          pendingOrder = null;
          continue; // Do not evaluate exit on fill bar
        }
      }
    }

    // 2. Check active trade exits (TP / SL / Break-Even / Trend Reversal)
    if (activeTrade) {
      const bidLow = bar.low;
      const bidHigh = bar.high;
      const askLow = bar.low + spreadAbs;
      const askHigh = bar.high + spreadAbs;

      let exitPrice: number | null = null;
      let status: HistoricalReplaySignal['status'] | null = null;
      let closeReason = '';
      let reversalAlertIssued = false;

      if (activeTrade.direction === 'BUY') {
        if (bidLow <= activeTrade.stopLoss) {
          exitPrice = activeTrade.stopLoss - slippageAbs;
          status = activeTrade.movedToBreakEven ? 'ENCERRADO_MANUALMENTE' : 'SL_ATINGIDO';
          closeReason = activeTrade.movedToBreakEven
            ? `[${barIso.slice(11, 16)} UTC] Proteção Break-Even (+1.0R) atingida a ${formatPrice(instrument, exitPrice)}.`
            : `[${barIso.slice(11, 16)} UTC] Stop Loss atingido a ${formatPrice(instrument, exitPrice)}.`;
        } else if (bidHigh >= activeTrade.takeProfit) {
          exitPrice = activeTrade.takeProfit - slippageAbs;
          status = 'TP_ATINGIDO';
          closeReason = `[${barIso.slice(11, 16)} UTC] Take Profit atingido a ${formatPrice(instrument, exitPrice)}.`;
        }
      } else {
        if (askHigh >= activeTrade.stopLoss) {
          exitPrice = activeTrade.stopLoss + slippageAbs;
          status = activeTrade.movedToBreakEven ? 'ENCERRADO_MANUALMENTE' : 'SL_ATINGIDO';
          closeReason = activeTrade.movedToBreakEven
            ? `[${barIso.slice(11, 16)} UTC] Proteção Break-Even (+1.0R) atingida a ${formatPrice(instrument, exitPrice)}.`
            : `[${barIso.slice(11, 16)} UTC] Stop Loss atingido a ${formatPrice(instrument, exitPrice)}.`;
        } else if (askLow <= activeTrade.takeProfit) {
          exitPrice = activeTrade.takeProfit + slippageAbs;
          status = 'TP_ATINGIDO';
          closeReason = `[${barIso.slice(11, 16)} UTC] Take Profit atingido a ${formatPrice(instrument, exitPrice)}.`;
        }
      }

      if (!status && useBreakEvenAt1R && !activeTrade.movedToBreakEven && activeTrade.initialRiskDist > 0) {
        if (
          activeTrade.direction === 'BUY' &&
          bidHigh >= activeTrade.entryPrice + activeTrade.initialRiskDist
        ) {
          activeTrade.stopLoss = activeTrade.entryPrice + spreadAbs * 0.25;
          activeTrade.movedToBreakEven = true;
        } else if (
          activeTrade.direction === 'SELL' &&
          askLow <= activeTrade.entryPrice - activeTrade.initialRiskDist
        ) {
          activeTrade.stopLoss = activeTrade.entryPrice - spreadAbs * 0.25;
          activeTrade.movedToBreakEven = true;
        }
      }

      if (!status && m5Slice.length >= 60 && m15Slice.length >= 60) {
        const rev = evaluateTrendReversal(
          activeTrade.direction,
          instrument,
          { M5: m5Slice, M15: m15Slice },
          volumeType
        );
        if (rev.shouldRecommendExit) {
          exitPrice =
            activeTrade.direction === 'BUY'
              ? bar.close - slippageAbs
              : bar.close + spreadAbs + slippageAbs;
          status = 'ENCERRADO_MANUALMENTE';
          reversalAlertIssued = true;
          closeReason = `[${barIso.slice(11, 16)} UTC] Encerramento antecipado por inversão de tendência (${rev.triggeredCount} critérios): ${rev.reasons.slice(0, 2).join(' · ')}`;
        }
      }

      // Close at end of trading day if still open on final bar
      const isLastBar = idx === targetBars.length - 1;
      if (!status && isLastBar) {
        exitPrice =
          activeTrade.direction === 'BUY'
            ? bar.close - slippageAbs
            : bar.close + spreadAbs + slippageAbs;
        status = 'ENCERRADO_MANUALMENTE';
        closeReason = `[${barIso.slice(11, 16)} UTC] Fecho de sessão de ${targetDateUtc} a ${formatPrice(instrument, exitPrice)}.`;
      }

      if (status && exitPrice !== null) {
        const diff =
          activeTrade.direction === 'BUY'
            ? exitPrice - activeTrade.entryPrice
            : activeTrade.entryPrice - exitPrice;
        const resultR =
          activeTrade.initialRiskDist > 0
            ? Number((diff / activeTrade.initialRiskDist).toFixed(2))
            : 0;
        const pips = diff / spec.pipSize;
        const resultMonetary = Number(
          (pips * spec.pipValuePerStandardLot * activeTrade.lots).toFixed(2)
        );

        results.push({
          id: activeTrade.id,
          instrument,
          direction: activeTrade.direction,
          strategy,
          timeframe: strategy === 'SCALPING' ? 'M5' : 'M15',
          executionType: activeTrade.executionType,
          status,
          score: activeTrade.score,
          recommendedEntry: activeTrade.recommendedEntry,
          actualEntry: activeTrade.entryPrice,
          takeProfit: activeTrade.takeProfit,
          stopLoss: activeTrade.initialStopLoss,
          observedSpread: spreadPips,
          lots: activeTrade.lots,
          indicatorsSummary: activeTrade.indicatorsSummary,
          rationale: activeTrade.rationale,
          sourceType: 'BACKTEST_HISTORICAL',
          closeReason,
          resultR,
          resultMonetary,
          reversalAlertIssued,
          emittedAtUtc: activeTrade.emittedAtUtc,
          closedAtUtc: barIso,
          exitPrice,
        });

        activeTrade = null;
        continue;
      }
    }

    // 3. Evaluate new candidate signal when flat (INTRADAY only on new M15 closes)
    if (!activeTrade && !pendingOrder && idx < targetBars.length - 2) {
      if (strategy === 'INTRADAY') {
        const latestM15 = m15Slice[m15Slice.length - 1];
        if (!latestM15 || latestM15.time <= lastEvaluatedM15Time) {
          continue;
        }
        lastEvaluatedM15Time = latestM15.time;
      }

      if (h1Slice.length < 55 || m15Slice.length < 55 || m5Slice.length < 55) {
        continue;
      }

      const quote: Quote = {
        instrument,
        bid: bar.close,
        ask: bar.close + spreadAbs,
        mid: bar.close + spreadAbs / 2,
        spread: spreadAbs,
        spreadPips,
        changePct: 0,
        timestampUtc: barIso,
        ageMs: 0,
        source: sourceLabel,
        marketOpen: true,
      };

      const candidate = evaluateStrategyForInstrument(
        {
          instrument,
          quote,
          candlesByTf: {
            H1: h1Slice,
            M15: m15Slice,
            M5: m5Slice,
            M1: m5Slice,
          },
          volumeType,
          settings: {
            scalpingTargetPips: settings.scalpingTargetPips,
            intradayTargetPips: settings.intradayTargetPips,
            xauScalpingDistance: settings.xauScalpingDistance,
            xauIntradayDistance: settings.xauIntradayDistance,
            minRiskReward: settings.minRiskReward,
          },
        },
        strategy,
        false
      );

      if (candidate && candidate.actionable && candidate.direction) {
        const signalId = sanitizeId(
          `REPLAY_${targetDateUtc.replace(/-/g, '')}_${instrument.replace('/', '')}_${strategy}_${candidate.direction}_${bar.time}`
        );
        const stampedRationale = `[Histórico Real ${barIso.slice(0, 16).replace('T', ' ')} UTC · ${sourceLabel}] ${candidate.rationale}`;

        if (candidate.executionType === 'CONDITIONAL') {
          const sizing = calculatePositionSize(
            instrument,
            candidate.recommendedEntry,
            candidate.stopLoss,
            settings.referenceCapital,
            settings.riskPercentPerTrade
          );
          pendingOrder = {
            id: signalId,
            emittedAtUtc: barIso,
            direction: candidate.direction,
            recommendedEntry: candidate.recommendedEntry,
            takeProfit: candidate.takeProfit,
            stopLoss: candidate.stopLoss,
            score: candidate.score.total,
            lots: sizing.lots,
            indicatorsSummary: candidate.indicatorsJustification.join(' | '),
            rationale: stampedRationale,
            expiresAtTime: bar.time + (strategy === 'SCALPING' ? 30 * 60 : 90 * 60),
          };
        } else {
          const entryWithSlippage =
            candidate.direction === 'BUY'
              ? candidate.recommendedEntry + slippageAbs
              : candidate.recommendedEntry - slippageAbs;
          const sizing = calculatePositionSize(
            instrument,
            entryWithSlippage,
            candidate.stopLoss,
            settings.referenceCapital,
            settings.riskPercentPerTrade
          );
          activeTrade = {
            id: signalId,
            emittedAtUtc: barIso,
            direction: candidate.direction,
            executionType: 'IMMEDIATE',
            recommendedEntry: candidate.recommendedEntry,
            entryPrice: entryWithSlippage,
            takeProfit: candidate.takeProfit,
            stopLoss: candidate.stopLoss,
            initialStopLoss: candidate.stopLoss,
            initialRiskDist: Math.abs(entryWithSlippage - candidate.stopLoss),
            movedToBreakEven: false,
            score: candidate.score.total,
            lots: sizing.lots,
            indicatorsSummary: candidate.indicatorsJustification.join(' | '),
            rationale: stampedRationale,
          };
        }
      }
    }
  }

  // Handle leftover pendingOrder at day end
  if (pendingOrder) {
    const lastBarIso = new Date(targetBars[targetBars.length - 1].time * 1000).toISOString();
    results.push({
      id: pendingOrder.id,
      instrument,
      direction: pendingOrder.direction,
      strategy,
      timeframe: strategy === 'SCALPING' ? 'M5' : 'M15',
      executionType: 'CONDITIONAL',
      status: 'EXPIRADO',
      score: pendingOrder.score,
      recommendedEntry: pendingOrder.recommendedEntry,
      takeProfit: pendingOrder.takeProfit,
      stopLoss: pendingOrder.stopLoss,
      observedSpread: spreadPips,
      lots: pendingOrder.lots,
      indicatorsSummary: pendingOrder.indicatorsSummary,
      rationale: pendingOrder.rationale,
      sourceType: 'BACKTEST_HISTORICAL',
      closeReason: `[${lastBarIso.slice(11, 16)} UTC] Sessão de ${targetDateUtc} encerrada sem execução da ordem condicionada.`,
      resultR: 0,
      resultMonetary: 0,
      reversalAlertIssued: false,
      emittedAtUtc: pendingOrder.emittedAtUtc,
      closedAtUtc: lastBarIso,
    });
  }

  return results;
}

export function summarizeDayReplay(
  targetDateUtc: string,
  signals: HistoricalReplaySignal[]
): DayReplaySummary {
  const sorted = [...signals].sort((a, b) => a.emittedAtUtc.localeCompare(b.emittedAtUtc));
  const executed = sorted.filter(
    (s) => s.status !== 'EXPIRADO' && s.status !== 'INVALIDADO'
  );
  const wins = executed.filter((s) => s.resultR > 0.05).length;
  const losses = executed.filter((s) => s.resultR < -0.05).length;
  const breakEvens = executed.length - wins - losses;
  const netR = Number(executed.reduce((acc, s) => acc + s.resultR, 0).toFixed(2));
  const netMonetaryUsd = Number(
    executed.reduce((acc, s) => acc + s.resultMonetary, 0).toFixed(2)
  );

  const instruments: InstrumentId[] = ['EUR/USD', 'GBP/USD', 'EUR/JPY', 'GBP/JPY', 'XAU/USD'];
  const byInstrument = instruments.map((inst) => {
    const subAll = sorted.filter((s) => s.instrument === inst);
    const subExec = subAll.filter(
      (s) => s.status !== 'EXPIRADO' && s.status !== 'INVALIDADO'
    );
    return {
      instrument: inst,
      signals: subAll.length,
      executed: subExec.length,
      wins: subExec.filter((s) => s.resultR > 0.05).length,
      losses: subExec.filter((s) => s.resultR < -0.05).length,
      netR: Number(subExec.reduce((a, b) => a + b.resultR, 0).toFixed(2)),
      netMonetaryUsd: Number(subExec.reduce((a, b) => a + b.resultMonetary, 0).toFixed(2)),
    };
  });

  return {
    targetDateUtc,
    totalSignals: sorted.length,
    executedTrades: executed.length,
    wins,
    losses,
    breakEvens,
    expiredOrInvalidated: sorted.length - executed.length,
    netR,
    netMonetaryUsd,
    byInstrument,
    signals: sorted,
  };
}
