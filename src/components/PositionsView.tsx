import React, { useState } from 'react';
import { AlertOctagon, ShieldCheck } from 'lucide-react';
import {
  PositionEvaluationResult,
  detectCorrelatedExposure,
} from '../shared/positionMonitor';
import {
  INSTRUMENTS,
  TradingSignalRecord,
  formatPrice,
} from '../shared/types';

interface PositionsViewProps {
  signals: TradingSignalRecord[];
  evaluations: Record<string, PositionEvaluationResult>;
  onManualClose: (
    signal: TradingSignalRecord,
    exitPrice: number,
    reason: string
  ) => Promise<void>;
}

export const PositionsView: React.FC<PositionsViewProps> = ({
  signals,
  evaluations,
  onManualClose,
}) => {
  const [closingTarget, setClosingTarget] = useState<TradingSignalRecord | null>(null);
  const [exitPriceInput, setExitPriceInput] = useState('');
  const [closeReasonInput, setCloseReasonInput] = useState('Encerramento manual confirmado na corretora.');
  const [submitting, setSubmitting] = useState(false);

  const openPositions = signals.filter(
    (s) => s.status === 'POSICAO_ABERTA' || s.status === 'ENCERRAMENTO_RECOMENDADO'
  );

  const startManualClose = (pos: TradingSignalRecord) => {
    const evalData = evaluations[pos.id];
    const defaultPrice = evalData?.currentExitPrice ?? pos.actualEntry ?? pos.recommendedEntry;
    setClosingTarget(pos);
    setExitPriceInput(formatPrice(pos.instrument, defaultPrice));
    setCloseReasonInput(
      pos.status === 'ENCERRAMENTO_RECOMENDADO'
        ? 'Encerramento antecipado confirmado após alerta de inversão de tendência.'
        : 'Encerramento manual confirmado na corretora.'
    );
  };

  const handleConfirmClose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!closingTarget) return;
    const price = Number(exitPriceInput);
    if (!Number.isFinite(price) || price <= 0) return;
    setSubmitting(true);
    try {
      await onManualClose(closingTarget, price, closeReasonInput);
      setClosingTarget(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-100">
          Acompanhamento de Posições Abertas
        </h2>
        <p className="text-xs text-slate-400">
          Monitorização contínua com preços Bid (fecho BUY) e Ask (fecho SELL), deteção automática de TP/SL e proteção contra inversões de tendência.
        </p>
      </div>

      {openPositions.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-10 text-center space-y-2">
          <p className="text-sm font-medium text-slate-200">
            Sem posições abertas de momento
          </p>
          <p className="text-xs text-slate-400">
            Registe uma entrada executada a partir do separador Sinais BUY/SELL para iniciar o acompanhamento automático.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {openPositions.map((pos) => {
            const spec = INSTRUMENTS[pos.instrument];
            const evalData = evaluations[pos.id];
            const entry = pos.actualEntry ?? pos.recommendedEntry;
            const isReversal = pos.status === 'ENCERRAMENTO_RECOMENDADO' || evalData?.reversal.shouldRecommendExit;
            const guidance = evalData?.managementGuidance;
            const correlation = detectCorrelatedExposure(
              pos.instrument,
              pos.direction,
              signals,
              pos.id
            );

            return (
              <div
                key={pos.id}
                className={`bg-[#111827] border rounded-lg p-5 space-y-4 ${
                  isReversal ? 'border-red-600/70' : 'border-slate-800'
                }`}
              >
                {isReversal && (
                  <div className="bg-red-950/50 border border-red-700/60 rounded-md p-3 flex items-start gap-3">
                    <AlertOctagon className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                    <div className="space-y-1 text-xs">
                      <p className="font-bold text-red-300">
                        RECOMENDAÇÃO DE ENCERRAMENTO — {pos.instrument} — POSIÇÃO {pos.direction}
                      </p>
                      {evalData?.reversal.reasons.length ? (
                        <ul className="list-disc list-inside text-red-200/90 space-y-0.5">
                          {evalData.reversal.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-red-200/90">
                          Confluência de múltiplos indicadores indica perda de momentum e inversão de tendência. Confirme o fecho manualmente na sua corretora.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {!isReversal && guidance?.guidanceText && (
                  <div className="bg-emerald-950/35 border border-emerald-700/60 rounded-md p-3 flex items-start gap-3">
                    <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="text-xs space-y-0.5">
                      <p className="font-semibold text-emerald-300">
                        {guidance.trailingStopActive
                          ? 'Gestão Dinâmica — Trailing Stop ATR (+1.5R)'
                          : 'Gestão de Capital — Break-Even (+1.0R)'}
                      </p>
                      <p className="text-emerald-200/90">{guidance.guidanceText}</p>
                    </div>
                  </div>
                )}

                {correlation.hasRisk && (
                  <div className="bg-amber-950/35 border border-amber-700/50 rounded-md p-2.5 text-xs text-amber-200 space-y-0.5">
                    {correlation.warnings.map((w, idx) => (
                      <p key={idx}>{w}</p>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-sm font-bold ${
                          pos.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {pos.direction}
                      </span>
                      <span className="text-base font-semibold text-slate-100">
                        {spec.label}
                      </span>
                      <span className="text-xs text-slate-400">
                        · {pos.strategy} · {pos.lots?.toFixed(2) || '—'} lotes · ID {pos.id}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Estado: {pos.status === 'ENCERRAMENTO_RECOMENDADO' ? 'Encerramento Recomendado' : 'Posição Aberta'}
                    </p>
                  </div>

                  <div className="text-right font-mono-num">
                    {evalData ? (
                      <>
                        <div
                          className={`text-lg font-bold ${
                            evalData.unrealizedPipsOrPoints >= 0
                              ? 'text-emerald-400'
                              : 'text-red-400'
                          }`}
                        >
                          {evalData.unrealizedPipsOrPoints >= 0 ? '+' : ''}
                          {evalData.unrealizedPipsOrPoints.toFixed(1)} {spec.unitLabel} (
                          {evalData.unrealizedR >= 0 ? '+' : ''}
                          {evalData.unrealizedR.toFixed(2)}R)
                        </div>
                        {evalData.unrealizedMonetary !== null && (
                          <div className="text-xs text-slate-300">
                            Resultado estimado:{' '}
                            {evalData.unrealizedMonetary >= 0 ? '+' : ''}
                            {evalData.unrealizedMonetary.toFixed(2)} USD
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-slate-400">A sincronizar cotação...</span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono-num bg-[#0D131F] border border-slate-800 rounded p-3">
                  <div>
                    <span className="text-slate-400 block">Entrada Efetiva</span>
                    <span className="text-slate-100">{formatPrice(pos.instrument, entry)}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">
                      Preço Atual ({pos.direction === 'BUY' ? 'Bid' : 'Ask'})
                    </span>
                    <span className="text-sky-400">
                      {evalData
                        ? formatPrice(pos.instrument, evalData.currentExitPrice)
                        : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Take Profit</span>
                    <span className="text-emerald-400">
                      {formatPrice(pos.instrument, pos.takeProfit)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Stop Loss</span>
                    <span className="text-red-400">
                      {formatPrice(pos.instrument, pos.stopLoss)}
                    </span>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => startManualClose(pos)}
                    className="px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md transition-colors"
                  >
                    Registar Encerramento Manual
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {closingTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <form
            onSubmit={handleConfirmClose}
            className="w-full max-w-md bg-[#111827] border border-slate-800 rounded-lg p-6 space-y-4"
          >
            <h3 className="text-base font-semibold text-slate-100">
              Confirmar Encerramento — {closingTarget.instrument}
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Preço Efetivo de Fecho
                </label>
                <input
                  type="number"
                  step="any"
                  required
                  value={exitPriceInput}
                  onChange={(e) => setExitPriceInput(e.target.value)}
                  className="w-full rounded-md bg-[#0B0F17] border border-slate-700 px-3 py-2 text-sm font-mono-num text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Motivo do Encerramento
                </label>
                <input
                  type="text"
                  required
                  maxLength={400}
                  value={closeReasonInput}
                  onChange={(e) => setCloseReasonInput(e.target.value)}
                  className="w-full rounded-md bg-[#0B0F17] border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setClosingTarget(null)}
                className="px-4 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-md"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-50"
              >
                {submitting ? 'A guardar...' : 'Confirmar Encerramento'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
