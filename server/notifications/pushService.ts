import fs from 'fs';
import path from 'path';
import * as webpush from 'web-push';

export interface StoredPushSubscription {
  id: string;
  userId: string;
  subscription: webpush.PushSubscription;
  createdAtUtc: string;
}

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url?: string;
}

const DATA_DIR = path.resolve(process.cwd(), '.data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');

export class PushNotificationService {
  private publicKey = '';
  private privateKey = '';
  private subscriptions: StoredPushSubscription[] = [];
  private sentDedupKeys = new Set<string>();

  constructor() {
    this.ensureInitialized();
  }

  private ensureInitialized(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
    const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
    const fallbackSubject = 'mailto:alerts@forex-intelligence.local';
    const rawSubject = process.env.VAPID_SUBJECT?.trim() || '';
    let subject = fallbackSubject;
    if (rawSubject) {
      try {
        const parsed = new URL(rawSubject);
        if (parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
          subject = rawSubject;
        }
      } catch {
        subject = fallbackSubject;
      }
    }

    if (envPub && envPriv) {
      this.publicKey = envPub;
      this.privateKey = envPriv;
    } else if (fs.existsSync(VAPID_FILE)) {
      try {
        const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8')) as {
          publicKey: string;
          privateKey: string;
        };
        this.publicKey = saved.publicKey;
        this.privateKey = saved.privateKey;
      } catch {
        const keys = webpush.generateVAPIDKeys();
        this.publicKey = keys.publicKey;
        this.privateKey = keys.privateKey;
        fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
      }
    } else {
      const keys = webpush.generateVAPIDKeys();
      this.publicKey = keys.publicKey;
      this.privateKey = keys.privateKey;
      fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
    }

    try {
      webpush.setVapidDetails(subject, this.publicKey, this.privateKey);
    } catch (err) {
      console.warn('[PushNotificationService] Invalid VAPID config, regenerating safe defaults:', err);
      const keys = webpush.generateVAPIDKeys();
      this.publicKey = keys.publicKey;
      this.privateKey = keys.privateKey;
      try {
        fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
      } catch {
        // Non-fatal in read-only containers
      }
      webpush.setVapidDetails(fallbackSubject, this.publicKey, this.privateKey);
    }

    if (fs.existsSync(SUBS_FILE)) {
      try {
        this.subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'));
      } catch {
        this.subscriptions = [];
      }
    }
  }

  public getPublicKey(): string {
    return this.publicKey;
  }

  public addSubscription(userId: string, subscription: webpush.PushSubscription): string {
    const existingIdx = this.subscriptions.findIndex(
      (s) => s.userId === userId && s.subscription.endpoint === subscription.endpoint
    );
    const id = `sub_${Buffer.from(subscription.endpoint).toString('base64url').slice(0, 24)}`;

    const record: StoredPushSubscription = {
      id,
      userId,
      subscription,
      createdAtUtc: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      this.subscriptions[existingIdx] = record;
    } else {
      this.subscriptions.push(record);
    }

    this.persistSubscriptions();
    return id;
  }

  public removeSubscription(userId: string, endpoint: string): void {
    this.subscriptions = this.subscriptions.filter(
      (s) => !(s.userId === userId && s.subscription.endpoint === endpoint)
    );
    this.persistSubscriptions();
  }

  public getSubscriptionCount(userId?: string): number {
    if (!userId) return this.subscriptions.length;
    return this.subscriptions.filter((s) => s.userId === userId).length;
  }

  private persistSubscriptions(): void {
    try {
      fs.writeFileSync(SUBS_FILE, JSON.stringify(this.subscriptions, null, 2));
    } catch {
      // Non-fatal in read-only containers
    }
  }

  public async sendToUser(
    userId: string,
    payload: PushPayload,
    dedupKey?: string
  ): Promise<{ sent: number; failed: number }> {
    if (dedupKey) {
      if (this.sentDedupKeys.has(dedupKey)) {
        return { sent: 0, failed: 0 };
      }
      this.sentDedupKeys.add(dedupKey);
      if (this.sentDedupKeys.size > 5000) {
        const first = this.sentDedupKeys.values().next().value;
        if (first) this.sentDedupKeys.delete(first);
      }
    }

    const targets = this.subscriptions.filter((s) => s.userId === userId);
    let sent = 0;
    let failed = 0;
    const staleEndpoints: string[] = [];

    for (const target of targets) {
      try {
        await webpush.sendNotification(target.subscription, JSON.stringify(payload));
        sent++;
      } catch (err: unknown) {
        failed++;
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          staleEndpoints.push(target.subscription.endpoint);
        }
      }
    }

    if (staleEndpoints.length > 0) {
      this.subscriptions = this.subscriptions.filter(
        (s) => !staleEndpoints.includes(s.subscription.endpoint)
      );
      this.persistSubscriptions();
    }

    return { sent, failed };
  }

  public async broadcastToAllSubscribers(
    payload: PushPayload,
    dedupKey?: string
  ): Promise<{ sent: number; failed: number }> {
    if (dedupKey) {
      if (this.sentDedupKeys.has(dedupKey)) {
        return { sent: 0, failed: 0 };
      }
      this.sentDedupKeys.add(dedupKey);
    }

    let sent = 0;
    let failed = 0;
    for (const sub of this.subscriptions) {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
        sent++;
      } catch {
        failed++;
      }
    }
    return { sent, failed };
  }
}
