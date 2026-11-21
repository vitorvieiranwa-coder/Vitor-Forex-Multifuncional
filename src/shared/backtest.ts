import { calculatePositionSize, evaluateTrendReversal } from './positionMonitor';
import { evaluateStrategyForInstrument } from './strategy';
import {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  Candle,
  INSTRUMENTS,
  Quote,
  VolumeNature,
  fromPipsOrPoints,
} from './types';

/**
 * Resamples lower timeframe candles into higher timeframe buckets without any look-ahead bias.
 */
function aggregateCandles(candles: Candle[], bucketSeconds: number): Candle[] {
  if (candles.length === 0) return [];
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const bTime = Math.floor(c.time / bucketSeconds) * bucketSeconds;
    const existing = buckets.get(bTime);
    if (!existing) {
      buckets.set(bTime, {
        time: bTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

/**
 * Runs a strictly causal (zero look-ahead bias) bar-by-bar backtest on real historical OHLC candles.
 */
export function runHistoricalBacktest(
  candlesPrimary: Candle[],
  config: BacktestConfig,
  sourceLabel: string,
  volumeType: VolumeNature = 'TICK_VOLUME'
): BacktestResult {
  const sorted = [...candlesPrimary].sort((a, b) => a.time - b.time);
  const spec = INSTRUMENTS[config.instrument];
  const spreadAbs = fromPipsOrPoints(config.instrument, config.spreadPips);
  const slippageAbs = fromPipsOrPoints(config.instrument, config.slippagePips);

  const trades: BacktestTrade[] = [];
  let equity = config.initialCapital;
  let peakEquity = config.initialCapital;
  let maxDrawdownPct = 0;
  let cumR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;

  let activeTrade: {
    entryTime: number;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    takeProfit: number;
    stopLoss: number;
    initialRiskDist: number;
    movedToBreakEven: boolean;
    score: number;
    lots: number;
  } | null = null;

  let pendingOrder: {
    direction: 'BUY' | 'SELL';
    recommendedEntry: number;
    takeProfit: number;
    stopLoss: number;
    score: number;
    expiresAtBar: number;
  } | null = null;

  // Need enough warm-up bars so H1/M15 indicators are valid
  const warmup = Math.min(220, Math.floor(sorted.length * 0.4));

  for (let i = warmup; i < sorted.length; i++) {
    const bar = sorted[i];
    const historySlice = sorted.slice(0, i + 1);

    // Build causal higher-TF views using ONLY candles up to `bar.time`
    const m5Slice = config.timeframe === 'M5' ? historySlice : historySlice;
    const m15Slice =
      config.timeframe === 'M15' ? historySlice : aggregateCandles(historySlice, 900);
    const h1Slice = aggregateCandles(historySlice, 3600);

    // Check pending conditional pullback limit order fill first
    if (!activeTrade && pendingOrder) {
      const bidLow = bar.low;
      const bidHigh = bar.high;
      const askLow = bar.low + spreadAbs;
      const askHigh = bar.high + spreadAbs;

      const invalidated =
        pendingOrder.direction === 'BUY'
          ? bidLow <= pendingOrder.stopLoss
          : askHigh >= pendingOrder.stopLoss;

      if (invalidated || i > pendingOrder.expiresAtBar) {
        pendingOrder = null;
      } else {
        const filled =
          pendingOrder.direction === 'BUY'
            ? askLow <= pendingOrder.recommendedEntry
            : bidHigh >= pendingOrder.recommendedEntry;

        if (filled) {
          const entryPrice = pendingOrder.recommendedEntry;
          const sizing = calculatePositionSize(
            config.instrument,
            entryPrice,
            pendingOrder.stopLoss,
            equity,
            config.riskPercentPerTrade
          );
          activeTrade = {
            entryTime: bar.time,
            direction: pendingOrder.direction,
            entryPrice,
            takeProfit: pendingOrder.takeProfit,
            stopLoss: pendingOrder.stopLoss,
            initialRiskDist: Math.abs(entryPrice - pendingOrder.stopLoss),
            movedToBreakEven: false,
            score: pendingOrder.score,
            lots: sizing.lots,
          };
          pendingOrder = null;
          continue; // Start checking exits on next bar
        }
      }
    }

    // Check active trade exit first using conservative Bid/Ask bar bounds
    if (activeTrade) {
      const riskDist = activeTrade.initialRiskDist;
      const commissionUsd = config.commissionPerLotUsd * activeTrade.lots;

      const bidLow = bar.low;
      const bidHigh = bar.high;
      const askLow = bar.low + spreadAbs;
      const askHigh = bar.high + spreadAbs;

      let exitPrice: number | null = null;
      let outcome: BacktestTrade['outcome'] | null = null;

      if (activeTrade.direction === 'BUY') {
        if (bidLow <= activeTrade.stopLoss) {
          exitPrice = activeTrade.stopLoss - slippageAbs;
          outcome = 'SL';
        } else if (bidHigh >= activeTrade.takeProfit) {
          exitPrice = activeTrade.takeProfit - slippageAbs;
          outcome = 'TP';
        }
      } else {
        if (askHigh >= activeTrade.stopLoss) {
          exitPrice = activeTrade.stopLoss + slippageAbs;
          outcome = 'SL';
        } else if (askLow <= activeTrade.takeProfit) {
          exitPrice = activeTrade.takeProfit + slippageAbs;
          outcome = 'TP';
        }
      }

      // Move SL to Break-Even after +1.0R favorable excursion (effective for subsequent bars)
      if (!outcome && config.useBreakEvenAt1R && !activeTrade.movedToBreakEven && riskDist > 0) {
        if (activeTrade.direction === 'BUY' && bidHigh >= activeTrade.entryPrice + riskDist) {
          activeTrade.stopLoss = activeTrade.entryPrice + spreadAbs * 0.25;
          activeTrade.movedToBreakEven = true;
        } else if (activeTrade.direction === 'SELL' && askLow <= activeTrade.entryPrice - riskDist) {
          activeTrade.stopLoss = activeTrade.entryPrice - spreadAbs * 0.25;
          activeTrade.movedToBreakEven = true;
        }
      }

      // Check trend reversal exit on closed bar if still open
      if (!outcome && m5Slice.length >= 60 && m15Slice.length >= 60) {
        const rev = evaluateTrendReversal(
          activeTrade.direction,
          config.instrument,
          { M5: m5Slice, M15: m15Slice },
          volumeType
        );
        if (rev.shouldRecommendExit) {
          exitPrice =
            activeTrade.direction === 'BUY'
              ? bar.close - slippageAbs
              : bar.close + spreadAbs + slippageAbs;
          outcome = 'REVERSAL_EXIT';
        }
      }

      if (outcome && exitPrice !== null) {
        const diff =
          activeTrade.direction === 'BUY'
            ? exitPrice - activeTrade.entryPrice
            : activeTrade.entryPrice - exitPrice;
        const resultR = riskDist > 0 ? Number((diff / riskDist).toFixed(2)) : 0;
        const pips = diff / spec.pipSize;
        const netMonetary = Number(
          (pips * spec.pipValuePerStandardLot * activeTrade.lots - commissionUsd).toFixed(2)
        );

        equity += netMonetary;
        peakEquity = Math.max(peakEquity, equity);
        const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
        maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);

        cumR += resultR;
        peakR = Math.max(peakR, cumR);
        maxDrawdownR = Math.max(maxDrawdownR, peakR - cumR);

        trades.push({
          id: `BT-${trades.length + 1}`,
          entryTimeUtc: new Date(activeTrade.entryTime * 1000).toISOString(),
          exitTimeUtc: new Date(bar.time * 1000).toISOString(),
          direction: activeTrade.direction,
          entryPrice: activeTrade.entryPrice,
          exitPrice,
          takeProfit: activeTrade.takeProfit,
          stopLoss: activeTrade.stopLoss,
          score: activeTrade.score,
          outcome,
          resultR,
          netMonetary,
          hourUtc: new Date(activeTrade.entryTime * 1000).getUTCHours(),
        });

        activeTrade = null;
        continue;
      }
    }

    // Look for new entry only when flat and higher TFs have sufficient history
    if (!activeTrade && !pendingOrder && h1Slice.length >= 55 && m15Slice.length >= 55 && m5Slice.length >= 55) {
      const quote: Quote = {
        instrument: config.instrument,
        bid: bar.close,
        ask: bar.close + spreadAbs,
        mid: bar.close + spreadAbs / 2,
        spread: spreadAbs,
        spreadPips: config.spreadPips,
        changePct: 0,
        timestampUtc: new Date(bar.time * 1000).toISOString(),
        ageMs: 0,
        source: sourceLabel,
        marketOpen: true,
      };

      const candidate = evaluateStrategyForInstrument(
        {
          instrument: config.instrument,
          quote,
          candlesByTf: {
            H1: h1Slice,
            M15: m15Slice,
            M5: m5Slice,
            M1: m5Slice,
          },
          volumeType,
          settings: {
            scalpingTargetPips: config.scalpingTargetPips,
            intradayTargetPips: config.intradayTargetPips,
            xauScalpingDistance: config.xauScalpingDistance,
            xauIntradayDistance: config.xauIntradayDistance,
            minRiskReward: config.minRiskReward,
          },
        },
        config.strategy,
        false
      );

      if (candidate && candidate.actionable && candidate.direction) {
        if (candidate.executionType === 'CONDITIONAL') {
          pendingOrder = {
            direction: candidate.direction,
            recommendedEntry: candidate.recommendedEntry,
            takeProfit: candidate.takeProfit,
            stopLoss: candidate.stopLoss,
            score: candidate.score.total,
            expiresAtBar: i + 6,
          };
        } else {
          const entryWithSlippage =
            candidate.direction === 'BUY'
              ? candidate.recommendedEntry + slippageAbs
              : candidate.recommendedEntry - slippageAbs;
          const sizing = calculatePositionSize(
            config.instrument,
            entryWithSlippage,
            candidate.stopLoss,
            equity,
            config.riskPercentPerTrade
          );

          activeTrade = {
            entryTime: bar.time,
            direction: candidate.direction,
            entryPrice: entryWithSlippage,
            takeProfit: candidate.takeProfit,
            stopLoss: candidate.stopLoss,
            initialRiskDist: Math.abs(entryWithSlippage - candidate.stopLoss),
            movedToBreakEven: false,
            score: candidate.score.total,
            lots: sizing.lots,
          };
        }
      }
    }
  }

  const wins = trades.filter((t) => t.resultR > 0).length;
  const losses = trades.filter((t) => t.resultR <= 0).length;
  const buyTrades = trades.filter((t) => t.direction === 'BUY');
  const sellTrades = trades.filter((t) => t.direction === 'SELL');

  const hourMap = new Map<number, { count: number; netR: number }>();
  for (const t of trades) {
    const prev = hourMap.get(t.hourUtc) || { count: 0, netR: 0 };
    hourMap.set(t.hourUtc, {
      count: prev.count + 1,
      netR: Number((prev.netR + t.resultR).toFixed(2)),
    });
  }

  return {
    instrument: config.instrument,
    strategy: config.strategy,
    timeframe: config.timeframe,
    sourceLabel,
    candlesAnalyzed: sorted.length,
    dateRangeUtc: {
      start: sorted.length ? new Date(sorted[0].time * 1000).toISOString() : '',
      end: sorted.length ? new Date(sorted[sorted.length - 1].time * 1000).toISOString() : '',
    },
    totalSignals: trades.length,
    wins,
    losses,
    winRatePct: trades.length ? Number(((wins / trades.length) * 100).toFixed(1)) : 0,
    netR: Number(cumR.toFixed(2)),
    netMonetary: Number((equity - config.initialCapital).toFixed(2)),
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    reversalExits: trades.filter((t) => t.outcome === 'REVERSAL_EXIT').length,
    buyStats: {
      count: buyTrades.length,
      winRatePct: buyTrades.length
        ? Number(((buyTrades.filter((t) => t.resultR > 0).length / buyTrades.length) * 100).toFixed(1))
        : 0,
      netR: Number(buyTrades.reduce((a, b) => a + b.resultR, 0).toFixed(2)),
    },
    sellStats: {
      count: sellTrades.length,
      winRatePct: sellTrades.length
        ? Number(((sellTrades.filter((t) => t.resultR > 0).length / sellTrades.length) * 100).toFixed(1))
        : 0,
      netR: Number(sellTrades.reduce((a, b) => a + b.resultR, 0).toFixed(2)),
    },
    byHourUtc: Array.from(hourMap.entries())
      .map(([hour, v]) => ({ hour, ...v }))
      .sort((a, b) => a.hour - b.hour),
    trades,
  };
}
