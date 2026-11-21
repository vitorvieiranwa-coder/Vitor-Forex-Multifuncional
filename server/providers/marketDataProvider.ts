import {
  Candle,
  INSTRUMENTS,
  InstrumentId,
  INSTRUMENT_LIST,
  Quote,
  Timeframe,
  VolumeNature,
} from '../../src/shared/types';

export interface CandleFetchResult {
  instrument: InstrumentId;
  timeframe: Timeframe;
  candles: Candle[];
  volumeType: VolumeNature;
  source: string;
  fetchedAtUtc: string;
}

export interface MarketProviderHealth {
  providerName: string;
  hasTwelveDataKey: boolean;
  feedStatus: 'CONNECTED' | 'DEGRADED' | 'NO_DATA';
  message: string;
  lastSuccessUtc: string | null;
  lastError: string | null;
  consecutiveErrors: number;
}

const SWISSQUOTE_PATH: Record<InstrumentId, string> = {
  'EUR/USD': 'EUR/USD',
  'GBP/USD': 'GBP/USD',
  'EUR/JPY': 'EUR/JPY',
  'GBP/JPY': 'GBP/JPY',
  'XAU/USD': 'XAU/USD',
};

const YAHOO_SYMBOL: Record<InstrumentId, string> = {
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'EUR/JPY': 'EURJPY=X',
  'GBP/JPY': 'GBPJPY=X',
  'XAU/USD': 'GC=F',
};

const YAHOO_INTERVAL: Record<Timeframe, { interval: string; range: string }> = {
  M1: { interval: '1m', range: '1d' },
  M5: { interval: '5m', range: '5d' },
  M15: { interval: '15m', range: '5d' },
  H1: { interval: '1h', range: '1mo' },
};

const TWELVE_DATA_INTERVAL: Record<Timeframe, string> = {
  M1: '1min',
  M5: '5min',
  M15: '15min',
  H1: '1h',
};

function isForexWeekendClosedUtc(now = new Date()): boolean {
  const day = now.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
  const hour = now.getUTCHours();
  if (day === 6) return true;
  if (day === 5 && hour >= 22) return true;
  if (day === 0 && hour < 22) return true;
  return false;
}

export class MarketDataService {
  private quoteCache = new Map<InstrumentId, { data: Quote; expiresAt: number }>();
  private candleCache = new Map<string, { data: CandleFetchResult; expiresAt: number }>();
  private lastSuccessUtc: string | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;

  private get twelveDataKey(): string | undefined {
    const k = process.env.TWELVE_DATA_API_KEY?.trim();
    return k && k.length > 5 && k !== 'MY_TWELVE_DATA_KEY' ? k : undefined;
  }

  public getHealth(): MarketProviderHealth {
    const hasKey = Boolean(this.twelveDataKey);
    const providerName = hasKey
      ? 'Twelve Data API + Swissquote BBO'
      : 'Swissquote BBO + Yahoo Finance OHLC';

    let feedStatus: MarketProviderHealth['feedStatus'] = 'CONNECTED';
    let message = 'Ligação ativa a cotações reais de mercado.';

    if (this.consecutiveErrors >= 5 || !this.lastSuccessUtc) {
      feedStatus = this.lastSuccessUtc ? 'DEGRADED' : 'NO_DATA';
      message = this.lastSuccessUtc
        ? `Instabilidade no fornecedor de dados: ${this.lastError || 'falha temporária'}`
        : 'SEM DADOS DE MERCADO';
    } else if (isForexWeekendClosedUtc()) {
      feedStatus = 'CONNECTED';
      message = 'Mercado Forex/Ouro encerrado (Fim de semana UTC) — Últimos preços reais de fecho.';
    }

    return {
      providerName,
      hasTwelveDataKey: hasKey,
      feedStatus,
      message,
      lastSuccessUtc: this.lastSuccessUtc,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  /**
   * Fetches real Bid/Ask/Spread quote via Swissquote BBO feed.
   */
  public async getQuote(instrument: InstrumentId): Promise<Quote | null> {
    const cached = this.quoteCache.get(instrument);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    try {
      const path = SWISSQUOTE_PATH[instrument];
      const url = `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${path}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'ForexIntelligence/1.0' },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) {
        throw new Error(`Swissquote HTTP ${res.status}`);
      }

      const payload = (await res.json()) as Array<{
        ts?: number;
        spreadProfilePrices?: Array<{
          spreadProfile?: string;
          bid?: number;
          ask?: number;
        }>;
      }>;

      const entry = Array.isArray(payload) ? payload[0] : undefined;
      const prices = entry?.spreadProfilePrices || [];
      const bbo =
        prices.find((p) => p.spreadProfile === 'standard') ||
        prices.find((p) => p.spreadProfile === 'premium') ||
        prices[0];

      if (!bbo || typeof bbo.bid !== 'number' || typeof bbo.ask !== 'number' || bbo.bid <= 0) {
        throw new Error(`Invalid BBO quote payload for ${instrument}`);
      }

      const spec = INSTRUMENTS[instrument];
      const bid = bbo.bid;
      const ask = bbo.ask;
      const mid = (bid + ask) / 2;
      const spread = Math.max(0, ask - bid);
      const spreadPips = Number((spread / spec.pipSize).toFixed(2));

      const quoteTs = typeof entry?.ts === 'number' ? entry.ts : Date.now();
      const ageMs = Math.max(0, Date.now() - quoteTs);
      const marketOpen = !isForexWeekendClosedUtc();

      // Compute session changePct from cached H1/M15 open if available
      let changePct = 0;
      const h1Cached = this.candleCache.get(`${instrument}_H1`);
      if (h1Cached && h1Cached.data.candles.length >= 24) {
        const refClose = h1Cached.data.candles[h1Cached.data.candles.length - 24].close;
        if (refClose > 0) {
          changePct = Number((((mid - refClose) / refClose) * 100).toFixed(3));
        }
      }

      const quote: Quote = {
        instrument,
        bid,
        ask,
        mid,
        spread,
        spreadPips,
        changePct,
        timestampUtc: new Date(quoteTs).toISOString(),
        ageMs,
        source: 'Swissquote BBO Real-Time',
        marketOpen,
      };

      this.quoteCache.set(instrument, { data: quote, expiresAt: Date.now() + 10_000 });
      this.lastSuccessUtc = new Date().toISOString();
      this.lastError = null;
      this.consecutiveErrors = 0;
      return quote;
    } catch (err) {
      this.consecutiveErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      return cached ? cached.data : null;
    }
  }

  public async getAllQuotes(): Promise<Record<InstrumentId, Quote | null>> {
    const results = await Promise.all(
      INSTRUMENT_LIST.map(async (inst) => [inst, await this.getQuote(inst)] as const)
    );
    return Object.fromEntries(results) as Record<InstrumentId, Quote | null>;
  }

  /**
   * Fetches real OHLC historical & intraday candles.
   * Uses Twelve Data when TWELVE_DATA_API_KEY is configured, otherwise Yahoo Finance real OHLC.
   */
  public async getCandles(
    instrument: InstrumentId,
    timeframe: Timeframe,
    limit = 240
  ): Promise<CandleFetchResult | null> {
    const cacheKey = `${instrument}_${timeframe}`;
    const ttlMs = timeframe === 'M1' ? 30_000 : timeframe === 'M5' ? 45_000 : 120_000;
    const cached = this.candleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ...cached.data,
        candles: cached.data.candles.slice(-limit),
      };
    }

    let result: CandleFetchResult | null = null;

    if (this.twelveDataKey) {
      result = await this.fetchFromTwelveData(instrument, timeframe, Math.max(limit, 260));
    }

    if (!result) {
      result = await this.fetchFromYahoo(instrument, timeframe);
    }

    if (result && result.candles.length > 0) {
      this.candleCache.set(cacheKey, { data: result, expiresAt: Date.now() + ttlMs });
      this.lastSuccessUtc = new Date().toISOString();
      this.lastError = null;
      this.consecutiveErrors = 0;
      return {
        ...result,
        candles: result.candles.slice(-limit),
      };
    }

    this.consecutiveErrors += 1;
    return cached
      ? { ...cached.data, candles: cached.data.candles.slice(-limit) }
      : null;
  }

  private async fetchFromTwelveData(
    instrument: InstrumentId,
    timeframe: Timeframe,
    outputsize: number
  ): Promise<CandleFetchResult | null> {
    try {
      const apiKey = this.twelveDataKey;
      if (!apiKey) return null;

      const tdInterval = TWELVE_DATA_INTERVAL[timeframe];
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
        instrument
      )}&interval=${tdInterval}&outputsize=${outputsize}&timezone=UTC&apikey=${encodeURIComponent(
        apiKey
      )}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);

      const json = (await res.json()) as {
        status?: string;
        message?: string;
        values?: Array<{
          datetime: string;
          open: string;
          high: string;
          low: string;
          close: string;
          volume?: string;
        }>;
      };

      if (json.status === 'error' || !Array.isArray(json.values) || json.values.length === 0) {
        throw new Error(json.message || 'Twelve Data empty response');
      }

      const candles: Candle[] = json.values
        .map((v) => {
          const ts = Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000);
          return {
            time: ts,
            open: Number(v.open),
            high: Number(v.high),
            low: Number(v.low),
            close: Number(v.close),
            volume: v.volume ? Number(v.volume) : 0,
          };
        })
        .filter(
          (c) =>
            Number.isFinite(c.time) &&
            c.time > 0 &&
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close) &&
            c.close > 0
        )
        .sort((a, b) => a.time - b.time);

      if (candles.length === 0) return null;
      const hasVol = candles.some((c) => c.volume > 0);

      return {
        instrument,
        timeframe,
        candles,
        volumeType: hasVol ? 'TICK_VOLUME' : 'NO_VOLUME_DATA',
        source: 'Twelve Data Live API (UTC)',
        fetchedAtUtc: new Date().toISOString(),
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  private async fetchFromYahoo(
    instrument: InstrumentId,
    timeframe: Timeframe
  ): Promise<CandleFetchResult | null> {
    try {
      const symbol = YAHOO_SYMBOL[instrument];
      const cfg = YAHOO_INTERVAL[timeframe];
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        symbol
      )}?interval=${cfg.interval}&range=${cfg.range}`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);

      const json = (await res.json()) as {
        chart?: {
          error?: { description?: string };
          result?: Array<{
            timestamp?: number[];
            indicators?: {
              quote?: Array<{
                open?: (number | null)[];
                high?: (number | null)[];
                low?: (number | null)[];
                close?: (number | null)[];
                volume?: (number | null)[];
              }>;
            };
          }>;
        };
      };

      const result = json.chart?.result?.[0];
      const timestamps = result?.timestamp || [];
      const q = result?.indicators?.quote?.[0];
      if (!q || timestamps.length === 0) {
        throw new Error(json.chart?.error?.description || `No OHLC for ${symbol}`);
      }

      const candles: Candle[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const time = timestamps[i];
        const open = q.open?.[i];
        const high = q.high?.[i];
        const low = q.low?.[i];
        const close = q.close?.[i];
        const volume = q.volume?.[i] ?? 0;

        if (
          typeof time === 'number' &&
          typeof open === 'number' &&
          typeof high === 'number' &&
          typeof low === 'number' &&
          typeof close === 'number' &&
          Number.isFinite(open) &&
          Number.isFinite(high) &&
          Number.isFinite(low) &&
          Number.isFinite(close) &&
          close > 0
        ) {
          candles.push({
            time,
            open,
            high,
            low,
            close,
            volume: typeof volume === 'number' && Number.isFinite(volume) ? volume : 0,
          });
        }
      }

      if (candles.length === 0) return null;

      // Deduplicate timestamps if any
      const dedup = new Map<number, Candle>();
      for (const c of candles) dedup.set(c.time, c);
      const sorted = Array.from(dedup.values()).sort((a, b) => a.time - b.time);

      const hasVol = sorted.some((c) => c.volume > 0);
      const volumeType: VolumeNature = !hasVol
        ? 'NO_VOLUME_DATA'
        : instrument === 'XAU/USD'
        ? 'FUTURES_VOLUME'
        : 'TICK_VOLUME';

      return {
        instrument,
        timeframe,
        candles: sorted,
        volumeType,
        source:
          instrument === 'XAU/USD'
            ? 'Yahoo Finance (GC=F Real OHLC) + Swissquote BBO'
            : 'Yahoo Finance Real OHLC (UTC)',
        fetchedAtUtc: new Date().toISOString(),
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }
}
