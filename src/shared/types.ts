export type InstrumentId = 'EUR/USD' | 'GBP/USD' | 'EUR/JPY' | 'GBP/JPY' | 'XAU/USD';

export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1';

export type SignalDirection = 'BUY' | 'SELL';

export type StrategyType = 'SCALPING' | 'INTRADAY';

export type ExecutionType = 'IMMEDIATE' | 'CONDITIONAL';

export type SignalStatus =
  | 'EMITIDO'
  | 'AGUARDAR_ENTRADA'
  | 'POSICAO_ABERTA'
  | 'TP_ATINGIDO'
  | 'SL_ATINGIDO'
  | 'ENCERRADO_MANUALMENTE'
  | 'ENCERRAMENTO_RECOMENDADO'
  | 'INVALIDADO'
  | 'EXPIRADO';

export type SignalSourceType = 'LIVE_SIGNAL' | 'DEMO_SIGNAL' | 'BACKTEST_HISTORICAL';

export type ScoreClassification =
  | 'SINAL_FORTE'
  | 'SINAL_FAVORAVEL'
  | 'EM_OBSERVACAO'
  | 'SEM_ENTRADA';

export type VolumeNature = 'TICK_VOLUME' | 'FUTURES_VOLUME' | 'NO_VOLUME_DATA';

export interface InstrumentSpec {
  id: InstrumentId;
  label: string;
  pipSize: number;
  priceDecimals: number;
  isMetal: boolean;
  /** Approximate USD value per 1.0 pip (or $1.00 move for XAU/USD) per 1.00 standard lot */
  pipValuePerStandardLot: number;
  maxAcceptableSpreadPips: number;
  unitLabel: 'pips' | 'USD';
}

export const INSTRUMENTS: Record<InstrumentId, InstrumentSpec> = {
  'EUR/USD': {
    id: 'EUR/USD',
    label: 'EUR/USD',
    pipSize: 0.0001,
    priceDecimals: 5,
    isMetal: false,
    pipValuePerStandardLot: 10,
    maxAcceptableSpreadPips: 2.5,
    unitLabel: 'pips',
  },
  'GBP/USD': {
    id: 'GBP/USD',
    label: 'GBP/USD',
    pipSize: 0.0001,
    priceDecimals: 5,
    isMetal: false,
    pipValuePerStandardLot: 10,
    maxAcceptableSpreadPips: 3.0,
    unitLabel: 'pips',
  },
  'EUR/JPY': {
    id: 'EUR/JPY',
    label: 'EUR/JPY',
    pipSize: 0.01,
    priceDecimals: 3,
    isMetal: false,
    pipValuePerStandardLot: 6.5,
    maxAcceptableSpreadPips: 3.2,
    unitLabel: 'pips',
  },
  'GBP/JPY': {
    id: 'GBP/JPY',
    label: 'GBP/JPY',
    pipSize: 0.01,
    priceDecimals: 3,
    isMetal: false,
    pipValuePerStandardLot: 6.5,
    maxAcceptableSpreadPips: 4.0,
    unitLabel: 'pips',
  },
  'XAU/USD': {
    id: 'XAU/USD',
    label: 'XAU/USD — Ouro',
    pipSize: 1.0,
    priceDecimals: 2,
    isMetal: true,
    pipValuePerStandardLot: 100, // 100 oz * $1.00 move = $100
    maxAcceptableSpreadPips: 1.5, // $1.50 spread
    unitLabel: 'USD',
  },
};

export const INSTRUMENT_LIST: InstrumentId[] = [
  'EUR/USD',
  'GBP/USD',
  'EUR/JPY',
  'GBP/JPY',
  'XAU/USD',
];

export interface Candle {
  time: number; // UTC unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  instrument: InstrumentId;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  spreadPips: number;
  changePct: number;
  timestampUtc: string;
  ageMs: number;
  source: string;
  marketOpen: boolean;
}

export type BreakoutStatus =
  | 'BULLISH_BREAKOUT'
  | 'BEARISH_BREAKOUT'
  | 'FALSE_BULL_BREAKOUT'
  | 'FALSE_BEAR_BREAKOUT'
  | 'NONE';

export type IndicatorDirection = 'SUBIDA' | 'DESCIDA' | 'NEUTRO';

export type TradingSessionQuality =
  | 'LONDON_NY_OVERLAP'
  | 'LONDON_SESSION'
  | 'NY_SESSION'
  | 'TOKYO_SESSION'
  | 'ROLLOVER_DEAD_ZONE';

export interface IndicatorSnapshot {
  candleTime: number;
  close: number;
  ema9: number;
  ema21: number;
  ema50: number;
  ema21SlopePct: number;
  atrStretchRatio: number;
  rsi14: number;
  macd: {
    macdLine: number;
    signalLine: number;
    histogram: number;
  };
  adx14: number;
  plusDI: number;
  minusDI: number;
  atr14: number;
  bollinger: {
    upper: number;
    middle: number;
    lower: number;
    bandwidth: number;
  };
  vwap: {
    value: number | null;
    volumeType: VolumeNature;
  };
  supports: number[];
  resistances: number[];
  prevHigh: number;
  prevLow: number;
  breakout: BreakoutStatus;
  candlePatterns: string[];
  priceActionBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trendDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  indicatorDirections: {
    rsi: IndicatorDirection;
    macd: IndicatorDirection;
    adx: IndicatorDirection;
    atr: IndicatorDirection;
  };
}

export interface ScoreBreakdown {
  h1Trend: number; // 0..20
  m15Structure: number; // 0..20
  m5Confirmation: number; // 0..20
  rsiMacd: number; // 0..15
  adxAtr: number; // 0..10
  priceAction: number; // 0..10
  spreadExecution: number; // 0..5
  total: number; // 0..100
  classification: ScoreClassification;
}

export interface StrategyCandidate {
  instrument: InstrumentId;
  strategy: StrategyType;
  timeframe: Timeframe;
  direction: SignalDirection | null;
  score: ScoreBreakdown;
  actionable: boolean;
  executionType: ExecutionType;
  entryExecutable: boolean;
  recommendedEntry: number;
  takeProfit: number;
  stopLoss: number;
  riskReward: number;
  observedSpread: number;
  indicatorsJustification: string[];
  rationale: string;
  opportunityKey: string;
  evaluatedAtUtc: string;
  candleTime: number;
  intradayContext: {
    sessionQuality: TradingSessionQuality;
    sessionLabel: string;
    entryQuality: 'PULLBACK_OTIMO' | 'ROMPIMENTO_LIMPO' | 'ESTICADO';
    structuralClearanceOk: boolean;
    nearestObstacleDistance: number | null;
    antiChopOk: boolean;
  };
}

export interface UserSettings {
  userId: string;
  riskPercentPerTrade: number;
  referenceCapital: number;
  dailyLossLimitPercent: number;
  maxOpenPositions: number;
  maxConsecutiveLosses: number;
  autoPauseOnLimit: boolean;
  scalpingTargetPips: number;
  intradayTargetPips: number;
  xauScalpingDistance: number;
  xauIntradayDistance: number;
  minRiskReward: number;
  pushEnabled: boolean;
  alertEurUsd: boolean;
  alertGbpUsd: boolean;
  alertEurJpy: boolean;
  alertGbpJpy: boolean;
  alertXauUsd: boolean;
  updatedAt?: unknown;
}

export const DEFAULT_USER_SETTINGS: Omit<UserSettings, 'userId'> = {
  riskPercentPerTrade: 0.25,
  referenceCapital: 10000,
  dailyLossLimitPercent: 1.0,
  maxOpenPositions: 3,
  maxConsecutiveLosses: 2,
  autoPauseOnLimit: true,
  scalpingTargetPips: 10,
  intradayTargetPips: 20,
  xauScalpingDistance: 3.5,
  xauIntradayDistance: 7.0,
  minRiskReward: 1.5,
  pushEnabled: false,
  alertEurUsd: true,
  alertGbpUsd: true,
  alertEurJpy: true,
  alertGbpJpy: true,
  alertXauUsd: true,
};

export interface TradingSignalRecord {
  id: string;
  userId: string;
  instrument: InstrumentId;
  direction: SignalDirection;
  strategy: StrategyType;
  timeframe: Timeframe;
  executionType: ExecutionType;
  status: SignalStatus;
  score: number;
  recommendedEntry: number;
  actualEntry?: number;
  takeProfit: number;
  stopLoss: number;
  observedSpread: number;
  lots?: number;
  indicatorsSummary: string;
  rationale: string;
  sourceType: SignalSourceType;
  closeReason?: string;
  resultR?: number;
  resultMonetary?: number;
  reversalAlertIssued: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
  closedAt?: unknown;
}

export interface SignalEventRecord {
  id: string;
  signalId: string;
  userId: string;
  eventType: string;
  message: string;
  priceAtEvent?: number;
  createdAt?: unknown;
}

export interface UserNotificationRecord {
  id: string;
  userId: string;
  signalId?: string;
  instrument: InstrumentId;
  category: 'NEW_BUY' | 'NEW_SELL' | 'TP_HIT' | 'SL_HIT' | 'REVERSAL_EXIT' | 'INVALIDATED';
  title: string;
  body: string;
  read: boolean;
  createdAt?: unknown;
}

export interface ReversalAnalysis {
  shouldRecommendExit: boolean;
  triggeredCount: number;
  reasons: string[];
  alertTitle: string | null;
}

export interface MarketInstrumentOverview {
  instrument: InstrumentId;
  feedStatus: 'CONNECTED' | 'DEGRADED' | 'NO_DATA';
  feedMessage: string;
  quote: Quote | null;
  timeframes: {
    H1: IndicatorSnapshot | null;
    M15: IndicatorSnapshot | null;
    M5: IndicatorSnapshot | null;
    M1: IndicatorSnapshot | null;
  };
  scalping: StrategyCandidate | null;
  intraday: StrategyCandidate | null;
  bestScore: number;
  classification: ScoreClassification;
}

export interface BacktestConfig {
  instrument: InstrumentId;
  strategy: StrategyType;
  timeframe: 'M5' | 'M15';
  spreadPips: number;
  slippagePips: number;
  commissionPerLotUsd: number;
  riskPercentPerTrade: number;
  initialCapital: number;
  scalpingTargetPips: number;
  intradayTargetPips: number;
  xauScalpingDistance: number;
  xauIntradayDistance: number;
  minRiskReward: number;
  useBreakEvenAt1R?: boolean;
}

export interface BacktestTrade {
  id: string;
  entryTimeUtc: string;
  exitTimeUtc: string;
  direction: SignalDirection;
  entryPrice: number;
  exitPrice: number;
  takeProfit: number;
  stopLoss: number;
  score: number;
  outcome: 'TP' | 'SL' | 'REVERSAL_EXIT' | 'END_OF_DATA';
  resultR: number;
  netMonetary: number;
  hourUtc: number;
}

export interface BacktestResult {
  instrument: InstrumentId;
  strategy: StrategyType;
  timeframe: Timeframe;
  sourceLabel: string;
  candlesAnalyzed: number;
  dateRangeUtc: { start: string; end: string };
  totalSignals: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netR: number;
  netMonetary: number;
  maxDrawdownR: number;
  maxDrawdownPct: number;
  reversalExits: number;
  buyStats: { count: number; winRatePct: number; netR: number };
  sellStats: { count: number; winRatePct: number; netR: number };
  byHourUtc: { hour: number; count: number; netR: number }[];
  trades: BacktestTrade[];
}

export function isTerminalStatus(status: SignalStatus): boolean {
  return (
    status === 'TP_ATINGIDO' ||
    status === 'SL_ATINGIDO' ||
    status === 'ENCERRADO_MANUALMENTE' ||
    status === 'INVALIDADO' ||
    status === 'EXPIRADO'
  );
}

export function formatPrice(instrument: InstrumentId, value: number): string {
  const decimals = INSTRUMENTS[instrument].priceDecimals;
  return value.toFixed(decimals);
}

export function toPipsOrPoints(instrument: InstrumentId, priceDiff: number): number {
  const spec = INSTRUMENTS[instrument];
  return priceDiff / spec.pipSize;
}

export function fromPipsOrPoints(instrument: InstrumentId, pipsOrPoints: number): number {
  const spec = INSTRUMENTS[instrument];
  return pipsOrPoints * spec.pipSize;
}
