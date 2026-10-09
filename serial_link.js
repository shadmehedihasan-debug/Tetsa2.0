// serial_link.js — wired USB (or Bluetooth-serial) link to an Arduino. Same interface as BleLink,
// so the rest of the page doesn't care which one is used.
//
// Works with:
//   - Desktop Chrome / Edge: any Arduino Nano/Uno over a USB cable (Web Serial).
//   - Android Chrome: USB goes through WebUSB plus Google's "web-serial-polyfill", which only supports
//     standard USB-CDC boards (Uno R3, Leonardo/Pro Micro, ...). A Nano with a CH340 chip probably is NOT
//     supported. Set SERIAL_POLYFILL_URL below to enable it.
//   - Not iPhone/iPad (Chrome there can't use USB devices from web pages).

// To try USB on Android, set this to the polyfill's ES-module URL, pinned to an exact version you have
// checked on npmjs.com (package "web-serial-polyfill"), e.g.
//   'https://cdn.jsdelivr.net/npm/web-serial-polyfill@<version>/+esm'
const SERIAL_POLYFILL_URL = '';

class SerialLink {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.port = null;
    this.writer = null;
    this.busy = false;
    this.lastSent = '';
    this.lastTime = 0;
  }

  get connected() { return !!this.writer; }

  async connect() {
    let serial = navigator.serial;
    const android = /Android/i.test(navigator.userAgent);
    if ((android || !serial) && SERIAL_POLYFILL_URL && navigator.usb) {
      serial = (await import(SERIAL_POLYFILL_URL)).serial;        // WebUSB-based serial for Android
    }
    if (!serial) {
      throw new Error('This browser has no serial support. Use desktop Chrome/Edge, or Chrome on Android with SERIAL_POLYFILL_URL set.');
    }
    this.port = await serial.requestPort({ filters: [] });
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this.onStatus('USB opened, waiting for the Arduino to restart...');
    await new Promise(r => setTimeout(r, 2000));                   // opening the port resets most Arduinos
    this.onStatus('USB serial connected');
  }

  disconnect() {
    try { if (this.writer) this.writer.releaseLock(); } catch (_) {}
    try { if (this.port) this.port.close(); } catch (_) {}
    this.writer = null;
  }

  async _write(line) {
    try {
      await this.writer.write(new TextEncoder().encode(line));
      this.lastTime = Date.now();
      return true;
    } catch (e) {
      this.writer = null;                                          // cable pulled or port closed
      this.onStatus('USB disconnected: ' + e.message);
      return false;
    }
  }

  // Sends "P<pan>,T<tilt>\n". Skips repeats, but re-sends every 300 ms as a keep-alive for the failsafe.
  async send(pan, tilt) {
    if (!this.connected || this.busy) return;
    const line = `P${Math.round(pan)},T${Math.round(tilt)}\n`;
    if (line === this.lastSent && Date.now() - this.lastTime < 300) return;
    this.busy = true;
    if (await this._write(line)) this.lastSent = line;
    this.busy = false;
  }

  // One-off commands (L1, B0, R1 ...). Waits for the link instead of dropping the command.
  async command(line) {
    if (!this.connected) return;
    for (let i = 0; this.busy && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    this.busy = true;
    await this._write(line + '\n');
    this.busy = false;
  }
}

if (typeof module !== 'undefined') module.exports = { SerialLink };
