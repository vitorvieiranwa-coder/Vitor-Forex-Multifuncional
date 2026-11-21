import { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { OperationType, db, handleFirestoreError } from '../firebase';
import { HistoricalReplaySignal } from '../shared/dayReplay';
import {
  DEFAULT_USER_SETTINGS,
  SignalEventRecord,
  SignalStatus,
  TradingSignalRecord,
  UserNotificationRecord,
  UserSettings,
  isTerminalStatus,
} from '../shared/types';

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 120);
}

export async function ensureUserProfile(user: User): Promise<void> {
  const path = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        email: (user.email || 'trader@forex-intelligence.local').slice(0, 254),
        displayName: (user.displayName || user.email?.split('@')[0] || 'Trader').slice(0, 120),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeToSettings(
  userId: string,
  onData: (settings: UserSettings) => void
): () => void {
  const path = `users/${userId}/settings/config`;
  const ref = doc(db, 'users', userId, 'settings', 'config');

  return onSnapshot(
    ref,
    async (snap) => {
      if (!snap.exists()) {
        const initial: UserSettings = {
          userId,
          ...DEFAULT_USER_SETTINGS,
        };
        try {
          await setDoc(ref, {
            ...initial,
            updatedAt: serverTimestamp(),
          });
          onData(initial);
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, path);
        }
      } else {
        onData(snap.data() as UserSettings);
      }
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export async function saveUserSettings(
  userId: string,
  settings: UserSettings
): Promise<void> {
  const path = `users/${userId}/settings/config`;
  const ref = doc(db, 'users', userId, 'settings', 'config');
  try {
    const payload = {
      userId,
      riskPercentPerTrade: Number(settings.riskPercentPerTrade),
      referenceCapital: Number(settings.referenceCapital),
      dailyLossLimitPercent: Number(settings.dailyLossLimitPercent),
      maxOpenPositions: Number(settings.maxOpenPositions),
      maxConsecutiveLosses: Number(settings.maxConsecutiveLosses),
      autoPauseOnLimit: Boolean(settings.autoPauseOnLimit),
      scalpingTargetPips: Number(settings.scalpingTargetPips),
      intradayTargetPips: Number(settings.intradayTargetPips),
      xauScalpingDistance: Number(settings.xauScalpingDistance),
      xauIntradayDistance: Number(settings.xauIntradayDistance),
      minRiskReward: Number(settings.minRiskReward),
      pushEnabled: Boolean(settings.pushEnabled),
      alertEurUsd: Boolean(settings.alertEurUsd),
      alertGbpUsd: Boolean(settings.alertGbpUsd),
      alertEurJpy: Boolean(settings.alertEurJpy),
      alertGbpJpy: Boolean(settings.alertGbpJpy),
      alertXauUsd: Boolean(settings.alertXauUsd),
      updatedAt: serverTimestamp(),
    };
    const existing = await getDoc(ref);
    if (existing.exists()) {
      await updateDoc(ref, payload);
    } else {
      await setDoc(ref, payload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeToSignals(
  userId: string,
  onData: (signals: TradingSignalRecord[]) => void
): () => void {
  const path = `users/${userId}/signals`;
  const q = query(collection(db, 'users', userId, 'signals'), orderBy('createdAt', 'desc'));

  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => d.data() as TradingSignalRecord);
      onData(items);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function createTradingSignal(
  userId: string,
  signal: Omit<TradingSignalRecord, 'userId' | 'createdAt' | 'updatedAt'>,
  initialEventMessage: string
): Promise<void> {
  const signalId = sanitizeId(signal.id);
  const sigPath = `users/${userId}/signals/${signalId}`;
  const sigRef = doc(db, 'users', userId, 'signals', signalId);

  try {
    const existing = await getDoc(sigRef);
    if (existing.exists()) {
      return; // Deduplication guard
    }

    const payload: Record<string, unknown> = {
      id: signalId,
      userId,
      instrument: signal.instrument,
      direction: signal.direction,
      strategy: signal.strategy,
      timeframe: signal.timeframe,
      executionType: signal.executionType,
      status: signal.status,
      score: Number(signal.score),
      recommendedEntry: Number(signal.recommendedEntry),
      takeProfit: Number(signal.takeProfit),
      stopLoss: Number(signal.stopLoss),
      observedSpread: Number(signal.observedSpread),
      indicatorsSummary: signal.indicatorsSummary.slice(0, 1200),
      rationale: signal.rationale.slice(0, 2000),
      sourceType: signal.sourceType,
      reversalAlertIssued: Boolean(signal.reversalAlertIssued),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (typeof signal.actualEntry === 'number' && signal.actualEntry > 0) {
      payload.actualEntry = signal.actualEntry;
    }
    if (typeof signal.lots === 'number' && signal.lots > 0) {
      payload.lots = signal.lots;
    }

    await setDoc(sigRef, payload);

    await addSignalEvent(
      userId,
      signalId,
      'SINAL_EMITIDO',
      initialEventMessage,
      signal.recommendedEntry
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, sigPath);
  }
}

export async function importHistoricalReplaySignals(
  userId: string,
  signals: HistoricalReplaySignal[]
): Promise<{ importedCount: number; skippedCount: number }> {
  let importedCount = 0;
  let skippedCount = 0;

  for (const item of signals) {
    const signalId = sanitizeId(item.id);
    const sigPath = `users/${userId}/signals/${signalId}`;
    const sigRef = doc(db, 'users', userId, 'signals', signalId);

    try {
      const existing = await getDoc(sigRef);
      if (existing.exists()) {
        skippedCount++;
        continue;
      }

      const payload: Record<string, unknown> = {
        id: signalId,
        userId,
        instrument: item.instrument,
        direction: item.direction,
        strategy: item.strategy,
        timeframe: item.timeframe,
        executionType: item.executionType,
        status: item.status,
        score: Number(item.score),
        recommendedEntry: Number(item.recommendedEntry),
        takeProfit: Number(item.takeProfit),
        stopLoss: Number(item.stopLoss),
        observedSpread: Number(item.observedSpread),
        lots: Number(item.lots),
        indicatorsSummary: item.indicatorsSummary.slice(0, 1200),
        rationale: item.rationale.slice(0, 2000),
        sourceType: 'BACKTEST_HISTORICAL',
        closeReason: item.closeReason.slice(0, 500),
        resultR: Number(item.resultR.toFixed(2)),
        resultMonetary: Number(item.resultMonetary.toFixed(2)),
        reversalAlertIssued: Boolean(item.reversalAlertIssued),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        closedAt: serverTimestamp(),
      };

      if (typeof item.actualEntry === 'number' && item.actualEntry > 0) {
        payload.actualEntry = Number(item.actualEntry);
      }

      await setDoc(sigRef, payload);

      await addSignalEvent(
        userId,
        signalId,
        'REPLAY_HISTORICO_IMPORTADO',
        `Emitido em ${item.emittedAtUtc.replace('T', ' ').slice(0, 19)} UTC · Encerrado em ${item.closedAtUtc.replace('T', ' ').slice(0, 19)} UTC · ${item.closeReason}`,
        item.exitPrice ?? item.recommendedEntry
      );

      importedCount++;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, sigPath);
    }
  }

  return { importedCount, skippedCount };
}

export async function openTrackedPosition(
  userId: string,
  signal: TradingSignalRecord,
  actualEntry: number,
  lots: number
): Promise<void> {
  if (isTerminalStatus(signal.status)) return;
  const signalId = sanitizeId(signal.id);
  const path = `users/${userId}/signals/${signalId}`;
  const ref = doc(db, 'users', userId, 'signals', signalId);

  try {
    await updateDoc(ref, {
      status: 'POSICAO_ABERTA',
      actualEntry: Number(actualEntry),
      lots: Number(lots),
      updatedAt: serverTimestamp(),
    });

    await addSignalEvent(
      userId,
      signalId,
      'POSICAO_ABERTA',
      `Posição aberta manualmente pelo utilizador a ${actualEntry} com ${lots} lotes.`,
      actualEntry
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function markReversalRecommendation(
  userId: string,
  signal: TradingSignalRecord,
  reasons: string[],
  currentPrice: number
): Promise<void> {
  if (isTerminalStatus(signal.status) || signal.reversalAlertIssued) return;
  const signalId = sanitizeId(signal.id);
  const path = `users/${userId}/signals/${signalId}`;
  const ref = doc(db, 'users', userId, 'signals', signalId);

  try {
    await updateDoc(ref, {
      status: 'ENCERRAMENTO_RECOMENDADO',
      reversalAlertIssued: true,
      updatedAt: serverTimestamp(),
    });

    await addSignalEvent(
      userId,
      signalId,
      'RECOMENDACAO_ENCERRAMENTO',
      `RECOMENDAÇÃO DE ENCERRAMENTO — ${signal.instrument} — POSIÇÃO ${signal.direction}. Motivos: ${reasons.join('; ')}`.slice(
        0,
        1500
      ),
      currentPrice
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function closeTrackedSignal(
  userId: string,
  signal: TradingSignalRecord,
  terminalStatus: Extract<
    SignalStatus,
    'TP_ATINGIDO' | 'SL_ATINGIDO' | 'ENCERRADO_MANUALMENTE' | 'INVALIDADO' | 'EXPIRADO'
  >,
  closeReason: string,
  resultR: number,
  resultMonetary?: number,
  priceAtEvent?: number
): Promise<void> {
  if (isTerminalStatus(signal.status)) return;
  const signalId = sanitizeId(signal.id);
  const path = `users/${userId}/signals/${signalId}`;
  const ref = doc(db, 'users', userId, 'signals', signalId);

  try {
    const updatePayload: Record<string, unknown> = {
      status: terminalStatus,
      closeReason: closeReason.slice(0, 500),
      resultR: Number(resultR.toFixed(2)),
      closedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (typeof resultMonetary === 'number' && Number.isFinite(resultMonetary)) {
      updatePayload.resultMonetary = Number(resultMonetary.toFixed(2));
    }

    await updateDoc(ref, updatePayload);
    await addSignalEvent(userId, signalId, terminalStatus, closeReason, priceAtEvent);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function addSignalEvent(
  userId: string,
  signalId: string,
  eventType: string,
  message: string,
  priceAtEvent?: number
): Promise<void> {
  const sId = sanitizeId(signalId);
  const eventId = sanitizeId(`ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const path = `users/${userId}/signals/${sId}/events/${eventId}`;
  const ref = doc(db, 'users', userId, 'signals', sId, 'events', eventId);

  try {
    const payload: Record<string, unknown> = {
      id: eventId,
      signalId: sId,
      userId,
      eventType: eventType.slice(0, 64),
      message: message.slice(0, 1500),
      createdAt: serverTimestamp(),
    };
    if (typeof priceAtEvent === 'number' && priceAtEvent > 0) {
      payload.priceAtEvent = priceAtEvent;
    }
    await setDoc(ref, payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function getSignalEvents(
  userId: string,
  signalId: string
): Promise<SignalEventRecord[]> {
  const sId = sanitizeId(signalId);
  const path = `users/${userId}/signals/${sId}/events`;
  try {
    const q = query(
      collection(db, 'users', userId, 'signals', sId, 'events'),
      orderBy('createdAt', 'asc')
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as SignalEventRecord);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export function subscribeToNotifications(
  userId: string,
  onData: (notifs: UserNotificationRecord[]) => void
): () => void {
  const path = `users/${userId}/notifications`;
  const q = query(
    collection(db, 'users', userId, 'notifications'),
    orderBy('createdAt', 'desc')
  );

  return onSnapshot(
    q,
    (snapshot) => {
      onData(snapshot.docs.map((d) => d.data() as UserNotificationRecord));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function createUserNotification(
  userId: string,
  notif: Omit<UserNotificationRecord, 'userId' | 'createdAt' | 'read'>
): Promise<void> {
  const notifId = sanitizeId(notif.id);
  const path = `users/${userId}/notifications/${notifId}`;
  const ref = doc(db, 'users', userId, 'notifications', notifId);
  try {
    const existing = await getDoc(ref);
    if (existing.exists()) return;
    const payload: Record<string, unknown> = {
      id: notifId,
      userId,
      instrument: notif.instrument,
      category: notif.category,
      title: notif.title.slice(0, 160),
      body: notif.body.slice(0, 1000),
      read: false,
      createdAt: serverTimestamp(),
    };
    if (notif.signalId) {
      payload.signalId = sanitizeId(notif.signalId);
    }
    await setDoc(ref, payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function markNotificationRead(userId: string, notifId: string): Promise<void> {
  const id = sanitizeId(notifId);
  const path = `users/${userId}/notifications/${id}`;
  const ref = doc(db, 'users', userId, 'notifications', id);
  try {
    await updateDoc(ref, { read: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function savePushSubscriptionRecord(
  userId: string,
  subId: string,
  endpoint: string,
  userAgent: string
): Promise<void> {
  const id = sanitizeId(subId);
  const path = `users/${userId}/pushSubscriptions/${id}`;
  const ref = doc(db, 'users', userId, 'pushSubscriptions', id);
  try {
    await setDoc(ref, {
      id,
      userId,
      endpoint: endpoint.slice(0, 1024),
      userAgent: userAgent.slice(0, 300),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}
