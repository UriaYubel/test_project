const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { SerialPort } = require('serialport')
const { ByteLengthParser } = require('@serialport/parser-byte-length')

// 隐藏菜单栏
Menu.setApplicationMenu(null)

// 端口管理
const ports = new Map() // portId -> SerialPort instance
const callbacks = new Map() // portId -> callback refs

// 文件写入缓冲 - 批量写入优化
const fileWriteBuffers = new Map() // filePath -> { buffer: string[], timer: Timer, maxSize: number }
const FILE_BUFFER_MAX_SIZE = 50 // 缓冲区最大条目数（达到后强制刷新）
const FILE_BUFFER_FLUSH_INTERVAL = 1000 // 定时刷新间隔（毫秒）

// 帧解析相关常量与状态
const FRAME_START_BYTE = 0xA0
const FRAME_END_BYTE = 0xC0
const FRAME_LENGTH = 209
const portFrameBuffers = new Map() // portId -> Buffer

function parseFrames(portId, newData) {
  let buffer = portFrameBuffers.get(portId)
  if (!buffer) buffer = Buffer.alloc(0)
  buffer = Buffer.concat([buffer, newData])
  const frames = []

  while (buffer.length >= FRAME_LENGTH) {
    let startIndex = -1
    for (let i = 0; i <= buffer.length - FRAME_LENGTH; i++) {
      if (buffer[i] === FRAME_START_BYTE && buffer[i + FRAME_LENGTH - 1] === FRAME_END_BYTE) {
        startIndex = i
        break
      }
    }
    if (startIndex === -1) {
      let lastPossibleStart = -1
      for (let i = buffer.length - 1; i >= Math.max(0, buffer.length - FRAME_LENGTH + 1); i--) {
        if (buffer[i] === FRAME_START_BYTE) { lastPossibleStart = i; break }
      }
      buffer = lastPossibleStart >= 0 ? buffer.subarray(lastPossibleStart) : Buffer.alloc(0)
      portFrameBuffers.set(portId, buffer)
      return frames
    }
    frames.push(buffer.subarray(startIndex, startIndex + FRAME_LENGTH))
    buffer = buffer.subarray(startIndex + FRAME_LENGTH)
  }
  portFrameBuffers.set(portId, buffer)
  return frames
}

function bufferToHexString(buffer) {
  const hex = new Array(buffer.length)
  for (let i = 0; i < buffer.length; i++) hex[i] = buffer[i].toString(16).padStart(2, '0').toUpperCase()
  return hex.join(' ')
}

function generateTimestamp(millis = null) {
  const d = millis ? new Date(millis) : new Date()
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0') + '.' + String(d.getMilliseconds()).padStart(3,'0')
}

// 串口配置映射 - serialport v13 使用字符串
const parityMap = {
  none: 'none',
  even: 'even',
  odd: 'odd',
}

const stopBitsMap = {
  1: 1,
  2: 2,
}

/**
 * 获取可用串口列表
 */
async function listPorts() {
  try {
    const ports = await SerialPort.list().catch(() => [])
    return ports
      .filter(p => p.productId && p.vendorId) // 过滤无效端口
      .map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        serialNumber: p.serialNumber || '',
        productId: p.productId,
        vendorId: p.vendorId,
        displayName: p.manufacturer
          ? `${p.path} - ${p.manufacturer} (${p.serialNumber})`
          : p.path,
      }))
  } catch (error) {
    console.error('列出串口失败:', error)
    return []
  }
}

/**
 * 获取串口配置选项
 */
function getPortOptions(config) {
  return {
    baudRate: config.baudRate || 9600,
    dataBits: config.dataBits || 8,
    stopBits: config.stopBits || 1,
    parity: parityMap[config.parity || 'none'] ?? SerialPort.PARITY.NONE,
    bufferSize: config.bufferSize || 209, // 改为帧大小，减少驱动层缓冲
    autoOpen: true,
  }
}

// IPC 处理 - 串口选择弹窗
ipcMain.handle('serial:select-port', async () => {
  const availablePorts = await listPorts()

  if (availablePorts.length === 0) {
    return { canceled: true }
  }

  const win = BrowserWindow.getFocusedWindow()
  if (!win) {
    return { canceled: true }
  }

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '选择串口',
    message: '请选择要连接的串口设备',
    buttons: availablePorts.map(p => p.displayName),
    cancelId: availablePorts.length,
    defaultId: 0,
  })

  if (response >= availablePorts.length) {
    return { canceled: true }
  }

  return { canceled: false, path: availablePorts[response].path }
})

/**
 * 选择保存文件路径
 */
ipcMain.handle('file:select-save-path', async () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) {
    return { canceled: true }
  }

  // 生成默认文件名：脑电数据_YYYYMMDD_HHMMSS.txt
  const now = new Date()
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const defaultFileName = `脑电数据_${timestamp}.txt`

  const result = await dialog.showSaveDialog(win, {
    title: '选择保存位置',
    defaultPath: defaultFileName,
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })

  if (result.canceled || !result.filePath) {
    return { canceled: true }
  }

  return { canceled: false, filePath: result.filePath }
})

/**
 * 刷新文件写入缓冲区
 */
function flushFileBuffer(filePath) {
  const bufferInfo = fileWriteBuffers.get(filePath)
  if (!bufferInfo || bufferInfo.buffer.length === 0) return

  try {
    // 批量写入所有缓冲的数据
    const content = bufferInfo.buffer.join('')
    fs.appendFileSync(filePath, content, 'utf8')
    
    // 清空缓冲区
    bufferInfo.buffer = []
  } catch (error) {
    console.error(`批量写入文件失败 [${filePath}]:`, error)
  }
}

// Worker 内联代码已包含帧解析逻辑，主线程无需额外帧解析

/**
 * 追加数据到文件 - 批量写入优化版本
 * formattedLine 已在Worker中生成，主线程只做缓冲区聚合和文件IO
 */
ipcMain.handle('file:append-to-file', async (event, { filePath, formattedLine }) => {
  try {
    // 获取或创建缓冲区
    let bufferInfo = fileWriteBuffers.get(filePath)
    if (!bufferInfo) {
      bufferInfo = {
        buffer: [],
        timer: null,
        maxSize: FILE_BUFFER_MAX_SIZE
      }
      fileWriteBuffers.set(filePath, bufferInfo)
    }
    
    // 添加到缓冲区（formattedLine已由Worker预格式化）
    bufferInfo.buffer.push(formattedLine)
    
    // 如果达到最大缓冲区大小，立即刷新
    if (bufferInfo.buffer.length >= bufferInfo.maxSize) {
      if (bufferInfo.timer) {
        clearTimeout(bufferInfo.timer)
        bufferInfo.timer = null
      }
      flushFileBuffer(filePath)
    } else if (!bufferInfo.timer) {
      // 否则设置定时刷新
      bufferInfo.timer = setTimeout(() => {
        flushFileBuffer(filePath)
        bufferInfo.timer = null
      }, FILE_BUFFER_FLUSH_INTERVAL)
    }
    
    return { success: true }
  } catch (error) {
    console.error('写入文件失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('serial:list-ports', async () => {
  return await listPorts()
})

ipcMain.handle('serial:open', async (event, { portId, config }) => {
  // 如果已打开，先关闭
  if (ports.has(portId)) {
    const existing = ports.get(portId)
    try {
      await new Promise((resolve) => {
        existing.close(() => resolve())
      })
    } catch (e) {
      // ignore
    }
    ports.delete(portId)
  }

  try {
    const serialPort = new SerialPort({
      path: config.path,
      ...getPortOptions(config.options),
    })

    // 等待串口真正打开
    await new Promise((resolve, reject) => {
      if (serialPort.isOpen) {
        resolve()
      } else {
        serialPort.once('open', () => resolve())
        serialPort.once('error', (err) => reject(err))
      }
    })

    // 数据读取 - 使用 ByteLengthParser 精确每次读取 209 字节，减少底层批量读取堆积
    const parser = serialPort.pipe(new ByteLengthParser({ length: FRAME_LENGTH }))

    parser.on('data', (data) => {
      if (!ports.has(portId)) return
      const receiveTime = Date.now()

      // 将 209 字节传给 parseFrames，处理错位和跨边界
      const frames = parseFrames(portId, data)
      if (frames.length === 0) return

      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return

      frames.forEach((frame, i) => {
        const hex = bufferToHexString(frame)
        const ts = generateTimestamp(receiveTime + i)
        const formattedLine = '(' + ts + ') ' + hex + '\n'
        win.webContents.send('serial:data', {
          portId,
          data: hex,
          formattedLine: formattedLine
        })
      })
    })

    // 关闭事件
    serialPort.on('close', () => {
      // 解除 pipe 并销毁 parser
      serialPort.unpipe(parser)
      parser.destroy()
      
      // 清理主线程帧解析缓冲区
      portFrameBuffers.delete(portId)
      
      // 刷新该端口的所有文件缓冲区
      for (const [filePath, bufferInfo] of fileWriteBuffers.entries()) {
        if (bufferInfo.timer) {
          clearTimeout(bufferInfo.timer)
          bufferInfo.timer = null
        }
        flushFileBuffer(filePath)
        fileWriteBuffers.delete(filePath)
      }
      
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) {
        win.webContents.send('serial:disconnect', { portId })
      }
      ports.delete(portId)
    })

    // 错误事件
    serialPort.on('error', (error) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) {
        win.webContents.send('serial:error', { portId, error: error.message })
      }
    })

    ports.set(portId, serialPort)

    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      win.webContents.send('serial:connected', { portId })
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('serial:flush', async (event, portId) => {
  const serialPort = ports.get(portId)
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: '串口未连接' }
  }
  try {
    // 1. 清空串口硬件接收缓冲区
    await new Promise((resolve, reject) => {
      serialPort.flush((err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // 2. 清理主线程帧解析缓冲区
    portFrameBuffers.delete(portId)

    // 3. 刷新该端口的所有文件写入缓冲区
    for (const [filePath, bufferInfo] of fileWriteBuffers.entries()) {
      if (bufferInfo.buffer.length > 0) {
        if (bufferInfo.timer) {
          clearTimeout(bufferInfo.timer)
          bufferInfo.timer = null
        }
        flushFileBuffer(filePath)
      }
    }

    return { success: true }
  } catch (error) {
    console.error('清空缓冲区失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('serial:close', async (event, portId) => {
  const serialPort = ports.get(portId)
  if (serialPort) {
    try {
      await new Promise((resolve, reject) => {
        serialPort.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } catch (error) {
      console.error('关闭串口失败:', error)
      return { success: false, error: error.message }
    }
    ports.delete(portId)
  }
  return { success: true }
})

/**
 * 向串口写入数据并等待刷新
 * @param {SerialPort} serialPort - 串口实例
 * @param {Buffer} buffer - 要写入的数据
 * @returns {Promise<void>}
 */
function writeAndDrain(serialPort, buffer) {
  return new Promise((resolve, reject) => {
    serialPort.write(buffer, (err) => {
      if (err) return reject(err)
      serialPort.drain((drainErr) => {
        if (drainErr) return reject(drainErr)
        resolve()
      })
    })
  })
}

ipcMain.handle('serial:write-hex', async (event, { portId, value }) => {
  const serialPort = ports.get(portId)
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: '串口未连接' }
  }
  try {
    const buffer = Buffer.from([value])
    await writeAndDrain(serialPort, buffer)
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('serial:write-string', async (event, { portId, text }) => {
  const serialPort = ports.get(portId)
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: '串口未连接' }
  }
  try {
    const buffer = Buffer.from(text + '\r\n')
    await writeAndDrain(serialPort, buffer)
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.on('serial:register-callbacks', (event, { portId }) => {
  callbacks.set(portId, {
    onData: null,
    onConnected: null,
    onDisconnected: null,
  })
})

ipcMain.handle('serial:send-start', async (event, { portId }) => {
  const serialPort = ports.get(portId)
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: '串口未连接' }
  }
  try {
    await writeAndDrain(serialPort, Buffer.from([0x62]))
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('serial:send-stop', async (event, { portId }) => {
  const serialPort = ports.get(portId)
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: '串口未连接' }
  }
  try {
    await writeAndDrain(serialPort, Buffer.from([0x73]))
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('serial:send-string', async (event, { portId, text }) => {
  const serialPort = ports.get(portId)
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: '串口未连接' }
  }
  try {
    const buffer = Buffer.from(text + '\r\n')
    await writeAndDrain(serialPort, buffer)
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    menuBarVisible: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  if (process.env.NODE_ENV === 'development') {
    // 开发模式加载 Vite 开发服务器
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    // 生产模式加载打包后的 HTML 文件
    win.loadFile(path.join(__dirname, '../dist/index.html'))
    // 生产模式也开启开发者工具（方便调试，正式发布前可删除此行）
    win.webContents.openDevTools()
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
