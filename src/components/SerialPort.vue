<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import {
  openSerialPort,
  closeSerialPort,
  isConnected,
  sendStartCommand,
  sendManualStopCommand,
  sendStopCommand,
  sendStringCommand,
  setOnDataCallback,
  setOnConnectCallback,
  setOnDisconnectCallback,
  getHexMode,
  setDataMode,
  getAutoStopEnabled,
  setAutoStopEnabled,
  getAutoSaveEnabled,
  setAutoSaveEnabled as _setAutoSaveEnabled,
  getSaveFilePath,
  setSaveFilePath as _setSaveFilePath,
  flushPort,
} from '@/utils/serial.js'

const connected = ref(false)
const messageLog = ref([])
const statusText = ref('未连接')
const isHexMode = ref(true)
const isAutoStop = ref(false)

// 日志显示优化：只保留最新N条数据，避免内存溢出和渲染卡顿
const MAX_LOG_ITEMS = 100 // 最大显示日志条数
const isAutoSave = ref(false)
const saveFilePath = ref(null)
const isListening = ref(false)

// 串口配置
const baudRate = ref(2000000)
const stopBits = ref(1)
const dataBits = ref(8)
const parity = ref('none')

const parityOptions = [
  { label: 'None', value: 'none' },
  { label: 'Even', value: 'even' },
  { label: 'Odd', value: 'odd' },
]

const stopBitsOptions = [
  { label: '1', value: 1 },
  { label: '2', value: 2 },
]

const dataBitsOptions = [
  { label: '7', value: 7 },
  { label: '8', value: 8 },
]

function addLog(message, type = 'info', isFrame = false) {
  const now = new Date()
  const ms = String(now.getMilliseconds()).padStart(3, '0') + '000'
  const timestamp = now.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + ms.substring(0, 6)
  
  messageLog.value.push({
    timestamp,
    message,
    type,
    isFrame, // 标记是否为完整数据帧
  })
  
  // 限制日志数量，只保留最新MAX_LOG_ITEMS条
  if (messageLog.value.length > MAX_LOG_ITEMS) {
    messageLog.value = messageLog.value.slice(-MAX_LOG_ITEMS)
  }
}

async function connect() {
  try {
    await openSerialPort({
      baudRate: baudRate.value,
      dataBits: dataBits.value,
      stopBits: stopBits.value,
      parity: parity.value,
    })
    connected.value = true
    statusText.value = '已连接'
    addLog(`串口连接成功 [波特率:${baudRate.value}, 数据位:${dataBits.value}, 停止位:${stopBits.value}, 校验位:${parity.value}]`, 'success')
  } catch (error) {
    addLog(`连接失败: ${error.message}`, 'error')
  }
}

async function disconnect() {
  try {
    await closeSerialPort()
    connected.value = false
    statusText.value = '未连接'
    addLog('串口已断开', 'info')
  } catch (error) {
    addLog(`断开失败: ${error.message}`, 'error')
  }
}

function handleStart() {
  try {
    setAutoStopEnabled(isAutoStop.value)
    sendStartCommand()
    addLog('发送开始指令 (0x62)', 'success')
  } catch (error) {
    addLog(`发送失败: ${error.message}`, 'error')
  }
}

function handleStop() {
  try {
    sendManualStopCommand()
    addLog('发送停止指令 (0x73)', 'success')
  } catch (error) {
    addLog(`发送失败: ${error.message}`, 'error')
  }
}

function handleATUKISO() {
  try {
    sendStringCommand('AT-UKISO')
    addLog('发送指令: AT-UKISO', 'success')
  } catch (error) {
    addLog(`发送失败: ${error.message}`, 'error')
  }
}

function handleToggleDataMode() {
  isHexMode.value = !isHexMode.value
  setDataMode(isHexMode.value)
  addLog(`数据模式: ${isHexMode.value ? '十六进制' : '文本'}`, 'info')
}

function handleToggleAutoStop() {
  isAutoStop.value = !isAutoStop.value
  _setAutoSaveEnabled(isAutoStop.value)
  addLog(`自动停止: ${isAutoStop.value ? '开启' : '关闭'}`, 'info')
}

async function handleToggleAutoSave() {
  if (!isAutoSave.value) {
    // 开启自动保存，需要选择文件路径
    const result = await window.electronAPI.selectSavePath()
    if (result.canceled || !result.filePath) {
      addLog('取消自动保存', 'info')
      return
    }
    saveFilePath.value = result.filePath
    _setSaveFilePath(result.filePath)
    isAutoSave.value = true
    _setAutoSaveEnabled(true)
    addLog(`自动保存已开启: ${result.filePath}`, 'success')
  } else {
    // 关闭自动保存
    isAutoSave.value = false
    _setAutoSaveEnabled(false)
    _setSaveFilePath(null)
    saveFilePath.value = null
    addLog('自动保存已关闭', 'info')
  }
}

function handleClear() {
  messageLog.value = []
}

async function handleFlush() {
  try {
    await flushPort()
    addLog('已清空串口缓冲区（硬件缓冲区 + 帧解析缓冲区 + 文件写入缓冲区）', 'success')
  } catch (error) {
    addLog(`清空缓冲区失败: ${error.message}`, 'error')
  }
}

async function handleToggleListen() {
  if (!isListening.value) {
    // 如果未连接，先连接串口
    if (!connected.value) {
      try {
        await openSerialPort({
          baudRate: baudRate.value,
          dataBits: dataBits.value,
          stopBits: stopBits.value,
          parity: parity.value,
        })
        connected.value = true
        statusText.value = '已连接'
        addLog(`串口连接成功 [波特率:${baudRate.value}, 数据位:${dataBits.value}, 停止位:${stopBits.value}, 校验位:${parity.value}]`, 'success')
      } catch (error) {
        addLog(`连接失败: ${error.message}`, 'error')
        return
      }
    }

    // 自动开启自动保存（如果未开启）
    if (!isAutoSave.value) {
      const result = await window.electronAPI.selectSavePath()
      if (result.canceled || !result.filePath) {
        addLog('取消监听：未选择保存文件', 'info')
        return
      }
      saveFilePath.value = result.filePath
      _setSaveFilePath(result.filePath)
      isAutoSave.value = true
      _setAutoSaveEnabled(true)
      addLog(`自动保存已开启: ${result.filePath}`, 'success')
    }

    isListening.value = true
    statusText.value = '监听中'
    addLog('开始监听串口数据（不发送开始指令）...', 'success')
  } else {
    // 停止监听
    isListening.value = false
    statusText.value = connected.value ? '已连接' : '未连接'
    addLog('停止监听', 'info')
  }
}

function handleDisconnect() {
  connected.value = false
  isListening.value = false
  statusText.value = '已断开'
  addLog('设备断开连接', 'error')
}

onMounted(() => {
  isHexMode.value = getHexMode()
  isAutoStop.value = getAutoStopEnabled()
  isAutoSave.value = getAutoSaveEnabled()
  saveFilePath.value = getSaveFilePath()
  setOnDataCallback((data) => {
    // data.raw 是完整帧（209字节），标记为 isFrame = true
    addLog(data.data, 'data', true)
  })
  setOnConnectCallback(() => {
    connected.value = true
    statusText.value = '已连接'
  })
  setOnDisconnectCallback(handleDisconnect)
})

onUnmounted(() => {
  if (connected.value) {
    closeSerialPort()
  }
})
</script>

<template>
  <div class="serial-port">
    <div class="header">
      <h2>串口通信工具</h2>
      <div class="status">
        <span class="status-dot" :class="connected ? 'connected' : 'disconnected'"></span>
        <span>{{ statusText }}</span>
      </div>
    </div>

    <!-- 串口配置 -->
    <div class="config-section">
      <h3>串口配置</h3>
      <div class="config-grid">
        <div class="config-item">
          <label>波特率</label>
          <select v-model="baudRate" :disabled="connected">
            <option value="9600">9600</option>
            <option value="19200">19200</option>
            <option value="38400">38400</option>
            <option value="57600">57600</option>
            <option value="115200">115200</option>
            <option value="230400">230400</option>
            <option value="460800">460800</option>
            <option value="921600">921600</option>
            <option value="2000000">2000000</option>
          </select>
        </div>
        <div class="config-item">
          <label>数据位</label>
          <select v-model="dataBits" :disabled="connected">
            <option v-for="opt in dataBitsOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
        <div class="config-item">
          <label>停止位</label>
          <select v-model="stopBits" :disabled="connected">
            <option v-for="opt in stopBitsOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
        <div class="config-item">
          <label>校验位</label>
          <select v-model="parity" :disabled="connected">
            <option v-for="opt in parityOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
      </div>
    </div>

    <div class="controls">
      <button
        class="btn btn-connect"
        :disabled="connected"
        @click="connect"
      >
        连接串口
      </button>
      <button
        class="btn btn-disconnect"
        :disabled="!connected"
        @click="disconnect"
      >
        断开连接
      </button>
      <div class="divider"></div>
      <button
        class="btn btn-start"
        :disabled="!connected"
        @click="handleStart"
      >
        开始 (0x62)
      </button>
      <button
        class="btn btn-stop"
        :disabled="!connected"
        @click="handleStop"
      >
        停止 (0x73)
      </button>
      <button
        class="btn btn-ukiso"
        :disabled="!connected"
        @click="handleATUKISO"
      >
        AT-UKISO
      </button>
      <button
        class="btn"
        :class="isHexMode ? 'btn-hex-active' : 'btn-hex'"
        :disabled="!connected"
        @click="handleToggleDataMode"
      >
        {{ isHexMode ? 'HEX' : 'TEXT' }}
      </button>
      <button
        class="btn"
        :class="isAutoStop ? 'btn-auto-stop-active' : 'btn-auto-stop'"
        :disabled="!connected"
        @click="handleToggleAutoStop"
      >
        自动停止: {{ isAutoStop ? '开' : '关' }}
      </button>
      <button
        class="btn"
        :class="isAutoSave ? 'btn-auto-save-active' : 'btn-auto-save'"
        :disabled="!connected"
        @click="handleToggleAutoSave"
      >
        自动保存: {{ isAutoSave ? '开' : '关' }}
      </button>
      <button
        class="btn"
        :class="isListening ? 'btn-listen-active' : 'btn-listen'"
        @click="handleToggleListen"
      >
        {{ isListening ? '停止监听' : '监听' }}
      </button>
      <button
        class="btn btn-flush"
        :disabled="!connected"
        @click="handleFlush"
      >
        清空缓冲区
      </button>
      <button
        class="btn btn-clear"
        @click="handleClear"
      >
        清除日志
      </button>
    </div>

    <div class="log-container">
      <h3>数据记录</h3>
      <div class="log-list">
        <div
          v-for="(log, index) in messageLog"
          :key="index"
          class="log-item"
          :class="[log.type, log.isFrame ? 'frame-data' : '']"
        >
          <span class="log-time">{{ log.timestamp }}</span>
          <span v-if="log.isFrame" class="frame-badge">[帧]</span>
          <span class="log-message">{{ log.message }}</span>
        </div>
        <div v-if="messageLog.length === 0" class="empty">
          暂无数据记录
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.serial-port {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.header h2 {
  margin: 0;
  font-size: 24px;
  color: #333;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #666;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.status-dot.connected {
  background-color: #52c41a;
}

.status-dot.disconnected {
  background-color: #ff4d4f;
}

.config-section {
  background-color: #f5f5f5;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 20px;
}

.config-section h3 {
  margin: 0 0 12px 0;
  font-size: 16px;
  color: #333;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.config-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-item label {
  font-size: 12px;
  color: #666;
}

.config-item select {
  padding: 8px;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  font-size: 14px;
  background-color: white;
}

.config-item select:disabled {
  background-color: #f5f5f5;
  cursor: not-allowed;
}

.controls {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
  align-items: center;
}

.btn {
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-connect {
  background-color: #1890ff;
  color: white;
}

.btn-connect:hover:not(:disabled) {
  background-color: #096dd9;
}

.btn-disconnect {
  background-color: #faad14;
  color: white;
}

.btn-disconnect:hover:not(:disabled) {
  background-color: #d48806;
}

.btn-start {
  background-color: #52c41a;
  color: white;
}

.btn-start:hover:not(:disabled) {
  background-color: #389e0d;
}

.btn-stop {
  background-color: #ff4d4f;
  color: white;
}

.btn-stop:hover:not(:disabled) {
  background-color: #d9363e;
}

.btn-ukiso {
  background-color: #722ed1;
  color: white;
}

.btn-ukiso:hover:not(:disabled) {
  background-color: #531dab;
}

.btn-hex {
  background-color: #e8e8e8;
  color: #666;
}

.btn-hex:hover:not(:disabled) {
  background-color: #d9d9d9;
}

.btn-hex-active {
  background-color: #1890ff;
  color: white;
}

.btn-hex-active:hover:not(:disabled) {
  background-color: #096dd9;
}

.btn-auto-stop {
  background-color: #e8e8e8;
  color: #666;
}

.btn-auto-stop:hover:not(:disabled) {
  background-color: #d9d9d9;
}

.btn-auto-stop-active {
  background-color: #fa8c16;
  color: white;
}

.btn-auto-stop-active:hover:not(:disabled) {
  background-color: #d46b08;
}

.btn-auto-save {
  background-color: #e8e8e8;
  color: #666;
}

.btn-auto-save:hover:not(:disabled) {
  background-color: #d9d9d9;
}

.btn-auto-save-active {
  background-color: #13c2c2;
  color: white;
}

.btn-auto-save-active:hover:not(:disabled) {
  background-color: #08979c;
}

.btn-clear {
  background-color: #f0f0f0;
  color: #333;
}

.btn-flush {
  background-color: #fff0f6;
  color: #c41d7f;
  border: 1px solid #ffadd2;
}

.btn-flush:hover:not(:disabled) {
  background-color: #ffadd2;
  color: #fff;
}

.btn-clear:hover {
  background-color: #d9d9d9;
}

.btn-listen {
  background-color: #e8e8e8;
  color: #666;
}

.btn-listen:hover:not(:disabled) {
  background-color: #d9d9d9;
}

.btn-listen-active {
  background-color: #eb2f96;
  color: white;
}

.btn-listen-active:hover:not(:disabled) {
  background-color: #c41d7f;
}

.divider {
  width: 1px;
  height: 32px;
  background-color: #e8e8e8;
}

.log-container {
  background-color: #f5f5f5;
  border-radius: 8px;
  padding: 16px;
  max-height: 400px;
  overflow-y: auto;
}

.log-container h3 {
  margin: 0 0 12px 0;
  font-size: 16px;
  color: #333;
}

.log-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-item {
  display: flex;
  gap: 12px;
  padding: 8px;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.4;
}

.log-item.info {
  background-color: #e6f7ff;
  color: #0050b3;
}

.log-item.success {
  background-color: #f6ffed;
  color: #389e0d;
}

.log-item.error {
  background-color: #fff2f0;
  color: #cf1322;
}

.log-item.data {
  background-color: #fafafa;
  color: #333;
  font-family: 'Courier New', monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-item.frame-data {
  background-color: #f0f5ff;
  border-left: 3px solid #1890ff;
}

.frame-badge {
  background-color: #1890ff;
  color: white;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: bold;
}

.log-time {
  color: #999;
  white-space: nowrap;
}

.log-message {
  flex: 1;
  word-break: break-all;
}

.empty {
  text-align: center;
  color: #999;
  padding: 20px;
}
</style>
