import React, { useMemo, useState } from 'react';
import {
  BacktestConfig,
  BacktestResult,
  Candle,
  INSTRUMENT_LIST,
  InstrumentId,
  SignalSourceType,
  StrategyType,
  TradingSignalRecord,
  UserSettings,
} from '../shared/types';

interface StatisticsBacktestViewProps {
  signals: TradingSignalRecord[];
  settings: UserSettings;
}

function parseCsvCandles(text: string): Candle[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const candles: Candle[] = [];

  for (const line of lines) {
    const parts = line.split(/[,;\t]+/);
    if (parts.length < 5) continue;
    const rawTime = parts[0];
    if (/time|date/i.test(rawTime)) continue;

    const ts = /^\d+$/.test(rawTime)
      ? Number(rawTime) > 1e12
        ? Math.floor(Number(rawTime) / 1000)
        : Number(rawTime)
      : Math.floor(Date.parse(rawTime) / 1000);

    const open = Number(parts[1]);
    const high = Number(parts[2]);
    const low = Number(parts[3]);
    const close = Number(parts[4]);
    const volume = parts[5] ? Number(parts[5]) : 0;

    if (
      Number.isFinite(ts) &&
      ts > 0 &&
      Number.isFinite(open) &&
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      Number.isFinite(close) &&
      close > 0
    ) {
      candles.push({
        time: ts,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
      });
    }
  }
  return candles;
}

export const StatisticsBacktestView: React.FC<StatisticsBacktestViewProps> = ({
  signals,
  settings,
}) => {
  const [sourceFilter, setSourceFilter] = useState<'EXECUTED' | SignalSourceType>('EXECUTED');

  // Backtester config
  const [btInstrument, setBtInstrument] = useState<InstrumentId>('EUR/USD');
  const [btStrategy, setBtStrategy] = useState<StrategyType>('SCALPING');
  const [btTimeframe, setBtTimeframe] = useState<'M5' | 'M15'>('M5');
  const [btSpread, setBtSpread] = useState('1.2');
  const [btSlippage, setBtSlippage] = useState('0.2');
  const [btCommission, setBtCommission] = useState('7.0');
  const [btUseBreakEven, setBtUseBreakEven] = useState(true);
  const [uploadedCandles, setUploadedCandles] = useState<Candle[] | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [btLoading, setBtLoading] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [btResult, setBtResult] = useState<BacktestResult | null>(null);

  const stats = useMemo(() => {
    const closed = signals.filter((s) => {
      const isClosed =
        s.status === 'TP_ATINGIDO' ||
        s.status === 'SL_ATINGIDO' ||
        s.status === 'ENCERRADO_MANUALMENTE';
      if (!isClosed) return false;
      if (sourceFilter === 'EXECUTED') {
        return typeof s.actualEntry === 'number' && s.sourceType === 'LIVE_SIGNAL';
      }
      return s.sourceType === sourceFilter;
    });

    const wins = closed.filter((t) => (t.resultR ?? 0) > 0);
    const losses = closed.filter((t) => (t.resultR ?? 0) < 0);
    const netR = closed.reduce((acc, t) => acc + (t.resultR ?? 0), 0);

    let peakR = 0;
    let cumR = 0;
    let maxDrawdownR = 0;
    const chronological = [...closed].reverse();
    for (const t of chronological) {
      cumR += t.resultR ?? 0;
      peakR = Math.max(peakR, cumR);
      maxDrawdownR = Math.max(maxDrawdownR, peakR - cumR);
    }

    const byInstrument = INSTRUMENT_LIST.map((inst) => {
      const sub = closed.filter((t) => t.instrument === inst);
      return {
        instrument: inst,
        count: sub.length,
        netR: sub.reduce((a, b) => a + (b.resultR ?? 0), 0),
      };
    });

    const buyTrades = closed.filter((t) => t.direction === 'BUY');
    const sellTrades = closed.filter((t) => t.direction === 'SELL');
    const reversalExits = closed.filter((t) => t.reversalAlertIssued).length;

    const byTimeframe = (['M1', 'M5', 'M15', 'H1'] as const).map((tf) => {
      const sub = closed.filter((t) => t.timeframe === tf);
      return {
        timeframe: tf,
        count: sub.length,
        netR: sub.reduce((a, b) => a + (b.resultR ?? 0), 0),
      };
    });

    return {
      total: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      netR,
      maxDrawdownR,
      byInstrument,
      buyNetR: buyTrades.reduce((a, b) => a + (b.resultR ?? 0), 0),
      buyCount: buyTrades.length,
      sellNetR: sellTrades.reduce((a, b) => a + (b.resultR ?? 0), 0),
      sellCount: sellTrades.length,
      byTimeframe,
      reversalExits,
    };
  }, [signals, sourceFilter]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseCsvCandles(text);
    setUploadedCandles(parsed);
    setUploadName(`${file.name} (${parsed.length} velas)`);
  };

  const handleRunBacktest = async (e: React.FormEvent) => {
    e.preventDefault();
    setBtLoading(true);
    setBtError(null);
    try {
      const config: BacktestConfig = {
        instrument: btInstrument,
        strategy: btStrategy,
        timeframe: btTimeframe,
        spreadPips: Number(btSpread) || 1.2,
        slippagePips: Number(btSlippage) || 0.2,
        commissionPerLotUsd: Number(btCommission) || 7.0,
        riskPercentPerTrade: settings.riskPercentPerTrade,
        initialCapital: settings.referenceCapital,
        scalpingTargetPips: settings.scalpingTargetPips,
        intradayTargetPips: settings.intradayTargetPips,
        xauScalpingDistance: settings.xauScalpingDistance,
        xauIntradayDistance: settings.xauIntradayDistance,
        minRiskReward: settings.minRiskReward,
        useBreakEvenAt1R: btUseBreakEven,
      };
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config,
          candles: uploadedCandles || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setBtError(json.error || 'Erro ao executar backtest.');
        setBtResult(null);
      } else {
        setBtResult(json.result as BacktestResult);
      }
    } catch (err) {
      setBtError(err instanceof Error ? err.message : 'Erro de rede no backtest.');
    } finally {
      setBtLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Live vs Demo vs Historical Separation Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Estatísticas de Desempenho & Backtesting
          </h2>
          <p className="text-xs text-slate-400">
            Separação rigorosa entre operações reais executadas, sinais em demonstração e simulações históricas sem informação futura.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#111827] border border-slate-800 rounded-md">
          {(
            [
              ['EXECUTED', 'Operações Executadas'],
              ['LIVE_SIGNAL', 'Todos Sinais Reais'],
              ['BACKTEST_HISTORICAL', 'Replay 20/11'],
              ['DEMO_SIGNAL', 'Sinais Demo'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSourceFilter(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                sourceFilter === key
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Real Trade Statistics */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-3.5">
          <span className="text-xs text-slate-400 block">Total Operações</span>
          <span className="text-xl font-semibold font-mono-num text-slate-100">
            {stats.total}
          </span>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-3.5">
          <span className="text-xs text-slate-400 block">Vencedoras / Perdedoras</span>
          <span className="text-xl font-semibold font-mono-num text-slate-100">
            {stats.wins} / {stats.losses}
          </span>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-3.5">
          <span className="text-xs text-slate-400 block">Taxa de Acerto</span>
          <span className="text-xl font-semibold font-mono-num text-slate-100">
            {stats.winRate.toFixed(1)}%
          </span>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-3.5">
          <span className="text-xs text-slate-400 block">Resultado Líquido</span>
          <span
            className={`text-xl font-semibold font-mono-num ${
              stats.netR >= 0 ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {stats.netR >= 0 ? '+' : ''}
            {stats.netR.toFixed(2)}R
          </span>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-3.5">
          <span className="text-xs text-slate-400 block">Drawdown Máx.</span>
          <span className="text-xl font-semibold font-mono-num text-red-400">
            -{stats.maxDrawdownR.toFixed(2)}R
          </span>
        </div>
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-3.5">
          <span className="text-xs text-slate-400 block">Saídas por Inversão</span>
          <span className="text-xl font-semibold font-mono-num text-amber-400">
            {stats.reversalExits}
          </span>
        </div>
      </div>

      {/* Breakdown Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4 space-y-2">
          <h3 className="text-xs font-semibold text-slate-300">Por Instrumento</h3>
          {stats.byInstrument.map((b) => (
            <div key={b.instrument} className="flex justify-between text-xs font-mono-num">
              <span className="text-slate-300">
                {b.instrument} ({b.count})
              </span>
              <span className={b.netR >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {b.netR >= 0 ? '+' : ''}
                {b.netR.toFixed(2)}R
              </span>
            </div>
          ))}
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4 space-y-2">
          <h3 className="text-xs font-semibold text-slate-300">BUY vs SELL</h3>
          <div className="flex justify-between text-xs font-mono-num">
            <span className="text-emerald-400">BUY ({stats.buyCount})</span>
            <span>{stats.buyNetR.toFixed(2)}R</span>
          </div>
          <div className="flex justify-between text-xs font-mono-num">
            <span className="text-red-400">SELL ({stats.sellCount})</span>
            <span>{stats.sellNetR.toFixed(2)}R</span>
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4 space-y-2">
          <h3 className="text-xs font-semibold text-slate-300">Por Timeframe</h3>
          {stats.byTimeframe.map((tf) => (
            <div key={tf.timeframe} className="flex justify-between text-xs font-mono-num">
              <span className="text-slate-300">
                {tf.timeframe} ({tf.count})
              </span>
              <span className={tf.netR >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {tf.netR >= 0 ? '+' : ''}
                {tf.netR.toFixed(2)}R
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Historical Backtesting Runner */}
      <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Motor de Backtesting Histórico (Dados Reais — Zero Look-Ahead)
          </h3>
          <p className="text-xs text-slate-400">
            Simulação barra-a-barra sobre velas históricas reais do fornecedor ou CSV próprio, contabilizando spread, slippage, comissões e Bid/Ask.
          </p>
        </div>

        <form onSubmit={handleRunBacktest} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Instrumento</label>
            <select
              value={btInstrument}
              onChange={(e) => setBtInstrument(e.target.value as InstrumentId)}
              className="w-full px-3 py-2 text-xs rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
            >
              {INSTRUMENT_LIST.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Estratégia</label>
            <select
              value={btStrategy}
              onChange={(e) => setBtStrategy(e.target.value as StrategyType)}
              className="w-full px-3 py-2 text-xs rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
            >
              <option value="SCALPING">SCALPING</option>
              <option value="INTRADAY">INTRADAY</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Timeframe</label>
            <select
              value={btTimeframe}
              onChange={(e) => setBtTimeframe(e.target.value as 'M5' | 'M15')}
              className="w-full px-3 py-2 text-xs rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
            >
              <option value="M5">M5</option>
              <option value="M15">M15</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Spread ({btInstrument === 'XAU/USD' ? 'USD' : 'pips'})</label>
            <input
              type="number"
              step="0.1"
              value={btSpread}
              onChange={(e) => setBtSpread(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono-num rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Slippage / Com. ($)</label>
            <div className="flex gap-1">
              <input
                type="number"
                step="0.1"
                value={btSlippage}
                onChange={(e) => setBtSlippage(e.target.value)}
                className="w-1/2 px-2 py-2 text-xs font-mono-num rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
              />
              <input
                type="number"
                step="0.5"
                value={btCommission}
                onChange={(e) => setBtCommission(e.target.value)}
                className="w-1/2 px-2 py-2 text-xs font-mono-num rounded-md bg-[#0B0F17] border border-slate-700 text-slate-100"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={btLoading}
            className="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {btLoading ? 'A simular...' : 'Executar Backtest'}
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
          <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={btUseBreakEven}
              onChange={(e) => setBtUseBreakEven(e.target.checked)}
              className="rounded border-slate-600 bg-[#0B0F17] text-emerald-500"
            />
            <span>Proteção Break-Even (+1.0R)</span>
          </label>
          <label className="cursor-pointer px-3 py-1.5 bg-[#0D131F] border border-slate-700 rounded hover:border-slate-500 text-slate-300">
            Carregar CSV OHLC Opcional (time,open,high,low,close,volume)
            <input type="file" accept=".csv,.txt" onChange={handleFileChange} className="hidden" />
          </label>
          {uploadName && (
            <span className="text-emerald-400 font-mono-num">
              Carregado: {uploadName}
            </span>
          )}
          {uploadName && (
            <button
              type="button"
              onClick={() => {
                setUploadedCandles(null);
                setUploadName(null);
              }}
              className="text-red-400 underline"
            >
              Limpar CSV
            </button>
          )}
        </div>

        {btError && (
          <div className="p-3 bg-red-950/40 border border-red-800 rounded text-xs text-red-300">
            {btError}
          </div>
        )}

        {btResult && (
          <div className="border-t border-slate-800 pt-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between text-xs text-slate-400">
              <span>
                RESULTADO HISTÓRICO SIMULADO · {btResult.sourceLabel} ·{' '}
                {btResult.candlesAnalyzed} velas ({btResult.dateRangeUtc.start.slice(0, 10)} a{' '}
                {btResult.dateRangeUtc.end.slice(0, 10)})
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs font-mono-num">
              <div className="bg-[#0D131F] border border-slate-800 rounded p-3">
                <span className="text-slate-400 block">Sinais Gerados</span>
                <span className="text-base font-semibold text-slate-100">
                  {btResult.totalSignals} ({btResult.wins}W / {btResult.losses}L)
                </span>
              </div>
              <div className="bg-[#0D131F] border border-slate-800 rounded p-3">
                <span className="text-slate-400 block">Taxa de Acerto</span>
                <span className="text-base font-semibold text-slate-100">
                  {btResult.winRatePct}%
                </span>
              </div>
              <div className="bg-[#0D131F] border border-slate-800 rounded p-3">
                <span className="text-slate-400 block">Resultado Líquido</span>
                <span
                  className={`text-base font-semibold ${
                    btResult.netR >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {btResult.netR >= 0 ? '+' : ''}
                  {btResult.netR}R ({btResult.netMonetary >= 0 ? '+' : ''}
                  {btResult.netMonetary} USD)
                </span>
              </div>
              <div className="bg-[#0D131F] border border-slate-800 rounded p-3">
                <span className="text-slate-400 block">Drawdown Máx.</span>
                <span className="text-base font-semibold text-red-400">
                  -{btResult.maxDrawdownR}R ({btResult.maxDrawdownPct}%)
                </span>
              </div>
              <div className="bg-[#0D131F] border border-slate-800 rounded p-3">
                <span className="text-slate-400 block">Fechos por Inversão</span>
                <span className="text-base font-semibold text-amber-400">
                  {btResult.reversalExits}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
