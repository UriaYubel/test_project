/**
 * 串口通信服务
 * 使用 Electron + Node.js serialport 实现串口数据收发
 */

let portId = null
let portPath = null
let onDataCallback = null
let onConnectCallback = null
let onDisconnectCallback = null
let onErrorCallback = null

let hexMode = true
let autoStopEnabled = false
let hasReceivedData = false

// 自动保存相关
let autoSaveEnabled = false
let saveFilePath = null

/**
 * 设置自动停止模式
 * @param {boolean} enabled - true=开启, false=关闭
 */
export function setAutoStopEnabled(enabled) {
  autoStopEnabled = enabled
  hasReceivedData = false
}

/**
 * 获取自动停止模式
 * @returns {boolean}
 */
export function getAutoStopEnabled() {
  return autoStopEnabled
}

/**
 * 设置数据显示模式
 * @param {boolean} isHex - true=十六进制, false=文本
 */
export function setDataMode(isHex) {
  hexMode = isHex
}

/**
 * 获取当前数据显示模式
 * @returns {boolean}
 */
export function getHexMode() {
  return hexMode
}

/**
 * 设置自动保存状态
 * @param {boolean} enabled - true=开启, false=关闭
 */
export function setAutoSaveEnabled(enabled) {
  autoSaveEnabled = enabled
}

/**
 * 获取自动保存状态
 * @returns {boolean}
 */
export function getAutoSaveEnabled() {
  return autoSaveEnabled
}

/**
 * 设置保存文件路径
 * @param {string|null} path - 文件路径，null表示未选择
 */
export function setSaveFilePath(path) {
  saveFilePath = path
}

/**
 * 获取保存文件路径
 * @returns {string|null}
 */
export function getSaveFilePath() {
  return saveFilePath
}

/**
 * 获取可用串口列表
 * @returns {Promise<Array<{path: string, displayName: string, manufacturer: string, serialNumber: string, productId: string, vendorId: string}>>}
 */
export async function listPorts() {
  if (!window.electronAPI) {
    throw new Error('当前环境不支持串口通信')
  }
  return await window.electronAPI.listPorts()
}

/**
 * 打开串口（使用端口选择弹窗）
 * @param {Object} options - 串口配置选项
 * @param {string} options.path - 串口路径（如 'COM3'），如果不传则弹出选择
 * @param {number} options.baudRate - 波特率
 * @param {number} options.dataBits - 数据位
 * @param {number} options.stopBits - 停止位
 * @param {string} options.parity - 校验位 ('none' | 'even' | 'odd')
 * @param {number} options.bufferSize - 缓冲区大小
 * @param {Function} onPortSelect - 端口选择回调（当没有传 path 时调用，返回选择的端口路径）
 */
export async function openSerialPort(options = {}, onPortSelect) {
  const {
    baudRate = 2000000,
    dataBits = 8,
    stopBits = 1,
    parity = 'none',
    bufferSize = 209,
  } = options

  if (!window.electronAPI) {
    throw new Error('当前环境不支持串口通信')
  }

  // 如果指定了 path，直接使用；否则弹出选择弹窗
  let selectedPath = options.path
  if (!selectedPath) {
    const result = await window.electronAPI.selectPort()
    if (result.canceled) {
      throw new Error('未选择串口设备')
    }
    selectedPath = result.path
  }

  if (!selectedPath) {
    throw new Error('未选择串口设备')
  }

  portId = selectedPath
  portPath = selectedPath

  try {
    const result = await window.electronAPI.openPort({
      portId,
      config: {
        path: selectedPath,
        options: {
          baudRate,
          dataBits,
          stopBits,
          parity,
          bufferSize,
        },
      },
    })

    if (!result.success) {
      throw new Error(result.error)
    }

    // 设置事件监听
    setupEventListeners()

    // 打开串口后自动清空一次缓冲区（忽略失败，不影响后续使用）
    window.electronAPI.flushPort(portId).catch((err) => {
      console.warn('打开串口后自动清空缓冲区失败:', err)
    })

    if (onConnectCallback) {
      onConnectCallback()
    }

    return { success: true }
  } catch (error) {
    throw error
  }
}

/**
 * 设置事件监听
 */
function setupEventListeners() {
  window.electronAPI.onConnected((data) => {
    if (data.portId === portId && onConnectCallback) {
      onConnectCallback()
    }
  })

  window.electronAPI.onDisconnected((data) => {
    if (data.portId === portId) {
      portId = null
      portPath = null
      if (onDisconnectCallback) {
        onDisconnectCallback()
      }
    }
  })

  window.electronAPI.onError((data) => {
    if (data.portId === portId && onErrorCallback) {
      onErrorCallback(data.error)
    }
  })

  window.electronAPI.onData((data) => {
    if (data.portId === portId && onDataCallback) {
      const displayData = data.data

      // 自动发送停止指令
      if (autoStopEnabled && !hasReceivedData) {
        hasReceivedData = true
        if (portId) {
          window.electronAPI.sendStop(portId).catch((err) => {
            console.error('自动发送停止指令失败:', err)
          })
        }
      }

      // 自动保存到文件（formattedLine已在Worker中预生成，无需再次转换）
      if (autoSaveEnabled && saveFilePath && data.formattedLine) {
        window.electronAPI.appendToFile(saveFilePath, data.formattedLine).catch((err) => {
          console.error('保存数据到文件失败:', err)
        })
      }

      onDataCallback(displayData)
    }
  })
}

/**
 * 关闭串口
 */
export async function closeSerialPort() {
  if (!window.electronAPI || !portId) {
    return
  }

  try {
    await window.electronAPI.closePort(portId)
  } catch (error) {
    console.error('关闭串口失败:', error)
  }

  portId = null
  portPath = null

  if (onDisconnectCallback) {
    onDisconnectCallback()
  }
}

/**
 * 检查串口是否已连接
 */
export function isConnected() {
  return portId !== null
}

/**
 * 发送十六进制指令
 * @param {number} hexValue - 十六进制值 (0-255)
 */
export function sendHexCommand(hexValue) {
  if (!portId) {
    throw new Error('串口未连接')
  }
  return window.electronAPI.sendHexCommand(portId, hexValue)
}

/**
 * 发送停止指令 (0x73)
 */
export function sendStopCommand() {
  sendHexCommand(0x73)
}

/**
 * 发送开始指令 (0x62)
 */
export function sendStartCommand() {
  hasReceivedData = false
  sendHexCommand(0x62)
}

/**
 * 发送手动停止指令
 */
export function sendManualStopCommand() {
  hasReceivedData = false
  sendStopCommand()
}

/**
 * 发送字符串指令
 * @param {string} text - 要发送的字符串
 */
export function sendStringCommand(text) {
  if (!portId) {
    throw new Error('串口未连接')
  }
  return window.electronAPI.sendString(portId, text)
}

/**
 * 设置数据接收回调
 * @param {Function} callback - 接收数据时调用，参数为接收到的字符串数据
 */
export function setOnDataCallback(callback) {
  onDataCallback = callback
}

/**
 * 设置连接回调
 * @param {Function} callback - 连接成功时调用
 */
export function setOnConnectCallback(callback) {
  onConnectCallback = callback
}

/**
 * 设置断开回调
 * @param {Function} callback - 断开连接时调用
 */
export function setOnDisconnectCallback(callback) {
  onDisconnectCallback = callback
}

/**
 * 设置错误回调
 * @param {Function} callback - 发生错误时调用
 */
export function setOnErrorCallback(callback) {
  onErrorCallback = callback
}

/**
 * 清空串口缓冲区（硬件缓冲 + 帧解析缓冲）
 */
export async function flushPort() {
  if (!portId) {
    throw new Error('串口未连接')
  }
  return window.electronAPI.flushPort(portId)
}

/**
 * 销毁串口服务
 */
export function destroy() {
  if (portId) {
    closeSerialPort()
  }
}
