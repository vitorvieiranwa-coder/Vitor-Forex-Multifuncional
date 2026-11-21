import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');
const rulesContent = fs.readFileSync(rulesPath, 'utf-8');
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf-8'));

describe('Firestore Security Rules Structural & Dirty Dozen Invariants', () => {
  it('enforces rules_version = 2 and global default deny catch-all', () => {
    expect(rulesContent).toContain("rules_version = '2';");
    expect(rulesContent).toContain('match /{document=**}');
    expect(rulesContent).toContain('allow read, write: if false;');
  });

  it('requires email_verified == true and strict owner UID matching', () => {
    expect(rulesContent).toContain('request.auth.token.email_verified == true');
    expect(rulesContent).toContain('request.auth.uid == userId');
  });

  it('protects every path declared in firebase-blueprint.json', () => {
    const paths = Object.keys(blueprint.firestore || {});
    expect(paths.length).toBeGreaterThanOrEqual(6);
    expect(rulesContent).toContain('match /users/{userId}');
    expect(rulesContent).toContain('match /settings/{settingId}');
    expect(rulesContent).toContain('match /signals/{signalId}');
    expect(rulesContent).toContain('match /events/{eventId}');
    expect(rulesContent).toContain('match /notifications/{notificationId}');
    expect(rulesContent).toContain('match /pushSubscriptions/{subscriptionId}');
  });

  it('enforces signal origin immutability and terminal state locking', () => {
    expect(rulesContent).toContain('function signalOriginImmutable()');
    expect(rulesContent).toContain('function isTerminalSignalStatus(val)');
    expect(rulesContent).toContain('!isTerminalSignalStatus(existing().status)');
    expect(rulesContent).toContain('allow delete: if false;');
  });

  it('enforces append-only events with parent Master Gate check', () => {
    expect(rulesContent).toContain('exists(/databases/$(database)/documents/users/$(userId)/signals/$(signalId))');
    expect(rulesContent).toContain('allow update: if false;');
  });

  it('prevents ID poisoning and shadow fields via isValidId and hasOnly', () => {
    expect(rulesContent).toContain('id.matches(\'^[a-zA-Z0-9_\\\\-]+$\')');
    expect(rulesContent).toContain('data.keys().hasOnly(');
    expect(rulesContent).toContain('affectedKeys().hasOnly(');
  });
});
