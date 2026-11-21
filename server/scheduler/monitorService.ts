import fs from 'fs';
import path from 'path';
import { computeIndicatorSnapshot } from '../../src/shared/indicators';
import { getMarketOpenScheduleStatus } from '../../src/shared/marketHours';
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

export interface AnalysisCycleOptions {
  forceFresh?: boolean;
  reason?: string;
}

export class MarketMonitorService {
  private marketData: MarketDataService;
  private pushService: PushNotificationService;
  private overviews = new Map<InstrumentId, MarketInstrumentOverview>();
  private emittedKeys = new Set<string>();
  private recentCandidates: StrategyCandidate[] = [];
  private userWatches = new Map<string, PersistedUserWatch>();
  private lastMarketOpenByInst = new Map<InstrumentId, boolean>();
  private lastMarketOpenTriggerUtc: string | null = null;
  private lastAnalysisReason: string = 'BOOTSTRAP';
  private isScanning = false;
  private pendingForceRescan = false;
  private isStopped = false;
  private lastScanUtc: string | null = null;
  private scanErrorLog: Array<{ timestampUtc: string; message: string }> = [];
  private quoteTimer: NodeJS.Timeout | null = null;
  private analysisTimer: NodeJS.Timeout | null = null;
  private openBoundaryTimer: NodeJS.Timeout | null = null;
  private postOpenVerifyTimers: NodeJS.Timeout[] = [];

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
    this.isStopped = false;
    // Immediate bootstrap scan
    void this.runFullAnalysisCycle({ reason: 'BOOTSTRAP' });

    // Adaptive quote & market-open detector loop (5s near market open, 15s normal)
    this.scheduleNextQuoteTick();

    // Adaptive multi-timeframe indicator & strategy loop (20s post-open launch, 60s normal)
    this.scheduleNextAnalysisTick();

    // Precision boundary timer armed for the exact second Forex / Gold markets open
    this.armNextMarketOpenBoundary();
  }

  public stop(): void {
    this.isStopped = true;
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    if (this.analysisTimer) clearTimeout(this.analysisTimer);
    if (this.openBoundaryTimer) clearTimeout(this.openBoundaryTimer);
    for (const t of this.postOpenVerifyTimers) clearTimeout(t);
    this.quoteTimer = null;
    this.analysisTimer = null;
    this.openBoundaryTimer = null;
    this.postOpenVerifyTimers = [];
  }

  private scheduleNextQuoteTick(): void {
    if (this.isStopped) return;
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    const schedule = getMarketOpenScheduleStatus();
    const delayMs =
      schedule.isWithinPreOpenWindow || schedule.isWithinPostOpenLaunchWindow ? 5_000 : 15_000;
    this.quoteTimer = setTimeout(async () => {
      await this.refreshQuotesAndPositions();
      this.scheduleNextQuoteTick();
    }, delayMs);
    this.quoteTimer.unref?.();
  }

  private scheduleNextAnalysisTick(): void {
    if (this.isStopped) return;
    if (this.analysisTimer) clearTimeout(this.analysisTimer);
    const schedule = getMarketOpenScheduleStatus();
    const delayMs = schedule.isWithinPostOpenLaunchWindow ? 20_000 : 60_000;
    this.analysisTimer = setTimeout(async () => {
      await this.runFullAnalysisCycle({
        forceFresh: schedule.isWithinPostOpenLaunchWindow,
        reason: schedule.isWithinPostOpenLaunchWindow ? 'POST_OPEN_LAUNCH' : 'SCHEDULED',
      });
      this.scheduleNextAnalysisTick();
    }, delayMs);
    this.analysisTimer.unref?.();
  }

  private armNextMarketOpenBoundary(): void {
    if (this.isStopped) return;
    if (this.openBoundaryTimer) clearTimeout(this.openBoundaryTimer);

    const schedule = getMarketOpenScheduleStatus();
    if (schedule.msUntilNextOpen <= 0) {
      // Both Forex & Gold are currently open — recheck periodically in case of daily/weekend close
      this.openBoundaryTimer = setTimeout(() => this.armNextMarketOpenBoundary(), 15 * 60_000);
      this.openBoundaryTimer.unref?.();
      return;
    }

    // Cap single timer at 6 hours so Node timeout stays safe & clock-drift-free
    const maxChunkMs = 6 * 60 * 60_000;
    const waitMs = Math.min(maxChunkMs, schedule.msUntilNextOpen + 1500);
    const willReachOpen = schedule.msUntilNextOpen <= maxChunkMs;

    this.openBoundaryTimer = setTimeout(() => {
      if (this.isStopped) return;
      if (willReachOpen) {
        this.triggerImmediateMarketOpenAnalysis('SCHEDULED_MARKET_OPEN');
      }
      this.armNextMarketOpenBoundary();
    }, waitMs);
    this.openBoundaryTimer.unref?.();
  }

  private triggerImmediateMarketOpenAnalysis(reason: string): void {
    this.lastMarketOpenTriggerUtc = new Date().toISOString();
    this.marketData.invalidateAllCaches();
    void this.runFullAnalysisCycle({ forceFresh: true, reason });

    // Schedule two quick follow-up scans right after the first M1 (65s) and M5 (305s) candles close
    for (const t of this.postOpenVerifyTimers) clearTimeout(t);
    this.postOpenVerifyTimers = [65_000, 305_000].map((delay) => {
      const timer = setTimeout(() => {
        if (this.isStopped) return;
        void this.runFullAnalysisCycle({ forceFresh: true, reason: `${reason}_FIRST_CANDLE` });
      }, delay);
      timer.unref?.();
      return timer;
    });
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
      lastAnalysisReason: this.lastAnalysisReason,
      lastMarketOpenTriggerUtc: this.lastMarketOpenTriggerUtc,
      autoStartOnOpenArmed: true,
      marketSchedule: getMarketOpenScheduleStatus(),
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
      const schedule = getMarketOpenScheduleStatus();
      const forceFreshQuotes =
        schedule.isWithinPreOpenWindow || schedule.isWithinPostOpenLaunchWindow;
      const quotes = await this.marketData.getAllQuotes(forceFreshQuotes);

      const transitionedToOpen: InstrumentId[] = [];
      for (const inst of INSTRUMENT_LIST) {
        const quote = quotes[inst];
        const prevOverview = this.overviews.get(inst);
        if (prevOverview && quote) {
          prevOverview.quote = quote;
          prevOverview.feedStatus = 'CONNECTED';
        }
        if (quote) {
          const prevOpen = this.lastMarketOpenByInst.get(inst);
          if (prevOpen === false && quote.marketOpen === true) {
            transitionedToOpen.push(inst);
          }
          this.lastMarketOpenByInst.set(inst, quote.marketOpen);
        }
      }

      if (transitionedToOpen.length > 0) {
        for (const inst of transitionedToOpen) {
          this.marketData.invalidateInstrumentCache(inst);
        }
        this.triggerImmediateMarketOpenAnalysis(
          `LIVE_OPEN_TRANSITION:${transitionedToOpen.join(',')}`
        );
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

  public async runFullAnalysisCycle(options: AnalysisCycleOptions = {}): Promise<void> {
    if (this.isScanning) {
      if (options.forceFresh) {
        this.pendingForceRescan = true;
      }
      return; // Deduplication mutex
    }
    this.isScanning = true;
    const forceFresh = Boolean(options.forceFresh);
    this.lastAnalysisReason = options.reason || 'SCHEDULED';

    try {
      if (forceFresh) {
        this.marketData.invalidateAllCaches();
      }

      // Analyze all 5 pairs concurrently for sub-second market-open readiness
      const perInstrumentResults = await Promise.all(
        INSTRUMENT_LIST.map(async (inst) => {
          const quote = await this.marketData.getQuote(inst, forceFresh);
          const [h1Res, m15Res, m5Res, m1Res] = await Promise.all([
            this.marketData.getCandles(inst, 'H1', 220, forceFresh),
            this.marketData.getCandles(inst, 'M15', 220, forceFresh),
            this.marketData.getCandles(inst, 'M5', 220, forceFresh),
            this.marketData.getCandles(inst, 'M1', 180, forceFresh),
          ]);

          if (!quote || !h1Res || !m15Res || !m5Res) {
            const noDataOverview: MarketInstrumentOverview = {
              instrument: inst,
              feedStatus: 'NO_DATA',
              feedMessage: 'SEM DADOS DE MERCADO',
              quote: quote || null,
              timeframes: { H1: null, M15: null, M5: null, M1: null },
              scalping: null,
              intraday: null,
              bestScore: 0,
              classification: 'SEM_ENTRADA',
            };
            return { inst, overview: noDataOverview, candidates: [] as StrategyCandidate[] };
          }

          this.lastMarketOpenByInst.set(inst, quote.marketOpen);

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
            feedStatus: 'CONNECTED',
            feedMessage: quote.marketOpen
              ? `${m5Res.source} · Ativo`
              : `${m5Res.source} · Mercado Fechado (Abertura automática armada)`,
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

          return {
            inst,
            overview,
            candidates: [scalping, intraday].filter(Boolean) as StrategyCandidate[],
          };
        })
      );

      for (const item of perInstrumentResults) {
        this.overviews.set(item.inst, item.overview);

        // Emit actionable BUY/SELL signals with strict deduplication
        for (const candidate of item.candidates) {
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
                this.isAlertEnabledForInstrument(watch.settings, item.inst)
              ) {
                await this.pushService.sendToUser(
                  watch.userId,
                  {
                    title: `Novo Sinal ${candidate.direction} — ${item.inst} (${candidate.strategy})`,
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
      if (this.pendingForceRescan && !this.isStopped) {
        this.pendingForceRescan = false;
        void this.runFullAnalysisCycle({ forceFresh: true, reason: 'CHAINED_FRESH_SCAN' });
      }
    }
  }
}
