export const DEVICE_NAME_PREFIX = "XIAO-Piezo";
export const SERVICE_UUID = "6f4d1000-7a2b-4c51-9e21-5a4b8d190001";
export const CONTROL_UUID = "6f4d1001-7a2b-4c51-9e21-5a4b8d190001";
export const DATA_UUID = "6f4d1002-7a2b-4c51-9e21-5a4b8d190001";
export const STATUS_UUID = "6f4d1003-7a2b-4c51-9e21-5a4b8d190001";

export const MODE_STANDBY = 0;
export const MODE_CONTINUOUS = 1;
export const MODE_ONE_WINDOW = 2;
export const PACKET_BYTES = 20;

export const CSV_HEADER = [
  "host_time_iso",
  "acquisition_time_s",
  "live_mean_v",
  "window_mean_v",
  "ac_rms_v",
  "peak_to_peak_v",
];

function asDataView(payload) {
  if (payload instanceof DataView) return payload;
  if (payload instanceof ArrayBuffer) return new DataView(payload);
  if (ArrayBuffer.isView(payload)) {
    return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new TypeError("BLE payload must be an ArrayBuffer or an ArrayBuffer view");
}

export function decodeDataPacket(payload) {
  const view = asDataView(payload);
  if (view.byteLength !== PACKET_BYTES) {
    throw new RangeError(
      `BLE data packet must be ${PACKET_BYTES} bytes, got ${view.byteLength}`,
    );
  }

  const values = [];
  for (let offset = 0; offset < PACKET_BYTES; offset += 4) {
    values.push(view.getFloat32(offset, true));
  }
  if (!values.every(Number.isFinite)) {
    throw new RangeError("BLE data packet contains a non-finite float32 value");
  }

  return {
    acquisitionTimeS: values[0],
    liveMeanV: values[1],
    windowMeanV: values[2],
    acRmsV: values[3],
    peakToPeakV: values[4],
  };
}

export function modeLabel(mode) {
  switch (mode) {
    case MODE_STANDBY:
      return "低功耗待机";
    case MODE_CONTINUOUS:
      return "连续采集";
    case MODE_ONE_WINDOW:
      return "采集 2 秒";
    default:
      return `未知状态 ${mode}`;
  }
}

function csvEscape(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function packetToCsvRow(hostTimeIso, packet) {
  return [
    hostTimeIso,
    packet.acquisitionTimeS,
    packet.liveMeanV,
    packet.windowMeanV,
    packet.acRmsV,
    packet.peakToPeakV,
  ]
    .map(csvEscape)
    .join(",");
}

export function encodeMode(mode) {
  if (![MODE_STANDBY, MODE_CONTINUOUS, MODE_ONE_WINDOW].includes(mode)) {
    throw new RangeError(`Unsupported acquisition mode: ${mode}`);
  }
  return Uint8Array.of(mode);
}
