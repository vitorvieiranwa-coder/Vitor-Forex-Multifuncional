import React, { useMemo, useState } from 'react';
import { Download, History, Search } from 'lucide-react';
import { getSignalEvents } from '../services/firestoreService';
import {
  INSTRUMENT_LIST,
  SignalEventRecord,
  SignalStatus,
  TradingSignalRecord,
  formatPrice,
} from '../shared/types';

interface ArchiveViewProps {
  userId: string;
  signals: TradingSignalRecord[];
  onSyncNov20Replay: () => Promise<void>;
  replaySyncing: boolean;
  replayMessage: string | null;
}

function getSignalDisplayTimeUtc(sig: TradingSignalRecord): string {
  if (sig.sourceType === 'BACKTEST_HISTORICAL') {
    const match = sig.rationale.match(/Histórico Real (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/);
    if (match) return `${match[1]}:00`;
  }
  return formatTs(sig.createdAt);
}

function formatTs(val: unknown): string {
  if (!val) return '—';
  if (typeof val === 'string') return val.replace('T', ' ').slice(0, 19);
  if (typeof val === 'object' && val !== null && 'toDate' in val) {
    return (val as { toDate: () => Date }).toDate().toISOString().replace('T', ' ').slice(0, 19);
  }
  return '—';
}

function getDurationText(sig: TradingSignalRecord): string {
  const getMs = (v: unknown) => {
    if (!v) return null;
    if (typeof v === 'string') return Date.parse(v);
    if (typeof v === 'object' && v !== null && 'toDate' in v) {
      return (v as { toDate: () => Date }).toDate().getTime();
    }
    return null;
  };
  const start = getMs(sig.createdAt);
  const end = getMs(sig.closedAt);
  if (!start || !end) return '—';
  const mins = Math.max(0, Math.round((end - start) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export const ArchiveView: React.FC<ArchiveViewProps> = ({
  userId,
  signals,
  onSyncNov20Replay,
  replaySyncing,
  replayMessage,
}) => {
  const [search, setSearch] = useState('');
  const [instrumentFilter, setInstrumentFilter] = useState<string>('ALL');
  const [directionFilter, setDirectionFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [dateFilter, setDateFilter] = useState('');

  const [selectedSignal, setSelectedSignal] = useState<TradingSignalRecord | null>(null);
  const [events, setEvents] = useState<SignalEventRecord[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const filtered = useMemo(() => {
    return signals.filter((s) => {
      if (instrumentFilter !== 'ALL' && s.instrument !== instrumentFilter) return false;
      if (directionFilter !== 'ALL' && s.direction !== directionFilter) return false;
      if (statusFilter !== 'ALL' && s.status !== statusFilter) return false;
      if (dateFilter) {
        const tsStr = getSignalDisplayTimeUtc(s);
        if (!tsStr.startsWith(dateFilter)) return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !s.id.toLowerCase().includes(q) &&
          !s.instrument.toLowerCase().includes(q) &&
          !s.rationale.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [signals, instrumentFilter, directionFilter, statusFilter, dateFilter, search]);

  const handleOpenDetails = async (sig: TradingSignalRecord) => {
    setSelectedSignal(sig);
    setLoadingEvents(true);
    try {
      const list = await getSignalEvents(userId, sig.id);
      setEvents(list);
    } finally {
      setLoadingEvents(false);
    }
  };

  const handleExportCsv = () => {
    const headers = [
      'ID',
      'Instrumento',
      'Direcao',
      'Estrategia',
      'Timeframe',
      'Estado',
      'Pontuacao',
      'EntradaPrevista',
      'EntradaEfetiva',
      'TP',
      'SL',
      'Spread',
      'Lotes',
      'ResultadoR',
      'ResultadoUSD',
      'MotivoEncerramento',
      'CriadoUTC',
      'EncerradoUTC',
    ];
    const rows = filtered.map((s) => [
      s.id,
      s.instrument,
      s.direction,
      s.strategy,
      s.timeframe,
      s.status,
      s.score,
      s.recommendedEntry,
      s.actualEntry ?? '',
      s.takeProfit,
      s.stopLoss,
      s.observedSpread,
      s.lots ?? '',
      s.resultR ?? '',
      s.resultMonetary ?? '',
      `"${(s.closeReason || '').replace(/"/g, '""')}"`,
      formatTs(s.createdAt),
      formatTs(s.closedAt),
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forex-intelligence-arquivo-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statuses: SignalStatus[] = [
    'EMITIDO',
    'AGUARDAR_ENTRADA',
    'POSICAO_ABERTA',
    'TP_ATINGIDO',
    'SL_ATINGIDO',
    'ENCERRADO_MANUALMENTE',
    'ENCERRAMENTO_RECOMENDADO',
    'INVALIDADO',
    'EXPIRADO',
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">ARQUIVO DE SINAIS</h2>
          <p className="text-xs text-slate-400">
            Registo permanente e imutável no Firestore com histórico cronológico completo de cada sinal.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onSyncNov20Replay}
            disabled={replaySyncing}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <History className="w-3.5 h-3.5" />
            <span>
              {replaySyncing ? 'A importar 20/11/2026...' : 'Importar Replay Real 20/11/2026'}
            </span>
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Exportar CSV ({filtered.length})</span>
          </button>
        </div>
      </div>

      {replayMessage && (
        <div className="bg-[#111827] border border-emerald-700/50 rounded-lg px-4 py-2.5 text-xs text-emerald-300">
          {replayMessage}
        </div>
      )}

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 bg-[#111827] border border-slate-800 rounded-lg p-3">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Pesquisar ID ou texto..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <select
          value={instrumentFilter}
          onChange={(e) => setInstrumentFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
        >
          <option value="ALL">Todos os Instrumentos</option>
          {INSTRUMENT_LIST.map((inst) => (
            <option key={inst} value={inst}>
              {inst}
            </option>
          ))}
        </select>

        <select
          value={directionFilter}
          onChange={(e) => setDirectionFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
        >
          <option value="ALL">BUY e SELL</option>
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
        >
          <option value="ALL">Todos os Estados</option>
          {statuses.map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100 font-mono-num"
        />
      </div>

      {/* Table */}
      <div className="bg-[#111827] border border-slate-800 rounded-lg overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            Nenhum sinal registado corresponde aos filtros selecionados.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0D131F] text-xs text-slate-400">
                  <th className="py-2.5 px-3 font-medium">Data UTC</th>
                  <th className="py-2.5 px-3 font-medium">Instrumento</th>
                  <th className="py-2.5 px-3 font-medium">Direção</th>
                  <th className="py-2.5 px-3 font-medium text-right">Pts</th>
                  <th className="py-2.5 px-3 font-medium text-right">Entrada Prev./Ef.</th>
                  <th className="py-2.5 px-3 font-medium text-right">TP / SL</th>
                  <th className="py-2.5 px-3 font-medium">Estado</th>
                  <th className="py-2.5 px-3 font-medium text-right">Resultado</th>
                  <th className="py-2.5 px-3 font-medium text-right">Duração</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 text-xs">
                {filtered.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => handleOpenDetails(s)}
                    className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                  >
                    <td className="py-2.5 px-3 font-mono-num text-slate-400 whitespace-nowrap">
                      {getSignalDisplayTimeUtc(s)}
                    </td>
                    <td className="py-2.5 px-3 font-medium text-slate-100 whitespace-nowrap">
                      {s.instrument} · {s.strategy}
                      {s.sourceType === 'BACKTEST_HISTORICAL' && (
                        <span className="text-sky-400 font-normal"> · Histórico</span>
                      )}
                    </td>
                    <td
                      className={`py-2.5 px-3 font-bold ${
                        s.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {s.direction}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-num text-slate-200">
                      {s.score}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-num text-slate-200">
                      {formatPrice(s.instrument, s.recommendedEntry)}
                      {s.actualEntry ? ` / ${formatPrice(s.instrument, s.actualEntry)}` : ''}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-num text-slate-300">
                      {formatPrice(s.instrument, s.takeProfit)} /{' '}
                      {formatPrice(s.instrument, s.stopLoss)}
                    </td>
                    <td className="py-2.5 px-3 text-slate-200">{s.status}</td>
                    <td
                      className={`py-2.5 px-3 text-right font-mono-num font-semibold ${
                        (s.resultR ?? 0) > 0
                          ? 'text-emerald-400'
                          : (s.resultR ?? 0) < 0
                          ? 'text-red-400'
                          : 'text-slate-400'
                      }`}
                    >
                      {typeof s.resultR === 'number'
                        ? `${s.resultR >= 0 ? '+' : ''}${s.resultR.toFixed(2)}R`
                        : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-num text-slate-400">
                      {getDurationText(s)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Signal Details & Audit Timeline Modal */}
      {selectedSignal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-[#111827] border border-slate-800 rounded-lg p-6 space-y-4">
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  {selectedSignal.instrument} · {selectedSignal.direction} ·{' '}
                  {selectedSignal.strategy}
                </h3>
                <p className="text-xs font-mono-num text-slate-400">
                  ID: {selectedSignal.id} · Estado: {selectedSignal.status}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSignal(null)}
                className="px-3 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded"
              >
                Fechar
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono-num bg-[#0D131F] border border-slate-800 rounded p-3">
              <div>
                <span className="text-slate-400 block">Pontuação</span>
                <span className="text-slate-100">{selectedSignal.score}/100</span>
              </div>
              <div>
                <span className="text-slate-400 block">Entrada Prevista</span>
                <span className="text-slate-100">
                  {formatPrice(selectedSignal.instrument, selectedSignal.recommendedEntry)}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">TP / SL</span>
                <span className="text-slate-100">
                  {formatPrice(selectedSignal.instrument, selectedSignal.takeProfit)} /{' '}
                  {formatPrice(selectedSignal.instrument, selectedSignal.stopLoss)}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Resultado</span>
                <span className="text-slate-100">
                  {typeof selectedSignal.resultR === 'number'
                    ? `${selectedSignal.resultR}R`
                    : '—'}
                </span>
              </div>
            </div>

            <div className="space-y-1 text-xs">
              <p className="font-semibold text-slate-200">Fundamentação Original (Imutável)</p>
              <p className="text-slate-300 leading-relaxed">{selectedSignal.rationale}</p>
              <p className="text-slate-400 pt-1">
                Indicadores: {selectedSignal.indicatorsSummary}
              </p>
            </div>

            {selectedSignal.closeReason && (
              <div className="space-y-1 text-xs border-t border-slate-800 pt-3">
                <p className="font-semibold text-slate-200">Motivo de Encerramento</p>
                <p className="text-slate-300">{selectedSignal.closeReason}</p>
              </div>
            )}

            <div className="space-y-2 border-t border-slate-800 pt-3">
              <p className="text-xs font-semibold text-slate-200">
                Histórico de Alterações (Eventos Auditáveis)
              </p>
              {loadingEvents ? (
                <p className="text-xs text-slate-400">A carregar eventos...</p>
              ) : events.length === 0 ? (
                <p className="text-xs text-slate-400">Sem eventos registados.</p>
              ) : (
                <div className="space-y-2">
                  {events.map((ev) => (
                    <div
                      key={ev.id}
                      className="bg-[#0D131F] border border-slate-800 rounded p-2.5 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between text-slate-400 font-mono-num">
                        <span className="font-semibold text-slate-200">{ev.eventType}</span>
                        <span>{formatTs(ev.createdAt)}</span>
                      </div>
                      <p className="text-slate-300">{ev.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
