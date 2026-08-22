/// <reference types="vite/client" />

interface ElectronAPI {
  getServerPort: () => Promise<number | null>;
  getServerInfo: () => Promise<{ port: number | null; token: string | null }>;
  pickDirectory: () => Promise<string | null>;
  onDeepLink: (callback: (url: string) => void) => () => void;
  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<boolean>;
  updaterCheck: () => Promise<void>;
  updaterInstall: () => Promise<void>;
  onUpdaterStatus: (
    callback: (status: Record<string, unknown>) => void
  ) => () => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}