import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { PushNotificationService } from './server/notifications/pushService';
import { MarketDataService } from './server/providers/marketDataProvider';
import { MarketMonitorService } from './server/scheduler/monitorService';
import { runHistoricalBacktest } from './src/shared/backtest';
import {
  HistoricalReplaySignal,
  replayInstrumentDay,
  summarizeDayReplay,
} from './src/shared/dayReplay';
import {
  calculateADX,
  calculateATR,
  calculateBollingerBands,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateVWAP,
  computeIndicatorSnapshot,
} from './src/shared/indicators';
import { evaluateTrackedSignal } from './src/shared/positionMonitor';
import { evaluateStrategyForInstrument } from './src/shared/strategy';
import {
  BacktestConfig,
  Candle,
  DEFAULT_USER_SETTINGS,
  INSTRUMENT_LIST,
  InstrumentId,
  Timeframe,
  TradingSignalRecord,
  UserSettings,
} from './src/shared/types';

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

function isValidInstrumentParam(val: unknown): val is InstrumentId {
  return typeof val === 'string' && INSTRUMENT_LIST.includes(val as InstrumentId);
}

function isValidTimeframeParam(val: unknown): val is Timeframe {
  return val === 'M1' || val === 'M5' || val === 'M15' || val === 'H1';
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const marketData = new MarketDataService();
  const pushService = new PushNotificationService();
  const monitorService = new MarketMonitorService(marketData, pushService);

  if (process.env.CRON_ENABLED !== 'false') {
    monitorService.start();
  }

  // Health & diagnostics
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'FOREX INTELLIGENCE',
      version: '1.0.0',
      timestampUtc: new Date().toISOString(),
      diagnostics: monitorService.getEngineDiagnostics(),
    });
  });

  // Market overview for all 5 monitored instruments
  app.get('/api/market/snapshot', (_req, res) => {
    res.json({
      timestampUtc: new Date().toISOString(),
      health: marketData.getHealth(),
      instruments: monitorService.getOverviews(),
    });
  });

  // Evaluate specific user settings against live market data (on-demand + personalized TP/SL)
  app.post('/api/market/evaluate-user-strategies', async (req, res) => {
    try {
      const settings = req.body?.settings as UserSettings | undefined;
      if (!settings) {
        return res.status(400).json({ error: 'Missing settings payload' });
      }
      const candidates = [];
      for (const inst of INSTRUMENT_LIST) {
        const quote = await marketData.getQuote(inst);
        const [h1, m15, m5, m1] = await Promise.all([
          marketData.getCandles(inst, 'H1', 220),
          marketData.getCandles(inst, 'M15', 220),
          marketData.getCandles(inst, 'M5', 220),
          marketData.getCandles(inst, 'M1', 180),
        ]);
        if (!quote || !h1 || !m15 || !m5) continue;

        const input = {
          instrument: inst,
          quote,
          candlesByTf: {
            H1: h1.candles,
            M15: m15.candles,
            M5: m5.candles,
            M1: m1?.candles || [],
          },
          volumeType: m5.volumeType,
          settings,
        };
        const scalp = evaluateStrategyForInstrument(input, 'SCALPING', true);
        const intra = evaluateStrategyForInstrument(input, 'INTRADAY', true);
        if (scalp) candidates.push(scalp);
        if (intra) candidates.push(intra);
      }
      return res.json({ candidates, timestampUtc: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Strategy evaluation error',
      });
    }
  });

  // OHLC candles + computed indicators for TradingView Lightweight Charts
  app.get('/api/market/candles', async (req, res) => {
    const instrument = req.query.instrument;
    const timeframe = req.query.timeframe;
    const limit = Math.min(500, Math.max(60, Number(req.query.limit) || 220));

    if (!isValidInstrumentParam(instrument) || !isValidTimeframeParam(timeframe)) {
      return res.status(400).json({ error: 'Invalid instrument or timeframe parameter' });
    }

    const [candleRes, quote] = await Promise.all([
      marketData.getCandles(instrument, timeframe, limit),
      marketData.getQuote(instrument),
    ]);

    if (!candleRes || candleRes.candles.length === 0) {
      return res.status(503).json({
        feedStatus: 'NO_DATA',
        message: 'SEM DADOS DE MERCADO',
        candles: [],
      });
    }

    const candles = candleRes.candles;
    const closes = candles.map((c) => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    const rsi14 = calculateRSI(closes, 14);
    const macd = calculateMACD(closes, 12, 26, 9);
    const atr14 = calculateATR(candles, 14);
    const adx = calculateADX(candles, 14);
    const bb = calculateBollingerBands(closes, 20, 2);
    const vwap = calculateVWAP(candles, candleRes.volumeType);
    const snapshot = computeIndicatorSnapshot(candles, candleRes.volumeType, true);

    return res.json({
      feedStatus: 'CONNECTED',
      instrument,
      timeframe,
      source: candleRes.source,
      volumeType: candleRes.volumeType,
      fetchedAtUtc: candleRes.fetchedAtUtc,
      quote,
      candles,
      series: {
        ema9,
        ema21,
        ema50,
        rsi14,
        macd,
        atr14,
        adx,
        bollinger: bb,
        vwap: vwap.values,
      },
      snapshot,
    });
  });

  // Server-detected actionable signals queue
  app.get('/api/engine/signals', (_req, res) => {
    res.json({
      signals: monitorService.getRecentActionableSignals(),
      timestampUtc: new Date().toISOString(),
    });
  });

  // Trigger manual market scan
  app.post('/api/engine/run-scan', async (_req, res) => {
    await monitorService.runFullAnalysisCycle();
    res.json({
      ok: true,
      timestampUtc: new Date().toISOString(),
      instruments: monitorService.getOverviews(),
    });
  });

  // Sync user's tracked signals & settings with backend daemon + evaluate open positions immediately
  app.post('/api/engine/sync-positions', async (req, res) => {
    try {
      const userId = req.body?.userId as string | undefined;
      const settings = req.body?.settings as UserSettings | undefined;
      const signals = req.body?.signals as TradingSignalRecord[] | undefined;

      if (!userId || !settings || !Array.isArray(signals)) {
        return res.status(400).json({ error: 'Invalid sync payload' });
      }

      monitorService.syncUserWatch(userId, settings, signals);

      const evaluations = [];
      for (const sig of signals) {
        const quote = await marketData.getQuote(sig.instrument);
        if (!quote) continue;
        const [m5Res, m15Res] = await Promise.all([
          marketData.getCandles(sig.instrument, 'M5', 120),
          marketData.getCandles(sig.instrument, 'M15', 120),
        ]);
        const evalRes = evaluateTrackedSignal(
          sig,
          quote,
          m5Res && m15Res ? { M5: m5Res.candles, M15: m15Res.candles } : undefined,
          m5Res?.volumeType || 'TICK_VOLUME'
        );
        if (evalRes) {
          evaluations.push({ ...evalRes, quote });
        }
      }

      return res.json({ evaluations, timestampUtc: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Position evaluation failed',
      });
    }
  });

  // Backtesting on real historical data (from market provider or uploaded CSV OHLC)
  app.post('/api/backtest/run', async (req, res) => {
    try {
      const config = req.body?.config as BacktestConfig | undefined;
      const uploadedCandles = req.body?.candles as Candle[] | undefined;

      if (!config || !isValidInstrumentParam(config.instrument)) {
        return res.status(400).json({ error: 'Invalid backtest configuration' });
      }

      let candles: Candle[] = [];
      let sourceLabel = '';
      let volumeType: 'TICK_VOLUME' | 'FUTURES_VOLUME' | 'NO_VOLUME_DATA' = 'TICK_VOLUME';

      if (Array.isArray(uploadedCandles) && uploadedCandles.length >= 250) {
        candles = uploadedCandles;
        sourceLabel = 'CSV Histórico Carregado pelo Utilizador';
        volumeType = candles.some((c) => c.volume > 0) ? 'TICK_VOLUME' : 'NO_VOLUME_DATA';
      } else {
        const fetched = await marketData.getCandles(
          config.instrument,
          config.timeframe,
          500
        );
        if (!fetched || fetched.candles.length < 250) {
          return res.status(503).json({
            error:
              'SEM DADOS HISTÓRICOS SUFICIENTES (mínimo 250 velas OHLC necessárias para backtest rigoroso).',
          });
        }
        candles = fetched.candles;
        sourceLabel = fetched.source;
        volumeType = fetched.volumeType;
      }

      const result = runHistoricalBacktest(candles, config, sourceLabel, volumeType);
      return res.json({ result });
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Backtest execution failed',
      });
    }
  });

  // Historical single-day multi-instrument replay (for auditing & Firestore archive import)
  app.post('/api/history/replay-day', async (req, res) => {
    try {
      const targetDateUtc =
        typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
          ? req.body.date
          : '2026-11-20';
      const settings = (req.body?.settings as UserSettings | undefined) ?? {
        userId: 'replay',
        ...DEFAULT_USER_SETTINGS,
      };
      const useBreakEvenAt1R =
        typeof req.body?.useBreakEvenAt1R === 'boolean' ? req.body.useBreakEvenAt1R : true;

      const allSignals: HistoricalReplaySignal[] = [];

      for (const inst of INSTRUMENT_LIST) {
        const [m5, m15, h1] = await Promise.all([
          marketData.getCandles(inst, 'M5', 2000),
          marketData.getCandles(inst, 'M15', 1000),
          marketData.getCandles(inst, 'H1', 1000),
        ]);
        if (!m5 || !m15 || !h1) continue;

        for (const strategy of ['SCALPING', 'INTRADAY'] as const) {
          const daySignals = replayInstrumentDay({
            instrument: inst,
            strategy,
            targetDateUtc,
            m5Candles: m5.candles,
            m15Candles: m15.candles,
            h1Candles: h1.candles,
            volumeType: m5.volumeType,
            sourceLabel: m5.source,
            settings,
            useBreakEvenAt1R,
          });
          allSignals.push(...daySignals);
        }
      }

      const summary = summarizeDayReplay(targetDateUtc, allSignals);
      return res.json(summary);
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Day replay failed',
      });
    }
  });

  // Web Push endpoints
  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({ publicKey: pushService.getPublicKey() });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const userId = req.body?.userId as string | undefined;
    const subscription = req.body?.subscription;
    if (!userId || !subscription?.endpoint) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }
    const id = pushService.addSubscription(userId, subscription);
    return res.json({ ok: true, id, count: pushService.getSubscriptionCount(userId) });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const userId = req.body?.userId as string | undefined;
    const endpoint = req.body?.endpoint as string | undefined;
    if (!userId || !endpoint) {
      return res.status(400).json({ error: 'Invalid unsubscribe request' });
    }
    pushService.removeSubscription(userId, endpoint);
    return res.json({ ok: true, count: pushService.getSubscriptionCount(userId) });
  });

  app.post('/api/push/test', async (req, res) => {
    const userId = req.body?.userId as string | undefined;
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    const outcome = await pushService.sendToUser(userId, {
      title: 'FOREX INTELLIGENCE — Teste Web Push',
      body: 'As notificações em segundo plano estão ativas neste dispositivo.',
      tag: `test-${Date.now()}`,
    });
    return res.json({ ok: true, ...outcome });
  });

  return { app, monitorService };
}

async function startServer() {
  const { app } = createApp();

  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FOREX INTELLIGENCE] Server listening on http://0.0.0.0:${PORT} (${IS_PROD ? 'production' : 'development'})`);
  });
}

if (process.env.VITEST !== 'true') {
  void startServer();
}
