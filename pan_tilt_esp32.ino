// pan_tilt_esp32.ino — Bluetooth LE pan/tilt + warning outputs for the tracking camera.
//
// Commands from the phone (one per line):
//   P<pan>,T<tilt>   servo angles in degrees      e.g.  P95,T60
//   L1 / L0          spotlight on / off
//   B1 / B0          buzzer on / off
//   R1 / R0          output relay on / off  (siren, strobe, door lock... see note)
//
// Wiring (ESP32 dev board):
//   Pan servo signal -> GPIO 18      Tilt servo signal -> GPIO 19
//   Buzzer           -> GPIO 25  (via a transistor/MOSFET if the buzzer draws more than ~10 mA)
//   Spotlight        -> GPIO 26  (via a logic-level MOSFET; the light has its OWN power supply)
//   Relay module IN  -> GPIO 27  (relay module powered separately; common ground with the ESP32)
//   Arm switch       -> GPIO 33 to GND. Switch CLOSED = armed. Open = buzzer, light and relay forced OFF.
//   Servo power      -> 5-6 V from a BUCK CONVERTER (not the ESP32 pin, not straight from 2S 18650), common GND.
//
// SAFETY: every output switches off if the Bluetooth link drops, commands stop for FAILSAFE_MS,
// or the arm switch is open. The buzzer and relay also have maximum on-times.
// The relay is for things like a siren, strobe or door lock. Mains wiring must be done by a qualified person.
//
// Arduino IDE: Board "ESP32 Dev Module"; library "ESP32Servo"; if "sketch too big" use Partition Scheme "Huge APP".

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <ESP32Servo.h>

#define SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define RX_UUID      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"   // phone -> ESP32

// ---- Settings ------------------------------------------------------------
const int PAN_PIN = 18, TILT_PIN = 19;
const int BUZZER_PIN = 25, LIGHT_PIN = 26, RELAY_PIN = 27, ARM_PIN = 33;
const bool RELAY_ACTIVE_HIGH = true;     // many relay modules are active-LOW: set false if it is inverted

const float PAN_MIN = 10,  PAN_MAX = 170,  PAN_CENTER = 90;     // set so servos never hit printed parts
const float TILT_MIN = 40, TILT_MAX = 140, TILT_CENTER = 90;

const float MAX_SPEED_DPS = 120;         // top servo speed, degrees/second
const float ACCEL_DPS2 = 400;            // acceleration limit: smooth start and stop
const uint32_t FAILSAFE_MS = 1500;       // no command for this long -> outputs off
const uint32_t BUZZER_MAX_MS = 10000, RELAY_MAX_MS = 30000;
const int PULSE_MIN_US = 500, PULSE_MAX_US = 2400;              // typical for MG90S
// --------------------------------------------------------------------------

Servo panServo, tiltServo;
volatile float panTarget = PAN_CENTER, tiltTarget = TILT_CENTER;
float panPos = PAN_CENTER, tiltPos = TILT_CENTER, panVel = 0, tiltVel = 0;
volatile bool wantLight = false, wantBuzzer = false, wantRelay = false;
volatile uint32_t lastCmdMs = 0, buzzerSince = 0, relaySince = 0;
volatile bool clientConnected = false;
String lineBuf;

float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

void handleLine(const String &line) {
  if (line.length() < 2) return;
  uint32_t now = millis();
  float p, t;
  if (line[0] == 'P' && sscanf(line.c_str(), "P%f,T%f", &p, &t) == 2) {
    panTarget = clampf(p, PAN_MIN, PAN_MAX);
    tiltTarget = clampf(t, TILT_MIN, TILT_MAX);
  } else if (line[0] == 'L') {
    wantLight = (line[1] == '1');
  } else if (line[0] == 'B') {
    wantBuzzer = (line[1] == '1');
    if (wantBuzzer) buzzerSince = now;
  } else if (line[0] == 'R') {
    wantRelay = (line[1] == '1');
    if (wantRelay) relaySince = now;
  } else {
    return;
  }
  lastCmdMs = now;
}

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    auto value = c->getValue();                 // std::string (core 2.x) or String (core 3.x)
    String chunk(value.c_str());                // works with both
    for (size_t i = 0; i < chunk.length(); i++) {
      char ch = chunk[i];
      if (ch == '\n' || ch == '\r') {
        if (lineBuf.length()) handleLine(lineBuf);
        lineBuf = "";
      } else if (lineBuf.length() < 40) {
        lineBuf += ch;
      } else {
        lineBuf = "";
      }
    }
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override { clientConnected = true; lastCmdMs = millis(); }
  void onDisconnect(BLEServer *s) override {
    clientConnected = false;
    wantLight = wantBuzzer = wantRelay = false;
    BLEDevice::startAdvertising();              // allow reconnecting without a reboot
  }
};

void writeServo(Servo &s, float deg) {
  s.writeMicroseconds((int)(PULSE_MIN_US + deg * (PULSE_MAX_US - PULSE_MIN_US) / 180.0f));
}

// Speed proportional to the remaining distance (capped), with limited acceleration -> no overshoot.
void stepAxis(float &pos, float &vel, float target, float dt) {
  float desired = clampf((target - pos) * 6.0f, -MAX_SPEED_DPS, MAX_SPEED_DPS);
  float dv = ACCEL_DPS2 * dt;
  vel += clampf(desired - vel, -dv, dv);
  pos += vel * dt;
}

void setRelay(bool on) { digitalWrite(RELAY_PIN, (on == RELAY_ACTIVE_HIGH) ? HIGH : LOW); }

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);  digitalWrite(BUZZER_PIN, LOW);
  pinMode(LIGHT_PIN, OUTPUT);   digitalWrite(LIGHT_PIN, LOW);
  pinMode(RELAY_PIN, OUTPUT);   setRelay(false);
  pinMode(ARM_PIN, INPUT_PULLUP);

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  panServo.setPeriodHertz(50);
  tiltServo.setPeriodHertz(50);
  panServo.attach(PAN_PIN, PULSE_MIN_US, PULSE_MAX_US);
  tiltServo.attach(TILT_PIN, PULSE_MIN_US, PULSE_MAX_US);
  writeServo(panServo, panPos);
  writeServo(tiltServo, tiltPos);

  BLEDevice::init("PanTilt");
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *service = server->createService(SERVICE_UUID);
  BLECharacteristic *rx = service->createCharacteristic(
      RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCallbacks());
  service->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("Advertising as 'PanTilt'");
}

void loop() {
  static uint32_t lastTick = millis();
  uint32_t now = millis();
  float dt = (now - lastTick) / 1000.0f;
  if (dt < 0.015f) return;                      // update about every 15 ms
  lastTick = now;

  // Servos
  stepAxis(panPos, panVel, panTarget, dt);
  stepAxis(tiltPos, tiltVel, tiltTarget, dt);
  panPos = clampf(panPos, PAN_MIN, PAN_MAX);
  tiltPos = clampf(tiltPos, TILT_MIN, TILT_MAX);
  writeServo(panServo, panPos);
  writeServo(tiltServo, tiltPos);

  // Outputs: allowed only while armed, linked, and commands are still arriving
  bool armed = (digitalRead(ARM_PIN) == LOW);
  bool linkOk = clientConnected && (now - lastCmdMs <= FAILSAFE_MS);
  bool allow = armed && linkOk;
  if (wantBuzzer && now - buzzerSince > BUZZER_MAX_MS) wantBuzzer = false;
  if (wantRelay && now - relaySince > RELAY_MAX_MS) wantRelay = false;
  digitalWrite(LIGHT_PIN, (allow && wantLight) ? HIGH : LOW);
  digitalWrite(BUZZER_PIN, (allow && wantBuzzer) ? HIGH : LOW);
  setRelay(allow && wantRelay);
}
