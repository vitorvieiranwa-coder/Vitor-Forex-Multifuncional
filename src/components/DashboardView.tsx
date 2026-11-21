import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  RefreshCw,
} from 'lucide-react';
import { getMarketOpenScheduleStatus } from '../shared/marketHours';
import { evaluateTradingSession, getClassificationLabel } from '../shared/strategy';
import {
  INSTRUMENTS,
  InstrumentId,
  MarketInstrumentOverview,
  ScoreClassification,
  TradingSignalRecord,
  UserNotificationRecord,
  formatPrice,
} from '../shared/types';

interface DashboardViewProps {
  overviews: MarketInstrumentOverview[];
  signals: TradingSignalRecord[];
  notifications: UserNotificationRecord[];
  feedHealthy: boolean;
  feedMessage: string;
  lastScanUtc: string | null;
  onSelectInstrumentForChart: (inst: InstrumentId) => void;
  onNavigateTab: (tab: string) => void;
  onRefreshScan: () => void;
  refreshing: boolean;
}

function scoreColorClasses(c: ScoreClassification, dir: 'BUY' | 'SELL' | null) {
  if (c === 'SINAL_FORTE' || c === 'SINAL_FAVORAVEL') {
    if (dir === 'BUY') return 'text-emerald-400';
    if (dir === 'SELL') return 'text-red-400';
  }
  if (c === 'EM_OBSERVACAO') return 'text-amber-400';
  return 'text-slate-400';
}

function trendLabel(t?: 'BULLISH' | 'BEARISH' | 'NEUTRAL') {
  if (t === 'BULLISH') return { text: 'Alta (BUY)', cls: 'text-emerald-400' };
  if (t === 'BEARISH') return { text: 'Baixa (SELL)', cls: 'text-red-400' };
  return { text: 'Neutra', cls: 'text-slate-400' };
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  overviews,
  signals,
  notifications,
  feedHealthy,
  feedMessage,
  lastScanUtc,
  onSelectInstrumentForChart,
  onNavigateTab,
  onRefreshScan,
  refreshing,
}) => {
  const [scheduleStatus, setScheduleStatus] = useState(() => getMarketOpenScheduleStatus());

  useEffect(() => {
    const timer = setInterval(() => {
      setScheduleStatus(getMarketOpenScheduleStatus());
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  const openPositions = signals.filter(
    (s) => s.status === 'POSICAO_ABERTA' || s.status === 'ENCERRAMENTO_RECOMENDADO'
  );
  const reversalAlerts = openPositions.filter(
    (s) => s.status === 'ENCERRAMENTO_RECOMENDADO'
  );
  const pendingSignals = signals.filter(
    (s) => s.status === 'EMITIDO' || s.status === 'AGUARDAR_ENTRADA'
  );
  const unreadAlerts = notifications.filter((n) => !n.read);

  return (
    <div className="space-y-6">
      {/* Top Feed Status & Summary Strip */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-[#111827] border border-slate-800 rounded-lg p-4">
        <div className="flex items-center gap-3">
          {feedHealthy ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
          )}
          <div>
            <p className="text-sm font-medium text-slate-100">
              {feedHealthy ? 'Ligação ao Mercado Ativa' : 'SEM DADOS DE MERCADO'}
            </p>
            <p className="text-xs text-slate-400">
              {feedMessage}
              {lastScanUtc && ` · Última análise UTC: ${lastScanUtc.slice(11, 19)}`}
              {` · Sessão: ${evaluateTradingSession('EUR/USD', new Date()).label}`}
            </p>
            {!scheduleStatus.isForexOpen || !scheduleStatus.isGoldOpen ? (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-sky-400">
                <Clock className="w-3.5 h-3.5 shrink-0" />
                <span>{scheduleStatus.statusText}</span>
              </p>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          onClick={onRefreshScan}
          disabled={refreshing}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          <span>{refreshing ? 'A analisar...' : 'Atualizar Análise'}</span>
        </button>
      </div>

      {/* Prominent Trend Reversal Banner if active */}
      {reversalAlerts.length > 0 && (
        <div className="bg-red-950/40 border border-red-700/60 rounded-lg p-4 space-y-2">
          {reversalAlerts.map((pos) => (
            <div
              key={pos.id}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <div>
                <p className="text-sm font-semibold text-red-300">
                  RECOMENDAÇÃO DE ENCERRAMENTO — {pos.instrument} — POSIÇÃO {pos.direction}
                </p>
                <p className="text-xs text-red-200/80">
                  Múltiplos indicadores confirmam inversão de tendência contra a posição aberta.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('positions')}
                className="px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Rever Posição
              </button>
            </div>
          ))}
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <p className="text-xs text-slate-400">Instrumentos Monitorizados</p>
          <p className="mt-1 text-2xl font-semibold font-mono-num text-slate-100">
            {overviews.filter((o) => o.feedStatus === 'CONNECTED').length} / 5
          </p>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <p className="text-xs text-slate-400">Sinais Ativos (≥ 80 pts)</p>
          <p className="mt-1 text-2xl font-semibold font-mono-num text-emerald-400">
            {pendingSignals.length}
          </p>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <p className="text-xs text-slate-400">Posições Abertas</p>
          <p className="mt-1 text-2xl font-semibold font-mono-num text-sky-400">
            {openPositions.length}
          </p>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <p className="text-xs text-slate-400">Alertas Pendentes</p>
          <p className="mt-1 text-2xl font-semibold font-mono-num text-amber-400">
            {unreadAlerts.length}
          </p>
        </div>
      </div>

      {/* Main 5 Instruments Overview Table */}
      <div className="bg-[#111827] border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">
            Painel Multi-Mercado Forex & Ouro (UTC)
          </h2>
          <button
            type="button"
            onClick={() => onNavigateTab('scanner')}
            className="text-xs font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            Abrir Market Scanner
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 bg-[#0D131F]">
                <th className="py-2.5 px-4 font-medium">Instrumento</th>
                <th className="py-2.5 px-4 font-medium text-right">Bid / Ask</th>
                <th className="py-2.5 px-4 font-medium text-right">Var. 24h</th>
                <th className="py-2.5 px-4 font-medium text-right">Spread</th>
                <th className="py-2.5 px-4 font-medium">Tendência H1</th>
                <th className="py-2.5 px-4 font-medium">Estrutura M15</th>
                <th className="py-2.5 px-4 font-medium">Estado M5</th>
                <th className="py-2.5 px-4 font-medium text-right">Pontuação</th>
                <th className="py-2.5 px-4 font-medium">Último Sinal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-sm">
              {overviews.map((ov) => {
                const spec = INSTRUMENTS[ov.instrument];
                const h1 = trendLabel(ov.timeframes.H1?.trendDirection);
                const m15 = trendLabel(ov.timeframes.M15?.trendDirection);
                const m5 = trendLabel(ov.timeframes.M5?.trendDirection);
                const best =
                  (ov.scalping?.score.total ?? 0) >= (ov.intraday?.score.total ?? 0)
                    ? ov.scalping
                    : ov.intraday;
                const lastSignal = signals.find((s) => s.instrument === ov.instrument);

                return (
                  <tr
                    key={ov.instrument}
                    onClick={() => onSelectInstrumentForChart(ov.instrument)}
                    className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-100">{spec.label}</div>
                      <div className="text-xs text-slate-400">
                        {ov.quote?.marketOpen ? 'Sessão Ativa' : 'Mercado Fechado'}
                      </div>
                    </td>

                    <td className="py-3 px-4 text-right font-mono-num">
                      {ov.quote ? (
                        <div>
                          <div className="text-slate-100">
                            {formatPrice(ov.instrument, ov.quote.bid)}
                          </div>
                          <div className="text-xs text-slate-400">
                            {formatPrice(ov.instrument, ov.quote.ask)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-red-400">SEM DADOS</span>
                      )}
                    </td>

                    <td className="py-3 px-4 text-right font-mono-num">
                      {ov.quote ? (
                        <span
                          className={`inline-flex items-center gap-0.5 ${
                            ov.quote.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {ov.quote.changePct >= 0 ? (
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          ) : (
                            <ArrowDownRight className="w-3.5 h-3.5" />
                          )}
                          {ov.quote.changePct >= 0 ? '+' : ''}
                          {ov.quote.changePct.toFixed(2)}%
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>

                    <td className="py-3 px-4 text-right font-mono-num text-slate-300">
                      {ov.quote
                        ? `${ov.quote.spreadPips.toFixed(2)} ${spec.unitLabel}`
                        : '—'}
                    </td>

                    <td className={`py-3 px-4 text-xs font-medium ${h1.cls}`}>
                      {h1.text}
                    </td>
                    <td className={`py-3 px-4 text-xs font-medium ${m15.cls}`}>
                      {m15.text}
                    </td>
                    <td className={`py-3 px-4 text-xs font-medium ${m5.cls}`}>
                      {m5.text}
                    </td>

                    <td className="py-3 px-4 text-right">
                      <div
                        className={`font-mono-num font-semibold ${scoreColorClasses(
                          ov.classification,
                          best?.direction ?? null
                        )}`}
                      >
                        {ov.bestScore}/100
                      </div>
                      <div className="text-xs text-slate-400">
                        {best?.direction ? `${best.direction} · ` : ''}
                        {getClassificationLabel(ov.classification)}
                      </div>
                    </td>

                    <td className="py-3 px-4 text-xs">
                      {lastSignal ? (
                        <div>
                          <span
                            className={`font-semibold ${
                              lastSignal.direction === 'BUY'
                                ? 'text-emerald-400'
                                : 'text-red-400'
                            }`}
                          >
                            {lastSignal.direction}
                          </span>
                          <span className="text-slate-400"> · {lastSignal.status}</span>
                        </div>
                      ) : (
                        <span className="text-slate-500">Sem histórico</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
