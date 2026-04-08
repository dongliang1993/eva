const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform
  },
  getServerPort: (): Promise<number | null> =>
    ipcRenderer.invoke("get-server-port")
});
