export type MoodNotificationPreferences = {
  enabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
};

export type MoodNotificationEvent = {
  id: string;
  eventId: string;
  kind: string;
  sender: string;
  sentAt: number;
};

export type MoodNotificationPayload = {
  id: number;
  title: string;
  body: string;
};

export const DEFAULT_MOOD_NOTIFICATION_PREFERENCES: MoodNotificationPreferences = {
  enabled: false,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
};

export const MOOD_NOTIFICATION_PREFERENCES_KEY = 'nymph.mood-notifications.v1';
export const MOOD_NOTIFICATION_DELIVERED_KEY = 'nymph.mood-notifications.delivered.v1';
const MAX_DELIVERED_EVENT_IDS = 250;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function moodNotificationStorageKey(scope: string, key = MOOD_NOTIFICATION_PREFERENCES_KEY): string {
  return `${key}:${scope}`;
}

export function normalizeMoodNotificationPreferences(value: unknown): MoodNotificationPreferences {
  if (!value || typeof value !== 'object') return { ...DEFAULT_MOOD_NOTIFICATION_PREFERENCES };
  const candidate = value as Partial<MoodNotificationPreferences>;
  return {
    enabled: candidate.enabled === true,
    quietHoursEnabled: candidate.quietHoursEnabled === true,
    quietHoursStart: typeof candidate.quietHoursStart === 'string' && TIME_PATTERN.test(candidate.quietHoursStart)
      ? candidate.quietHoursStart
      : DEFAULT_MOOD_NOTIFICATION_PREFERENCES.quietHoursStart,
    quietHoursEnd: typeof candidate.quietHoursEnd === 'string' && TIME_PATTERN.test(candidate.quietHoursEnd)
      ? candidate.quietHoursEnd
      : DEFAULT_MOOD_NOTIFICATION_PREFERENCES.quietHoursEnd,
  };
}

export function readMoodNotificationPreferences(storage: Pick<Storage, 'getItem'>, key: string): MoodNotificationPreferences {
  try {
    const stored = storage.getItem(key);
    return stored ? normalizeMoodNotificationPreferences(JSON.parse(stored) as unknown) : {
      ...DEFAULT_MOOD_NOTIFICATION_PREFERENCES,
    };
  } catch {
    return { ...DEFAULT_MOOD_NOTIFICATION_PREFERENCES };
  }
}

export function readDeliveredMoodEventIds(storage: Pick<Storage, 'getItem'>, key: string): string[] {
  try {
    const stored: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    return Array.isArray(stored)
      ? stored.filter((eventId): eventId is string => typeof eventId === 'string').slice(-MAX_DELIVERED_EVENT_IDS)
      : [];
  } catch {
    return [];
  }
}

export function recordDeliveredMoodEvent(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  key: string,
  eventId: string,
): void {
  const ids = readDeliveredMoodEventIds(storage, key).filter((storedId) => storedId !== eventId);
  ids.push(eventId);
  storage.setItem(key, JSON.stringify(ids.slice(-MAX_DELIVERED_EVENT_IDS)));
}

function minuteOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function isWithinQuietHours(
  date: Date,
  preferences: Pick<MoodNotificationPreferences, 'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd'>,
): boolean {
  if (!preferences.quietHoursEnabled) return false;
  const start = minuteOfDay(preferences.quietHoursStart);
  const end = minuteOfDay(preferences.quietHoursEnd);
  if (start === end) return false;
  const current = date.getHours() * 60 + date.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function shouldNotifyForMood(
  event: MoodNotificationEvent,
  options: {
    localUserId: string;
    preferences: MoodNotificationPreferences;
    deliveredEventIds: readonly string[];
    now: number;
    retentionSeconds: number | null;
  },
): boolean {
  if (
    event.kind !== 'mood' ||
    event.sender === options.localUserId ||
    !event.eventId ||
    !Number.isFinite(event.sentAt) ||
    !options.preferences.enabled ||
    options.deliveredEventIds.includes(event.eventId) ||
    isWithinQuietHours(new Date(options.now), options.preferences)
  ) return false;
  if (
    options.retentionSeconds !== null &&
    event.sentAt + options.retentionSeconds * 1000 <= options.now
  ) return false;
  return true;
}

export function createPrivateMoodNotification(eventId: string): MoodNotificationPayload {
  let hash = 0x811c9dc5;
  for (let index = 0; index < eventId.length; index += 1) {
    hash ^= eventId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return {
    id: (hash >>> 0) & 0x7fffffff || 1,
    title: 'NYMPH',
    body: 'A private mood ping is waiting. Open NYMPH to view it.',
  };
}
