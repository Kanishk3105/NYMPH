import { expect, test } from '@playwright/test';

const demoState = {
  roomReady: true,
  messages: [],
  profile: { displayName: 'Amelia', username: '@amelia', bio: '', avatar: 'A' },
  partnerName: 'Luca',
  retention: '24 hours',
  favourites: [],
  recent: [],
  favoriteCustomStickerIds: [],
  recentCustomStickerIds: [],
  customStickerPacks: [],
};

const pngFixture = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGO8oxH1n4GBgYEJRIAwACSKAmFRJpJAAAAAAElFTkSuQmCC',
  'base64',
);
const animatedGifFixture = Buffer.from(
  'R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQADAAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBDAABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7',
  'base64',
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((state) => {
    if (!localStorage.getItem('nymph.local.v1')) {
      localStorage.setItem('nymph.local.v1', JSON.stringify(state));
    }
    const audioContexts: AudioContext[] = [];
    Object.defineProperty(window, '__nymphTestAudioContexts', { value: audioContexts });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 440;
        oscillator.connect(destination);
        oscillator.start();
        audioContexts.push(context);
        await context.resume();
        return destination.stream;
      },
    });
  }, demoState);
  await page.goto('/');
  await expect(page.getByText('Local demo', { exact: true })).toBeVisible();
});

test('voice recording controls, preview, playback, seeking and speed work with synthetic audio', async ({ page }) => {
  await page.getByRole('button', { name: 'Record voice message' }).click();
  const recording = page.locator('.voice-recording');
  await expect(recording).toBeVisible();
  await expect(recording.locator('time')).toHaveText(/^0:0\d$/);

  await recording.getByRole('button', { name: 'Pause' }).click();
  await expect(recording).toHaveClass(/paused/);
  await page.waitForTimeout(300);
  const pausedTime = await recording.locator('time').textContent();
  await page.waitForTimeout(300);
  expect(await recording.locator('time').textContent()).toBe(pausedTime);
  await recording.getByRole('button', { name: 'Resume' }).click();
  await expect(recording).not.toHaveClass(/paused/);
  await recording.getByRole('button', { name: 'Cancel' }).click();
  await expect(recording).toHaveCount(0);
  await expect(page.locator('.viewer')).toHaveCount(0);

  await page.getByRole('button', { name: 'Record voice message' }).click();
  await expect(page.locator('.voice-recording')).toBeVisible();
  await page.waitForTimeout(700);
  await page.locator('.voice-recording').getByRole('button', { name: 'Finish' }).click();
  const preview = page.locator('.viewer');
  await expect(preview.locator('audio.voice-preview')).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Send privately' })).toBeVisible();
  await preview.getByRole('button', { name: 'Send privately' }).click();

  const voiceMessage = page.locator('.message-row').filter({ has: page.locator('audio[aria-label="Voice message from you"]') });
  await expect(voiceMessage).toBeVisible();
  const player = voiceMessage.locator('audio');
  await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.duration)).toBeGreaterThan(0.5);
  const seekedTime = await player.evaluate(async (audio: HTMLAudioElement) => {
    audio.pause();
    const target = 0.1;
    const seeked = new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Synthetic voice seek did not finish.')), 5_000);
      audio.addEventListener('seeked', () => {
        window.clearTimeout(timeout);
        resolve(audio.currentTime);
      }, { once: true });
    });
    audio.currentTime = target;
    const currentTime = await seeked;
    if (Math.abs(currentTime - target) > 0.05) {
      throw new Error('Synthetic voice seek did not reach its target.');
    }
    return currentTime;
  });
  expect(seekedTime).toBeGreaterThan(0.05);
  await voiceMessage.getByRole('combobox', { name: 'Voice playback speed' }).selectOption('1.5');
  await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(1.5);
  expect(await player.evaluate((audio: HTMLAudioElement) => audio.duration)).toBeGreaterThan(0.5);

  await page.evaluate(async () => {
    await Promise.all((window as Window & { __nymphTestAudioContexts: AudioContext[] })
      .__nymphTestAudioContexts.map((context) => context.close()));
  });
});

test('view-once sending requires a connected encrypted room instead of local-only expiry', async ({ page }) => {
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'one-view.png',
    mimeType: 'image/png',
    buffer: pngFixture,
  });
  await expect(page.getByLabel('View-once duration')).toHaveValue('Off');
  await page.getByLabel('View-once duration').selectOption('Custom');
  await expect(page.getByLabel('View-once duration')).toHaveValue('Custom');
  await page.getByLabel('Custom viewing duration in seconds').fill('7');
  await expect(page.getByLabel('Custom viewing duration in seconds')).toHaveValue('7');
  await page.getByRole('button', { name: 'Send privately' }).click();
  await expect(page.getByText('Connect the verified encrypted room before sending expiring media.')).toBeVisible();
  await expect(page.getByLabel('View-once duration')).toHaveValue('Custom');
  await expect(page.getByLabel('Custom viewing duration in seconds')).toHaveValue('7');
  await expect(page.locator('.message-row .media-message')).toHaveCount(0);
});

test('mood pings preserve mode and custom emoji through local fixture sending', async ({ page }) => {
  const moodModes = [
    { label: 'Romantic', mode: 'romantic' },
    { label: 'Flirty', mode: 'flirty' },
    { label: 'Spicy', mode: 'spicy' },
    { label: 'Kinky · 18+', mode: 'kinky' },
  ];
  for (const [index, item] of moodModes.entries()) {
    await page.getByRole('tab', { name: item.label }).click();
    await page.getByTitle('Send a mood').click();
    await page.getByRole('group', { name: 'Mood mode' }).getByRole('button', { name: item.label }).click();
    if (index === moodModes.length - 1) {
      await page.getByLabel('Custom mood emoji').fill('🌙');
      await page.getByLabel('Custom mood label').fill('Dreaming of home');
      await page.getByRole('button', { name: 'Send mood', exact: true }).click();
      await expect(page.locator('.message-row .mood-message')).toContainText('Dreaming of home');
      await expect(page.locator('.message-row .mood-message')).toContainText('🌙');
    } else {
      await page.getByRole('button', { name: /Loving/ }).click();
      await expect(page.locator('.message-row .mood-message')).toContainText('Loving');
    }
    await expect(page.locator('.message-row .mood-message')).toHaveCount(1);
  }
  await expect(page.locator('.local-warning')).toContainText('local demonstration');
});

test('received mood fixture opens in-app responses and sends a local fixture reply', async ({ page }) => {
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('nymph.local.v1') ?? '{}') as {
      messages: unknown[];
    };
    state.messages.push({
      id: 'partner-mood-fixture',
      mode: 'flirty',
      sender: 'partner',
      kind: 'mood',
      text: '🫶 Thinking of you',
      time: Date.now(),
      transport: 'matrix',
      delivery: 'sent',
      remoteEventId: '$fixture-mood-event',
    });
    localStorage.setItem('nymph.local.v1', JSON.stringify(state));
  });
  await page.reload();
  await page.getByRole('tab', { name: 'Flirty' }).click();
  await page.getByRole('button', { name: /Thinking of you/ }).click();
  await expect(page.getByRole('heading', { name: 'Thinking of you' })).toBeVisible();
  await expect(page.getByText(/verified encrypted room/)).toBeVisible();
  await page.getByRole('button', { name: 'React ❤️' }).click();
  await expect(page.locator('.message-row .bubble-meta .reaction')).toHaveText('❤️');

  await page.getByTitle('Send a mood').click();
  await page.getByLabel('Custom mood emoji').fill('✨');
  await page.getByLabel('Custom mood label').fill('Sending a little sparkle');
  await page.getByRole('button', { name: 'Send mood', exact: true }).click();
  await expect(page.locator('.message-row .mood-message').filter({ hasText: 'Sending a little sparkle' }))
    .toContainText('Sending a little sparkle');
});

test('notification permissions and quiet-hours preferences persist locally', async ({ page }) => {
  await page.context().grantPermissions(['notifications']);
  await page.getByRole('button', { name: 'Settings' }).click();
  const enableNotifications = page.getByLabel('Enable private mood notifications');
  await enableNotifications.check();
  await expect(enableNotifications).toBeChecked();
  await expect(page.getByText('Permission: granted')).toBeVisible();

  await page.getByLabel('Enable quiet hours').check();
  await page.getByLabel('Quiet hours start').fill('21:30');
  await page.getByLabel('Quiet hours end').fill('07:15');
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Enable private mood notifications')).toBeChecked();
  await expect(page.getByLabel('Enable quiet hours')).toBeChecked();
  await expect(page.getByLabel('Quiet hours start')).toHaveValue('21:30');
  await expect(page.getByLabel('Quiet hours end')).toHaveValue('07:15');
});

test('sticker and GIF browser interactions and local pack cache survive reload', async ({ page }) => {
  const openPicker = async () => page.getByTitle('Stickers and GIFs').click();
  await openPicker();

  await page.getByRole('button', { name: 'Kisses', exact: true }).click();
  await expect(page.locator('.sticker-grid .sticker-select')).toHaveCount(12);
  await page.getByRole('textbox', { name: 'Search stickers' }).fill('😘');
  await expect(page.locator('.sticker-grid .sticker-select')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search stickers' }).fill('');
  const favoriteSticker = page.locator('.sticker-cell').filter({
    has: page.getByRole('button', { name: '😘', exact: true }),
  });
  await favoriteSticker.getByRole('button', { name: 'Favorite sticker' }).click();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.locator('.sticker-grid .sticker-select')).toHaveCount(1);
  const favorite = await page.locator('.sticker-grid .sticker-select').textContent();

  await page.getByRole('button', { name: 'Kisses', exact: true }).click();
  await page.getByRole('button', { name: '💕', exact: true }).click();
  await openPicker();
  await page.getByRole('button', { name: 'Recent', exact: true }).click();
  await expect(page.locator('.sticker-grid .sticker-select')).toContainText('💕');

  await page.getByLabel('Pack name').fill('Us together');
  await page.getByRole('button', { name: 'Create pack' }).click();
  await page.getByLabel('Pack name').fill('Us together');
  await page.getByRole('button', { name: 'Add file' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'rose.png',
    mimeType: 'image/png',
    buffer: pngFixture,
  });
  const importedSticker = page.locator('.sticker-grid img[alt="rose"]');
  await expect(importedSticker).toBeVisible();
  await expect.poll(() => importedSticker.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(2);

  await page.getByLabel('Pack name').fill('Our little world');
  await page.getByLabel('Description').fill('Small moments');
  await page.getByRole('button', { name: 'Save pack details' }).click();
  await expect(page.getByRole('button', { name: 'Our little world', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'GIFs', exact: true }).click();
  await page.getByLabel('Pack name').fill('Our little world');
  await page.getByRole('button', { name: 'Add file' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'loop.gif',
    mimeType: 'image/gif',
    buffer: animatedGifFixture,
  });
  const gif = page.locator('.imported-gif-grid img[alt="loop"]');
  await expect(gif).toBeVisible();
  await expect.poll(() => gif.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(2);
  const animationFrames = await gif.evaluate(async (image: HTMLImageElement) => {
    type DecodedFrame = {
      image: {
        copyTo(destination: Uint8Array): Promise<void>;
        close(): void;
      };
    };
    type GifDecoder = {
      tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
      decode(options: { frameIndex: number }): Promise<DecodedFrame>;
      close(): void;
    };
    type GifDecoderConstructor = new (options: { data: ArrayBuffer; type: string }) => GifDecoder;
    const Decoder = (window as Window & { ImageDecoder?: GifDecoderConstructor }).ImageDecoder;
    if (!Decoder) throw new Error('This browser does not expose the animated-image decoder.');
    const decoder = new Decoder({ data: await (await fetch(image.src)).arrayBuffer(), type: 'image/gif' });
    await decoder.tracks.ready;
    const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
    const pixels = async (frameIndex: number) => {
      const frame = await decoder.decode({ frameIndex });
      try {
        const rgba = new Uint8Array(image.naturalWidth * image.naturalHeight * 4);
        await frame.image.copyTo(rgba);
        return [...rgba];
      } finally {
        frame.image.close();
      }
    };
    const frames = frameCount > 1 ? [await pixels(0), await pixels(1)] : [];
    decoder.close();
    return { frameCount, frames };
  });
  expect(animationFrames.frameCount).toBeGreaterThan(1);
  expect(animationFrames.frames[1]).not.toEqual(animationFrames.frames[0]);

  await page.getByRole('button', { name: 'Stickers', exact: true }).click();
  await page.getByRole('button', { name: '18+ collection' }).click();
  await expect(page.getByRole('button', { name: 'Everyday collection' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'After dark', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Our little world', exact: true })).toHaveCount(0);
  await page.getByLabel('Pack name').fill('Private fantasy');
  await page.getByRole('button', { name: 'Create pack' }).click();
  await page.getByLabel('Pack name').fill('Private fantasy');
  await page.getByRole('button', { name: 'Add file' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'moon.png',
    mimeType: 'image/png',
    buffer: pngFixture,
  });
  await expect(page.locator('.sticker-grid img[alt="moon"]')).toBeVisible();
  await page.getByRole('button', { name: 'Everyday collection' }).click();
  await expect(page.getByRole('button', { name: 'Private fantasy', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Our little world', exact: true }).click();
  await expect(page.locator('.sticker-grid img[alt="rose"]')).toBeVisible();

  await page.reload();
  await openPicker();
  await expect(page.getByRole('button', { name: 'Our little world', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Our little world', exact: true }).click();
  await expect(page.locator('.sticker-grid img[alt="rose"]')).toBeVisible();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.locator('.sticker-grid .sticker-select')).toContainText(favorite ?? '');
  await page.getByRole('button', { name: 'Recent', exact: true }).click();
  await expect(page.locator('.sticker-grid .sticker-select')).toContainText('💕');
  await page.getByRole('button', { name: 'GIFs', exact: true }).click();
  await expect(page.locator('.imported-gif-grid img[alt="loop"]')).toBeVisible();
});
