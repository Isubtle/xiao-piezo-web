import {
  CONTROL_UUID,
  CSV_HEADER,
  DATA_UUID,
  DEVICE_NAME_PREFIX,
  MODE_CONTINUOUS,
  MODE_ONE_WINDOW,
  MODE_STANDBY,
  SERVICE_UUID,
  STATUS_UUID,
  decodeDataPacket,
  encodeMode,
  modeLabel,
  packetToCsvRow,
} from "./ble_protocol.mjs";

const MAX_CHART_POINTS = 2400;
const MAX_CSV_ROWS = 100000;

const elements = Object.fromEntries(
  [
    "connectionDot",
    "connectionText",
    "compatibilityBanner",
    "connectButton",
    "disconnectButton",
    "demoButton",
    "startButton",
    "oneWindowButton",
    "stopButton",
    "modeText",
    "autoStopCheckbox",
    "liveMeanValue",
    "windowMeanValue",
    "acRmsValue",
    "peakToPeakValue",
    "timeWindowSelect",
    "liveChart",
    "featureChart",
    "elapsedValue",
    "packetCountValue",
    "packetRateValue",
    "clearButton",
    "exportButton",
    "messageText",
  ].map((id) => [id, document.getElementById(id)]),
);

const messageCard = elements.messageText.closest(".message-card");

let device = null;
let controlCharacteristic = null;
let dataCharacteristic = null;
let statusCharacteristic = null;
let connecting = false;
let currentMode = MODE_STANDBY;
let demoMode = false;
let demoTimer = null;
let demoTime = 0;
let sessionOrigin = null;
let points = [];
let csvRows = [];
let arrivalTimes = [];
let drawPending = false;

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

class LineChart {
  constructor(canvas, series, emptyText) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.series = series;
    this.emptyText = emptyText;
  }

  draw(data, windowSeconds) {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(320, rect.width);
    const height = Math.max(220, rect.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const targetWidth = Math.round(width * ratio);
    const targetHeight = Math.round(height * ratio);
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }

    const ctx = this.context;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const margin = { left: 58, right: 18, top: 18, bottom: 39 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;

    ctx.fillStyle = "rgba(4, 18, 24, 0.42)";
    ctx.fillRect(margin.left, margin.top, plotWidth, plotHeight);

    if (data.length === 0) {
      ctx.fillStyle = cssColor("--muted");
      ctx.font = '14px "Segoe UI", sans-serif';
      ctx.textAlign = "center";
      ctx.fillText(this.emptyText, margin.left + plotWidth / 2, margin.top + plotHeight / 2);
      this.drawFrame(ctx, margin, plotWidth, plotHeight);
      return;
    }

    const lastTime = data[data.length - 1].time;
    const xMin = Math.max(0, lastTime - windowSeconds);
    const xMax = Math.max(windowSeconds, lastTime);
    const visible = data.filter((point) => point.time >= xMin);

    let yMax = 0.05;
    for (const point of visible) {
      for (const series of this.series) {
        yMax = Math.max(yMax, Number(point[series.key]) || 0);
      }
    }
    yMax *= 1.12;

    const mapX = (value) => margin.left + ((value - xMin) / (xMax - xMin)) * plotWidth;
    const mapY = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;

    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let tick = 0; tick <= 5; tick += 1) {
      const value = (yMax * tick) / 5;
      const y = mapY(value);
      ctx.strokeStyle = cssColor("--grid");
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotWidth, y);
      ctx.stroke();
      ctx.fillStyle = cssColor("--muted");
      ctx.fillText(value.toFixed(yMax < 0.5 ? 3 : 2), margin.left - 9, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let tick = 0; tick <= 6; tick += 1) {
      const value = xMin + ((xMax - xMin) * tick) / 6;
      const x = mapX(value);
      ctx.strokeStyle = cssColor("--grid");
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + plotHeight);
      ctx.stroke();
      ctx.fillStyle = cssColor("--muted");
      ctx.fillText(`${value.toFixed(0)} s`, x, margin.top + plotHeight + 10);
    }

    for (const series of this.series) {
      ctx.strokeStyle = series.color();
      ctx.lineWidth = series.width ?? 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      let started = false;
      for (const point of visible) {
        const value = point[series.key];
        if (!Number.isFinite(value)) continue;
        const x = mapX(point.time);
        const y = mapY(value);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    this.drawFrame(ctx, margin, plotWidth, plotHeight);
  }

  drawFrame(ctx, margin, width, height) {
    ctx.strokeStyle = "rgba(174, 218, 228, 0.24)";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, width, height);
  }
}

const liveChart = new LineChart(
  elements.liveChart,
  [{ key: "liveMeanV", color: () => cssColor("--teal"), width: 2.2 }],
  "连接设备并开始采集后显示曲线",
);

const featureChart = new LineChart(
  elements.featureChart,
  [
    { key: "windowMeanV", color: () => cssColor("--green"), width: 1.8 },
    { key: "acRmsV", color: () => cssColor("--purple"), width: 2 },
    { key: "peakToPeakV", color: () => cssColor("--orange"), width: 2 },
  ],
  "每完成一个 2 秒窗口后更新特征",
);

function showMessage(message, isError = false) {
  elements.messageText.textContent = message;
  messageCard.classList.toggle("error", isError);
}

function isBleConnected() {
  return Boolean(device?.gatt?.connected && controlCharacteristic && dataCharacteristic);
}

function updateControls() {
  const connected = isBleConnected();
  const usable = connected || demoMode;
  elements.connectButton.disabled = connecting || connected || demoMode;
  elements.disconnectButton.disabled = !connected;
  elements.demoButton.disabled = connecting || connected;
  elements.startButton.disabled = !usable || currentMode === MODE_CONTINUOUS;
  elements.oneWindowButton.disabled = !usable || currentMode === MODE_ONE_WINDOW;
  elements.stopButton.disabled = !usable || currentMode === MODE_STANDBY;

  elements.connectionDot.classList.toggle("connected", connected);
  elements.connectionDot.classList.toggle("demo", demoMode);
  elements.connectionText.textContent = connecting
    ? "正在连接"
    : connected
      ? device.name || "已连接"
      : demoMode
        ? "界面演示"
        : "未连接";
}

function updateMode(mode) {
  currentMode = mode;
  elements.modeText.textContent = modeLabel(mode);
  elements.modeText.style.color =
    mode === MODE_STANDBY ? cssColor("--green") : cssColor("--orange");
  updateControls();
}

function formatVoltage(value) {
  return Number.isFinite(value) ? value.toFixed(4) : "—";
}

function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    const windowSeconds = Number(elements.timeWindowSelect.value);
    liveChart.draw(points, windowSeconds);
    featureChart.draw(points, windowSeconds);
  });
}

function updatePacketRate(now) {
  arrivalTimes.push(now);
  const cutoff = now - 3000;
  arrivalTimes = arrivalTimes.filter((value) => value >= cutoff);
  let rate = 0;
  if (arrivalTimes.length >= 2) {
    rate = ((arrivalTimes.length - 1) * 1000) /
      (arrivalTimes[arrivalTimes.length - 1] - arrivalTimes[0]);
  }
  elements.packetRateValue.textContent = `${rate.toFixed(1)} Hz`;
}

function acceptPacket(packet, hostTime = new Date()) {
  if (sessionOrigin === null || packet.acquisitionTimeS < sessionOrigin) {
    sessionOrigin = packet.acquisitionTimeS;
  }
  const relativeTime = Math.max(0, packet.acquisitionTimeS - sessionOrigin);
  points.push({ time: relativeTime, ...packet });
  if (points.length > MAX_CHART_POINTS) points.shift();

  csvRows.push(packetToCsvRow(hostTime.toISOString(), packet));
  if (csvRows.length > MAX_CSV_ROWS) csvRows.shift();

  elements.liveMeanValue.textContent = formatVoltage(packet.liveMeanV);
  elements.windowMeanValue.textContent = formatVoltage(packet.windowMeanV);
  elements.acRmsValue.textContent = formatVoltage(packet.acRmsV);
  elements.peakToPeakValue.textContent = formatVoltage(packet.peakToPeakV);
  elements.elapsedValue.textContent = `${relativeTime.toFixed(1)} s`;
  elements.packetCountValue.textContent = `${csvRows.length} 包`;
  elements.exportButton.disabled = csvRows.length === 0;
  updatePacketRate(performance.now());
  scheduleDraw();
}

function onDataNotification(event) {
  try {
    acceptPacket(decodeDataPacket(event.target.value));
  } catch (error) {
    showMessage(`收到的数据包无法解析：${error.message}`, true);
  }
}

function onStatusNotification(event) {
  const value = event.target.value;
  if (value.byteLength >= 1) updateMode(value.getUint8(0));
}

function clearSession() {
  points = [];
  csvRows = [];
  arrivalTimes = [];
  sessionOrigin = null;
  elements.liveMeanValue.textContent = "—";
  elements.windowMeanValue.textContent = "—";
  elements.acRmsValue.textContent = "—";
  elements.peakToPeakValue.textContent = "—";
  elements.elapsedValue.textContent = "0.0 s";
  elements.packetCountValue.textContent = "0 包";
  elements.packetRateValue.textContent = "0.0 Hz";
  elements.exportButton.disabled = true;
  scheduleDraw();
}

async function writeMode(mode) {
  const payload = encodeMode(mode);
  if (typeof controlCharacteristic.writeValueWithoutResponse === "function") {
    await controlCharacteristic.writeValueWithoutResponse(payload);
  } else {
    await controlCharacteristic.writeValue(payload);
  }
}

async function requestMode(mode) {
  try {
    if (demoMode) {
      updateMode(mode);
      if (mode === MODE_STANDBY) stopDemoTimer();
      else startDemoTimer(mode === MODE_ONE_WINDOW);
      return;
    }
    if (!isBleConnected()) throw new Error("蓝牙尚未连接");
    await writeMode(mode);
    showMessage(`已发送“${modeLabel(mode)}”命令，等待开发板状态确认。`);
  } catch (error) {
    showMessage(`命令发送失败：${error.message}`, true);
  }
}

async function connectBle() {
  if (!navigator.bluetooth) {
    showMessage("当前浏览器不支持 Web Bluetooth，请使用 Android/Windows 的 Chrome 或 Edge。", true);
    return;
  }

  connecting = true;
  updateControls();
  showMessage("请选择 XIAO-Piezo-LP，随后读取 GATT 服务……");
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: DEVICE_NAME_PREFIX }],
      optionalServices: [SERVICE_UUID],
    });
    device.addEventListener("gattserverdisconnected", onDisconnected);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    [controlCharacteristic, dataCharacteristic, statusCharacteristic] =
      await Promise.all([
        service.getCharacteristic(CONTROL_UUID),
        service.getCharacteristic(DATA_UUID),
        service.getCharacteristic(STATUS_UUID),
      ]);

    dataCharacteristic.addEventListener("characteristicvaluechanged", onDataNotification);
    statusCharacteristic.addEventListener("characteristicvaluechanged", onStatusNotification);
    await dataCharacteristic.startNotifications();
    await statusCharacteristic.startNotifications();
    const initialStatus = await statusCharacteristic.readValue();
    updateMode(initialStatus.getUint8(0));
    showMessage("蓝牙已连接。点击“连续采集”或“采集 2 秒”开始接收数据。");
  } catch (error) {
    if (device?.gatt?.connected) device.gatt.disconnect();
    resetBleReferences();
    if (error.name === "NotFoundError") {
      showMessage("没有选择设备，或未扫描到 XIAO-Piezo-LP。", true);
    } else {
      showMessage(`连接失败：${error.message}`, true);
    }
  } finally {
    connecting = false;
    updateControls();
  }
}

function resetBleReferences() {
  controlCharacteristic = null;
  dataCharacteristic = null;
  statusCharacteristic = null;
}

function onDisconnected() {
  resetBleReferences();
  updateMode(MODE_STANDBY);
  showMessage("蓝牙已断开；开发板会自动返回低功耗待机。", true);
  updateControls();
}

async function disconnectBle() {
  if (!device?.gatt?.connected) return;
  try {
    if (currentMode !== MODE_STANDBY && controlCharacteristic) {
      await writeMode(MODE_STANDBY);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch {
    // Disconnect still forces the firmware into standby.
  }
  device.gatt.disconnect();
}

function startDemoTimer(oneWindow) {
  stopDemoTimer();
  const stopAt = oneWindow ? demoTime + 2 : Number.POSITIVE_INFINITY;
  demoTimer = window.setInterval(() => {
    demoTime += 0.1;
    const gait = 0.78 + 0.36 * Math.sin(2 * Math.PI * 1.15 * demoTime);
    const detail = 0.065 * Math.sin(2 * Math.PI * 7.4 * demoTime);
    const live = Math.max(0.02, gait + detail);
    acceptPacket({
      acquisitionTimeS: demoTime,
      liveMeanV: live,
      windowMeanV: 0.78 + 0.08 * Math.sin(2 * Math.PI * 0.18 * demoTime),
      acRmsV: 0.24 + 0.055 * Math.sin(2 * Math.PI * 0.34 * demoTime),
      peakToPeakV: 0.92 + 0.16 * Math.sin(2 * Math.PI * 0.28 * demoTime),
    });
    if (demoTime >= stopAt) {
      stopDemoTimer();
      updateMode(MODE_STANDBY);
    }
  }, 100);
}

function stopDemoTimer() {
  if (demoTimer !== null) window.clearInterval(demoTimer);
  demoTimer = null;
}

function toggleDemo() {
  if (demoMode) {
    stopDemoTimer();
    demoMode = false;
    elements.demoButton.textContent = "界面演示";
    updateMode(MODE_STANDBY);
    showMessage("已退出界面演示。可以连接真实开发板。");
    return;
  }
  demoMode = true;
  elements.demoButton.textContent = "退出演示";
  demoTime = 0;
  clearSession();
  updateMode(MODE_CONTINUOUS);
  startDemoTimer(false);
  showMessage("正在使用模拟压电数据演示界面；此状态未连接开发板。");
}

function exportCsv() {
  if (csvRows.length === 0) return;
  const content = `\ufeff${CSV_HEADER.join(",")}\r\n${csvRows.join("\r\n")}\r\n`;
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `xiao_piezo_${stamp}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function checkCompatibility() {
  const messages = [];
  if (!window.isSecureContext) messages.push("Web Bluetooth 需要 HTTPS 或 localhost 安全环境。");
  if (!navigator.bluetooth) messages.push("当前浏览器不支持 Web Bluetooth；请使用 Chrome 或 Edge。");
  if (messages.length > 0) {
    elements.compatibilityBanner.textContent = messages.join(" ");
    elements.compatibilityBanner.classList.remove("hidden");
  }
}

elements.connectButton.addEventListener("click", connectBle);
elements.disconnectButton.addEventListener("click", disconnectBle);
elements.demoButton.addEventListener("click", toggleDemo);
elements.startButton.addEventListener("click", () => requestMode(MODE_CONTINUOUS));
elements.oneWindowButton.addEventListener("click", () => requestMode(MODE_ONE_WINDOW));
elements.stopButton.addEventListener("click", () => requestMode(MODE_STANDBY));
elements.clearButton.addEventListener("click", clearSession);
elements.exportButton.addEventListener("click", exportCsv);
elements.timeWindowSelect.addEventListener("change", scheduleDraw);
window.addEventListener("resize", scheduleDraw);

document.addEventListener("visibilitychange", () => {
  if (
    document.hidden &&
    elements.autoStopCheckbox.checked &&
    currentMode !== MODE_STANDBY
  ) {
    requestMode(MODE_STANDBY);
  }
});

window.addEventListener("pagehide", () => {
  if (device?.gatt?.connected) device.gatt.disconnect();
});

checkCompatibility();
updateMode(MODE_STANDBY);
scheduleDraw();

if (new URLSearchParams(window.location.search).get("demo") === "1") {
  toggleDemo();
}
