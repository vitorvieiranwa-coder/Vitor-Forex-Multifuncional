import React, { useEffect, useState } from 'react';
import { saveUserSettings } from '../services/firestoreService';
import { UserSettings } from '../shared/types';
import { PWAInstallButton } from './PWAInstallButton';

interface SettingsViewProps {
  userId: string;
  settings: UserSettings;
  diagnostics: {
    providerName: string;
    hasTwelveDataKey: boolean;
    feedStatus: string;
    message: string;
    lastSuccessUtc: string | null;
  } | null;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  userId,
  settings,
  diagnostics,
}) => {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedMsg(null);
    try {
      await saveUserSettings(userId, form);
      setSavedMsg('Configurações de estratégia e alvos atualizadas.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-100">
          Configurações da Plataforma e Estratégias
        </h2>
        <p className="text-xs text-slate-400">
          Personalize os objetivos indicativos de Scalping, Intraday, distâncias específicas para Ouro (XAU/USD) e ligação ao fornecedor de mercado.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleSave}
          className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-200">
            Objetivos de Lucro e Relação Risco/Retorno
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 mb-1">
                Objetivo Scalping Forex (pips)
              </label>
              <input
                type="number"
                min="2"
                max="100"
                step="1"
                value={form.scalpingTargetPips}
                onChange={(e) =>
                  setForm({ ...form, scalpingTargetPips: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-300 mb-1">
                Objetivo Intraday Forex (pips)
              </label>
              <input
                type="number"
                min="5"
                max="300"
                step="1"
                value={form.intradayTargetPips}
                onChange={(e) =>
                  setForm({ ...form, intradayTargetPips: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-300 mb-1">
                XAU/USD Scalping (distância USD)
              </label>
              <input
                type="number"
                min="0.5"
                max="50"
                step="0.5"
                value={form.xauScalpingDistance}
                onChange={(e) =>
                  setForm({ ...form, xauScalpingDistance: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-300 mb-1">
                XAU/USD Intraday (distância USD)
              </label>
              <input
                type="number"
                min="1"
                max="150"
                step="0.5"
                value={form.xauIntradayDistance}
                onChange={(e) =>
                  setForm({ ...form, xauIntradayDistance: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-300 mb-1">
                Relação Risco/Retorno Mínima (1 : X)
              </label>
              <input
                type="number"
                min="1.0"
                max="10.0"
                step="0.1"
                value={form.minRiskReward}
                onChange={(e) =>
                  setForm({ ...form, minRiskReward: Number(e.target.value) })
                }
                className="w-full px-3 py-2 rounded-md bg-[#0B0F17] border border-slate-700 font-mono-num text-slate-100"
              />
            </div>
          </div>

          {savedMsg && <p className="text-xs text-emerald-400">{savedMsg}</p>}

          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {saving ? 'A guardar...' : 'Guardar Configurações'}
          </button>
        </form>

        {/* Data Feed & PWA Install Info */}
        <div className="space-y-4">
          <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3 text-xs">
            <h3 className="text-sm font-semibold text-slate-200">
              Fornecedor de Dados de Mercado (Servidor)
            </h3>
            <div className="space-y-1.5 text-slate-300">
              <p>
                Fornecedor Ativo:{' '}
                <span className="font-mono-num text-slate-100">
                  {diagnostics?.providerName || 'A verificar...'}
                </span>
              </p>
              <p>
                Estado da Ligação:{' '}
                <span className="font-mono-num text-emerald-400">
                  {diagnostics?.feedStatus || '—'}
                </span>
              </p>
              <p>
                Chave Twelve Data (Servidor):{' '}
                <span className="font-mono-num text-slate-100">
                  {diagnostics?.hasTwelveDataKey
                    ? 'Configurada via variável secreta'
                    : 'Não configurada (a usar Swissquote BBO + Yahoo OHLC real)'}
                </span>
              </p>
              <p className="text-slate-400 pt-1">
                Para utilizar a API Twelve Data como fonte primária de velas XAU/USD Spot e Forex, configure a variável secreta de ambiente{' '}
                <code className="font-mono-num text-slate-200">TWELVE_DATA_API_KEY</code> no servidor Cloud Run (nunca no frontend).
              </p>
            </div>
          </div>

          <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3 text-xs">
            <h3 className="text-sm font-semibold text-slate-200">
              Instalação PWA (Android & Desktop)
            </h3>
            <p className="text-slate-400 leading-relaxed">
              Esta plataforma é instalável como Progressive Web App (PWA) com suporte a notificações Web Push e modo standalone no Android Chrome ou navegador de computador.
            </p>
            <div className="pt-1">
              <PWAInstallButton />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
