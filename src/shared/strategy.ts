import { computeIndicatorSnapshot } from './indicators';
import {
  Candle,
  ExecutionType,
  INSTRUMENTS,
  IndicatorSnapshot,
  InstrumentId,
  Quote,
  ScoreBreakdown,
  ScoreClassification,
  SignalDirection,
  StrategyCandidate,
  StrategyType,
  TradingSessionQuality,
  UserSettings,
  VolumeNature,
  fromPipsOrPoints,
  toPipsOrPoints,
} from './types';

export interface MultiTimeframeInput {
  instrument: InstrumentId;
  quote: Quote;
  candlesByTf: {
    H1: Candle[];
    M15: Candle[];
    M5: Candle[];
    M1: Candle[];
  };
  volumeType: VolumeNature;
  settings: Pick<
    UserSettings,
    | 'scalpingTargetPips'
    | 'intradayTargetPips'
    | 'xauScalpingDistance'
    | 'xauIntradayDistance'
    | 'minRiskReward'
  >;
}

export interface TradingSessionEvaluation {
  quality: TradingSessionQuality;
  label: string;
  allowActionable: boolean;
  minRequiredScore: number;
}

/**
 * Classifies current UTC market session for intraday liquidity & spread quality.
 * Blocks rollover dead zone (21:00–23:59 UTC) and raises threshold in Tokyo session for non-JPY pairs.
 */
export function evaluateTradingSession(
  instrument: InstrumentId,
  dateUtc: Date
): TradingSessionEvaluation {
  const mins = dateUtc.getUTCHours() * 60 + dateUtc.getUTCMinutes();

  if (mins >= 21 * 60) {
    return {
      quality: 'ROLLOVER_DEAD_ZONE',
      label: 'Zona Morta / Rollover (21:00–00:00 UTC)',
      allowActionable: false,
      minRequiredScore: 101,
    };
  }

  if (mins >= 12 * 60 && mins <= 16 * 60 + 30) {
    return {
      quality: 'LONDON_NY_OVERLAP',
      label: 'Sobreposição Londres / NY (Liquidez Máxima)',
      allowActionable: true,
      minRequiredScore: 80,
    };
  }

  if (mins >= 7 * 60 && mins < 12 * 60) {
    return {
      quality: 'LONDON_SESSION',
      label: 'Sessão de Londres',
      allowActionable: true,
      minRequiredScore: 80,
    };
  }

  if (mins > 16 * 60 + 30 && mins < 21 * 60) {
    return {
      quality: 'NY_SESSION',
      label: 'Sessão de Nova Iorque',
      allowActionable: true,
      minRequiredScore: 80,
    };
  }

  // 00:00 - 06:59 UTC: Tokyo / Asia
  const isNonJpyForex = instrument === 'EUR/USD' || instrument === 'GBP/USD';
  return {
    quality: 'TOKYO_SESSION',
    label: 'Sessão Asiática / Tóquio',
    allowActionable: true,
    minRequiredScore: isNonJpyForex ? 85 : 80,
  };
}

export function classifyScore(total: number): ScoreClassification {
  if (total >= 90) return 'SINAL_FORTE';
  if (total >= 80) return 'SINAL_FAVORAVEL';
  if (total >= 70) return 'EM_OBSERVACAO';
  return 'SEM_ENTRADA';
}

export function getClassificationLabel(c: ScoreClassification): string {
  switch (c) {
    case 'SINAL_FORTE':
      return 'Sinal forte';
    case 'SINAL_FAVORAVEL':
      return 'Sinal favorável';
    case 'EM_OBSERVACAO':
      return 'Em observação';
    case 'SEM_ENTRADA':
      return 'Sem entrada';
  }
}

function roundPrice(instrument: InstrumentId, price: number): number {
  const decimals = INSTRUMENTS[instrument].priceDecimals;
  const factor = Math.pow(10, decimals);
  return Math.round(price * factor) / factor;
}

function scoreH1Trend(
  h1: IndicatorSnapshot,
  dir: SignalDirection
): { points: number; note: string } {
  let pts = 0;
  const isBull = dir === 'BUY';
  if (isBull) {
    if (h1.ema9 > h1.ema21 && h1.ema21 > h1.ema50) pts += 12;
    else if (h1.ema9 > h1.ema21 || h1.close > h1.ema50) pts += 6;
    if (h1.close > h1.ema21) pts += 5;
    if (h1.plusDI > h1.minusDI) pts += 3;
  } else {
    if (h1.ema9 < h1.ema21 && h1.ema21 < h1.ema50) pts += 12;
    else if (h1.ema9 < h1.ema21 || h1.close < h1.ema50) pts += 6;
    if (h1.close < h1.ema21) pts += 5;
    if (h1.minusDI > h1.plusDI) pts += 3;
  }
  return {
    points: Math.min(20, pts),
    note: `H1 Tendência ${h1.trendDirection} (EMA9/21/50: ${pts}/20)`,
  };
}

function scoreM15Structure(
  m15: IndicatorSnapshot,
  dir: SignalDirection
): { points: number; note: string } {
  let pts = 0;
  const isBull = dir === 'BUY';
  if (isBull) {
    if (m15.close > m15.ema50) pts += 7;
    if (m15.ema9 >= m15.ema21) pts += 5;
    if (m15.breakout === 'BULLISH_BREAKOUT' || m15.breakout === 'FALSE_BEAR_BREAKOUT') pts += 5;
    if (m15.supports.length > 0 && m15.close > m15.supports[m15.supports.length - 1]) pts += 3;
  } else {
    if (m15.close < m15.ema50) pts += 7;
    if (m15.ema9 <= m15.ema21) pts += 5;
    if (m15.breakout === 'BEARISH_BREAKOUT' || m15.breakout === 'FALSE_BULL_BREAKOUT') pts += 5;
    if (m15.resistances.length > 0 && m15.close < m15.resistances[0]) pts += 3;
  }
  return {
    points: Math.min(20, pts),
    note: `M15 Estrutura S/R (${pts}/20)`,
  };
}

function scoreM5Confirmation(
  m5: IndicatorSnapshot,
  m1: IndicatorSnapshot | null,
  dir: SignalDirection,
  strategy: StrategyType
): { points: number; note: string } {
  let pts = 0;
  const isBull = dir === 'BUY';

  if (isBull) {
    if (m5.ema9 > m5.ema21) pts += 8;
    if (m5.close > m5.ema9 && m5.close > m5.ema50) pts += 6;
    if (m5.vwap.value !== null && m5.close >= m5.vwap.value) pts += 3;
    if (strategy === 'SCALPING' && m1 && m1.ema9 > m1.ema21 && m1.close > m1.ema21) {
      pts += 3;
    } else if (strategy === 'INTRADAY' && m5.close > m5.bollinger.middle) {
      pts += 3;
    }
  } else {
    if (m5.ema9 < m5.ema21) pts += 8;
    if (m5.close < m5.ema9 && m5.close < m5.ema50) pts += 6;
    if (m5.vwap.value !== null && m5.close <= m5.vwap.value) pts += 3;
    if (strategy === 'SCALPING' && m1 && m1.ema9 < m1.ema21 && m1.close < m1.ema21) {
      pts += 3;
    } else if (strategy === 'INTRADAY' && m5.close < m5.bollinger.middle) {
      pts += 3;
    }
  }

  return {
    points: Math.min(20, pts),
    note:
      strategy === 'SCALPING' && m1
        ? `Confirmação M5 + Micro M1 (${pts}/20)`
        : `Confirmação M5 (${pts}/20)`,
  };
}

function scoreRsiMacd(
  primary: IndicatorSnapshot,
  dir: SignalDirection
): { points: number; note: string } {
  let pts = 0;
  const isBull = dir === 'BUY';

  if (isBull) {
    if (primary.rsi14 >= 50 && primary.rsi14 <= 68) pts += 7;
    else if (primary.rsi14 > 44 && primary.rsi14 < 72) pts += 4;
    if (primary.macd.histogram > 0 && primary.macd.macdLine > primary.macd.signalLine) pts += 8;
    else if (primary.macd.histogram > 0 || primary.macd.macdLine > primary.macd.signalLine) pts += 4;
  } else {
    if (primary.rsi14 <= 50 && primary.rsi14 >= 32) pts += 7;
    else if (primary.rsi14 < 56 && primary.rsi14 > 28) pts += 4;
    if (primary.macd.histogram < 0 && primary.macd.macdLine < primary.macd.signalLine) pts += 8;
    else if (primary.macd.histogram < 0 || primary.macd.macdLine < primary.macd.signalLine) pts += 4;
  }

  return {
    points: Math.min(15, pts),
    note: `RSI(14)=${primary.rsi14.toFixed(1)} & MACD Hist=${primary.macd.histogram.toFixed(5)} (${pts}/15)`,
  };
}

function scoreAdxAtr(
  primary: IndicatorSnapshot,
  dir: SignalDirection
): { points: number; note: string } {
  let pts = 0;
  const isBull = dir === 'BUY';

  if (primary.adx14 >= 25) pts += 5;
  else if (primary.adx14 >= 18) pts += 3;

  if ((isBull && primary.plusDI > primary.minusDI) || (!isBull && primary.minusDI > primary.plusDI)) {
    pts += 3;
  }

  if (primary.atr14 > 0 && primary.bollinger.bandwidth > 0.0005) {
    pts += 2;
  }

  return {
    points: Math.min(10, pts),
    note: `ADX(14)=${primary.adx14.toFixed(1)} DI+=${primary.plusDI.toFixed(1)} DI-=${primary.minusDI.toFixed(1)} (${pts}/10)`,
  };
}

function scorePriceAction(
  primary: IndicatorSnapshot,
  dir: SignalDirection
): { points: number; note: string } {
  let pts = 0;
  const isBull = dir === 'BUY';

  if (isBull) {
    if (primary.priceActionBias === 'BULLISH') pts += 5;
    if (primary.breakout === 'BULLISH_BREAKOUT' || primary.breakout === 'FALSE_BEAR_BREAKOUT') pts += 5;
    else if (primary.candlePatterns.length > 0 && primary.priceActionBias !== 'BEARISH') pts += 2;
  } else {
    if (primary.priceActionBias === 'BEARISH') pts += 5;
    if (primary.breakout === 'BEARISH_BREAKOUT' || primary.breakout === 'FALSE_BULL_BREAKOUT') pts += 5;
    else if (primary.candlePatterns.length > 0 && primary.priceActionBias !== 'BULLISH') pts += 2;
  }

  return {
    points: Math.min(10, pts),
    note: `Price Action [${primary.candlePatterns.join(', ') || primary.breakout}] (${pts}/10)`,
  };
}

function scoreSpread(
  instrument: InstrumentId,
  quote: Quote
): { points: number; note: string } {
  const maxAllowed = INSTRUMENTS[instrument].maxAcceptableSpreadPips;
  const ratio = quote.spreadPips / maxAllowed;
  let pts = 0;
  if (!quote.marketOpen) pts = 0;
  else if (ratio <= 0.45) pts = 5;
  else if (ratio <= 0.75) pts = 4;
  else if (ratio <= 1.0) pts = 2;

  return {
    points: pts,
    note: `Spread ${quote.spreadPips.toFixed(2)} ${INSTRUMENTS[instrument].unitLabel} (${pts}/5)`,
  };
}

function calculateTpSl(
  instrument: InstrumentId,
  strategy: StrategyType,
  direction: SignalDirection,
  entryPrice: number,
  primary: IndicatorSnapshot,
  m15: IndicatorSnapshot,
  h1: IndicatorSnapshot,
  settings: MultiTimeframeInput['settings']
): {
  takeProfit: number;
  stopLoss: number;
  riskReward: number;
  volatilityCompatible: boolean;
  structuralClearanceOk: boolean;
  nearestObstacleDistance: number | null;
} {
  const spec = INSTRUMENTS[instrument];
  const minRR = Math.max(1.5, settings.minRiskReward);
  const atr = primary.atr14;

  // Configurable base target distance (separate pip logic for Forex vs USD price distance for XAU/USD)
  const configuredTargetDist = spec.isMetal
    ? strategy === 'SCALPING'
      ? settings.xauScalpingDistance
      : settings.xauIntradayDistance
    : fromPipsOrPoints(
        instrument,
        strategy === 'SCALPING' ? settings.scalpingTargetPips : settings.intradayTargetPips
      );

  // Respect available volatility: cap TP to realistic 3.8 * ATR(14) on primary timeframe (or 3.5 * M15 ATR for Intraday)
  const maxRealisticTpDist =
    strategy === 'SCALPING'
      ? Math.max(atr * 3.8, configuredTargetDist * 0.8)
      : Math.max(m15.atr14 * 3.5, configuredTargetDist * 0.8);
  let targetTpDist = Math.min(configuredTargetDist, maxRealisticTpDist);

  // Structural stop loss via ATR & nearest swing support/resistance
  const atrSlDist = Math.max(atr * 1.4, targetTpDist / minRR);
  let slDist = Math.min(atrSlDist, targetTpDist / minRR);

  if (direction === 'BUY') {
    const nearestSup = m15.supports[m15.supports.length - 1];
    if (nearestSup && nearestSup < entryPrice) {
      const structDist = entryPrice - nearestSup + atr * 0.3;
      if (structDist > atr * 0.6 && structDist <= targetTpDist / minRR) {
        slDist = structDist;
      }
    }
  } else {
    const nearestRes = m15.resistances[0];
    if (nearestRes && nearestRes > entryPrice) {
      const structDist = nearestRes - entryPrice + atr * 0.3;
      if (structDist > atr * 0.6 && structDist <= targetTpDist / minRR) {
        slDist = structDist;
      }
    }
  }

  // Structural S/R clearance & TP front-running across M15 + H1 levels ahead of entry
  const opposingLevels =
    direction === 'BUY'
      ? [...m15.resistances, ...h1.resistances]
          .filter((lvl) => lvl > entryPrice + atr * 0.05)
          .sort((a, b) => a - b)
      : [...m15.supports, ...h1.supports]
          .filter((lvl) => lvl < entryPrice - atr * 0.05)
          .sort((a, b) => b - a);

  const nearestObstacle = opposingLevels[0];
  const nearestObstacleDistance =
    nearestObstacle !== undefined
      ? Number(Math.abs(nearestObstacle - entryPrice).toFixed(spec.priceDecimals))
      : null;

  const structuralClearanceOk =
    nearestObstacleDistance === null || nearestObstacleDistance >= 0.85 * slDist;

  // Front-run major M15/H1 obstacle if it sits between 1.55R and targetTpDist
  if (
    structuralClearanceOk &&
    nearestObstacleDistance !== null &&
    nearestObstacleDistance < targetTpDist &&
    nearestObstacleDistance >= slDist * minRR + atr * 0.15
  ) {
    const frontRunDist = nearestObstacleDistance - atr * 0.15;
    if (frontRunDist / Math.max(slDist, 1e-9) >= minRR) {
      targetTpDist = frontRunDist;
    }
  }

  if (direction === 'BUY') {
    const takeProfit = roundPrice(instrument, entryPrice + targetTpDist);
    const stopLoss = roundPrice(instrument, entryPrice - slDist);
    const rr = (takeProfit - entryPrice) / Math.max(entryPrice - stopLoss, 1e-9);
    return {
      takeProfit,
      stopLoss,
      riskReward: Number(rr.toFixed(2)),
      volatilityCompatible: targetTpDist >= atr * 0.8,
      structuralClearanceOk,
      nearestObstacleDistance,
    };
  } else {
    const takeProfit = roundPrice(instrument, entryPrice - targetTpDist);
    const stopLoss = roundPrice(instrument, entryPrice + slDist);
    const rr = (entryPrice - takeProfit) / Math.max(stopLoss - entryPrice, 1e-9);
    return {
      takeProfit,
      stopLoss,
      riskReward: Number(rr.toFixed(2)),
      volatilityCompatible: targetTpDist >= atr * 0.8,
      structuralClearanceOk,
      nearestObstacleDistance,
    };
  }
}

export function evaluateStrategyForInstrument(
  input: MultiTimeframeInput,
  strategy: StrategyType,
  closedCandlesOnly = true,
  options?: { enforceSessionFilter?: boolean }
): StrategyCandidate | null {
  const h1 = computeIndicatorSnapshot(input.candlesByTf.H1, input.volumeType, closedCandlesOnly);
  const m15 = computeIndicatorSnapshot(input.candlesByTf.M15, input.volumeType, closedCandlesOnly);
  const m5 = computeIndicatorSnapshot(input.candlesByTf.M5, input.volumeType, closedCandlesOnly);
  const m1 = computeIndicatorSnapshot(input.candlesByTf.M1, input.volumeType, closedCandlesOnly);

  if (!h1 || !m15 || !m5) {
    return null;
  }

  const primary = strategy === 'SCALPING' ? m5 : m15;
  const timeframe = strategy === 'SCALPING' ? 'M5' : 'M15';

  // Evaluate both BUY and SELL and pick the higher-scoring direction
  const evaluateDir = (dir: SignalDirection) => {
    const sH1 = scoreH1Trend(h1, dir);
    const sM15 = scoreM15Structure(m15, dir);
    const sM5 = scoreM5Confirmation(m5, m1, dir, strategy);
    const sRsiMacd = scoreRsiMacd(primary, dir);
    const sAdxAtr = scoreAdxAtr(primary, dir);
    const sPa = scorePriceAction(primary, dir);
    const sSpread = scoreSpread(input.instrument, input.quote);

    const total =
      sH1.points +
      sM15.points +
      sM5.points +
      sRsiMacd.points +
      sAdxAtr.points +
      sPa.points +
      sSpread.points;

    const breakdown: ScoreBreakdown = {
      h1Trend: sH1.points,
      m15Structure: sM15.points,
      m5Confirmation: sM5.points,
      rsiMacd: sRsiMacd.points,
      adxAtr: sAdxAtr.points,
      priceAction: sPa.points,
      spreadExecution: sSpread.points,
      total,
      classification: classifyScore(total),
    };

    const notes = [
      sH1.note,
      sM15.note,
      sM5.note,
      sRsiMacd.note,
      sAdxAtr.note,
      sPa.note,
      sSpread.note,
    ];

    return { dir, breakdown, notes };
  };

  const buyEval = evaluateDir('BUY');
  const sellEval = evaluateDir('SELL');
  const best = buyEval.breakdown.total >= sellEval.breakdown.total ? buyEval : sellEval;

  // Session & regime checks
  const parsedQuoteTime = input.quote.timestampUtc ? new Date(input.quote.timestampUtc) : new Date();
  const quoteDate = Number.isNaN(parsedQuoteTime.getTime()) ? new Date() : parsedQuoteTime;
  const session = evaluateTradingSession(input.instrument, quoteDate);
  const enforceSessionFilter = options?.enforceSessionFilter ?? true;
  const sessionOk =
    !enforceSessionFilter ||
    (session.allowActionable && best.breakdown.total >= session.minRequiredScore);

  // Anti-chop filter: avoid trading sideways low-ADX range traps
  const antiChopOk = !(primary.adx14 < 18 && h1.adx14 < 18);

  // H1 EMA21 slope alignment guard (never trade into a steep opposing H1 EMA21)
  const ema21SlopeAligned =
    best.dir === 'BUY' ? h1.ema21SlopePct >= -0.02 : h1.ema21SlopePct <= 0.02;

  // Mandatory confluence gates for actionable entry (>= 80 points + H1, M15, M5 agreement)
  const mandatoryConfluence =
    best.breakdown.total >= 80 &&
    best.breakdown.h1Trend >= 12 &&
    best.breakdown.m15Structure >= 12 &&
    best.breakdown.m5Confirmation >= 12 &&
    input.quote.marketOpen;

  const marketEntryPrice =
    best.dir === 'BUY'
      ? roundPrice(input.instrument, input.quote.ask)
      : roundPrice(input.instrument, input.quote.bid);

  // Entry quality & anti-chasing guard via ATR stretch + RSI extreme
  const isOverstretchedRsi =
    (best.dir === 'BUY' && primary.rsi14 > 72) ||
    (best.dir === 'SELL' && primary.rsi14 < 28);
  const isConfirmedBreakout =
    (best.dir === 'BUY' &&
      (primary.breakout === 'BULLISH_BREAKOUT' || m15.breakout === 'BULLISH_BREAKOUT')) ||
    (best.dir === 'SELL' &&
      (primary.breakout === 'BEARISH_BREAKOUT' || m15.breakout === 'BEARISH_BREAKOUT'));

  let entryQuality: 'PULLBACK_OTIMO' | 'ROMPIMENTO_LIMPO' | 'ESTICADO';
  if (primary.atrStretchRatio > 1.9 || isOverstretchedRsi) {
    entryQuality = 'ESTICADO';
  } else if (primary.atrStretchRatio <= 1.2) {
    entryQuality = 'PULLBACK_OTIMO';
  } else if (isConfirmedBreakout) {
    entryQuality = 'ROMPIMENTO_LIMPO';
  } else {
    entryQuality = 'ESTICADO';
  }

  // Determine immediate vs conditional entry & recommendedEntry BEFORE TP/SL calculation
  const pullbackTolerance = primary.atr14 * 0.45;
  const distFromEma9 = Math.abs(marketEntryPrice - primary.ema9);
  const executionType: ExecutionType =
    entryQuality === 'ESTICADO' || distFromEma9 > pullbackTolerance
      ? 'CONDITIONAL'
      : 'IMMEDIATE';

  const recommendedEntry =
    executionType === 'IMMEDIATE'
      ? marketEntryPrice
      : roundPrice(
          input.instrument,
          best.dir === 'BUY'
            ? Math.min(marketEntryPrice, primary.ema9)
            : Math.max(marketEntryPrice, primary.ema9)
        );

  const {
    takeProfit,
    stopLoss,
    riskReward,
    volatilityCompatible,
    structuralClearanceOk,
    nearestObstacleDistance,
  } = calculateTpSl(
    input.instrument,
    strategy,
    best.dir,
    recommendedEntry,
    primary,
    m15,
    h1,
    input.settings
  );

  // Never mark a conditional entry as executable if price already ran past 50% of TP
  const halfwayToTp =
    best.dir === 'BUY'
      ? recommendedEntry + (takeProfit - recommendedEntry) * 0.5
      : recommendedEntry - (recommendedEntry - takeProfit) * 0.5;
  const entryAlreadySurpassed =
    best.dir === 'BUY'
      ? input.quote.ask >= halfwayToTp
      : input.quote.bid <= halfwayToTp;

  const entryExecutable = !entryAlreadySurpassed && input.quote.marketOpen;
  const actionable =
    mandatoryConfluence &&
    sessionOk &&
    antiChopOk &&
    ema21SlopeAligned &&
    structuralClearanceOk &&
    entryExecutable &&
    volatilityCompatible &&
    riskReward >= 1.5;

  const unit = INSTRUMENTS[input.instrument].unitLabel;
  const tpDist = Math.abs(toPipsOrPoints(input.instrument, takeProfit - recommendedEntry)).toFixed(1);
  const slDist = Math.abs(toPipsOrPoints(input.instrument, recommendedEntry - stopLoss)).toFixed(1);

  const entryQualityText =
    entryQuality === 'PULLBACK_OTIMO'
      ? 'Pullback ótimo à média'
      : entryQuality === 'ROMPIMENTO_LIMPO'
      ? 'Rompimento estrutural limpo'
      : 'Preço esticado (aguardar pullback à EMA 9)';

  const rationale = `${input.instrument} em estratégia ${strategy} (${timeframe}) apresenta direção ${best.dir} com pontuação ${best.breakdown.total}/100 (${getClassificationLabel(best.breakdown.classification)}). Sessão: ${session.label}. Entrada: ${entryQualityText}. Tendência H1 ${h1.trendDirection}, RSI(14) ${primary.rsi14.toFixed(1)}, ADX(14) ${primary.adx14.toFixed(1)}. Alvo TP a ${tpDist} ${unit} e SL estrutural a ${slDist} ${unit} (R:R 1:${riskReward.toFixed(2)}).${!structuralClearanceOk ? ' Atenção: obstáculo S/R demasiado próximo.' : ''}${!antiChopOk ? ' Atenção: mercado lateral (ADX baixo).' : ''}`;

  const opportunityKey = `${input.instrument}_${strategy}_${best.dir}_${primary.candleTime}`;

  return {
    instrument: input.instrument,
    strategy,
    timeframe,
    direction: best.breakdown.total >= 70 ? best.dir : null,
    score: best.breakdown,
    actionable,
    executionType,
    entryExecutable,
    recommendedEntry,
    takeProfit,
    stopLoss,
    riskReward,
    observedSpread: input.quote.spreadPips,
    indicatorsJustification: best.notes,
    rationale,
    opportunityKey,
    evaluatedAtUtc: new Date().toISOString(),
    candleTime: primary.candleTime,
    intradayContext: {
      sessionQuality: session.quality,
      sessionLabel: session.label,
      entryQuality,
      structuralClearanceOk,
      nearestObstacleDistance,
      antiChopOk,
    },
  };
}
