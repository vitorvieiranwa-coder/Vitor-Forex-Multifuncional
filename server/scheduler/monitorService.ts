import fs from 'fs';
import path from 'path';
import { computeIndicatorSnapshot } from '../../src/shared/indicators';
import { evaluateTrackedSignal } from '../../src/shared/positionMonitor';
import { evaluateStrategyForInstrument } from '../../src/shared/strategy';
import {
  DEFAULT_USER_SETTINGS,
  INSTRUMENT_LIST,
  InstrumentId,
  MarketInstrumentOverview,
  StrategyCandidate,
  TradingSignalRecord,
  UserSettings,
  isTerminalStatus,
} from '../../src/shared/types';
import { PushNotificationService } from '../notifications/pushService';
import { MarketDataService } from '../providers/marketDataProvider';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const STATE_FILE = path.join(DATA_DIR, 'engine-state.json');

interface PersistedUserWatch {
  userId: string;
  settings: UserSettings;
  signals: TradingSignalRecord[];
  updatedAtUtc: string;
}

interface EngineStateSnapshot {
  emittedOpportunityKeys: string[];
  recentCandidates: StrategyCandidate[];
  userWatches: Record<string, PersistedUserWatch>;
}

export class MarketMonitorService {
  private marketData: MarketDataService;
  private pushService: PushNotificationService;
  private overviews = new Map<InstrumentId, MarketInstrumentOverview>();
  private emittedKeys = new Set<string>();
  private recentCandidates: StrategyCandidate[] = [];
  private userWatches = new Map<string, PersistedUserWatch>();
  private isScanning = false;
  private lastScanUtc: string | null = null;
  private scanErrorLog: Array<{ timestampUtc: string; message: string }> = [];
  private quoteTimer: NodeJS.Timeout | null = null;
  private analysisTimer: NodeJS.Timeout | null = null;

  constructor(marketData: MarketDataService, pushService: PushNotificationService) {
    this.marketData = marketData;
    this.pushService = pushService;
    this.loadState();
  }

  private loadState(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as EngineStateSnapshot;
        if (Array.isArray(raw.emittedOpportunityKeys)) {
          raw.emittedOpportunityKeys.slice(-500).forEach((k) => this.emittedKeys.add(k));
        }
        if (Array.isArray(raw.recentCandidates)) {
          this.recentCandidates = raw.recentCandidates.slice(0, 50);
        }
        if (raw.userWatches) {
          for (const [uid, watch] of Object.entries(raw.userWatches)) {
            this.userWatches.set(uid, watch);
          }
        }
      }
    } catch {
      // Ignore corrupt cache and start clean
    }
  }

  private persistState(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const payload: EngineStateSnapshot = {
        emittedOpportunityKeys: Array.from(this.emittedKeys).slice(-500),
        recentCandidates: this.recentCandidates.slice(0, 50),
        userWatches: Object.fromEntries(this.userWatches.entries()),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
    } catch {
      // Non-fatal
    }
  }

  public start(): void {
    // Immediate bootstrap scan
    void this.runFullAnalysisCycle();

    // Fast quote & open-position monitoring every 20s
    this.quoteTimer = setInterval(() => {
      void this.refreshQuotesAndPositions();
    }, 20_000);

    // Full multi-timeframe indicator & strategy scan every 60s
    this.analysisTimer = setInterval(() => {
      void this.runFullAnalysisCycle();
    }, 60_000);
  }

  public stop(): void {
    if (this.quoteTimer) clearInterval(this.quoteTimer);
    if (this.analysisTimer) clearInterval(this.analysisTimer);
  }

  public syncUserWatch(
    userId: string,
    settings: UserSettings,
    signals: TradingSignalRecord[]
  ): void {
    const active = signals.filter((s) => !isTerminalStatus(s.status));
    this.userWatches.set(userId, {
      userId,
      settings,
      signals: active,
      updatedAtUtc: new Date().toISOString(),
    });
    this.persistState();
  }

  public getOverviews(): MarketInstrumentOverview[] {
    return INSTRUMENT_LIST.map(
      (inst) =>
        this.overviews.get(inst) || {
          instrument: inst,
          feedStatus: 'NO_DATA',
          feedMessage: 'SEM DADOS DE MERCADO',
          quote: null,
          timeframes: { H1: null, M15: null, M5: null, M1: null },
          scalping: null,
          intraday: null,
          bestScore: 0,
          classification: 'SEM_ENTRADA',
        }
    );
  }

  public getRecentActionableSignals(): StrategyCandidate[] {
    return this.recentCandidates;
  }

  public getEngineDiagnostics() {
    return {
      isScanning: this.isScanning,
      lastScanUtc: this.lastScanUtc,
      recentErrors: this.scanErrorLog.slice(-10),
      trackedUsers: this.userWatches.size,
      marketHealth: this.marketData.getHealth(),
    };
  }

  private recordError(msg: string): void {
    this.scanErrorLog.push({ timestampUtc: new Date().toISOString(), message: msg });
    if (this.scanErrorLog.length > 50) {
      this.scanErrorLog.shift();
    }
  }

  private isAlertEnabledForInstrument(settings: UserSettings, inst: InstrumentId): boolean {
    switch (inst) {
      case 'EUR/USD':
        return settings.alertEurUsd;
      case 'GBP/USD':
        return settings.alertGbpUsd;
      case 'EUR/JPY':
        return settings.alertEurJpy;
      case 'GBP/JPY':
        return settings.alertGbpJpy;
      case 'XAU/USD':
        return settings.alertXauUsd;
    }
  }

  public async refreshQuotesAndPositions(): Promise<void> {
    try {
      const quotes = await this.marketData.getAllQuotes();
      for (const inst of INSTRUMENT_LIST) {
        const quote = quotes[inst];
        const prev = this.overviews.get(inst);
        if (prev && quote) {
          prev.quote = quote;
          prev.feedStatus = 'CONNECTED';
        }
      }

      // Evaluate any tracked active positions for background Web Push alerts
      for (const watch of this.userWatches.values()) {
        for (const sig of watch.signals) {
          if (isTerminalStatus(sig.status)) continue;
          const quote = quotes[sig.instrument];
          if (!quote || !quote.marketOpen) continue;

          const [m5Res, m15Res] = await Promise.all([
            this.marketData.getCandles(sig.instrument, 'M5', 120),
            this.marketData.getCandles(sig.instrument, 'M15', 120),
          ]);

          const evalRes = evaluateTrackedSignal(
            sig,
            quote,
            m5Res && m15Res ? { M5: m5Res.candles, M15: m15Res.candles } : undefined,
            m5Res?.volumeType || 'TICK_VOLUME'
          );

          if (!evalRes || !evalRes.newStatus) continue;

          if (watch.settings.pushEnabled && this.isAlertEnabledForInstrument(watch.settings, sig.instrument)) {
            if (evalRes.newStatus === 'TP_ATINGIDO') {
              await this.pushService.sendToUser(
                watch.userId,
                {
                  title: `TP Atingido — ${sig.instrument} (${sig.direction})`,
                  body: evalRes.closeReason || 'Objetivo de Take Profit atingido.',
                  tag: `tp-${sig.id}`,
                },
                `tp-${sig.id}`
              );
            } else if (evalRes.newStatus === 'SL_ATINGIDO') {
              await this.pushService.sendToUser(
                watch.userId,
                {
                  title: `SL Atingido — ${sig.instrument} (${sig.direction})`,
                  body: evalRes.closeReason || 'Stop Loss atingido.',
                  tag: `sl-${sig.id}`,
                },
                `sl-${sig.id}`
              );
            } else if (
              evalRes.newStatus === 'ENCERRAMENTO_RECOMENDADO' &&
              evalRes.reversal.alertTitle
            ) {
              await this.pushService.sendToUser(
                watch.userId,
                {
                  title: evalRes.reversal.alertTitle,
                  body: evalRes.reversal.reasons.slice(0, 2).join(' · '),
                  tag: `rev-${sig.id}`,
                },
                `rev-${sig.id}`
              );
            } else if (evalRes.newStatus === 'INVALIDADO') {
              await this.pushService.sendToUser(
                watch.userId,
                {
                  title: `Sinal Invalidado — ${sig.instrument}`,
                  body: evalRes.closeReason || 'Sinal invalidado antes da entrada.',
                  tag: `inv-${sig.id}`,
                },
                `inv-${sig.id}`
              );
            }
          }
        }
      }
    } catch (err) {
      this.recordError(err instanceof Error ? err.message : String(err));
    }
  }

  public async runFullAnalysisCycle(): Promise<void> {
    if (this.isScanning) return; // Deduplication mutex
    this.isScanning = true;

    try {
      for (const inst of INSTRUMENT_LIST) {
        const quote = await this.marketData.getQuote(inst);
        const [h1Res, m15Res, m5Res, m1Res] = await Promise.all([
          this.marketData.getCandles(inst, 'H1', 220),
          this.marketData.getCandles(inst, 'M15', 220),
          this.marketData.getCandles(inst, 'M5', 220),
          this.marketData.getCandles(inst, 'M1', 180),
        ]);

        if (!quote || !h1Res || !m15Res || !m5Res) {
          this.overviews.set(inst, {
            instrument: inst,
            feedStatus: 'NO_DATA',
            feedMessage: 'SEM DADOS DE MERCADO',
            quote: quote || null,
            timeframes: { H1: null, M15: null, M5: null, M1: null },
            scalping: null,
            intraday: null,
            bestScore: 0,
            classification: 'SEM_ENTRADA',
          });
          continue;
        }

        const volType = m5Res.volumeType;
        const h1Snap = computeIndicatorSnapshot(h1Res.candles, volType, true);
        const m15Snap = computeIndicatorSnapshot(m15Res.candles, volType, true);
        const m5Snap = computeIndicatorSnapshot(m5Res.candles, volType, true);
        const m1Snap = m1Res ? computeIndicatorSnapshot(m1Res.candles, volType, true) : null;

        const strategyInput = {
          instrument: inst,
          quote,
          candlesByTf: {
            H1: h1Res.candles,
            M15: m15Res.candles,
            M5: m5Res.candles,
            M1: m1Res?.candles || [],
          },
          volumeType: volType,
          settings: DEFAULT_USER_SETTINGS,
        };

        const scalping = evaluateStrategyForInstrument(strategyInput, 'SCALPING', true);
        const intraday = evaluateStrategyForInstrument(strategyInput, 'INTRADAY', true);

        const bestCandidate =
          (scalping?.score.total ?? 0) >= (intraday?.score.total ?? 0) ? scalping : intraday;

        const overview: MarketInstrumentOverview = {
          instrument: inst,
          feedStatus: quote.marketOpen ? 'CONNECTED' : 'CONNECTED',
          feedMessage: quote.marketOpen
            ? `${m5Res.source} · Ativo`
            : `${m5Res.source} · Mercado Fechado (Últimos dados reais)`,
          quote,
          timeframes: {
            H1: h1Snap,
            M15: m15Snap,
            M5: m5Snap,
            M1: m1Snap,
          },
          scalping,
          intraday,
          bestScore: bestCandidate?.score.total ?? 0,
          classification: bestCandidate?.score.classification ?? 'SEM_ENTRADA',
        };

        this.overviews.set(inst, overview);

        // Emit actionable BUY/SELL signals with strict deduplication
        for (const candidate of [scalping, intraday]) {
          if (
            candidate &&
            candidate.actionable &&
            candidate.direction &&
            candidate.score.total >= 80 &&
            !this.emittedKeys.has(candidate.opportunityKey)
          ) {
            this.emittedKeys.add(candidate.opportunityKey);
            this.recentCandidates.unshift(candidate);
            this.recentCandidates = this.recentCandidates.slice(0, 50);

            // Background Web Push for subscribed users who enabled this instrument
            for (const watch of this.userWatches.values()) {
              if (
                watch.settings.pushEnabled &&
                this.isAlertEnabledForInstrument(watch.settings, inst)
              ) {
                await this.pushService.sendToUser(
                  watch.userId,
                  {
                    title: `Novo Sinal ${candidate.direction} — ${inst} (${candidate.strategy})`,
                    body: `Pontuação ${candidate.score.total}/100 · Entrada ${candidate.recommendedEntry} · TP ${candidate.takeProfit} · SL ${candidate.stopLoss}`,
                    tag: candidate.opportunityKey,
                  },
                  `${watch.userId}_${candidate.opportunityKey}`
                );
              }
            }
          }
        }
      }

      this.lastScanUtc = new Date().toISOString();
      this.persistState();
    } catch (err) {
      this.recordError(err instanceof Error ? err.message : String(err));
    } finally {
      this.isScanning = false;
    }
  }
}
