/// <reference types="vite/client" />

interface ElectronAPI {
  readonly versions: {
    readonly electron: string;
    readonly node: string;
    readonly platform: string;
  };
  getAppVersion: () => Promise<string>;
  getServerPort: () => Promise<number | null>;
  getServerInfo: () => Promise<{ port: number | null; token: string | null }>;
  pickDirectory: () => Promise<string | null>;
  onDeepLink: (callback: (url: string) => void) => () => void;
  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<boolean>;
  updaterCheck: () => Promise<void>;
  updaterDownload: () => Promise<void>;
  updaterInstall: () => Promise<void>;
  getUpdaterStatus: () => Promise<Record<string, unknown> | null>;
  onUpdaterStatus: (
    callback: (status: Record<string, unknown>) => void
  ) => () => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}