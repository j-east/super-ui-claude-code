// Bridge between the page and the Electron host. The page talks to `window.cpHost.postMessage(...)`
// exactly as it talks to the Mac app's script bridge.
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

contextBridge.exposeInMainWorld('cpHost', {
  postMessage: (m) => ipcRenderer.send('cp-host', m),
});

// Dropping files or folders on the window types their paths into the active tab, like a terminal does.
const WIN = process.platform === 'win32';
const quote = (p) => (WIN
  ? (/[\s'&()$;`]/.test(p) ? `'${p.replace(/'/g, "''")}'` : p)
  : p.replace(/[^\w\-.,:/@+=%^~]/g, '\\$&'));
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  const text = files.map((f) => quote(webUtils.getPathForFile(f))).filter(Boolean).join(' ') + ' ';
  void webFrame.executeJavaScript(`window.cp?.paste(${JSON.stringify(text)})`);
});
