import { InstrumentId } from './types';

export interface MarketScheduleStatus {
  nowUtc: string;
  isForexOpen: boolean;
  isGoldOpen: boolean;
  isAnyOpen: boolean;
  isWithinPreOpenWindow: boolean;
  isWithinPostOpenLaunchWindow: boolean;
  nextForexOpenUtc: string;
  nextGoldOpenUtc: string;
  msUntilForexOpen: number;
  msUntilGoldOpen: number;
  msUntilNextOpen: number;
  countdownLabel: string;
  statusText: string;
}

/**
 * Standard FX market hours (UTC):
 * Closed from Friday 22:00 UTC until Sunday 22:00 UTC.
 */
export function isForexMarketOpenUtc(now = new Date()): boolean {
  const day = now.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 0 && hour < 22) return false;
  return true;
}

/**
 * Gold (XAU/USD / COMEX GC=F) market hours (UTC):
 * Closed Friday 22:00 UTC until Sunday 23:00 UTC,
 * plus daily COMEX maintenance break 22:00-22:59 UTC (Mon-Thu).
 */
export function isGoldMarketOpenUtc(now = new Date()): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 0 && hour < 23) return false;
  if (day >= 1 && day <= 4 && hour === 22) return false;
  return true;
}

/**
 * Determines if an instrument market is open, combining scheduled UTC hours
 * with live-tick detection (handles US/EU DST shifts automatically when fresh
 * real-time BBO quotes arrive within 90 seconds).
 */
export function isInstrumentMarketOpen(
  instrument: InstrumentId,
  quoteAgeMs?: number | null,
  now = new Date()
): boolean {
  const scheduledOpen =
    instrument === 'XAU/USD' ? isGoldMarketOpenUtc(now) : isForexMarketOpenUtc(now);

  if (scheduledOpen) return true;

  // Live-tick override around DST transitions (e.g. Sunday 21:00 UTC summer open)
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const hasFreshLiveTick =
    typeof quoteAgeMs === 'number' && Number.isFinite(quoteAgeMs) && quoteAgeMs >= 0 && quoteAgeMs <= 90_000;

  if (!hasFreshLiveTick) return false;
  if (day === 6) return false;
  if (day === 0 && hour >= 20) return true;
  if (instrument === 'XAU/USD' && day >= 1 && day <= 4 && hour === 22) return true;

  return false;
}

/**
 * Computes the next scheduled Forex market open (Sunday 22:00:00 UTC).
 * Returns `now` if Forex is currently open.
 */
export function getNextForexOpenUtc(now = new Date()): Date {
  if (isForexMarketOpenUtc(now)) {
    return new Date(now.getTime());
  }

  const candidate = new Date(now.getTime());
  const day = candidate.getUTCDay(); // 5=Fri, 6=Sat, 0=Sun
  const daysUntilSunday = (7 - day) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilSunday);
  candidate.setUTCHours(22, 0, 0, 0);

  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return candidate;
}

/**
 * Computes the next scheduled XAU/USD (Gold) market open (23:00:00 UTC).
 * Returns `now` if Gold is currently open.
 */
export function getNextGoldOpenUtc(now = new Date()): Date {
  if (isGoldMarketOpenUtc(now)) {
    return new Date(now.getTime());
  }

  const candidate = new Date(now.getTime());
  const day = candidate.getUTCDay();
  if (day >= 1 && day <= 4 && candidate.getUTCHours() === 22) {
    candidate.setUTCHours(23, 0, 0, 0);
    return candidate;
  }

  const daysUntilSunday = (7 - day) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilSunday);
  candidate.setUTCHours(23, 0, 0, 0);

  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return candidate;
}

export function formatCountdownMs(ms: number): string {
  if (ms <= 0) return '00h 00m 00s';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) {
    return `${days}d ${pad(hours)}h ${pad(mins)}m ${pad(secs)}s`;
  }
  return `${pad(hours)}h ${pad(mins)}m ${pad(secs)}s`;
}

export function getMarketOpenScheduleStatus(now = new Date()): MarketScheduleStatus {
  const isForexOpen = isForexMarketOpenUtc(now);
  const isGoldOpen = isGoldMarketOpenUtc(now);
  const nextForexOpen = getNextForexOpenUtc(now);
  const nextGoldOpen = getNextGoldOpenUtc(now);
  const msUntilForexOpen = Math.max(0, nextForexOpen.getTime() - now.getTime());
  const msUntilGoldOpen = Math.max(0, nextGoldOpen.getTime() - now.getTime());
  const msUntilNextOpen = !isForexOpen
    ? msUntilForexOpen
    : !isGoldOpen
    ? msUntilGoldOpen
    : 0;

  // Pre-open window: up to 15 minutes before Forex or Gold opens
  const isWithinPreOpenWindow =
    (!isForexOpen && msUntilForexOpen <= 15 * 60_000) ||
    (!isGoldOpen && msUntilGoldOpen <= 15 * 60_000);

  // Post-open launch window: first 10 minutes after Sunday 22:00 UTC or 23:00 UTC open
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const mins = now.getUTCMinutes();
  const isWithinPostOpenLaunchWindow =
    (day === 0 && (hour === 22 || hour === 23) && mins < 10) ||
    (day >= 1 && day <= 4 && hour === 23 && mins < 10);

  let statusText = 'Mercados Forex e Ouro abertos — monitorização contínua ativa.';
  if (!isForexOpen && !isGoldOpen) {
    statusText = `Abertura automática armada: Forex em ${formatCountdownMs(
      msUntilForexOpen
    )} (Dom 22:00 UTC) · Ouro XAU/USD Dom 23:00 UTC.`;
  } else if (isForexOpen && !isGoldOpen) {
    statusText = `Forex ativo · Ouro XAU/USD abre em ${formatCountdownMs(msUntilGoldOpen)} (23:00 UTC).`;
  }

  return {
    nowUtc: now.toISOString(),
    isForexOpen,
    isGoldOpen,
    isAnyOpen: isForexOpen || isGoldOpen,
    isWithinPreOpenWindow,
    isWithinPostOpenLaunchWindow,
    nextForexOpenUtc: nextForexOpen.toISOString(),
    nextGoldOpenUtc: nextGoldOpen.toISOString(),
    msUntilForexOpen,
    msUntilGoldOpen,
    msUntilNextOpen,
    countdownLabel: formatCountdownMs(msUntilNextOpen),
    statusText,
  };
}
