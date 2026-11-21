import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Archive,
  BarChart3,
  Bell,
  CandlestickChart,
  LayoutDashboard,
  LogOut,
  Menu,
  Radio,
  Settings,
  ShieldCheck,
  TrendingUp,
  X,
} from 'lucide-react';
import { ArchiveView } from './components/ArchiveView';
import { DashboardView } from './components/DashboardView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NotificationsView } from './components/NotificationsView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { PositionsView } from './components/PositionsView';
import { RiskManagementView } from './components/RiskManagementView';
import { ScannerView } from './components/ScannerView';
import { SettingsView } from './components/SettingsView';
import { SignalsView } from './components/SignalsView';
import { StatisticsBacktestView } from './components/StatisticsBacktestView';
import { TradingChart } from './components/TradingChart';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import {
  closeTrackedSignal,
  createTradingSignal,
  createUserNotification,
  importHistoricalReplaySignals,
  markReversalRecommendation,
  openTrackedPosition,
  subscribeToNotifications,
  subscribeToSettings,
  subscribeToSignals,
} from './services/firestoreService';
import { DayReplaySummary } from './shared/dayReplay';
import {
  PositionEvaluationResult,
  evaluateRiskStatus,
} from './shared/positionMonitor';
import {
  DEFAULT_USER_SETTINGS,
  INSTRUMENTS,
  InstrumentId,
  MarketInstrumentOverview,
  StrategyCandidate,
  TradingSignalRecord,
  UserNotificationRecord,
  UserSettings,
  isTerminalStatus,
  toPipsOrPoints,
} from './shared/types';

type TabId =
  | 'dashboard'
  | 'scanner'
  | 'charts'
  | 'signals'
  | 'positions'
  | 'archive'
  | 'notifications'
  | 'statistics'
  | 'risk'
  | 'settings';

const NAV_ITEMS: Array<{ id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'scanner', label: 'Market Scanner', icon: Radio },
  { id: 'charts', label: 'Gráficos', icon: CandlestickChart },
  { id: 'signals', label: 'Sinais BUY/SELL', icon: TrendingUp },
  { id: 'positions', label: 'Posições Abertas', icon: Activity },
  { id: 'archive', label: 'Arquivo de Sinais', icon: Archive },
  { id: 'notifications', label: 'Alertas e Push', icon: Bell },
  { id: 'statistics', label: 'Estatísticas & Backtest', icon: BarChart3 },
  { id: 'risk', label: 'Gestão de Risco', icon: ShieldCheck },
  { id: 'settings', label: 'Configurações', icon: Settings },
];

function sanitizeSignalId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 120);
}

const WorkspaceShell: React.FC = () => {
  const { user, loading, authError, signInWithGoogle, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedInstrument, setSelectedInstrument] = useState<InstrumentId>('EUR/USD');

  const [settings, setSettings] = useState<UserSettings>({
    userId: '',
    ...DEFAULT_USER_SETTINGS,
  });
  const [signals, setSignals] = useState<TradingSignalRecord[]>([]);
  const [notifications, setNotifications] = useState<UserNotificationRecord[]>([]);

  const [overviews, setOverviews] = useState<MarketInstrumentOverview[]>([]);
  const [feedHealthy, setFeedHealthy] = useState(true);
  const [feedMessage, setFeedMessage] = useState('A ligar ao fornecedor de cotações...');
  const [lastScanUtc, setLastScanUtc] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<{
    providerName: string;
    hasTwelveDataKey: boolean;
    feedStatus: string;
    message: string;
    lastSuccessUtc: string | null;
  } | null>(null);
  const [evaluations, setEvaluations] = useState<Record<string, PositionEvaluationResult>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [replaySyncing, setReplaySyncing] = useState(false);
  const [replayMessage, setReplayMessage] = useState<string | null>(null);

  // Subscribe to Firestore user collections once authenticated
  useEffect(() => {
    if (!user) return;
    const unsubSettings = subscribeToSettings(user.uid, (s) => setSettings(s));
    const unsubSignals = subscribeToSignals(user.uid, (list) => setSignals(list));
    const unsubNotifs = subscribeToNotifications(user.uid, (list) => setNotifications(list));
    return () => {
      unsubSettings();
      unsubSignals();
      unsubNotifs();
    };
  }, [user]);

  const riskStatus = useMemo(
    () => evaluateRiskStatus(signals, settings),
    [signals, settings]
  );

  const syncNov20ReplayToFirestore = useCallback(
    async (forceMessage = false) => {
      if (!user || replaySyncing) return;
      setReplaySyncing(true);
      try {
        const res = await fetch('/api/history/replay-day', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date: '2026-11-20',
            settings,
            useBreakEvenAt1R: true,
          }),
        });
        if (!res.ok) {
          if (forceMessage) {
            setReplayMessage('Não foi possível obter os dados históricos de 20/11/2026.');
          }
          return;
        }
        const summary = (await res.json()) as DayReplaySummary;
        const { importedCount, skippedCount } = await importHistoricalReplaySignals(
          user.uid,
          summary.signals
        );
        localStorage.setItem(`fi_replay_2026_11_20_${user.uid}`, '1');
        if (forceMessage || importedCount > 0) {
          setReplayMessage(
            `Replay 20/11/2026 sincronizado: ${importedCount} novos sinais inseridos no Firestore (${skippedCount} já existentes). Resultado simulado do dia: ${summary.netR >= 0 ? '+' : ''}${summary.netR}R (${summary.netMonetaryUsd >= 0 ? '+' : ''}${summary.netMonetaryUsd} USD).`
          );
        }
      } catch {
        if (forceMessage) {
          setReplayMessage('Erro ao sincronizar sinais históricos com o Firestore.');
        }
      } finally {
        setReplaySyncing(false);
      }
    },
    [user, settings, replaySyncing]
  );

  // Automatic one-time sync of 2026-11-20 historical signals for authenticated user
  useEffect(() => {
    if (!user) return;
    const key = `fi_replay_2026_11_20_${user.uid}`;
    if (!localStorage.getItem(key)) {
      void syncNov20ReplayToFirestore(false);
    }
  }, [user, syncNov20ReplayToFirestore]);

  // Poll market snapshot & evaluate user strategies
  const fetchMarketSnapshot = useCallback(async () => {
    try {
      const [snapRes, evalRes] = await Promise.all([
        fetch('/api/market/snapshot'),
        fetch('/api/market/evaluate-user-strategies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings }),
        }),
      ]);

      if (snapRes.ok) {
        const snapJson = await snapRes.json();
        const instruments = (snapJson.instruments || []) as MarketInstrumentOverview[];
        if (evalRes.ok) {
          const evalJson = await evalRes.json();
          const userCands = (evalJson.candidates || []) as StrategyCandidate[];
          for (const ov of instruments) {
            const uScalp = userCands.find(
              (c) => c.instrument === ov.instrument && c.strategy === 'SCALPING'
            );
            const uIntra = userCands.find(
              (c) => c.instrument === ov.instrument && c.strategy === 'INTRADAY'
            );
            if (uScalp) ov.scalping = uScalp;
            if (uIntra) ov.intraday = uIntra;
            const best =
              (ov.scalping?.score.total ?? 0) >= (ov.intraday?.score.total ?? 0)
                ? ov.scalping
                : ov.intraday;
            if (best) {
              ov.bestScore = best.score.total;
              ov.classification = best.score.classification;
            }
          }
        }
        setOverviews(instruments);
        const h = snapJson.health;
        if (h) {
          setDiagnostics(h);
          setFeedHealthy(h.feedStatus !== 'NO_DATA');
          setFeedMessage(h.message);
        }
        setLastScanUtc(snapJson.timestampUtc || new Date().toISOString());
      }
    } catch {
      setFeedHealthy(false);
      setFeedMessage('SEM DADOS DE MERCADO — Erro de comunicação com o servidor.');
    }
  }, [settings]);

  useEffect(() => {
    void fetchMarketSnapshot();
    const timer = setInterval(fetchMarketSnapshot, 20_000);
    return () => clearInterval(timer);
  }, [fetchMarketSnapshot]);

  // Persist newly detected actionable signals into Firestore (with dedup ID)
  useEffect(() => {
    if (!user || riskStatus.paused || overviews.length === 0) return;

    const persistAutoSignals = async () => {
      for (const ov of overviews) {
        for (const cand of [ov.scalping, ov.intraday]) {
          if (!cand || !cand.actionable || !cand.direction || cand.score.total < 80) {
            continue;
          }
          const sigId = sanitizeSignalId(cand.opportunityKey);
          const alreadyExists = signals.some((s) => s.id === sigId);
          if (alreadyExists) continue;

          await createTradingSignal(
            user.uid,
            {
              id: sigId,
              instrument: cand.instrument,
              direction: cand.direction,
              strategy: cand.strategy,
              timeframe: cand.timeframe,
              executionType: cand.executionType,
              status: cand.executionType === 'IMMEDIATE' ? 'EMITIDO' : 'AGUARDAR_ENTRADA',
              score: cand.score.total,
              recommendedEntry: cand.recommendedEntry,
              takeProfit: cand.takeProfit,
              stopLoss: cand.stopLoss,
              observedSpread: cand.observedSpread,
              indicatorsSummary: cand.indicatorsJustification.join(' | '),
              rationale: cand.rationale,
              sourceType: 'LIVE_SIGNAL',
              reversalAlertIssued: false,
            },
            `Sinal ${cand.direction} gerado automaticamente (${cand.score.total}/100).`
          );

          await createUserNotification(user.uid, {
            id: `notif_${sigId}`,
            signalId: sigId,
            instrument: cand.instrument,
            category: cand.direction === 'BUY' ? 'NEW_BUY' : 'NEW_SELL',
            title: `Novo Sinal ${cand.direction} — ${cand.instrument}`,
            body: `Estratégia ${cand.strategy} (${cand.score.total}/100) · Entrada ${cand.recommendedEntry} · TP ${cand.takeProfit} · SL ${cand.stopLoss}`,
          });
        }
      }
    };

    void persistAutoSignals();
  }, [user, overviews, signals, riskStatus.paused]);

  // Sync open/pending positions with backend monitor & apply automated TP/SL/Reversal state transitions
  useEffect(() => {
    if (!user) return;
    const activeSignals = signals.filter((s) => !isTerminalStatus(s.status));

    const syncPositions = async () => {
      try {
        const res = await fetch('/api/engine/sync-positions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: user.uid,
            settings,
            signals: activeSignals,
          }),
        });
        if (!res.ok) return;
        const json = await res.json();
        const list = (json.evaluations || []) as PositionEvaluationResult[];
        const map: Record<string, PositionEvaluationResult> = {};
        for (const item of list) {
          map[item.signalId] = item;
          const orig = activeSignals.find((s) => s.id === item.signalId);
          if (!orig || !item.newStatus) continue;

          if (
            item.newStatus === 'TP_ATINGIDO' ||
            item.newStatus === 'SL_ATINGIDO' ||
            item.newStatus === 'INVALIDADO'
          ) {
            await closeTrackedSignal(
              user.uid,
              orig,
              item.newStatus,
              item.closeReason || item.newStatus,
              item.resultR ?? 0,
              item.resultMonetary ?? undefined,
              item.currentExitPrice
            );
            await createUserNotification(user.uid, {
              id: `notif_${orig.id}_${item.newStatus}`,
              signalId: orig.id,
              instrument: orig.instrument,
              category:
                item.newStatus === 'TP_ATINGIDO'
                  ? 'TP_HIT'
                  : item.newStatus === 'SL_ATINGIDO'
                  ? 'SL_HIT'
                  : 'INVALIDATED',
              title: `${item.newStatus.replace('_', ' ')} — ${orig.instrument}`,
              body: item.closeReason || 'Estado atualizado automaticamente.',
            });
          } else if (
            item.newStatus === 'ENCERRAMENTO_RECOMENDADO' &&
            !orig.reversalAlertIssued
          ) {
            await markReversalRecommendation(
              user.uid,
              orig,
              item.reversal.reasons,
              item.currentExitPrice
            );
            await createUserNotification(user.uid, {
              id: `notif_${orig.id}_REV`,
              signalId: orig.id,
              instrument: orig.instrument,
              category: 'REVERSAL_EXIT',
              title:
                item.reversal.alertTitle ||
                `RECOMENDAÇÃO DE ENCERRAMENTO — ${orig.instrument} — POSIÇÃO ${orig.direction}`,
              body: item.reversal.reasons.join(' · '),
            });
          }
        }
        setEvaluations(map);
      } catch {
        // Non-fatal background sync error
      }
    };

    void syncPositions();
    const timer = setInterval(syncPositions, 15_000);
    return () => clearInterval(timer);
  }, [user, signals, settings]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/engine/run-scan', { method: 'POST' });
      await fetchMarketSnapshot();
    } finally {
      setRefreshing(false);
    }
  };

  const handleEmitSignal = async (
    cand: StrategyCandidate,
    asOpen: boolean,
    actualEntry?: number,
    lots?: number
  ) => {
    if (!user || !cand.direction) return;
    const sigId = sanitizeSignalId(cand.opportunityKey);
    await createTradingSignal(
      user.uid,
      {
        id: sigId,
        instrument: cand.instrument,
        direction: cand.direction,
        strategy: cand.strategy,
        timeframe: cand.timeframe,
        executionType: cand.executionType,
        status: asOpen
          ? 'POSICAO_ABERTA'
          : cand.executionType === 'IMMEDIATE'
          ? 'EMITIDO'
          : 'AGUARDAR_ENTRADA',
        score: cand.score.total,
        recommendedEntry: cand.recommendedEntry,
        actualEntry,
        takeProfit: cand.takeProfit,
        stopLoss: cand.stopLoss,
        observedSpread: cand.observedSpread,
        lots,
        indicatorsSummary: cand.indicatorsJustification.join(' | '),
        rationale: cand.rationale,
        sourceType: 'LIVE_SIGNAL',
        reversalAlertIssued: false,
      },
      asOpen
        ? `Sinal registado e posição aberta a ${actualEntry} (${lots} lotes).`
        : `Sinal guardado manualmente no arquivo (${cand.score.total}/100).`
    );
    if (asOpen) setActiveTab('positions');
  };

  const handleOpenPendingSignal = async (
    sig: TradingSignalRecord,
    actualEntry: number,
    lots: number
  ) => {
    if (!user) return;
    await openTrackedPosition(user.uid, sig, actualEntry, lots);
    setActiveTab('positions');
  };

  const handleInvalidateSignal = async (sig: TradingSignalRecord, reason: string) => {
    if (!user) return;
    await closeTrackedSignal(user.uid, sig, 'INVALIDADO', reason, 0, 0);
  };

  const handleManualClose = async (
    sig: TradingSignalRecord,
    exitPrice: number,
    reason: string
  ) => {
    if (!user) return;
    const entry = sig.actualEntry ?? sig.recommendedEntry;
    const riskDist = Math.abs(entry - sig.stopLoss);
    const diff = sig.direction === 'BUY' ? exitPrice - entry : entry - exitPrice;
    const resultR = riskDist > 0 ? Number((diff / riskDist).toFixed(2)) : 0;
    const spec = INSTRUMENTS[sig.instrument];
    const pips = toPipsOrPoints(sig.instrument, diff);
    const resultMonetary =
      sig.lots && sig.lots > 0
        ? Number((pips * spec.pipValuePerStandardLot * sig.lots).toFixed(2))
        : undefined;

    await closeTrackedSignal(
      user.uid,
      sig,
      'ENCERRADO_MANUALMENTE',
      reason,
      resultR,
      resultMonetary,
      exitPrice
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center text-slate-300 text-sm">
        A inicializar FOREX INTELLIGENCE...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-[#111827] border border-slate-800 rounded-lg p-8 space-y-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              FOREX INTELLIGENCE
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed">
              Plataforma institucional de análise técnica multi-timeframe, sinais Scalping & Intraday, gestão de posições e arquivo histórico em tempo real para EUR/USD, GBP/USD, EUR/JPY, GBP/JPY e XAU/USD.
            </p>
          </div>

          <div className="border-t border-slate-800 pt-4 space-y-2 text-xs text-slate-400">
            <p>· Autenticação segura via Firebase Authentication</p>
            <p>· Arquivo permanente de sinais persistente no Cloud Firestore</p>
            <p>· Motor de cotações reais e alertas Web Push em segundo plano</p>
          </div>

          {authError && (
            <p className="text-xs text-red-400 bg-red-950/40 border border-red-800 rounded p-2.5">
              {authError}
            </p>
          )}

          <button
            type="button"
            onClick={signInWithGoogle}
            className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-md transition-colors"
          >
            Entrar com Conta Google
          </button>

          <div className="flex justify-center">
            <PWAInstallButton />
          </div>
        </div>
      </div>
    );
  }

  const unreadCount = notifications.filter((n) => !n.read).length;
  const openPosCount = signals.filter(
    (s) => s.status === 'POSICAO_ABERTA' || s.status === 'ENCERRAMENTO_RECOMENDADO'
  ).length;

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col md:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 bg-[#0D131F] border-r border-slate-800">
        <div className="px-5 py-5 border-b border-slate-800">
          <span className="text-base font-bold tracking-tight text-slate-100 block whitespace-nowrap">
            FOREX INTELLIGENCE
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            const badge =
              item.id === 'positions' && openPosCount > 0
                ? openPosCount
                : item.id === 'notifications' && unreadCount > 0
                ? unreadCount
                : null;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {badge !== null && (
                  <span className="font-mono-num text-[11px] text-emerald-400">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-3">
          <PWAInstallButton />
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-400 truncate">{user.email}</span>
            <button
              type="button"
              onClick={logout}
              title="Terminar sessão"
              className="p-1.5 text-slate-400 hover:text-slate-100 rounded hover:bg-slate-800"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Top Header (compact, <15% viewport height) */}
      <header className="md:hidden sticky top-0 z-40 bg-[#0D131F] border-b border-slate-800 px-4 py-3 flex items-center justify-between gap-4">
        <span className="text-sm font-bold tracking-tight text-slate-100 whitespace-nowrap">
          FOREX INTELLIGENCE
        </span>
        <div className="flex items-center gap-2">
          <PWAInstallButton />
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="p-2 text-slate-300 bg-slate-800 rounded-md"
            aria-label="Menu"
          >
            {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-black/70" onClick={() => setMobileMenuOpen(false)}>
          <div
            className="w-72 h-full bg-[#0D131F] border-r border-slate-800 p-4 flex flex-col justify-between"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1">
              <div className="flex items-center justify-between pb-3 mb-2 border-b border-slate-800">
                <span className="text-sm font-bold text-slate-100">Módulos</span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-1 text-slate-400"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-xs font-medium rounded-md ${
                      activeTab === item.id
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="border-t border-slate-800 pt-3 flex items-center justify-between text-xs">
              <span className="text-slate-400 truncate">{user.email}</span>
              <button
                type="button"
                onClick={logout}
                className="text-red-400 font-medium px-2 py-1"
              >
                Sair
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Viewport */}
      <main className="flex-1 md:pl-64 pb-16 md:pb-8">
        <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
          {activeTab === 'dashboard' && (
            <DashboardView
              overviews={overviews}
              signals={signals}
              notifications={notifications}
              feedHealthy={feedHealthy}
              feedMessage={feedMessage}
              lastScanUtc={lastScanUtc}
              onSelectInstrumentForChart={(inst) => {
                setSelectedInstrument(inst);
                setActiveTab('charts');
              }}
              onNavigateTab={(t) => setActiveTab(t as TabId)}
              onRefreshScan={handleManualRefresh}
              refreshing={refreshing}
            />
          )}

          {activeTab === 'scanner' && (
            <ScannerView
              overviews={overviews}
              onSelectInstrument={(inst) => {
                setSelectedInstrument(inst);
                setActiveTab('charts');
              }}
            />
          )}

          {activeTab === 'charts' && (
            <TradingChart
              selectedInstrument={selectedInstrument}
              onSelectInstrument={setSelectedInstrument}
              activeSignals={signals.filter((s) => !isTerminalStatus(s.status))}
            />
          )}

          {activeTab === 'signals' && (
            <SignalsView
              overviews={overviews}
              signals={signals}
              settings={settings}
              riskPaused={riskStatus.paused}
              pauseReasons={riskStatus.pauseReasons}
              onEmitSignal={handleEmitSignal}
              onOpenPendingSignal={handleOpenPendingSignal}
              onInvalidateSignal={handleInvalidateSignal}
            />
          )}

          {activeTab === 'positions' && (
            <PositionsView
              signals={signals}
              evaluations={evaluations}
              onManualClose={handleManualClose}
            />
          )}

          {activeTab === 'archive' && (
            <ArchiveView
              userId={user.uid}
              signals={signals}
              onSyncNov20Replay={() => syncNov20ReplayToFirestore(true)}
              replaySyncing={replaySyncing}
              replayMessage={replayMessage}
            />
          )}

          {activeTab === 'notifications' && (
            <NotificationsView
              userId={user.uid}
              settings={settings}
              notifications={notifications}
            />
          )}

          {activeTab === 'statistics' && (
            <StatisticsBacktestView signals={signals} settings={settings} />
          )}

          {activeTab === 'risk' && (
            <RiskManagementView
              userId={user.uid}
              settings={settings}
              riskStatus={riskStatus}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              userId={user.uid}
              settings={settings}
              diagnostics={diagnostics}
            />
          )}
        </div>
      </main>

      {/* Mobile Quick Bottom Bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-[#0D131F] border-t border-slate-800 grid grid-cols-5 h-14">
        {(
          [
            ['dashboard', 'Início', LayoutDashboard],
            ['charts', 'Gráficos', CandlestickChart],
            ['signals', 'Sinais', TrendingUp],
            ['positions', 'Posições', Activity],
            ['archive', 'Arquivo', Archive],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
              activeTab === id ? 'text-emerald-400' : 'text-slate-400'
            }`}
          >
            <Icon className="w-4 h-4" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <OfflineIndicator />
    </div>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <WorkspaceShell />
      </AuthProvider>
    </ErrorBoundary>
  );
}
