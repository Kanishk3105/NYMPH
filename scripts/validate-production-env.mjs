const homeserver = process.env.VITE_MATRIX_HOMESERVER?.trim();

if (!homeserver) {
  throw new Error('Set VITE_MATRIX_HOMESERVER to the deployed HTTPS Matrix URL before building a release.');
}

let parsed;
try {
  parsed = new URL(homeserver);
} catch {
  throw new Error('VITE_MATRIX_HOMESERVER must be a valid HTTPS URL.');
}

const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
if (
  parsed.protocol !== 'https:' ||
  parsed.username ||
  parsed.password ||
  ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname) ||
  hostname.endsWith('.localhost')
) {
  throw new Error('VITE_MATRIX_HOMESERVER must use HTTPS and a non-loopback production hostname.');
}
