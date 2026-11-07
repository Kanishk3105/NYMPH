export function getThumbnailDimensions(
  width: number,
  height: number,
  maxDimension = 480,
): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(maxDimension) ||
    width <= 0 ||
    height <= 0 ||
    maxDimension <= 0
  ) {
    throw new Error('Media dimensions must be positive finite values.');
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('A private media preview could not be created.'));
        return;
      }
      resolve(blob);
    }, 'image/webp', 0.78);
  });
}

async function thumbnailFromImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const dimensions = getThumbnailDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This device cannot create a private media preview.');
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    return await canvasToWebp(canvas);
  } finally {
    bitmap.close();
  }
}

async function thumbnailFromVideo(file: File): Promise<Blob> {
  const video = document.createElement('video');
  const objectUrl = URL.createObjectURL(file);
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Timed out preparing the video preview.')), 15_000);
      video.addEventListener('loadedmetadata', () => {
        if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) {
          window.clearTimeout(timeout);
          reject(new Error('The selected video has no usable preview frame.'));
          return;
        }
        video.currentTime = Math.min(0.25, video.duration / 2);
      }, { once: true });
      video.addEventListener('seeked', () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
      video.addEventListener('error', () => {
        window.clearTimeout(timeout);
        reject(new Error('The selected video preview could not be decoded.'));
      }, { once: true });
      video.src = objectUrl;
      video.load();
    });
    const dimensions = getThumbnailDimensions(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This device cannot create a private video preview.');
    context.drawImage(video, 0, 0, dimensions.width, dimensions.height);
    return await canvasToWebp(canvas);
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function createMediaThumbnail(file: File): Promise<File> {
  const thumbnail = file.type.startsWith('image/')
    ? await thumbnailFromImage(file)
    : file.type.startsWith('video/')
      ? await thumbnailFromVideo(file)
      : undefined;
  if (!thumbnail) throw new Error('Choose a photo or video to create a private preview.');
  return new File([thumbnail], 'preview.webp', { type: 'image/webp' });
}
