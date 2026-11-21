import React, { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  IChartApi,
  LineSeries,
  LineStyle,
  Time,
  createChart,
} from 'lightweight-charts';
import {
  Candle,
  INSTRUMENTS,
  INSTRUMENT_LIST,
  IndicatorSnapshot,
  InstrumentId,
  Quote,
  Timeframe,
  TradingSignalRecord,
  VolumeNature,
} from '../shared/types';

interface ChartPayload {
  feedStatus: 'CONNECTED' | 'NO_DATA';
  instrument: InstrumentId;
  timeframe: Timeframe;
  source: string;
  volumeType: VolumeNature;
  fetchedAtUtc: string;
  quote: Quote | null;
  candles: Candle[];
  series: {
    ema9: number[];
    ema21: number[];
    ema50: number[];
    rsi14: number[];
    macd: { macdLine: number[]; signalLine: number[]; histogram: number[] };
    bollinger: { upper: number[]; middle: number[]; lower: number[] };
    vwap: (number | null)[];
  };
  snapshot: IndicatorSnapshot | null;
}

interface TradingChartProps {
  selectedInstrument: InstrumentId;
  onSelectInstrument: (inst: InstrumentId) => void;
  activeSignals: TradingSignalRecord[];
}

const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'H1'];

export const TradingChart: React.FC<TradingChartProps> = ({
  selectedInstrument,
  onSelectInstrument,
  activeSignals,
}) => {
  const [timeframe, setTimeframe] = useState<Timeframe>('M5');
  const [showEma, setShowEma] = useState(true);
  const [showBollinger, setShowBollinger] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const [oscillatorTab, setOscillatorTab] = useState<'RSI' | 'MACD'>('RSI');
  const [data, setData] = useState<ChartPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mainContainerRef = useRef<HTMLDivElement | null>(null);
  const oscContainerRef = useRef<HTMLDivElement | null>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const oscChartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErrorMsg(null);
      try {
        const res = await fetch(
          `/api/market/candles?instrument=${encodeURIComponent(
            selectedInstrument
          )}&timeframe=${timeframe}&limit=220`
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || json.feedStatus === 'NO_DATA') {
          setErrorMsg(json.message || 'SEM DADOS DE MERCADO');
          setData(null);
        } else {
          setData(json as ChartPayload);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'SEM DADOS DE MERCADO');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(load, 25_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedInstrument, timeframe]);

  useEffect(() => {
    if (!mainContainerRef.current || !oscContainerRef.current || !data || data.candles.length === 0) {
      return;
    }

    const spec = INSTRUMENTS[selectedInstrument];
    const mainEl = mainContainerRef.current;
    const oscEl = oscContainerRef.current;

    const chartOptions = {
      layout: {
        background: { type: ColorType.Solid, color: '#0F1521' },
        textColor: '#94A3B8',
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: '#1E293B' },
        horzLines: { color: '#1E293B' },
      },
      crosshair: {
        vertLine: { color: '#475569', labelBackgroundColor: '#1E293B' },
        horzLine: { color: '#475569', labelBackgroundColor: '#1E293B' },
      },
      timeScale: {
        borderColor: '#1E293B',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#1E293B',
      },
    };

    const mainChart = createChart(mainEl, {
      ...chartOptions,
      width: mainEl.clientWidth,
      height: 400,
    });
    mainChartRef.current = mainChart;

    const candleSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: '#10B981',
      downColor: '#EF4444',
      borderVisible: false,
      wickUpColor: '#10B981',
      wickDownColor: '#EF4444',
      priceFormat: {
        type: 'price',
        precision: spec.priceDecimals,
        minMove: 1 / Math.pow(10, spec.priceDecimals),
      },
    });

    candleSeries.setData(
      data.candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    const mapLine = (arr: (number | null)[]) =>
      data.candles
        .map((c, idx) => {
          const val = arr[idx];
          if (val === null || val === undefined || Number.isNaN(val)) return null;
          return { time: c.time as Time, value: val };
        })
        .filter((x): x is { time: Time; value: number } => x !== null);

    if (showEma) {
      const s9 = mainChart.addSeries(LineSeries, { color: '#38BDF8', lineWidth: 1, title: 'EMA 9' });
      s9.setData(mapLine(data.series.ema9));
      const s21 = mainChart.addSeries(LineSeries, { color: '#F59E0B', lineWidth: 1, title: 'EMA 21' });
      s21.setData(mapLine(data.series.ema21));
      const s50 = mainChart.addSeries(LineSeries, { color: '#A855F7', lineWidth: 2, title: 'EMA 50' });
      s50.setData(mapLine(data.series.ema50));
    }

    if (showBollinger) {
      const bbU = mainChart.addSeries(LineSeries, {
        color: 'rgba(148, 163, 184, 0.45)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: 'BB Sup',
      });
      bbU.setData(mapLine(data.series.bollinger.upper));
      const bbL = mainChart.addSeries(LineSeries, {
        color: 'rgba(148, 163, 184, 0.45)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: 'BB Inf',
      });
      bbL.setData(mapLine(data.series.bollinger.lower));
    }

    if (showVwap && data.volumeType !== 'NO_VOLUME_DATA') {
      const sVwap = mainChart.addSeries(LineSeries, {
        color: '#EC4899',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        title: 'VWAP',
      });
      sVwap.setData(mapLine(data.series.vwap));
    }

    // Structural Support & Resistance lines
    if (data.snapshot) {
      data.snapshot.supports.forEach((sup) => {
        candleSeries.createPriceLine({
          price: sup,
          color: '#10B981',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'SUP',
        });
      });
      data.snapshot.resistances.forEach((res) => {
        candleSeries.createPriceLine({
          price: res,
          color: '#EF4444',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'RES',
        });
      });
    }

    // Active Signal Entry / TP / SL lines for this instrument
    const relevantSignal = activeSignals.find(
      (s) => s.instrument === selectedInstrument
    );
    if (relevantSignal) {
      candleSeries.createPriceLine({
        price: relevantSignal.actualEntry ?? relevantSignal.recommendedEntry,
        color: '#38BDF8',
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `${relevantSignal.direction} ENT`,
      });
      candleSeries.createPriceLine({
        price: relevantSignal.takeProfit,
        color: '#10B981',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'TP',
      });
      candleSeries.createPriceLine({
        price: relevantSignal.stopLoss,
        color: '#EF4444',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'SL',
      });
    }

    mainChart.timeScale().fitContent();

    // Oscillator sub-chart (RSI 14 or MACD 12,26,9)
    const oscChart = createChart(oscEl, {
      ...chartOptions,
      width: oscEl.clientWidth,
      height: 150,
    });
    oscChartRef.current = oscChart;

    if (oscillatorTab === 'RSI') {
      const rsiSeries = oscChart.addSeries(LineSeries, {
        color: '#38BDF8',
        lineWidth: 2,
        title: 'RSI(14)',
      });
      rsiSeries.setData(mapLine(data.series.rsi14));
      rsiSeries.createPriceLine({
        price: 70,
        color: '#EF4444',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '70',
      });
      rsiSeries.createPriceLine({
        price: 30,
        color: '#10B981',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '30',
      });
    } else {
      const histSeries = oscChart.addSeries(HistogramSeries, { title: 'MACD Hist' });
      const histData = data.candles
        .map((c, idx) => {
          const val = data.series.macd.histogram[idx];
          if (val === undefined || Number.isNaN(val)) return null;
          return {
            time: c.time as Time,
            value: val,
            color: val >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)',
          };
        })
        .filter((x): x is { time: Time; value: number; color: string } => x !== null);
      histSeries.setData(histData);

      const macdLineSeries = oscChart.addSeries(LineSeries, {
        color: '#38BDF8',
        lineWidth: 1,
        title: 'MACD',
      });
      macdLineSeries.setData(mapLine(data.series.macd.macdLine));

      const sigLineSeries = oscChart.addSeries(LineSeries, {
        color: '#F59E0B',
        lineWidth: 1,
        title: 'Sinal',
      });
      sigLineSeries.setData(mapLine(data.series.macd.signalLine));
    }

    oscChart.timeScale().fitContent();

    const handleResize = () => {
      if (mainContainerRef.current && mainChartRef.current) {
        mainChartRef.current.applyOptions({ width: mainContainerRef.current.clientWidth });
      }
      if (oscContainerRef.current && oscChartRef.current) {
        oscChartRef.current.applyOptions({ width: oscContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      mainChart.remove();
      oscChart.remove();
    };
  }, [data, selectedInstrument, showEma, showBollinger, showVwap, oscillatorTab, activeSignals]);

  const snap = data?.snapshot;
  const spec = INSTRUMENTS[selectedInstrument];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-[#111827] border border-slate-800 rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-2">
          {INSTRUMENT_LIST.map((inst) => (
            <button
              key={inst}
              type="button"
              onClick={() => onSelectInstrument(inst)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                selectedInstrument === inst
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {inst}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={`px-3 py-1.5 text-xs font-mono-num font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                timeframe === tf
                  ? 'bg-slate-100 text-slate-900'
                  : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowEma((v) => !v)}
            className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap shrink-0 ${
              showEma
                ? 'border-sky-500/60 bg-sky-500/10 text-sky-300'
                : 'border-slate-700 text-slate-400'
            }`}
          >
            EMA 9/21/50
          </button>
          <button
            type="button"
            onClick={() => setShowBollinger((v) => !v)}
            className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap shrink-0 ${
              showBollinger
                ? 'border-slate-500 bg-slate-800 text-slate-200'
                : 'border-slate-700 text-slate-400'
            }`}
          >
            Bollinger
          </button>
          <button
            type="button"
            onClick={() => setShowVwap((v) => !v)}
            className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap shrink-0 ${
              showVwap
                ? 'border-pink-500/60 bg-pink-500/10 text-pink-300'
                : 'border-slate-700 text-slate-400'
            }`}
          >
            VWAP
          </button>
        </div>
      </div>

      {errorMsg ? (
        <div className="bg-[#111827] border border-red-900/60 rounded-lg p-10 text-center space-y-2">
          <p className="text-base font-semibold text-red-400">{errorMsg}</p>
          <p className="text-xs text-slate-400">
            Geração de sinais suspensa até restabelecimento de velas OHLC reais válidas.
          </p>
        </div>
      ) : (
        <div className="bg-[#111827] border border-slate-800 rounded-lg overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-b border-slate-800 text-xs text-slate-400">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-semibold text-slate-100">{spec.label}</span>
              <span aria-hidden="true">·</span>
              <span>Timeframe {timeframe} (UTC)</span>
              {data?.quote && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-num text-slate-200">
                    Bid {data.quote.bid.toFixed(spec.priceDecimals)} / Ask{' '}
                    {data.quote.ask.toFixed(spec.priceDecimals)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-num">
                    Spread {data.quote.spreadPips.toFixed(2)} {spec.unitLabel}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span>{data?.source || (loading ? 'A carregar velas reais...' : '')}</span>
              {data && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    Volume VWAP:{' '}
                    {data.volumeType === 'NO_VOLUME_DATA'
                      ? 'Indisponível no feed'
                      : data.volumeType === 'FUTURES_VOLUME'
                      ? 'Volume Futuros (GC=F)'
                      : 'Tick Volume'}
                  </span>
                </>
              )}
            </div>
          </div>

          <div ref={mainContainerRef} className="w-full min-h-[400px]" />

          <div className="flex items-center justify-between px-4 py-2 border-t border-b border-slate-800 bg-[#0D131F]">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOscillatorTab('RSI')}
                className={`px-2.5 py-1 text-xs font-medium rounded ${
                  oscillatorTab === 'RSI'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                RSI (14)
              </button>
              <button
                type="button"
                onClick={() => setOscillatorTab('MACD')}
                className={`px-2.5 py-1 text-xs font-medium rounded ${
                  oscillatorTab === 'MACD'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                MACD (12, 26, 9)
              </button>
            </div>
            {snap && (
              <div className="flex flex-wrap items-center gap-4 text-xs font-mono-num text-slate-300">
                <span>RSI: {snap.rsi14.toFixed(1)}</span>
                <span>ADX: {snap.adx14.toFixed(1)}</span>
                <span>ATR: {snap.atr14.toFixed(spec.priceDecimals)}</span>
                <span>
                  Padrão: {snap.candlePatterns.join(', ') || 'Sem padrão'}
                </span>
              </div>
            )}
          </div>

          <div ref={oscContainerRef} className="w-full min-h-[150px]" />
        </div>
      )}
    </div>
  );
};
