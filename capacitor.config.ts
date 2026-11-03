import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.nymph.privateroom',
  appName: 'NYMPH',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  backgroundColor: '#10090d',
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#10090d',
      showSpinner: false,
    },
    StatusBar: {
      backgroundColor: '#10090d',
      style: 'DARK',
      overlaysWebView: false,
    },
  },
};

export default config;
