import React, { useState } from 'react';
import { Bell, Check } from 'lucide-react';
import {
  markNotificationRead,
  savePushSubscriptionRecord,
  saveUserSettings,
} from '../services/firestoreService';
import { UserNotificationRecord, UserSettings } from '../shared/types';

interface NotificationsViewProps {
  userId: string;
  settings: UserSettings;
  notifications: UserNotificationRecord[];
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export const NotificationsView: React.FC<NotificationsViewProps> = ({
  userId,
  settings,
  notifications,
}) => {
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleEnableWebPush = async () => {
    setBusy(true);
    setStatusMsg(null);
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        setStatusMsg('Este navegador não suporta notificações Web Push.');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setStatusMsg('Permissão de notificações negada pelo utilizador.');
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const keyRes = await fetch('/api/push/vapid-public-key');
      const { publicKey } = (await keyRes.json()) as { publicKey: string };

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      const subRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, subscription: sub.toJSON() }),
      });
      const subJson = await subRes.json();

      await savePushSubscriptionRecord(
        userId,
        subJson.id || `sub_${Date.now()}`,
        sub.endpoint,
        navigator.userAgent
      );
      await saveUserSettings(userId, { ...settings, pushEnabled: true });

      setStatusMsg('Notificações Web Push ativadas com sucesso para segundo plano.');
    } catch (err) {
      setStatusMsg(
        err instanceof Error
          ? `Falha ao registar Push: ${err.message}`
          : 'Erro ao ativar notificações.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleTestPush = async () => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/push/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const json = await res.json();
      setStatusMsg(
        json.sent > 0
          ? 'Notificação de teste enviada via Web Push.'
          : 'Nenhuma subscrição push ativa neste dispositivo. Ative primeiro.'
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleInstrumentAlert = async (
    field:
      | 'alertEurUsd'
      | 'alertGbpUsd'
      | 'alertEurJpy'
      | 'alertGbpJpy'
      | 'alertXauUsd'
  ) => {
    await saveUserSettings(userId, {
      ...settings,
      [field]: !settings[field],
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Alertas e Notificações Push
          </h2>
          <p className="text-xs text-slate-400">
            Emissão em segundo plano para novos sinais BUY/SELL, TP atingido, SL atingido, inversões e invalidações.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleEnableWebPush}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors disabled:opacity-50"
          >
            <Bell className="w-3.5 h-3.5" />
            <span>{settings.pushEnabled ? 'Renovar Subscrição Push' : 'Ativar Web Push'}</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleTestPush}
            className="px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md transition-colors disabled:opacity-50"
          >
            Testar Push
          </button>
        </div>
      </div>

      {statusMsg && (
        <div className="bg-[#111827] border border-slate-700 rounded-lg p-3 text-xs text-slate-200">
          {statusMsg}
        </div>
      )}

      {/* Per-instrument alert toggles */}
      <div className="bg-[#111827] border border-slate-800 rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-200">
          Alertas Individuais por Instrumento
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {(
            [
              ['EUR/USD', 'alertEurUsd'],
              ['GBP/USD', 'alertGbpUsd'],
              ['EUR/JPY', 'alertEurJpy'],
              ['GBP/JPY', 'alertGbpJpy'],
              ['XAU/USD', 'alertXauUsd'],
            ] as const
          ).map(([label, field]) => {
            const active = settings[field];
            return (
              <button
                key={field}
                type="button"
                onClick={() => toggleInstrumentAlert(field)}
                className={`px-3 py-2 rounded-md border text-xs font-medium transition-colors text-left ${
                  active
                    ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-800 bg-[#0D131F] text-slate-400'
                }`}
              >
                <span className="block font-semibold">{label}</span>
                <span className="text-[11px]">{active ? 'Alertas Ativos' : 'Silenciado'}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Notifications Log */}
      <div className="bg-[#111827] border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-slate-200">
            Histórico de Alertas ({notifications.length})
          </h3>
        </div>
        {notifications.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">
            Nenhum alerta emitido ainda.
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {notifications.map((n) => (
              <div
                key={n.id}
                className={`p-4 flex items-start justify-between gap-4 ${
                  n.read ? 'opacity-70' : 'bg-slate-900/40'
                }`}
              >
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-100">{n.title}</span>
                    <span className="text-slate-400">· {n.instrument}</span>
                  </div>
                  <p className="text-slate-300">{n.body}</p>
                </div>
                {!n.read && (
                  <button
                    type="button"
                    onClick={() => markNotificationRead(userId, n.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 rounded shrink-0"
                  >
                    <Check className="w-3 h-3" />
                    <span>Lida</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
