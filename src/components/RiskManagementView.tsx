import React, { useEffect, useState } from 'react';
import { saveUserSettings } from '../services/firestoreService';
import { calculatePositionSize } from '../shared/positionMonitor';
import {
  INSTRUMENT_LIST,
  InstrumentId,
  UserSettings,
} from '../shared/types';

interface RiskManagementViewProps {
  userId: string;
  settings: UserSettings;
  riskStatus: {
    paused: boolean;
    pauseReasons: string[];
    openPositionsCount: number;
    consecutiveLosses: number;
    dailyPnlUsd: number;
    dailyLossLimitUsd: number;
  };
}

export const RiskManagementView: React.FC<RiskManagementViewProps> = ({
  userId,
  settings,
  riskStatus,
}) => {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Interactive position sizing calculator state
  const [calcInstrument, setCalcInstrument] = useState<InstrumentId>('EUR/USD');
  const [calcEntry, setCalcEntry] = useState('1.09500');
  const [calcSl, setCalcSl] = useState('1.09380');

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedMsg(null);
    try {
      await saveUserSettings(userId, form);
      setSavedMsg('Parâmetros de gestão de risco guardados no Firestore.');
    } finally {
      setSaving(false);
    }
  };

  const calcResult = calculatePositionSize(
    calcInstrument,
    Number(calcEntry) || 1,
    Number(calcSl) || 0.99,
    form.referenceCapital,
    form.riskPercentPerTrade
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-100">
          Gestão de Risco & Dimensionamento de Posição
        </h2>
        <p className="text-xs text-slate-400">
          Controlo rigoroso de exposição por operação, limite diário e suspensão automática após perdas consecutivas.
        </p>
      </div>

      {/* Live Risk Status */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <span className="text-xs text-slate-400 block">Estado do Motor de Risco</span>
          <span
            className={`text-base font-semibold ${
              riskStatus.paused ? 'text-red-400' : 'text-emerald-400'
            }`}
          >
            {riskStatus.paused ? 'Pausa Automática Ativa' : 'Operacional'}
          </span>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <span className="text-xs text-slate-400 block">Posições Abertas</span>
          <span className="text-base font-semibold font-mono-num text-slate-100">
            {riskStatus.openPositionsCount} / {settings.maxOpenPositions}
          </span>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <span className="text-xs text-slate-400 block">Perdas Consecutivas</span>
          <span className="text-base font-semibold font-mono-num text-slate-100">
            {riskStatus.consecutiveLosses} / {settings.maxConsecutiveLosses}
          </span>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <span className="text-xs text-slate-400 block">Resultado Diário (UTC)</span>
          <span
            className={`text-base font-semibold font-mono-num ${
              riskStatus.dailyPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {riskStatus.dailyPnlUsd.toFixed(2)} USD (Lim: {riskStatus.dailyLossLimitUsd.toFixed(0)} USD)
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleSave}
          className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-200">
            Regras Configuráveis
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 mb-1">Capital de Referência (USD)</label>
              <input
                type="number"
                min="100"
                step="100"
                value={form.referenceCapital}
                onChange={(e) =>
                  setForm({ ...form, referenceCapital: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-300 mb-1">Risco por Operação (%)</label>
              <input
                type="number"
                min="0.05"
                max="10"
                step="0.05"
                value={form.riskPercentPerTrade}
                onChange={(e) =>
                  setForm({ ...form, riskPercentPerTrade: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-300 mb-1">Limite Diário de Perdas (%)</label>
              <input
                type="number"
                min="0.25"
                max="50"
                step="0.25"
                value={form.dailyLossLimitPercent}
                onChange={(e) =>
                  setForm({ ...form, dailyLossLimitPercent: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-300 mb-1">Máx. Operações Abertas</label>
              <input
                type="number"
                min="1"
                max="20"
                value={form.maxOpenPositions}
                onChange={(e) =>
                  setForm({ ...form, maxOpenPositions: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-300 mb-1">Máx. Perdas Consecutivas</label>
              <input
                type="number"
                min="1"
                max="20"
                value={form.maxConsecutiveLosses}
                onChange={(e) =>
                  setForm({ ...form, maxConsecutiveLosses: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>

            <div className="flex items-center pt-5">
              <label className="inline-flex items-center gap-2 cursor-pointer text-slate-200">
                <input
                  type="checkbox"
                  checked={form.autoPauseOnLimit}
                  onChange={(e) =>
                    setForm({ ...form, autoPauseOnLimit: e.target.checked })
                  }
                  className="rounded border-slate-600 bg-[#0B0F17]"
                />
                <span>Pausa automática ao atingir limites</span>
              </label>
            </div>
          </div>

          {savedMsg && <p className="text-xs text-emerald-400">{savedMsg}</p>}

          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {saving ? 'A guardar...' : 'Guardar Gestão de Risco'}
          </button>
        </form>

        {/* Position Size Calculator */}
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-200">
            Calculadora de Tamanho de Posição (Lotes)
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div>
              <label className="block text-slate-400 mb-1">Instrumento</label>
              <select
                value={calcInstrument}
                onChange={(e) => setCalcInstrument(e.target.value as InstrumentId)}
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
              >
                {INSTRUMENT_LIST.map((inst) => (
                  <option key={inst} value={inst}>
                    {inst}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Preço de Entrada</label>
              <input
                type="number"
                step="any"
                value={calcEntry}
                onChange={(e) => setCalcEntry(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Stop Loss</label>
              <input
                type="number"
                step="any"
                value={calcSl}
                onChange={(e) => setCalcSl(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 bg-[#0D131F] border border-slate-800 rounded p-4 text-xs font-mono-num">
            <div>
              <span className="text-slate-400 block">Lotes Recomendados</span>
              <span className="text-xl font-bold text-emerald-400">
                {calcResult.lots.toFixed(2)}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block">Risco Monetário</span>
              <span className="text-base font-semibold text-slate-100">
                {calcResult.riskAmountUsd.toFixed(2)} USD
              </span>
            </div>
            <div>
              <span className="text-slate-400 block">Distância SL</span>
              <span className="text-base font-semibold text-slate-100">
                {calcResult.stopDistancePipsOrPoints}{' '}
                {calcInstrument === 'XAU/USD' ? 'USD' : 'pips'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
