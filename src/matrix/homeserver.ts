export interface HomeserverEnvironment {
  configured?: string;
  mode: string;
  platform: string;
  development: boolean;
}

export function getDefaultHomeserver(environment: HomeserverEnvironment): string {
  const configured = environment.configured?.trim();
  if (configured) return configured;
  if (environment.platform === 'android' && environment.mode === 'android') {
    return 'http://localhost:8008';
  }
  if (environment.development) return 'http://127.0.0.1:8008';
  return '';
}
