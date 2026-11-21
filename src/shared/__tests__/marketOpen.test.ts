import { describe, expect, it, vi } from 'vitest';
import { PushNotificationService } from '../../../server/notifications/pushService';
import { MarketDataService } from '../../../server/providers/marketDataProvider';
import { MarketMonitorService } from '../../../server/scheduler/monitorService';
import {
  getMarketOpenScheduleStatus,
  getNextForexOpenUtc,
  getNextGoldOpenUtc,
  isForexMarketOpenUtc,
  isGoldMarketOpenUtc,
  isInstrumentMarketOpen,
} from '../marketHours';
import { INSTRUMENT_LIST, InstrumentId, Quote } from '../types';

function makeQuote(instrument: InstrumentId, marketOpen: boolean): Quote {
  return {
    instrument,
    bid: instrument === 'XAU/USD' ? 2650 : 1.05,
    ask: instrument === 'XAU/USD' ? 2650.4 : 1.0501,
    mid: instrument === 'XAU/USD' ? 2650.2 : 1.05005,
    spread: instrument === 'XAU/USD' ? 0.4 : 0.0001,
    spreadPips: instrument === 'XAU/USD' ? 0.4 : 1.0,
    changePct: 0.1,
    timestampUtc: new Date().toISOString(),
    ageMs: 500,
    source: 'Test',
    marketOpen,
  };
}

describe('Market Open Auto-Analysis Schedule & Transition Trigger', () => {
  it('handles Forex and XAU/USD open/close UTC schedules and live-tick DST overrides', () => {
    const saturday = new Date('2026-11-21T16:00:00.000Z');
    expect(isForexMarketOpenUtc(saturday)).toBe(false);
    expect(isGoldMarketOpenUtc(saturday)).toBe(false);
    expect(isInstrumentMarketOpen('EUR/USD', 100, saturday)).toBe(false);

    // Sunday 21:15 UTC: scheduled FX closed, but fresh live tick (DST) marks FX open
    const sunDst = new Date('2026-11-22T21:15:00.000Z');
    expect(isForexMarketOpenUtc(sunDst)).toBe(false);
    expect(isInstrumentMarketOpen('EUR/USD', 15_000, sunDst)).toBe(true);
    expect(isInstrumentMarketOpen('EUR/USD', 500_000, sunDst)).toBe(false);

    // Sunday 22:05 UTC: FX open, Gold still closed until 23:00 UTC unless live tick arrives
    const sun2205 = new Date('2026-11-22T22:05:00.000Z');
    expect(isForexMarketOpenUtc(sun2205)).toBe(true);
    expect(isGoldMarketOpenUtc(sun2205)).toBe(false);
    expect(getNextForexOpenUtc(saturday).toISOString()).toBe('2026-11-22T22:00:00.000Z');
    expect(getNextGoldOpenUtc(saturday).toISOString()).toBe('2026-11-22T23:00:00.000Z');

    // Pre-open & post-open windows
    const preOpen = getMarketOpenScheduleStatus(new Date('2026-11-22T21:55:00.000Z'));
    expect(preOpen.isWithinPreOpenWindow).toBe(true);
    expect(preOpen.msUntilForexOpen).toBe(5 * 60_000);

    const postOpen = getMarketOpenScheduleStatus(new Date('2026-11-22T22:02:00.000Z'));
    expect(postOpen.isForexOpen).toBe(true);
    expect(postOpen.isWithinPostOpenLaunchWindow).toBe(true);
  });

  it('triggers immediate forceFresh analysis across all instruments when marketOpen transitions false -> true', async () => {
    const marketData = new MarketDataService();
    const pushService = new PushNotificationService();
    const monitor = new MarketMonitorService(marketData, pushService);

    let currentlyOpen = false;
    vi.spyOn(marketData, 'getAllQuotes').mockImplementation(async () => {
      return Object.fromEntries(
        INSTRUMENT_LIST.map((inst) => [inst, makeQuote(inst, currentlyOpen)])
      ) as Record<InstrumentId, Quote>;
    });

    const invalidateSpy = vi.spyOn(marketData, 'invalidateInstrumentCache');
    const runCycleSpy = vi
      .spyOn(monitor, 'runFullAnalysisCycle')
      .mockResolvedValue(undefined);

    // First poll while closed -> seeds state, does NOT trigger open rescan
    await monitor.refreshQuotesAndPositions();
    expect(runCycleSpy).not.toHaveBeenCalled();

    // Market opens -> next quote poll immediately invalidates caches & runs forceFresh cycle
    currentlyOpen = true;
    await monitor.refreshQuotesAndPositions();

    expect(invalidateSpy).toHaveBeenCalledTimes(INSTRUMENT_LIST.length);
    expect(runCycleSpy).toHaveBeenCalledTimes(1);
    expect(runCycleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        forceFresh: true,
        reason: expect.stringContaining('LIVE_OPEN_TRANSITION'),
      })
    );

    monitor.stop();
  });
});
