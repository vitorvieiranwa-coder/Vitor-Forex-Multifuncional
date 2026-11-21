import { computeIndicatorSnapshot } from './indicators';
import {
  Candle,
  INSTRUMENTS,
  InstrumentId,
  Quote,
  ReversalAnalysis,
  SignalDirection,
  SignalStatus,
  TradingSignalRecord,
  UserSettings,
  VolumeNature,
  isTerminalStatus,
  toPipsOrPoints,
} from './types';

export interface PositionManagementGuidance {
  breakEvenRecommended: boolean;
  trailingStopActive: boolean;
  suggestedStopLoss: number | null;
  guidanceText: string | null;
}

export interface PositionEvaluationResult {
  signalId: string;
  currentExitPrice: number;
  unrealizedPipsOrPoints: number;
  unrealizedR: number;
  unrealizedMonetary: number | null;
  newStatus: SignalStatus | null;
  closeReason: string | null;
  resultR: number | null;
  resultMonetary: number | null;
  reversal: ReversalAnalysis;
  managementGuidance: PositionManagementGuidance;
}

function roundPriceForInstrument(instrument: InstrumentId, value: number): number {
  const factor = Math.pow(10, INSTRUMENTS[instrument].priceDecimals);
  return Math.round(value * factor) / factor;
}

const EMPTY_GUIDANCE: PositionManagementGuidance = {
  breakEvenRecommended: false,
  trailingStopActive: false,
  suggestedStopLoss: null,
  guidanceText: null,
};

/**
 * Evaluates 6 independent reversal criteria against an open position.
 * Never recommends closure based on a single isolated indicator (>= 3 required).
 */
export function evaluateTrendReversal(
  direction: SignalDirection,
  instrument: InstrumentId,
  candlesByTf: {
    M5: Candle[];
    M15: Candle[];
  },
  volumeType: VolumeNature
): ReversalAnalysis {
  const m5 = computeIndicatorSnapshot(candlesByTf.M5, volumeType, true);
  const m15 = computeIndicatorSnapshot(candlesByTf.M15, volumeType, true);

  if (!m5 || !m15) {
    return {
      shouldRecommendExit: false,
      triggeredCount: 0,
      reasons: [],
      alertTitle: null,
    };
  }

  const reasons: string[] = [];
  const isBuy = direction === 'BUY';

  // 1. Cruzamento de médias móveis (EMA 9 vs EMA 21)
  if ((isBuy && m5.ema9 < m5.ema21) || (!isBuy && m5.ema9 > m5.ema21)) {
    reasons.push(
      `Cruzamento EMA 9/21 contrário no M5 (EMA9=${m5.ema9.toFixed(INSTRUMENTS[instrument].priceDecimals)} vs EMA21=${m5.ema21.toFixed(INSTRUMENTS[instrument].priceDecimals)})`
    );
  }

  // 2. Inversão do MACD
  if (
    (isBuy && m5.macd.histogram < 0 && m5.macd.macdLine < m5.macd.signalLine) ||
    (!isBuy && m5.macd.histogram > 0 && m5.macd.macdLine > m5.macd.signalLine)
  ) {
    reasons.push(
      `Inversão do MACD no M5 (Histograma=${m5.macd.histogram.toFixed(5)})`
    );
  }

  // 3. Perda de momentum do RSI
  if ((isBuy && m5.rsi14 < 45) || (!isBuy && m5.rsi14 > 55)) {
    reasons.push(`Perda de momentum RSI(14)=${m5.rsi14.toFixed(1)}`);
  }

  // 4. Alteração da estrutura M15
  if (
    (isBuy && (m15.close < m15.ema21 || m15.breakout === 'BEARISH_BREAKOUT')) ||
    (!isBuy && (m15.close > m15.ema21 || m15.breakout === 'BULLISH_BREAKOUT'))
  ) {
    reasons.push(`Alteração estrutural no M15 (Fecho vs EMA21 / rutura contrária)`);
  }

  // 5. Confirmação de tendência contrária no M5
  if ((isBuy && m5.trendDirection === 'BEARISH') || (!isBuy && m5.trendDirection === 'BULLISH')) {
    reasons.push(`Confirmação de tendência ${m5.trendDirection} no M5`);
  }

  // 6. Alteração relevante do ADX (DI+ vs DI-)
  if (
    m5.adx14 >= 20 &&
    ((isBuy && m5.minusDI > m5.plusDI) || (!isBuy && m5.plusDI > m5.minusDI))
  ) {
    reasons.push(
      `Força direcional ADX=${m5.adx14.toFixed(1)} favorável à inversão (DI+=${m5.plusDI.toFixed(1)} / DI-=${m5.minusDI.toFixed(1)})`
    );
  }

  const shouldRecommendExit = reasons.length >= 3;

  return {
    shouldRecommendExit,
    triggeredCount: reasons.length,
    reasons,
    alertTitle: shouldRecommendExit
      ? `RECOMENDAÇÃO DE ENCERRAMENTO — ${instrument} — POSIÇÃO ${direction}`
      : null,
  };
}

/**
 * Evaluates a live signal or open position against current Bid/Ask quote.
 * Uses Bid to close BUY, Ask to close SELL. Prevents double-closing terminal records.
 */
export function evaluateTrackedSignal(
  signal: TradingSignalRecord,
  quote: Quote,
  candlesByTf?: { M5: Candle[]; M15: Candle[] },
  volumeType: VolumeNature = 'TICK_VOLUME'
): PositionEvaluationResult | null {
  if (isTerminalStatus(signal.status)) {
    return null;
  }

  const entry = signal.actualEntry ?? signal.recommendedEntry;
  const exitPrice = signal.direction === 'BUY' ? quote.bid : quote.ask;
  const priceDiff =
    signal.direction === 'BUY' ? exitPrice - entry : entry - exitPrice;
  const riskDist = Math.abs(entry - signal.stopLoss);
  const unrealizedR = riskDist > 0 ? priceDiff / riskDist : 0;
  const unrealizedPipsOrPoints = toPipsOrPoints(signal.instrument, priceDiff);

  const spec = INSTRUMENTS[signal.instrument];
  const unrealizedMonetary =
    signal.lots && signal.lots > 0
      ? Number((unrealizedPipsOrPoints * spec.pipValuePerStandardLot * signal.lots).toFixed(2))
      : null;

  const isOpenPosition =
    signal.status === 'POSICAO_ABERTA' || signal.status === 'ENCERRAMENTO_RECOMENDADO';

  if (isOpenPosition) {
    const tpHit =
      signal.direction === 'BUY'
        ? quote.bid >= signal.takeProfit
        : quote.ask <= signal.takeProfit;
    const slHit =
      signal.direction === 'BUY'
        ? quote.bid <= signal.stopLoss
        : quote.ask >= signal.stopLoss;

    if (tpHit) {
      const tpDiff = Math.abs(signal.takeProfit - entry);
      const tpPips = toPipsOrPoints(signal.instrument, tpDiff);
      const finalR = riskDist > 0 ? Number((tpDiff / riskDist).toFixed(2)) : 1.5;
      const finalMon =
        signal.lots && signal.lots > 0
          ? Number((tpPips * spec.pipValuePerStandardLot * signal.lots).toFixed(2))
          : null;

      return {
        signalId: signal.id,
        currentExitPrice: exitPrice,
        unrealizedPipsOrPoints: Number(tpPips.toFixed(2)),
        unrealizedR: finalR,
        unrealizedMonetary: finalMon,
        newStatus: 'TP_ATINGIDO',
        closeReason: `Take Profit atingido automaticamente (${exitPrice.toFixed(spec.priceDecimals)})`,
        resultR: finalR,
        resultMonetary: finalMon,
        reversal: {
          shouldRecommendExit: false,
          triggeredCount: 0,
          reasons: [],
          alertTitle: null,
        },
        managementGuidance: EMPTY_GUIDANCE,
      };
    }

    if (slHit) {
      const slDiff = -Math.abs(entry - signal.stopLoss);
      const slPips = toPipsOrPoints(signal.instrument, slDiff);
      const finalMon =
        signal.lots && signal.lots > 0
          ? Number((slPips * spec.pipValuePerStandardLot * signal.lots).toFixed(2))
          : null;

      return {
        signalId: signal.id,
        currentExitPrice: exitPrice,
        unrealizedPipsOrPoints: Number(slPips.toFixed(2)),
        unrealizedR: -1,
        unrealizedMonetary: finalMon,
        newStatus: 'SL_ATINGIDO',
        closeReason: `Stop Loss atingido automaticamente (${exitPrice.toFixed(spec.priceDecimals)})`,
        resultR: -1,
        resultMonetary: finalMon,
        reversal: {
          shouldRecommendExit: false,
          triggeredCount: 0,
          reasons: [],
          alertTitle: null,
        },
        managementGuidance: EMPTY_GUIDANCE,
      };
    }

    // Check trend reversal exit warning if not already issued
    const reversal = candlesByTf
      ? evaluateTrendReversal(signal.direction, signal.instrument, candlesByTf, volumeType)
      : {
          shouldRecommendExit: false,
          triggeredCount: 0,
          reasons: [],
          alertTitle: null,
        };

    // Compute Break-Even (+1.0R) & Trailing ATR (+1.5R) stop management guidance
    let managementGuidance: PositionManagementGuidance = EMPTY_GUIDANCE;
    if (!reversal.shouldRecommendExit && unrealizedR >= 1.0) {
      const isBuy = signal.direction === 'BUY';
      const beBuffer = quote.spread * 0.5;
      const bePrice = roundPriceForInstrument(
        signal.instrument,
        isBuy ? entry + beBuffer : entry - beBuffer
      );

      let atrVal: number | null = null;
      if (candlesByTf) {
        const snap =
          computeIndicatorSnapshot(candlesByTf.M5, volumeType, true) ||
          computeIndicatorSnapshot(candlesByTf.M15, volumeType, true);
        if (snap && snap.atr14 > 0) {
          atrVal = snap.atr14;
        }
      }

      if (unrealizedR >= 1.5 && atrVal !== null) {
        const trailCandidate = roundPriceForInstrument(
          signal.instrument,
          isBuy ? exitPrice - atrVal * 1.2 : exitPrice + atrVal * 1.2
        );
        const trailBetterThanCurrent = isBuy
          ? trailCandidate > signal.stopLoss && trailCandidate >= bePrice
          : trailCandidate < signal.stopLoss && trailCandidate <= bePrice;

        if (trailBetterThanCurrent) {
          managementGuidance = {
            breakEvenRecommended: true,
            trailingStopActive: true,
            suggestedStopLoss: trailCandidate,
            guidanceText: `Lucro ≥ +1.5R: sugerido Trailing Stop ATR para ${trailCandidate.toFixed(spec.priceDecimals)} na corretora.`,
          };
        }
      }

      if (!managementGuidance.suggestedStopLoss) {
        const slNotAtBe = isBuy ? signal.stopLoss < entry : signal.stopLoss > entry;
        if (slNotAtBe) {
          managementGuidance = {
            breakEvenRecommended: true,
            trailingStopActive: false,
            suggestedStopLoss: bePrice,
            guidanceText: `Lucro ≥ +1.0R: mova o Stop Loss para Break-Even (${bePrice.toFixed(spec.priceDecimals)}) para eliminar risco.`,
          };
        }
      }
    }

    return {
      signalId: signal.id,
      currentExitPrice: exitPrice,
      unrealizedPipsOrPoints: Number(unrealizedPipsOrPoints.toFixed(2)),
      unrealizedR: Number(unrealizedR.toFixed(2)),
      unrealizedMonetary,
      newStatus:
        reversal.shouldRecommendExit && !signal.reversalAlertIssued
          ? 'ENCERRAMENTO_RECOMENDADO'
          : null,
      closeReason: null,
      resultR: null,
      resultMonetary: null,
      reversal,
      managementGuidance,
    };
  }

  // Pending / Emitted signal checks (if SL level hit before entry -> invalidated)
  const invalidated =
    signal.direction === 'BUY'
      ? quote.bid <= signal.stopLoss
      : quote.ask >= signal.stopLoss;

  if (invalidated) {
    return {
      signalId: signal.id,
      currentExitPrice: exitPrice,
      unrealizedPipsOrPoints: 0,
      unrealizedR: 0,
      unrealizedMonetary: null,
      newStatus: 'INVALIDADO',
      closeReason: 'Preço atingiu o nível de invalidação (SL) antes da execução.',
      resultR: 0,
      resultMonetary: 0,
      reversal: {
        shouldRecommendExit: false,
        triggeredCount: 0,
        reasons: [],
        alertTitle: null,
      },
      managementGuidance: EMPTY_GUIDANCE,
    };
  }

  return {
    signalId: signal.id,
    currentExitPrice: exitPrice,
    unrealizedPipsOrPoints: Number(unrealizedPipsOrPoints.toFixed(2)),
    unrealizedR: Number(unrealizedR.toFixed(2)),
    unrealizedMonetary,
    newStatus: null,
    closeReason: null,
    resultR: null,
    resultMonetary: null,
    reversal: {
      shouldRecommendExit: false,
      triggeredCount: 0,
      reasons: [],
      alertTitle: null,
    },
    managementGuidance: EMPTY_GUIDANCE,
  };
}

/**
 * Calculates recommended position size in standard lots based on risk settings.
 */
export function calculatePositionSize(
  instrument: InstrumentId,
  entryPrice: number,
  stopLoss: number,
  referenceCapital: number,
  riskPercentPerTrade: number
): { lots: number; riskAmountUsd: number; stopDistancePipsOrPoints: number } {
  const spec = INSTRUMENTS[instrument];
  const riskAmountUsd = (referenceCapital * riskPercentPerTrade) / 100;
  const stopDistancePipsOrPoints = Math.abs(
    toPipsOrPoints(instrument, entryPrice - stopLoss)
  );
  if (stopDistancePipsOrPoints <= 0) {
    return { lots: 0.01, riskAmountUsd, stopDistancePipsOrPoints: 0 };
  }
  const rawLots =
    riskAmountUsd / (stopDistancePipsOrPoints * spec.pipValuePerStandardLot);
  const lots = Math.max(0.01, Math.floor(rawLots * 100 + 1e-9) / 100);
  return {
    lots,
    riskAmountUsd: Number(riskAmountUsd.toFixed(2)),
    stopDistancePipsOrPoints: Number(stopDistancePipsOrPoints.toFixed(2)),
  };
}

/**
 * Evaluates risk management limits (daily loss, consecutive losses, max open positions).
 */
export function evaluateRiskStatus(
  signals: TradingSignalRecord[],
  settings: Pick<
    UserSettings,
    | 'referenceCapital'
    | 'dailyLossLimitPercent'
    | 'maxOpenPositions'
    | 'maxConsecutiveLosses'
    | 'autoPauseOnLimit'
  >
): {
  paused: boolean;
  pauseReasons: string[];
  openPositionsCount: number;
  consecutiveLosses: number;
  dailyPnlUsd: number;
  dailyLossLimitUsd: number;
} {
  const openPositionsCount = signals.filter(
    (s) => s.status === 'POSICAO_ABERTA' || s.status === 'ENCERRAMENTO_RECOMENDADO'
  ).length;

  const closedTrades = signals
    .filter(
      (s) =>
        s.status === 'TP_ATINGIDO' ||
        s.status === 'SL_ATINGIDO' ||
        s.status === 'ENCERRADO_MANUALMENTE'
    )
    .sort((a, b) => {
      const ta = typeof a.closedAt === 'number' ? a.closedAt : 0;
      const tb = typeof b.closedAt === 'number' ? b.closedAt : 0;
      return tb - ta;
    });

  let consecutiveLosses = 0;
  for (const t of closedTrades) {
    if ((t.resultR ?? 0) < 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }

  const todayUtc = new Date().toISOString().slice(0, 10);
  const dailyPnlUsd = closedTrades
    .filter((t) => {
      if (typeof t.closedAt === 'string') return t.closedAt.slice(0, 10) === todayUtc;
      return false;
    })
    .reduce((acc, t) => acc + (t.resultMonetary ?? 0), 0);

  const dailyLossLimitUsd = -(settings.referenceCapital * settings.dailyLossLimitPercent) / 100;
  const pauseReasons: string[] = [];

  if (openPositionsCount >= settings.maxOpenPositions) {
    pauseReasons.push(
      `Limite máximo de posições abertas atingido (${openPositionsCount}/${settings.maxOpenPositions}).`
    );
  }
  if (consecutiveLosses >= settings.maxConsecutiveLosses) {
    pauseReasons.push(
      `Limite de perdas consecutivas atingido (${consecutiveLosses}/${settings.maxConsecutiveLosses}).`
    );
  }
  if (dailyPnlUsd <= dailyLossLimitUsd) {
    pauseReasons.push(
      `Limite diário de perdas atingido (${dailyPnlUsd.toFixed(2)} USD <= ${dailyLossLimitUsd.toFixed(2)} USD).`
    );
  }

  return {
    paused: settings.autoPauseOnLimit && pauseReasons.length > 0,
    pauseReasons,
    openPositionsCount,
    consecutiveLosses,
    dailyPnlUsd: Number(dailyPnlUsd.toFixed(2)),
    dailyLossLimitUsd: Number(dailyLossLimitUsd.toFixed(2)),
  };
}

/**
 * Detects overlapping or positively correlated currency/gold exposure across open/active positions.
 */
export function detectCorrelatedExposure(
  instrument: InstrumentId,
  direction: SignalDirection,
  signals: TradingSignalRecord[],
  excludeSignalId?: string
): { hasRisk: boolean; warnings: string[] } {
  const openOrPending = signals.filter(
    (s) =>
      s.id !== excludeSignalId &&
      (s.status === 'POSICAO_ABERTA' || s.status === 'ENCERRAMENTO_RECOMENDADO')
  );

  const warnings: string[] = [];

  for (const pos of openOrPending) {
    if (pos.instrument === instrument && pos.direction === direction) {
      warnings.push(
        `Exposição duplicada: já existe posição aberta ${pos.direction} em ${pos.instrument}.`
      );
      continue;
    }

    const pairSet = new Set([instrument, pos.instrument]);
    if (pairSet.has('EUR/USD') && pairSet.has('GBP/USD') && pos.direction === direction) {
      warnings.push(
        `Correlação positiva elevada (~85%): ${pos.direction} em ${pos.instrument} duplica risco direcional no USD.`
      );
    } else if (pairSet.has('EUR/JPY') && pairSet.has('GBP/JPY') && pos.direction === direction) {
      warnings.push(
        `Correlação positiva elevada (~85%): ${pos.direction} em ${pos.instrument} duplica risco direcional no JPY.`
      );
    } else if (
      (pairSet.has('EUR/USD') || pairSet.has('GBP/USD')) &&
      pairSet.has('XAU/USD') &&
      pos.direction === direction
    ) {
      warnings.push(
        `Concentração no USD: ${pos.direction} em ${pos.instrument} e ${direction} em ${instrument} dependem ambas da fraqueza/força do Dólar.`
      );
    }
  }

  return {
    hasRisk: warnings.length > 0,
    warnings: Array.from(new Set(warnings)),
  };
}
