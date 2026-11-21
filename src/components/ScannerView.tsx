import React from 'react';
import { getClassificationLabel } from '../shared/strategy';
import {
  INSTRUMENTS,
  IndicatorDirection,
  InstrumentId,
  MarketInstrumentOverview,
  formatPrice,
} from '../shared/types';

function renderIndicatorBias(dir: IndicatorDirection, isVolatility = false) {
  if (dir === 'SUBIDA') {
    return (
      <span
        className={`block text-[11px] font-medium mt-0.5 ${
          isVolatility ? 'text-amber-400' : 'text-emerald-400'
        }`}
      >
        ▲ {isVolatility ? 'Subida (Vol.)' : 'Em subida'}
      </span>
    );
  }
  if (dir === 'DESCIDA') {
    return (
      <span
        className={`block text-[11px] font-medium mt-0.5 ${
          isVolatility ? 'text-slate-300' : 'text-red-400'
        }`}
      >
        ▼ {isVolatility ? 'Descida (Vol.)' : 'Em descida'}
      </span>
    );
  }
  return (
    <span className="block text-[11px] font-medium mt-0.5 text-slate-400">
      — Neutro
    </span>
  );
}

interface ScannerViewProps {
  overviews: MarketInstrumentOverview[];
  onSelectInstrument: (inst: InstrumentId) => void;
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  overviews,
  onSelectInstrument,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Market Scanner Multi-Timeframe
          </h2>
          <p className="text-xs text-slate-400">
            Matriz técnica em tempo real calculada exclusivamente sobre velas fechadas (sem look-ahead bias).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {overviews.map((ov) => {
          const spec = INSTRUMENTS[ov.instrument];
          const m5 = ov.timeframes.M5;
          const m15 = ov.timeframes.M15;
          const h1 = ov.timeframes.H1;
          const dirs = m5?.indicatorDirections;

          return (
            <div
              key={ov.instrument}
              className="bg-[#111827] border border-slate-800 rounded-lg p-4 space-y-4"
            >
              <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">{spec.label}</h3>
                  <p className="text-xs text-slate-400">{ov.feedMessage}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onSelectInstrument(ov.instrument)}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Abrir Gráfico
                </button>
              </div>

              {ov.feedStatus === 'NO_DATA' || !m5 || !m15 || !h1 ? (
                <p className="text-sm text-red-400 font-medium">SEM DADOS DE MERCADO</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div>
                      <span className="text-slate-400 block">RSI (14) M5</span>
                      <span className="font-mono-num font-medium text-slate-100">
                        {m5.rsi14.toFixed(1)}
                      </span>
                      {dirs && renderIndicatorBias(dirs.rsi)}
                    </div>
                    <div>
                      <span className="text-slate-400 block">MACD Hist M5</span>
                      <span
                        className={`font-mono-num font-medium ${
                          m5.macd.histogram >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {m5.macd.histogram.toFixed(5)}
                      </span>
                      {dirs && renderIndicatorBias(dirs.macd)}
                    </div>
                    <div>
                      <span className="text-slate-400 block">ADX (14) / DI</span>
                      <span className="font-mono-num font-medium text-slate-100">
                        {m5.adx14.toFixed(1)} ({m5.plusDI.toFixed(0)}/{m5.minusDI.toFixed(0)})
                      </span>
                      {dirs && renderIndicatorBias(dirs.adx)}
                    </div>
                    <div>
                      <span className="text-slate-400 block">ATR (14) M5</span>
                      <span className="font-mono-num font-medium text-slate-100">
                        {formatPrice(ov.instrument, m5.atr14)}
                      </span>
                      {dirs && renderIndicatorBias(dirs.atr, true)}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs border-t border-slate-800/80 pt-3">
                    <div>
                      <span className="text-slate-400">VWAP M5: </span>
                      <span className="font-mono-num text-slate-200">
                        {m5.vwap.value !== null
                          ? formatPrice(ov.instrument, m5.vwap.value)
                          : 'N/D'}
                      </span>
                      <span className="text-slate-500"> ({m5.vwap.volumeType})</span>
                    </div>
                    <div>
                      <span className="text-slate-400">Price Action: </span>
                      <span className="text-slate-200">
                        {m5.candlePatterns.join(', ') || m5.breakout}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 border-t border-slate-800/80 pt-3 text-xs">
                    <div className="bg-[#0D131F] border border-slate-800 rounded p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Scalping (M5)</span>
                        <span className="font-mono-num font-semibold text-slate-100">
                          {ov.scalping?.score.total ?? 0}/100
                        </span>
                      </div>
                      <p className="mt-1 text-slate-300">
                        {ov.scalping?.direction || 'Neutro'} ·{' '}
                        {ov.scalping
                          ? getClassificationLabel(ov.scalping.score.classification)
                          : 'Sem entrada'}
                      </p>
                    </div>
                    <div className="bg-[#0D131F] border border-slate-800 rounded p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Intraday (M15)</span>
                        <span className="font-mono-num font-semibold text-slate-100">
                          {ov.intraday?.score.total ?? 0}/100
                        </span>
                      </div>
                      <p className="mt-1 text-slate-300">
                        {ov.intraday?.direction || 'Neutro'} ·{' '}
                        {ov.intraday
                          ? getClassificationLabel(ov.intraday.score.classification)
                          : 'Sem entrada'}
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
