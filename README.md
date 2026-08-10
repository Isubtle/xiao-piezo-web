# XIAO 压电 BLE 网页实时绘图

这个网页直接连接 `XIAO-Piezo-LP`，不依赖 phyphox，也不需要修改当前
BLE 数据包格式。

## 功能

- 显示蓝牙连接和开发板采集状态。
- 写入 `00 / 01 / 02`，控制待机、连续采集和单次 2 秒采集。
- 订阅已有的 `...1002...` 通知特征。
- 解析 20 字节、5 个 little-endian `float32` 数据。
- 绘制 100 ms 均值、2 s 窗口均值、交流 RMS 和峰峰值。
- 显示接收包数、实际刷新率并导出 CSV。
- 页面切到后台时默认发送停止命令，减少遗忘采集造成的功耗。
- “界面演示”不连接硬件，可快速确认图表是否正常。

## Windows 电脑快速使用

1. 使用 Chrome 或 Edge。
2. 双击 `启动网页版.cmd`。
3. 点击网页中的“连接 XIAO”，在浏览器窗口里选择 `XIAO-Piezo-LP`。
4. 点击“连续采集”或“采集 2 秒”。
5. 完成后点击“停止 / 待机”。
6. 不再使用时可双击 `停止网页版.cmd` 关闭后台本地服务器。

如果启动脚本失败，运行 `调试启动网页版.cmd` 查看 Python 错误信息。

## Android 手机使用

Web Bluetooth 要求安全环境。手机不能直接使用电脑局域网的普通
`http://电脑IP:8765` 地址连接蓝牙。需要把这个文件夹作为静态网站部署到
HTTPS 地址，例如 GitHub Pages、Cloudflare Pages 或其他 HTTPS 主机，然后
使用 Android Chrome 打开。

手机操作步骤：

1. 完全断开 nRF Connect、phyphox 等其他 BLE 客户端。
2. 用 Android Chrome 打开部署后的 HTTPS 页面。
3. 点击“连接 XIAO”并选择设备。
4. 开始采集并查看曲线。

iPhone/iPad 的 Chrome 仍使用 WebKit，不能按 Android Chrome 的方式直接
使用 Web Bluetooth。

## 功耗说明

网页绘图运行在浏览器内，不占用开发板 CPU。开发板仍然是 500 Hz 内部采样、
10 Hz BLE 特征通知，因此与电脑 Python 工具处于相同采集模式时，板端功耗
基本一致。停止按钮写入 `00`；浏览器断开后固件的断开回调也会返回待机。

## 开发检查

```powershell
node --test tests/ble_protocol.test.mjs
node --check app.js
```

## 500 Hz 原始采样验证模式

同一个网页也支持独立诊断固件 `XIAO-Piezo-Raw500`，无需换网页：

- 连接后自动识别 20 字节原始数据包并切换界面。
- 显示原始电压、12 位 ADC 码、检测到的丢点和实际接收率。
- 绘图刷新与 BLE 接收解耦；CSV 保留每一个 500 Hz 样本。
- 用万用表测量 XIAO 的 `3V3-GND`，把实测值填入网页的“ADC 满量程”。
- 导出的 `sample_index` 和 `packet_sequence` 可用于检查 BLE 是否漏点。

原始验证固件位于 `firmware/xiao_piezo_raw500_bluefruit`。正式低功耗工作仍使用原来的处理结果固件。
