# POS_V2 Mobile — Android Build & Run Guide

แอปนี้รองรับ web + android อยู่แล้ว — มี **Kitchen view เต็มฟังก์ชัน** (offline mode + push + status), ส่วน Staff/Admin เป็น stub (ใช้ web `/staff`, `/admin` แทนได้)

## ⚠️ Path มาตรฐานสำหรับ build

โปรเจค production ต้องอยู่ที่ `D:\POS_V2` เท่านั้น เพราะ Gradle/Android toolchain บน Windows มีปัญหากับ path ที่มีวงเล็บ

ห้ามใช้ mapped drive หรือ `subst` แล้ว ให้ build จาก path จริง:

```cmd
cd D:\POS_V2\mobile
flutter build apk --debug --dart-define=POS_API_BASE=http://10.0.2.2:4000
```

หรือใช้ wrapper batch ที่เตรียมไว้:
```cmd
cd D:\POS_V2\mobile
android-build.bat            REM debug APK
android-build.bat run        REM flutter run live
android-build.bat release    REM release APK
```


## 0. สถานะปัจจุบันบนเครื่องนี้

จาก `flutter doctor` ของคุณ:
- ✅ Flutter SDK 3.41.9 ที่ `D:\flutter`
- ✅ Android SDK 36.1.0 (จาก Android Studio)
- ✅ JDK 21 bundled
- ⚠️ **Some Android licenses not accepted** — ต้องตอบยอมรับครั้งแรก (ขั้นที่ 1 ด้านล่าง)
- ❌ ยังไม่มี Android device หรือ emulator ต่อ — ต้องเปิด emulator หรือต่อมือถือ (ขั้นที่ 2)

## 1. ยอมรับ Android licenses (ครั้งเดียว)

เปิด terminal แล้วรัน — มันจะถามยอมรับหลายข้อ ตอบ `y` ทุกข้อ:

```cmd
D:\flutter\bin\flutter.bat doctor --android-licenses
```

ถ้าเสร็จเรียบร้อย flutter doctor จะแสดง `[√] Android toolchain` แล้ว

## 2. เตรียม device ให้ Flutter เห็น

เลือกทางใดทางหนึ่ง:

### ทาง A — Android Emulator (ในเครื่อง dev เดียวกัน)

เปิด **Android Studio → Device Manager → Create Device** เลือก Pixel/Tablet → System image (เช่น API 35) → Finish → เปิด emulator

ตรวจว่า Flutter เห็น:
```cmd
D:\flutter\bin\flutter.bat devices
```

ควรเห็น emulator-5554 ขึ้นมา

> ⚠️ **บน Emulator** `localhost` หมายถึง emulator เอง ไม่ใช่เครื่อง Windows  
> ใช้ `10.0.2.2:4000` แทน `localhost:4000` เป็น backend URL

### ทาง B — มือถือ Android จริง (ผ่านสาย USB)

1. มือถือ → **Settings → About phone → กด Build number 7 ครั้ง** เพื่อปลดล็อก Developer options
2. **Settings → Developer options → USB debugging = ON**
3. เสียบสาย USB เชื่อมเข้า PC — มือถือจะถาม "Allow USB debugging?" → ติ๊ก "Always allow" → OK
4. ตรวจ:
```cmd
D:\flutter\bin\flutter.bat devices
```

ควรเห็นชื่อมือถือคุณ (เช่น `SM-A520F`)

> ใช้ **IP จริงของเครื่อง Windows ใน LAN** เป็น backend URL — ตอนนี้คือ `192.168.1.163:4000`

### ทาง C — มือถือ Android จริง (ผ่าน WiFi, Android 11+)

1. ตั้ง USB debugging เหมือนทาง B หนึ่งครั้งก่อน
2. **Settings → Developer options → Wireless debugging = ON**
3. กด "Pair device with pairing code" — จดเลข IP:port + 6-digit code
4. บน PC:
```cmd
D:\flutter\bin\flutter.bat devices
adb pair 192.168.1.50:42345    (ใส่ pairing code ตอนถาม)
adb connect 192.168.1.50:5555
D:\flutter\bin\flutter.bat devices    (เช็คใหม่)
```

## 3. หา backend URL ที่ถูกต้อง

```cmd
ipconfig | findstr "IPv4"
```

คุณจะเห็นบรรทัดเช่น `IPv4 Address. . . . . . . . . . . : 192.168.1.163`

จด IP นี้ไว้ — เรียกว่า `<SERVER_IP>` ในขั้นต่อไป

ตรวจว่ามือถือ/emulator คุยกับ backend ได้ก่อน build แอป — จากมือถือเปิด browser ไป `http://<SERVER_IP>:4000/api/health` ต้องเห็น `{"ok":true,...}` ถ้าไม่เห็น:
- ตรวจ Windows Firewall เปิด port 4000 (รัน `deploy/firewall-allow.ps1` แบบ admin)
- ตรวจ PC + มือถืออยู่ subnet เดียวกัน
- ปิด VPN ทั้งสองฝั่ง

## 4. Run แบบ debug (hot reload)

```cmd
cd D:\POS_V2\mobile

REM Emulator (localhost จากมุมมอง emulator คือ 10.0.2.2)
D:\flutter\bin\flutter.bat run --dart-define=POS_API_BASE=http://10.0.2.2:4000

REM มือถือจริง — ใช้ IP ของ Windows server
D:\flutter\bin\flutter.bat run --dart-define=POS_API_BASE=http://192.168.1.163:4000
```

ระหว่างรัน:
- `r` = hot reload, `R` = hot restart, `q` = quit
- เปลี่ยน URL ภายหลังจาก **Settings → Backend URL** ในแอปก็ได้

## 5. Build APK (release) — แจกจ่าย / install ถาวร

```cmd
cd D:\POS_V2\mobile
D:\flutter\bin\flutter.bat build apk --release ^
  --dart-define=POS_API_BASE=http://192.168.1.163:4000
```

APK จะอยู่ที่:
```
D:\POS_V2\mobile\build\app\outputs\flutter-apk\app-release.apk
```

**Install บนมือถือ:**
- ต่อ USB + รัน `adb install -r app-release.apk`
- หรือ copy ไฟล์ไปมือถือแล้วเปิดติดตั้งเอง (อาจต้องอนุญาต "Install unknown apps")

## 6. (Optional) Build APK แยกตาม CPU เพื่อให้ไฟล์เล็กลง

```cmd
D:\flutter\bin\flutter.bat build apk --release --split-per-abi ^
  --dart-define=POS_API_BASE=http://192.168.1.163:4000
```

ได้ 3 ไฟล์: `app-armeabi-v7a-release.apk`, `app-arm64-v8a-release.apk`, `app-x86_64-release.apk`
ส่งให้มือถือแต่ละเครื่องตาม CPU

## 7. ทดสอบฟีเจอร์ทีละอย่าง

| ฟีเจอร์ | วิธีทดสอบ |
|--------|----------|
| Login | กรอก kitchen / kitchen123 → เข้าหน้า Kitchen |
| Realtime | สั่งจาก browser `/order?t=...` → Kitchen ในมือถือเห็นออเดอร์ใหม่ทันที |
| Offline mode | ปิด WiFi มือถือ → header เปลี่ยนเป็น `🔴 offline` → กดเปลี่ยนสถานะ → "ออฟไลน์ — เก็บคิวไว้" → เปิด WiFi กลับ → ออเดอร์ sync อัตโนมัติ |
| Print | กดปุ่ม 🖨️ บน order card |
| mDNS | Settings → กด "สแกน LAN" → เห็น `POS V2 — HOME_Win11` → กด "ใช้" |

## ปัญหาที่พบบ่อย

| Symptom | Fix |
|---------|-----|
| `Connection refused` ตอน login | ใช้ `localhost` ตอนรันบนมือถือ — ใช้ IP เครื่อง Windows แทน |
| `Cleartext HTTP traffic not permitted` | `usesCleartextTraffic="true"` ตั้งไว้ใน AndroidManifest แล้ว — ถ้ายังเจอ ตรวจว่าใช้ release build ที่ build ใหม่หลังตั้งค่า |
| Emulator ขึ้น "ECONNREFUSED" | ใช้ `10.0.2.2:4000` ไม่ใช่ `localhost:4000` |
| สแกน mDNS แล้วไม่เจอ | ตรวจมือถือ + PC อยู่ WiFi เดียวกัน, port 5353/UDP เปิดใน firewall, AccessPoint ไม่บล็อก mDNS |
| Build error "License not accepted" | รัน `flutter doctor --android-licenses` แล้วตอบ y ทุกข้อ |
| Bonsoir crash ตอนสแกน | Android 13+ ต้องเปิด permission "Nearby devices" ใน Settings → Apps → POS V2 → Permissions |
| Push notifications ไม่ทำงาน | Web Push ใช้ได้เฉพาะใน browser (web build); สำหรับ APK ต้องใช้ FCM ซึ่ง **ยังไม่ได้ทำใน Phase นี้** |

## ขั้นต่อไป (ถ้าจะทำต่อ)

- **Push บน Android native** — ใช้ `firebase_messaging` package (ต้องสมัคร Firebase project)
- **Splash screen + app icon** — แทนที่ icon default ที่ `mobile/android/app/src/main/res/mipmap-*`
- **ลายเซ็น release** — ตอนนี้ build APK ใช้ debug key ติดตั้ง dev ได้ แต่ไม่เหมาะแจก ต้องสร้าง upload keystore ตาม [Flutter docs](https://docs.flutter.dev/deployment/android#signing-the-app)
