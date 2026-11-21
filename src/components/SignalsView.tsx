import React, { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { calculatePositionSize, detectCorrelatedExposure } from '../shared/positionMonitor';
import { getClassificationLabel } from '../shared/strategy';
import {
  INSTRUMENTS,
  MarketInstrumentOverview,
  StrategyCandidate,
  TradingSignalRecord,
  UserSettings,
  formatPrice,
} from '../shared/types';

interface SignalsViewProps {
  overviews: MarketInstrumentOverview[];
  signals: TradingSignalRecord[];
  settings: UserSettings;
  riskPaused: boolean;
  pauseReasons: string[];
  onEmitSignal: (candidate: StrategyCandidate, asOpen: boolean, actualEntry?: number, lots?: number) => Promise<void>;
  onOpenPendingSignal: (signal: TradingSignalRecord, actualEntry: number, lots: number) => Promise<void>;
  onInvalidateSignal: (signal: TradingSignalRecord, reason: string) => Promise<void>;
}

export const SignalsView: React.FC<SignalsViewProps> = ({
  overviews,
  signals,
  settings,
  riskPaused,
  pauseReasons,
  onEmitSignal,
  onOpenPendingSignal,
  onInvalidateSignal,
}) => {
  const [strategyFilter, setStrategyFilter] = useState<'ALL' | 'SCALPING' | 'INTRADAY'>('ALL');
  const [modalCandidate, setModalCandidate] = useState<StrategyCandidate | null>(null);
  const [modalSignal, setModalSignal] = useState<TradingSignalRecord | null>(null);
  const [entryInput, setEntryInput] = useState('');
  const [lotsInput, setLotsInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const candidates: StrategyCandidate[] = [];
  for (const ov of overviews) {
    if (ov.scalping && (strategyFilter === 'ALL' || strategyFilter === 'SCALPING')) {
      candidates.push(ov.scalping);
    }
    if (ov.intraday && (strategyFilter === 'ALL' || strategyFilter === 'INTRADAY')) {
      candidates.push(ov.intraday);
    }
  }
  candidates.sort((a, b) => b.score.total - a.score.total);

  const pendingOrEmitted = signals.filter(
    (s) => s.status === 'EMITIDO' || s.status === 'AGUARDAR_ENTRADA'
  );

  const openModalForCandidate = (c: StrategyCandidate) => {
    const sizing = calculatePositionSize(
      c.instrument,
      c.recommendedEntry,
      c.stopLoss,
      settings.referenceCapital,
      settings.riskPercentPerTrade
    );
    setModalSignal(null);
    setModalCandidate(c);
    setEntryInput(formatPrice(c.instrument, c.recommendedEntry));
    setLotsInput(String(sizing.lots));
  };

  const openModalForSignal = (s: TradingSignalRecord) => {
    const sizing = calculatePositionSize(
      s.instrument,
      s.recommendedEntry,
      s.stopLoss,
      settings.referenceCapital,
      settings.riskPercentPerTrade
    );
    setModalCandidate(null);
    setModalSignal(s);
    setEntryInput(formatPrice(s.instrument, s.recommendedEntry));
    setLotsInput(String(sizing.lots));
  };

  const handleConfirmOpen = async (e: React.FormEvent) => {
    e.preventDefault();
    const entryNum = Number(entryInput);
    const lotsNum = Number(lotsInput);
    if (!Number.isFinite(entryNum) || entryNum <= 0 || !Number.isFinite(lotsNum) || lotsNum <= 0) {
      return;
    }
    setSubmitting(true);
    try {
      if (modalCandidate) {
        await onEmitSignal(modalCandidate, true, entryNum, lotsNum);
        setModalCandidate(null);
      } else if (modalSignal) {
        await onOpenPendingSignal(modalSignal, entryNum, lotsNum);
        setModalSignal(null);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Motor de Sinais BUY / SELL (Pontuação 0–100)
          </h2>
          <p className="text-xs text-slate-400">
            Alertas de entrada emitidos exclusivamente a partir de 80 pontos com confluência H1 + M15 + M5. A pontuação mede confluência técnica, não probabilidade de ganho.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#111827] border border-slate-800 rounded-md">
          {(['ALL', 'SCALPING', 'INTRADAY'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setStrategyFilter(tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                strategyFilter === tab
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab === 'ALL' ? 'Todas' : tab}
            </button>
          ))}
        </div>
      </div>

      {riskPaused && (
        <div className="bg-amber-950/40 border border-amber-600/50 rounded-lg p-4 flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <p className="font-semibold text-amber-300">
              Novas Entradas Suspensas por Gestão de Risco
            </p>
            {pauseReasons.map((r, i) => (
              <p key={i} className="text-amber-200/80">
                {r}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Pending / Emitted Signals stored in Firestore */}
      {pendingOrEmitted.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-200">
            Sinais Emitidos a Aguardar Execução ({pendingOrEmitted.length})
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {pendingOrEmitted.map((sig) => (
              <div
                key={sig.id}
                className="bg-[#111827] border border-slate-800 rounded-lg p-4 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-sm font-bold ${
                        sig.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {sig.direction}
                    </span>
                    <span className="text-sm font-semibold text-slate-100">
                      {sig.instrument}
                    </span>
                    <span className="text-xs text-slate-400">
                      · {sig.strategy} ({sig.timeframe}) · {sig.executionType === 'IMMEDIATE' ? 'Entrada Imediata' : 'Entrada Condicionada'}
                    </span>
                  </div>
                  <span className="font-mono-num text-sm font-semibold text-emerald-400">
                    {sig.score}/100
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs font-mono-num bg-[#0D131F] border border-slate-800 rounded p-2.5">
                  <div>
                    <span className="text-slate-400 block">Entrada</span>
                    <span className="text-slate-100">
                      {formatPrice(sig.instrument, sig.recommendedEntry)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Take Profit</span>
                    <span className="text-emerald-400">
                      {formatPrice(sig.instrument, sig.takeProfit)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Stop Loss</span>
                    <span className="text-red-400">
                      {formatPrice(sig.instrument, sig.stopLoss)}
                    </span>
                  </div>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">{sig.rationale}</p>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => onInvalidateSignal(sig, 'Invalidado manualmente pelo utilizador.')}
                    className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors"
                  >
                    Invalidar
                  </button>
                  <button
                    type="button"
                    disabled={riskPaused}
                    onClick={() => openModalForSignal(sig)}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-md transition-colors"
                  >
                    Registar Posição Aberta
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Evaluated Opportunities */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-200">
          Avaliação Técnica Atual por Estratégia
        </h3>

        {candidates.length === 0 ? (
          <div className="bg-[#111827] border border-slate-800 rounded-lg p-8 text-center text-sm text-slate-400">
            SEM DADOS DE MERCADO suficientes para calcular oportunidades.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {candidates.map((c) => {
              const spec = INSTRUMENTS[c.instrument];
              const isActionable = c.actionable && c.score.total >= 80;
              const isObservation = c.score.total >= 70 && c.score.total < 80;
              const sizing = calculatePositionSize(
                c.instrument,
                c.recommendedEntry,
                c.stopLoss,
                settings.referenceCapital,
                settings.riskPercentPerTrade
              );
              const correlation = c.direction
                ? detectCorrelatedExposure(c.instrument, c.direction, signals)
                : { hasRisk: false, warnings: [] };
              const entryQualityLabel =
                c.intradayContext?.entryQuality === 'PULLBACK_OTIMO'
                  ? 'Pullback Ótimo'
                  : c.intradayContext?.entryQuality === 'ROMPIMENTO_LIMPO'
                  ? 'Rompimento Limpo'
                  : 'Esticado (Pullback EMA 9)';

              return (
                <div
                  key={`${c.instrument}_${c.strategy}`}
                  className="bg-[#111827] border border-slate-800 rounded-lg p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-bold ${
                            c.direction === 'BUY'
                              ? 'text-emerald-400'
                              : c.direction === 'SELL'
                              ? 'text-red-400'
                              : 'text-slate-400'
                          }`}
                        >
                          {c.direction || 'SEM DIREÇÃO'}
                        </span>
                        <span className="text-sm font-semibold text-slate-100">
                          {spec.label}
                        </span>
                        <span className="text-xs text-slate-400">
                          · {c.strategy} ({c.timeframe})
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {getClassificationLabel(c.score.classification)} ·{' '}
                        {c.executionType === 'IMMEDIATE'
                          ? 'Entrada imediata'
                          : 'Entrada condicionada'}
                        {!c.entryExecutable && ' · Preço já ultrapassado / Mercado fechado'}
                      </p>
                    </div>
                    <div className="text-right font-mono-num">
                      <span
                        className={`text-lg font-bold ${
                          isActionable
                            ? c.direction === 'BUY'
                              ? 'text-emerald-400'
                              : 'text-red-400'
                            : isObservation
                            ? 'text-amber-400'
                            : 'text-slate-400'
                        }`}
                      >
                        {c.score.total}
                      </span>
                      <span className="text-xs text-slate-500">/100</span>
                    </div>
                  </div>

                  {/* Breakdown bars */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono-num">
                    <div className="text-slate-300">H1: {c.score.h1Trend}/20</div>
                    <div className="text-slate-300">M15: {c.score.m15Structure}/20</div>
                    <div className="text-slate-300">M5: {c.score.m5Confirmation}/20</div>
                    <div className="text-slate-300">RSI/MACD: {c.score.rsiMacd}/15</div>
                    <div className="text-slate-300">ADX/ATR: {c.score.adxAtr}/10</div>
                    <div className="text-slate-300">Price Act.: {c.score.priceAction}/10</div>
                    <div className="text-slate-300">Spread: {c.score.spreadExecution}/5</div>
                    <div className="text-slate-300">R:R 1:{c.riskReward}</div>
                  </div>

                  <div className="grid grid-cols-4 gap-2 text-xs font-mono-num bg-[#0D131F] border border-slate-800 rounded p-2.5">
                    <div>
                      <span className="text-slate-400 block">Entrada</span>
                      <span className="text-slate-100">
                        {formatPrice(c.instrument, c.recommendedEntry)}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">TP</span>
                      <span className="text-emerald-400">
                        {formatPrice(c.instrument, c.takeProfit)}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">SL</span>
                      <span className="text-red-400">
                        {formatPrice(c.instrument, c.stopLoss)}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Lote Sug.</span>
                      <span className="text-sky-400">{sizing.lots.toFixed(2)}</span>
                    </div>
                  </div>

                  {c.intradayContext && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 border-t border-slate-800/70 pt-2">
                      <span>
                        Entrada:{' '}
                        <span
                          className={
                            c.intradayContext.entryQuality === 'ESTICADO'
                              ? 'text-amber-400 font-medium'
                              : 'text-emerald-400 font-medium'
                          }
                        >
                          {entryQualityLabel}
                        </span>
                      </span>
                      <span>·</span>
                      <span
                        className={
                          c.intradayContext.structuralClearanceOk
                            ? 'text-emerald-400'
                            : 'text-red-400'
                        }
                      >
                        {c.intradayContext.structuralClearanceOk
                          ? 'Estrutura Livre'
                          : 'Obstáculo S/R Próximo'}
                      </span>
                      <span>·</span>
                      <span
                        className={
                          c.intradayContext.antiChopOk ? 'text-slate-300' : 'text-amber-400'
                        }
                      >
                        {c.intradayContext.antiChopOk ? 'Tendência Limpa' : 'Mercado Lateral (Chop)'}
                      </span>
                      <span>·</span>
                      <span>{c.intradayContext.sessionLabel}</span>
                    </div>
                  )}

                  {correlation.hasRisk && (
                    <div className="bg-amber-950/35 border border-amber-700/50 rounded p-2 text-[11px] text-amber-200 space-y-0.5">
                      {correlation.warnings.map((w, idx) => (
                        <p key={idx}>{w}</p>
                      ))}
                    </div>
                  )}

                  <p className="text-xs text-slate-300 leading-relaxed">{c.rationale}</p>

                  {isActionable && (
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => onEmitSignal(c, false)}
                        className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors"
                      >
                        Guardar no Arquivo
                      </button>
                      <button
                        type="button"
                        disabled={riskPaused}
                        onClick={() => openModalForCandidate(c)}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-md transition-colors"
                      >
                        Registar Entrada na Corretora
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirm Broker Execution Modal */}
      {(modalCandidate || modalSignal) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <form
            onSubmit={handleConfirmOpen}
            className="w-full max-w-md bg-[#111827] border border-slate-800 rounded-lg p-6 space-y-4"
          >
            <h3 className="text-base font-semibold text-slate-100">
              Registar Posição Executada na Corretora
            </h3>
            <p className="text-xs text-slate-400">
              Confirme o preço efetivo de execução na sua corretora e o volume de lotes para acompanhamento automático de TP, SL e inversões.
            </p>

            {(() => {
              const targetInst = modalCandidate?.instrument ?? modalSignal?.instrument;
              const targetDir = modalCandidate?.direction ?? modalSignal?.direction;
              if (!targetInst || !targetDir) return null;
              const modalCorr = detectCorrelatedExposure(targetInst, targetDir, signals);
              if (!modalCorr.hasRisk) return null;
              return (
                <div className="bg-amber-950/40 border border-amber-700/60 rounded p-2.5 text-xs text-amber-200 space-y-1">
                  <p className="font-semibold text-amber-300">Aviso de Exposição Correlacionada</p>
                  {modalCorr.warnings.map((w, idx) => (
                    <p key={idx}>{w}</p>
                  ))}
                </div>
              );
            })()}

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Preço Efetivo de Entrada
                </label>
                <input
                  type="number"
                  step="any"
                  required
                  value={entryInput}
                  onChange={(e) => setEntryInput(e.target.value)}
                  className="w-full rounded-md bg-[#0B0F17] border border-slate-700 px-3 py-2 text-sm font-mono-num text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Quantidade de Lotes
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={lotsInput}
                  onChange={(e) => setLotsInput(e.target.value)}
                  className="w-full rounded-md bg-[#0B0F17] border border-slate-700 px-3 py-2 text-sm font-mono-num text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setModalCandidate(null);
                  setModalSignal(null);
                }}
                className="px-4 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-md"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-50"
              >
                {submitting ? 'A registar...' : 'Confirmar Posição Aberta'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
