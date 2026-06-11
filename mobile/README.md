# POS_V2 Mobile (Flutter)

Flutter app — single codebase, 3 view ตาม role (admin/staff/kitchen)

ตอนนี้ scaffold รองรับเต็มสำหรับ **Kitchen role** (display + status transitions + พิมพ์)
ส่วน Staff/Admin เป็น placeholder — ใช้ web (`/staff`, `/admin`) ได้เต็มฟังก์ชันก่อน

## Setup

ต้องมี Flutter SDK 3.41+ (อยู่ที่ `D:\flutter` แล้ว)

```bash
cd mobile
flutter pub get
```

## Run

### Web (พร้อมใช้ทันที — backend ต้อง CORS allow origin นี้)

```bash
flutter run -d web-server --web-port=3001
# หรือ release build:
flutter run -d web-server --web-port=3001 --release
# หรือ deploy build static:
flutter build web --release   # ผลที่ build/web/
```

URL: http://localhost:3001 — login ด้วย admin/admin123, staff1/staff123, หรือ kitchen/kitchen123

### Android (ต้องตั้งค่าเพิ่ม)

`flutter doctor` แจ้งว่า Android cmdline-tools หายไป — แก้โดย:

1. เปิด Android Studio → SDK Manager → SDK Tools tab
2. ติ๊ก **Android SDK Command-line Tools (latest)** → Apply
3. รัน `flutter doctor --android-licenses` แล้ว type `y` ตอบทุกข้อ

จากนั้น:
```bash
flutter devices                       # ดูว่ามี Android device อะไรบ้าง
flutter run -d <device-id>
flutter build apk --release           # ได้ build/app/outputs/flutter-apk/app-release.apk
```

## Configuration

Backend URL อ่านจาก env `POS_API_BASE` (default `http://localhost:4000`)

```bash
flutter run --dart-define=POS_API_BASE=http://192.168.1.10:4000
flutter build apk --release --dart-define=POS_API_BASE=https://your-pos.example.com
```

**สำคัญ:** ใน Android emulator localhost คือ emulator เอง ต้องใช้ `10.0.2.2` แทน localhost
ใน device จริงต้องใช้ IP ของเครื่อง Windows ใน LAN เดียวกัน

## โครงสร้างโค้ด

```
lib/
├── main.dart                  app entry, role-based routing
├── config.dart                AppConfig.apiBase
├── models/
│   └── order.dart             PosOrder, OrderItem
├── services/
│   ├── auth_service.dart      login, JWT storage (SharedPreferences)
│   ├── api_service.dart       REST client (orders, status, print)
│   └── socket_service.dart    Socket.io connection (order:new / order:update)
└── screens/
    ├── login_screen.dart      navy gradient + dev users hint
    ├── kitchen_screen.dart    🔥 main: dark display, grid cards, status flow
    ├── staff_screen.dart      placeholder
    └── admin_screen.dart      placeholder
```

## ที่ยังไม่ได้ทำ

- Staff/Admin screens เต็มฟังก์ชัน
- Offline mode (drift / sqflite + sync queue)
- Local server discovery (mDNS, multicast_dns package)
- รูปเมนู (image_picker + multipart upload)
- Push notifications สำหรับครัว
