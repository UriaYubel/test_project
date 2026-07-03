const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 列出可用串口
  listPorts: () => ipcRenderer.invoke('serial:list-ports'),

  // 串口选择弹窗
  selectPort: () => ipcRenderer.invoke('serial:select-port'),

  // 打开串口
  openPort: (config) => ipcRenderer.invoke('serial:open', config),

  // 关闭串口
  closePort: (portId) => ipcRenderer.invoke('serial:close', portId),

  // 发送十六进制指令
  sendHexCommand: (portId, value) =>
    ipcRenderer.invoke('serial:write-hex', { portId, value }),

  // 发送字符串指令
  sendStringCommand: (portId, text) =>
    ipcRenderer.invoke('serial:write-string', { portId, text }),

  // 发送开始指令
  sendStart: (portId) => ipcRenderer.invoke('serial:send-start', { portId }),

  // 发送停止指令
  sendStop: (portId) => ipcRenderer.invoke('serial:send-stop', { portId }),

  // 发送自定义字符串指令
  sendString: (portId, text) =>
    ipcRenderer.invoke('serial:send-string', { portId, text }),

  // 事件监听
  onData: (callback) => {
    ipcRenderer.on('serial:data', (_event, data) => callback(data))
  },
  onConnected: (callback) => {
    ipcRenderer.on('serial:connected', (_event, data) => callback(data))
  },
  onDisconnected: (callback) => {
    ipcRenderer.on('serial:disconnect', (_event, data) => callback(data))
  },
  onError: (callback) => {
    ipcRenderer.on('serial:error', (_event, data) => callback(data))
  },

  // 清空串口缓冲区
  flushPort: (portId) => ipcRenderer.invoke('serial:flush', portId),

  // 文件保存相关
  selectSavePath: () => ipcRenderer.invoke('file:select-save-path'),
  appendToFile: (filePath, formattedLine) =>
    ipcRenderer.invoke('file:append-to-file', { filePath, formattedLine }),
})
