import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { createPrivateMoodNotification } from './mood-notifications.ts';

const MOOD_CHANNEL_ID = 'private-mood-pings';
let channelReady: Promise<void> | undefined;

export async function getMoodNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (Capacitor.isNativePlatform()) {
    const status = await LocalNotifications.checkPermissions();
    return status.display === 'granted' ? 'granted' : status.display === 'denied' ? 'denied' : 'default';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestMoodNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (Capacitor.isNativePlatform()) {
    const status = await LocalNotifications.requestPermissions();
    return status.display === 'granted' ? 'granted' : status.display === 'denied' ? 'denied' : 'default';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission === 'default' ? Notification.requestPermission() : Notification.permission;
}

async function ensureMoodChannel(): Promise<void> {
  channelReady ??= LocalNotifications.createChannel({
    id: MOOD_CHANNEL_ID,
    name: 'Private mood pings',
    description: 'Generic alerts for private mood events in NYMPH.',
    importance: 3,
    visibility: 0,
    lights: false,
    vibration: true,
  });
  try {
    await channelReady;
  } catch (error) {
    channelReady = undefined;
    throw error;
  }
}

export async function deliverPrivateMoodNotification(eventId: string, appIsForeground: boolean): Promise<boolean> {
  if (appIsForeground) return false;
  const permission = await getMoodNotificationPermission();
  if (permission !== 'granted') return false;
  const notification = createPrivateMoodNotification(eventId);
  if (Capacitor.isNativePlatform()) {
    await ensureMoodChannel();
    await LocalNotifications.schedule({
      notifications: [{
        ...notification,
        channelId: MOOD_CHANNEL_ID,
        schedule: { at: new Date(Date.now() + 1_000) },
        isExactNotification: false,
      }],
    });
    return true;
  }
  const instance = new Notification(notification.title, { body: notification.body, tag: `nymph-mood-${notification.id}` });
  instance.onclick = () => {
    window.focus();
    instance.close();
  };
  return true;
}
