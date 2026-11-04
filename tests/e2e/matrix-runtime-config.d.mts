export interface IsolatedMatrixConfig {
  homeserverUrl: string;
  serverName: string;
  partnerA: string;
  partnerB: string;
}

export function parseIsolatedMatrixConfig(contents: string): IsolatedMatrixConfig;
export function loadIsolatedMatrixConfig(): IsolatedMatrixConfig;
