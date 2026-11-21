import {
  BreakoutStatus,
  Candle,
  IndicatorDirection,
  IndicatorSnapshot,
  VolumeNature,
} from './types';

/**
 * Exponential Moving Average (EMA) seeded with SMA for initial period.
 */
export function calculateEMA(values: number[], period: number): number[] {
  if (values.length === 0 || period <= 0) return [];
  if (values.length < period) {
    return values.map(() => NaN);
  }

  const k = 2 / (period + 1);
  const result = new Array<number>(values.length).fill(NaN);

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  let ema = sum / period;
  result[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }

  return result;
}

/**
 * Wilder's Relative Strength Index (RSI 14).
 */
export function calculateRSI(closes: number[], period = 14): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return result;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}

/**
 * MACD (12, 26, 9).
 */
export function calculateMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const len = closes.length;
  const macdLine = new Array<number>(len).fill(NaN);
  const signalLine = new Array<number>(len).fill(NaN);
  const histogram = new Array<number>(len).fill(NaN);

  const fastEma = calculateEMA(closes, fastPeriod);
  const slowEma = calculateEMA(closes, slowPeriod);

  const validMacdValues: number[] = [];
  const validIndices: number[] = [];

  for (let i = 0; i < len; i++) {
    if (!Number.isNaN(fastEma[i]) && !Number.isNaN(slowEma[i])) {
      const val = fastEma[i] - slowEma[i];
      macdLine[i] = val;
      validMacdValues.push(val);
      validIndices.push(i);
    }
  }

  const sigEma = calculateEMA(validMacdValues, signalPeriod);
  for (let j = 0; j < validIndices.length; j++) {
    const idx = validIndices[j];
    if (!Number.isNaN(sigEma[j])) {
      signalLine[idx] = sigEma[j];
      histogram[idx] = macdLine[idx] - sigEma[j];
    }
  }

  return { macdLine, signalLine, histogram };
}

/**
 * Average True Range (ATR 14) using Wilder smoothing.
 */
export function calculateATR(candles: Candle[], period = 14): number[] {
  const len = candles.length;
  const atr = new Array<number>(len).fill(NaN);
  if (len <= period) return atr;

  const tr = new Array<number>(len).fill(0);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < len; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += tr[i];
  }
  let prevAtr = sum / period;
  atr[period] = prevAtr;

  for (let i = period + 1; i < len; i++) {
    prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
    atr[i] = prevAtr;
  }

  return atr;
}

/**
 * ADX (14), DI+, and DI- using Wilder smoothing.
 */
export function calculateADX(
  candles: Candle[],
  period = 14
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const len = candles.length;
  const adx = new Array<number>(len).fill(NaN);
  const plusDI = new Array<number>(len).fill(NaN);
  const minusDI = new Array<number>(len).fill(NaN);

  if (len < period * 2 + 1) {
    return { adx, plusDI, minusDI };
  }

  const tr = new Array<number>(len).fill(0);
  const plusDM = new Array<number>(len).fill(0);
  const minusDM = new Array<number>(len).fill(0);

  for (let i = 1; i < len; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;

    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
  }

  let smoothTR = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    smoothTR += tr[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }

  const dxArr = new Array<number>(len).fill(NaN);

  for (let i = period; i < len; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + tr[i];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    }

    const pDI = smoothTR === 0 ? 0 : (100 * smoothPlusDM) / smoothTR;
    const mDI = smoothTR === 0 ? 0 : (100 * smoothMinusDM) / smoothTR;
    plusDI[i] = pDI;
    minusDI[i] = mDI;

    const diSum = pDI + mDI;
    dxArr[i] = diSum === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / diSum;
  }

  let dxSum = 0;
  const firstAdxIdx = period * 2 - 1;
  if (firstAdxIdx < len) {
    for (let i = period; i <= firstAdxIdx; i++) {
      dxSum += dxArr[i];
    }
    let prevAdx = dxSum / period;
    adx[firstAdxIdx] = prevAdx;

    for (let i = firstAdxIdx + 1; i < len; i++) {
      prevAdx = (prevAdx * (period - 1) + dxArr[i]) / period;
      adx[i] = prevAdx;
    }
  }

  return { adx, plusDI, minusDI };
}

/**
 * Bollinger Bands (20, 2).
 */
export function calculateBollingerBands(
  closes: number[],
  period = 20,
  stdDevMult = 2
): { upper: number[]; middle: number[]; lower: number[]; bandwidth: number[] } {
  const len = closes.length;
  const upper = new Array<number>(len).fill(NaN);
  const middle = new Array<number>(len).fill(NaN);
  const lower = new Array<number>(len).fill(NaN);
  const bandwidth = new Array<number>(len).fill(NaN);

  if (len < period) return { upper, middle, lower, bandwidth };

  for (let i = period - 1; i < len; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += closes[j];
    }
    const sma = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - sma;
      sqSum += diff * diff;
    }
    const std = Math.sqrt(sqSum / period);
    middle[i] = sma;
    upper[i] = sma + stdDevMult * std;
    lower[i] = sma - stdDevMult * std;
    bandwidth[i] = sma === 0 ? 0 : (upper[i] - lower[i]) / sma;
  }

  return { upper, middle, lower, bandwidth };
}

/**
 * Session-anchored VWAP (UTC midnight reset).
 * Explicitly tracks the nature of volume used; returns null values if no volume data exists.
 */
export function calculateVWAP(
  candles: Candle[],
  declaredVolumeType: VolumeNature
): { values: (number | null)[]; volumeType: VolumeNature } {
  if (candles.length === 0) {
    return { values: [], volumeType: 'NO_VOLUME_DATA' };
  }

  const hasAnyPositiveVolume = candles.some((c) => c.volume > 0);
  if (!hasAnyPositiveVolume || declaredVolumeType === 'NO_VOLUME_DATA') {
    return {
      values: candles.map(() => null),
      volumeType: 'NO_VOLUME_DATA',
    };
  }

  let currentDay = '';
  let cumPV = 0;
  let cumVol = 0;

  const values = candles.map((c) => {
    const day = new Date(c.time * 1000).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      cumPV = 0;
      cumVol = 0;
    }
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume > 0 ? c.volume : 0;
    cumPV += typicalPrice * vol;
    cumVol += vol;
    return cumVol > 0 ? cumPV / cumVol : null;
  });

  return { values, volumeType: declaredVolumeType };
}

/**
 * Detects structural Support & Resistance levels from swing highs/lows.
 */
export function detectSupportResistance(
  candles: Candle[],
  lookback = 60
): { supports: number[]; resistances: number[]; prevHigh: number; prevLow: number } {
  const slice = candles.slice(-Math.min(candles.length, lookback));
  if (slice.length < 5) {
    const last = slice[slice.length - 1];
    return {
      supports: last ? [last.low] : [],
      resistances: last ? [last.high] : [],
      prevHigh: last ? last.high : 0,
      prevLow: last ? last.low : 0,
    };
  }

  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (
      c.high >= slice[i - 1].high &&
      c.high >= slice[i - 2].high &&
      c.high >= slice[i + 1].high &&
      c.high >= slice[i + 2].high
    ) {
      swingHighs.push(c.high);
    }
    if (
      c.low <= slice[i - 1].low &&
      c.low <= slice[i - 2].low &&
      c.low <= slice[i + 1].low &&
      c.low <= slice[i + 2].low
    ) {
      swingLows.push(c.low);
    }
  }

  const currentClose = slice[slice.length - 1].close;
  const cluster = (levels: number[]) => {
    const sorted = [...levels].sort((a, b) => a - b);
    const out: number[] = [];
    const tolerance = currentClose * 0.0012;
    for (const lvl of sorted) {
      const existing = out.find((x) => Math.abs(x - lvl) <= tolerance);
      if (!existing) out.push(lvl);
    }
    return out;
  };

  const supports = cluster(swingLows.filter((l) => l <= currentClose * 1.001)).slice(-3);
  const resistances = cluster(swingHighs.filter((h) => h >= currentClose * 0.999)).slice(0, 3);

  const priorWindow = slice.slice(-21, -1);
  const prevHigh = priorWindow.length
    ? Math.max(...priorWindow.map((c) => c.high))
    : slice[slice.length - 1].high;
  const prevLow = priorWindow.length
    ? Math.min(...priorWindow.map((c) => c.low))
    : slice[slice.length - 1].low;

  return { supports, resistances, prevHigh, prevLow };
}

/**
 * Distinguishes confirmed breakouts (body close outside level) from false breakouts (wick sweep & close back inside).
 */
export function detectBreakoutAndFalseBreakout(
  candles: Candle[],
  supports: number[],
  resistances: number[]
): BreakoutStatus {
  if (candles.length < 3) return 'NONE';
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const nearestRes = resistances.length > 0 ? resistances[0] : prev.high;
  const nearestSup = supports.length > 0 ? supports[supports.length - 1] : prev.low;

  // False bullish breakout: wick pierced above resistance, but candle closed below resistance
  if (last.high > nearestRes && last.close < nearestRes && last.close < last.open) {
    return 'FALSE_BULL_BREAKOUT';
  }
  // False bearish breakout: wick pierced below support, but candle closed above support
  if (last.low < nearestSup && last.close > nearestSup && last.close > last.open) {
    return 'FALSE_BEAR_BREAKOUT';
  }
  // Confirmed bullish breakout: previous close <= resistance and current close > resistance
  if (prev.close <= nearestRes && last.close > nearestRes && last.close > last.open) {
    return 'BULLISH_BREAKOUT';
  }
  // Confirmed bearish breakout: previous close >= support and current close < support
  if (prev.close >= nearestSup && last.close < nearestSup && last.close < last.open) {
    return 'BEARISH_BREAKOUT';
  }

  return 'NONE';
}

/**
 * Detects classic institutional price-action candlestick patterns on the latest closed candles.
 */
export function detectCandlePatterns(candles: Candle[]): {
  patterns: string[];
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
} {
  if (candles.length < 2) return { patterns: [], bias: 'NEUTRAL' };

  const curr = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const body = Math.abs(curr.close - curr.open);
  const range = Math.max(curr.high - curr.low, 1e-9);
  const upperWick = curr.high - Math.max(curr.open, curr.close);
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;

  const prevBody = Math.abs(prev.close - prev.open);
  const patterns: string[] = [];
  let bullScore = 0;
  let bearScore = 0;

  // Pin Bar / Hammer (long lower wick >= 2x body, small upper wick)
  if (lowerWick >= Math.max(body * 2, range * 0.55) && upperWick <= range * 0.25) {
    patterns.push('Pin Bar Alta / Martelo');
    bullScore += 2;
  }

  // Shooting Star / Bearish Pin Bar
  if (upperWick >= Math.max(body * 2, range * 0.55) && lowerWick <= range * 0.25) {
    patterns.push('Pin Bar Baixa / Estrela Cadente');
    bearScore += 2;
  }

  // Bullish Engulfing
  if (
    prev.close < prev.open &&
    curr.close > curr.open &&
    curr.open <= prev.close &&
    curr.close >= prev.open &&
    body > prevBody * 1.05
  ) {
    patterns.push('Engolfo de Alta');
    bullScore += 2;
  }

  // Bearish Engulfing
  if (
    prev.close > prev.open &&
    curr.close < curr.open &&
    curr.open >= prev.close &&
    curr.close <= prev.open &&
    body > prevBody * 1.05
  ) {
    patterns.push('Engolfo de Baixa');
    bearScore += 2;
  }

  // Inside Bar
  if (curr.high < prev.high && curr.low > prev.low) {
    patterns.push('Inside Bar (Compressão)');
  }

  // Doji
  if (body <= range * 0.12) {
    patterns.push('Doji (Indecisão)');
  }

  const bias =
    bullScore > bearScore ? 'BULLISH' : bearScore > bullScore ? 'BEARISH' : 'NEUTRAL';

  return { patterns, bias };
}

/**
 * Computes the complete IndicatorSnapshot on closed candles.
 * By default, drops the very last live unclosed candle when `closedCandlesOnly` is true
 * to strictly prevent look-ahead bias on signal generation.
 */
export function computeIndicatorSnapshot(
  rawCandles: Candle[],
  declaredVolumeType: VolumeNature,
  closedCandlesOnly = true
): IndicatorSnapshot | null {
  const candles =
    closedCandlesOnly && rawCandles.length > 60
      ? rawCandles.slice(0, -1)
      : rawCandles;

  if (candles.length < 52) {
    return null;
  }

  const closes = candles.map((c) => c.close);
  const ema9Arr = calculateEMA(closes, 9);
  const ema21Arr = calculateEMA(closes, 21);
  const ema50Arr = calculateEMA(closes, 50);
  const rsiArr = calculateRSI(closes, 14);
  const macdRes = calculateMACD(closes, 12, 26, 9);
  const atrArr = calculateATR(candles, 14);
  const adxRes = calculateADX(candles, 14);
  const bbRes = calculateBollingerBands(closes, 20, 2);
  const vwapRes = calculateVWAP(candles, declaredVolumeType);
  const sr = detectSupportResistance(candles, 60);
  const breakout = detectBreakoutAndFalseBreakout(candles, sr.supports, sr.resistances);
  const candlePa = detectCandlePatterns(candles);

  const idx = candles.length - 1;
  const last = candles[idx];

  const ema9 = ema9Arr[idx];
  const ema21 = ema21Arr[idx];
  const ema50 = ema50Arr[idx];
  const rsi14 = rsiArr[idx];
  const macdLine = macdRes.macdLine[idx];
  const signalLine = macdRes.signalLine[idx];
  const histogram = macdRes.histogram[idx];
  const adx14 = adxRes.adx[idx];
  const plusDI = adxRes.plusDI[idx];
  const minusDI = adxRes.minusDI[idx];
  const atr14 = atrArr[idx];
  const bbUpper = bbRes.upper[idx];
  const bbMiddle = bbRes.middle[idx];
  const bbLower = bbRes.lower[idx];
  const bbBw = bbRes.bandwidth[idx];

  if (
    [ema9, ema21, ema50, rsi14, macdLine, signalLine, histogram, adx14, atr14, bbUpper].some(
      (v) => Number.isNaN(v) || !Number.isFinite(v)
    )
  ) {
    return null;
  }

  let trendDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (ema9 > ema21 && ema21 > ema50 && last.close > ema50) {
    trendDirection = 'BULLISH';
  } else if (ema9 < ema21 && ema21 < ema50 && last.close < ema50) {
    trendDirection = 'BEARISH';
  }

  const prevAtr14 = idx > 0 ? atrArr[idx - 1] : NaN;
  const macdEps = Math.max(1e-7, atr14 * 0.005);

  const rsiDir: IndicatorDirection =
    rsi14 > 52 ? 'SUBIDA' : rsi14 < 48 ? 'DESCIDA' : 'NEUTRO';
  const macdDir: IndicatorDirection =
    histogram > macdEps && macdLine > signalLine
      ? 'SUBIDA'
      : histogram < -macdEps && macdLine < signalLine
      ? 'DESCIDA'
      : 'NEUTRO';
  const adxDir: IndicatorDirection =
    adx14 >= 20 && plusDI > minusDI + 2
      ? 'SUBIDA'
      : adx14 >= 20 && minusDI > plusDI + 2
      ? 'DESCIDA'
      : 'NEUTRO';
  const atrDir: IndicatorDirection =
    Number.isFinite(prevAtr14) && prevAtr14 > 0
      ? atr14 > prevAtr14 * 1.005
        ? 'SUBIDA'
        : atr14 < prevAtr14 * 0.995
        ? 'DESCIDA'
        : 'NEUTRO'
      : 'NEUTRO';

  const prevEma21 = idx >= 5 ? ema21Arr[idx - 5] : NaN;
  const ema21SlopePct =
    Number.isFinite(prevEma21) && prevEma21 > 0
      ? Number((((ema21 - prevEma21) / prevEma21) * 100).toFixed(4))
      : 0;
  const atrStretchRatio =
    atr14 > 0 ? Number((Math.abs(last.close - ema21) / atr14).toFixed(2)) : 0;

  return {
    candleTime: last.time,
    close: last.close,
    ema9,
    ema21,
    ema50,
    ema21SlopePct,
    atrStretchRatio,
    rsi14,
    macd: { macdLine, signalLine, histogram },
    adx14,
    plusDI,
    minusDI,
    atr14,
    bollinger: {
      upper: bbUpper,
      middle: bbMiddle,
      lower: bbLower,
      bandwidth: bbBw,
    },
    vwap: {
      value: vwapRes.values[idx],
      volumeType: vwapRes.volumeType,
    },
    supports: sr.supports,
    resistances: sr.resistances,
    prevHigh: sr.prevHigh,
    prevLow: sr.prevLow,
    breakout,
    candlePatterns: candlePa.patterns,
    priceActionBias: candlePa.bias,
    trendDirection,
    indicatorDirections: {
      rsi: rsiDir,
      macd: macdDir,
      adx: adxDir,
      atr: atrDir,
    },
  };
}
