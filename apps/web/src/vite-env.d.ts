/// <reference types="vite/client" />

interface ElectronAPI {
  getServerPort: () => Promise<number | null>;
  pickDirectory: () => Promise<string | null>;
}

interface Window {
  electronAPI?: ElectronAPI;
}