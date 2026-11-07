import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MOOD_NOTIFICATION_PREFERENCES,
  createPrivateMoodNotification,
  isWithinQuietHours,
  normalizeMoodNotificationPreferences,
  readDeliveredMoodEventIds,
  recordDeliveredMoodEvent,
  shouldNotifyForMood,
  type MoodNotificationEvent,
  type MoodNotificationPreferences,
} from './mood-notifications.ts';

const now = new Date(2026, 10, 7, 23, 0).getTime();
const partnerMood: MoodNotificationEvent = {
  id: 'mood-1',
  eventId: '$event-1',
  kind: 'mood',
  sender: '@partner:nymph.test',
  sentAt: now - 60_000,
};
const enabledPreferences: MoodNotificationPreferences = {
  ...DEFAULT_MOOD_NOTIFICATION_PREFERENCES,
  enabled: true,
};

test('notification preferences sanitize invalid values and default to disabled', () => {
  assert.deepEqual(normalizeMoodNotificationPreferences({
    enabled: true,
    quietHoursEnabled: true,
    quietHoursStart: '25:90',
    quietHoursEnd: '08:30',
  }), {
    enabled: true,
    quietHoursEnabled: true,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:30',
  });
  assert.equal(DEFAULT_MOOD_NOTIFICATION_PREFERENCES.enabled, false);
});

test('quiet hours support same-day and overnight windows', () => {
  const overnight = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' };
  assert.equal(isWithinQuietHours(new Date(2026, 10, 7, 23, 0), overnight), true);
  assert.equal(isWithinQuietHours(new Date(2026, 10, 8, 6, 59), overnight), true);
  assert.equal(isWithinQuietHours(new Date(2026, 10, 8, 7, 0), overnight), false);
  assert.equal(isWithinQuietHours(new Date(2026, 10, 7, 13, 0), {
    quietHoursEnabled: true,
    quietHoursStart: '12:00',
    quietHoursEnd: '14:00',
  }), true);
});

test('only fresh, enabled, incoming mood events outside quiet hours are eligible', () => {
  const options = {
    localUserId: '@me:nymph.test',
    preferences: enabledPreferences,
    deliveredEventIds: [] as string[],
    now,
    retentionSeconds: 3_600,
  };
  assert.equal(shouldNotifyForMood(partnerMood, options), true);
  assert.equal(shouldNotifyForMood({ ...partnerMood, kind: 'text' }, options), false);
  assert.equal(shouldNotifyForMood({ ...partnerMood, sender: options.localUserId }, options), false);
  assert.equal(shouldNotifyForMood(partnerMood, { ...options, preferences: DEFAULT_MOOD_NOTIFICATION_PREFERENCES }), false);
  assert.equal(shouldNotifyForMood(partnerMood, { ...options, deliveredEventIds: ['$event-1'] }), false);
  assert.equal(shouldNotifyForMood({ ...partnerMood, sentAt: now - 4_000_000 }, options), false);
  assert.equal(shouldNotifyForMood(partnerMood, {
    ...options,
    preferences: { ...enabledPreferences, quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' },
  }), false);
});

test('generic notification payload cannot reveal mood content or event metadata', () => {
  const payload = createPrivateMoodNotification('$secret-event-identifier');
  assert.deepEqual(Object.keys(payload).sort(), ['body', 'id', 'title']);
  assert.equal(payload.title, 'NYMPH');
  assert.equal(payload.body, 'A private mood ping is waiting. Open NYMPH to view it.');
  assert.equal(JSON.stringify(payload).includes('$secret-event-identifier'), false);
  assert.equal(JSON.stringify(payload).includes('Kinky'), false);
  assert.equal(payload.id, createPrivateMoodNotification('$secret-event-identifier').id);
  assert.ok(payload.id > 0);
});

test('delivered event IDs persist bounded deduplication state', () => {
  const state = new Map<string, string>();
  const storage = {
    getItem: (key: string) => state.get(key) ?? null,
    setItem: (key: string, value: string) => state.set(key, value),
  };
  for (let index = 0; index < 260; index += 1) {
    recordDeliveredMoodEvent(storage, 'delivered', `$event-${index}`);
  }
  const delivered = readDeliveredMoodEventIds(storage, 'delivered');
  assert.equal(delivered.length, 250);
  assert.deepEqual(delivered.slice(0, 2), ['$event-10', '$event-11']);
  assert.deepEqual(delivered.slice(-2), ['$event-258', '$event-259']);
  recordDeliveredMoodEvent(storage, 'delivered', '$event-11');
  assert.equal(readDeliveredMoodEventIds(storage, 'delivered').at(-1), '$event-11');
});
