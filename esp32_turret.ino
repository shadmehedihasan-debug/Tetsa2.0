// Tetsa turret - ESP32, USB serial 115200. Needs the "ESP32Servo" library.
// Lines from the laptop:  P<pan>,T<tilt>   L0|L1 (spotlight)   B<ms> (buzzer)   R0|R1 (relay)
// Wiring: servos on 18 (pan) and 19 (tilt), powered from a 5-6 V buck converter (NOT the ESP32 pin),
//   all grounds joined. Spotlight via MOSFET on 5, buzzer via transistor on 23, relay module on 25.
//   Arm switch: GPIO 33 to GND = armed. Avoid GPIO 12 (boot pin).
// Safety: spotlight, buzzer and relay switch off if no valid line arrives for 1.5 s or the arm switch is open.
#include <ESP32Servo.h>

const int PAN_PIN = 18, TILT_PIN = 19, LIGHT_PIN = 5, BUZZER_PIN = 23, RELAY_PIN = 25, ARM_PIN = 33;
const int PAN_MIN = 10, PAN_MAX = 170, TILT_MIN = 40, TILT_MAX = 140;   // keep clear of your printed parts
const float MAX_SPEED = 120, ACCEL = 400;                               // deg/s, deg/s^2
const unsigned long FAILSAFE_MS = 1500, BUZZ_MAX = 10000, RELAY_MAX = 30000;

Servo pan, tilt;
float panPos = 90, tiltPos = 90, panVel = 0, tiltVel = 0;
int panGoal = 90, tiltGoal = 90;
bool light = false, relay = false;
unsigned long lastCmd = 0, buzzUntil = 0, relayUntil = 0, lastTick = 0;
String line;

float ramp(float pos, float &vel, float goal, float dt) {
  float want = constrain((goal - pos) * 6.0f, -MAX_SPEED, MAX_SPEED);
  float dv = ACCEL * dt;
  vel += constrain(want - vel, -dv, dv);
  return pos + vel * dt;
}

void handle(const String &s) {
  int p, t, ms;
  if (s.startsWith("P") && sscanf(s.c_str(), "P%d,T%d", &p, &t) == 2) {
    panGoal = constrain(p, PAN_MIN, PAN_MAX); tiltGoal = constrain(t, TILT_MIN, TILT_MAX);
  } else if (s.length() == 2 && s[0] == 'L' && (s[1] == '0' || s[1] == '1')) {
    light = s[1] == '1';
  } else if (s.startsWith("B") && (ms = s.substring(1).toInt()) > 0) {
    buzzUntil = millis() + min((unsigned long)ms, BUZZ_MAX);
  } else if (s.length() == 2 && s[0] == 'R' && (s[1] == '0' || s[1] == '1')) {
    relay = s[1] == '1'; relayUntil = millis() + RELAY_MAX;
  } else return;                       // malformed line: ignore, and do not refresh the failsafe
  lastCmd = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(LIGHT_PIN, OUTPUT); pinMode(BUZZER_PIN, OUTPUT); pinMode(RELAY_PIN, OUTPUT);
  pinMode(ARM_PIN, INPUT_PULLUP);
  pan.setPeriodHertz(50); tilt.setPeriodHertz(50);
  pan.attach(PAN_PIN, 500, 2400); tilt.attach(TILT_PIN, 500, 2400);
  pan.write(90); tilt.write(90);
  lastTick = millis();
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { line.trim(); handle(line); line = ""; }
    else if (line.length() < 40) line += c;
  }
  unsigned long now = millis();
  float dt = (now - lastTick) / 1000.0f; lastTick = now;
  panPos = ramp(panPos, panVel, panGoal, dt);
  tiltPos = ramp(tiltPos, tiltVel, tiltGoal, dt);
  pan.write((int)(panPos + .5)); tilt.write((int)(tiltPos + .5));

  bool safe = digitalRead(ARM_PIN) == LOW && now - lastCmd < FAILSAFE_MS;
  digitalWrite(LIGHT_PIN, safe && light);
  digitalWrite(BUZZER_PIN, safe && now < buzzUntil);
  digitalWrite(RELAY_PIN, safe && relay && now < relayUntil);
  delay(10);
}
