# คู่มือแก้ปัญหา (Troubleshooting) — POS V2 Web

คู่มือนี้รวมปัญหาที่พบบ่อยตอน deploy / แก้โค้ด / ใช้งานเว็บ `customer-web`
บนเครื่อง Windows production (`D:\POS_V2`) พร้อมวิธีแก้ทีละขั้น

> สรุปสั้นที่สุด: **แก้โค้ดเว็บแล้วหน้าไม่เปลี่ยน = ยังไม่ได้ `npm run build` + restart service**

---

## 1. แก้โค้ด / pull โค้ดใหม่แล้ว แต่หน้าเว็บเหมือนเดิม

**สาเหตุ:** Windows service `pos-v2-web` เสิร์ฟจากโฟลเดอร์ `.next/` ที่ build ค้างไว้
การแก้ไฟล์ใน `customer-web/src/` จะไม่มีผลจนกว่าจะ build ใหม่และ restart

**วิธีแก้:**

```powershell
cd D:\POS_V2\customer-web
npm install          # เผื่อมี dependency ใหม่
npm run build        # รอจนขึ้นตาราง Route และไม่มี error
D:\POS_V2\deploy\services\pos-v2-web.exe restart
```

จากนั้นเปิดหน้าเว็บแล้วกด **Ctrl + Shift + R** (hard refresh ล้าง cache เบราว์เซอร์)

**เช็คว่าได้เวอร์ชันที่ถูกต้อง:**

```powershell
cd D:\POS_V2
git branch --show-current   # ต้องเป็น branch ที่ตั้งใจใช้
git log --oneline -1        # commit ล่าสุดต้องตรงกับที่คาดไว้
```

---

## 2. รัน `npm run dev` แล้วเปิด localhost:3000 ยังเห็นหน้าเก่า

**สาเหตุ:** service `pos-v2-web` (production) ยึด port 3000 อยู่แล้ว
ตัว dev server จึง start ไม่ได้ หรือย้ายไป port อื่น (เช่น 3001)
แต่เบราว์เซอร์ยังเปิด port 3000 ของตัวเก่า

**วิธีเช็ค:** ดูข้อความตอน `npm run dev`
- ขึ้น `Port 3000 is in use` หรือ `- Local: http://localhost:3001` = โดน port ชน

**วิธีแก้ (เลือกอย่างใดอย่างหนึ่ง):**

1. เปิดตาม port ที่ dev server แจ้งจริง เช่น `http://localhost:3001/login`
2. หยุด service ชั่วคราวก่อนทดลอง:
   ```powershell
   D:\POS_V2\deploy\services\pos-v2-web.exe stop
   cd D:\POS_V2\customer-web
   npm run dev
   # ทดลองเสร็จแล้ว start กลับ:
   D:\POS_V2\deploy\services\pos-v2-web.exe start
   ```

---

## 3. `npm run build` ล้มเหลว

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| error เกี่ยวกับ `next/font` หรือดาวน์โหลด font ไม่ได้ | ตอน build ต้องต่ออินเทอร์เน็ต (ดาวน์โหลด Noto Sans Thai จาก Google Fonts ครั้งแรก) — ต่อเน็ตแล้ว build ใหม่ |
| `Cannot find module ...` | รัน `npm install` ใน `customer-web` ก่อน แล้ว build ใหม่ |
| build ค้าง / ช้าผิดปกติ | ปิด dev server (`npm run dev`) ที่เปิดค้างไว้ก่อน แล้ว build ใหม่ |
| error แปลกๆ หลังสลับ branch | ลบ cache แล้ว build ใหม่: `Remove-Item -Recurse -Force .next` จากนั้น `npm run build` |

---

## 4. Restart service ไม่ได้ / ขึ้น Access Denied

- เปิด PowerShell แบบ **Run as Administrator** แล้วรันคำสั่ง restart ใหม่
- หรือใช้สคริปต์รวม: `D:\POS_V2\deploy\services\restart-services.bat` (คลิกขวา → Run as administrator)
- เช็คสถานะ service: เปิด `services.msc` หาชื่อ `pos-v2-web` / `pos-v2-backend`
- ดู log เมื่อ service ไม่ยอมขึ้น:
  - เว็บ: `D:\POS_V2\customer-web\logs\pos-v2-web.*.log`
  - backend: `D:\POS_V2\backend\logs\pos-v2-backend.*.log`

---

## 5. หน้าเว็บขึ้น error / ล็อกอินไม่ได้ / เมนูไม่โหลด

ไล่เช็คตามลำดับ:

1. **backend ยังทำงานไหม** — เปิด `http://localhost:4000/api/discovery/info`
   ต้องได้ JSON กลับมา ถ้าไม่ได้ให้ restart `pos-v2-backend`
2. **PostgreSQL ทำงานไหม** — เปิด `services.msc` เช็ค service ของ PostgreSQL
   หรือรัน `D:\POS_V2\deploy\services\ensure-postgresql.bat`
3. **ล็อกอินแล้วเด้ง / token หมดอายุ** — กดออกจากระบบ (ออก) แล้วล็อกอินใหม่
   ถ้ายังไม่ได้ ลองล้าง localStorage: เปิด DevTools (F12) → Application → Local Storage → Clear
4. **บัญชีทดสอบ (เฉพาะเครื่อง dev ที่ seed ไว้):** `admin/admin123`, `staff1/staff123`, `kitchen/kitchen123`

---

## 6. QR ลูกค้าสแกนแล้วเข้าไม่ได้

- QR ชี้ไปที่ URL แบบ LAN (`192.168.x.x`) → ลูกค้าต้องต่อ WiFi ร้านเดียวกัน
  ถ้าต้องการให้ใช้เน็ตมือถือได้ ให้ตั้ง `PUBLIC_BASE_URL` ใน `D:\POS_V2\backend\.env`
  (เป็นโดเมน Caddy หรือ ngrok) แล้ว restart backend
- เปิดหน้า order แล้วขึ้น "ไม่พบรหัส QR ของโต๊ะ" → URL ขาดพารามิเตอร์ `?t=...`
  ให้พิมพ์ QR ใหม่จากหน้า admin (tab QR Code) หรือหน้า staff (ปุ่ม QR ลูกค้า)
- ร้านเปิด GPS guard ไว้ → ลูกค้าต้องกดอนุญาตตำแหน่ง และต้องเข้าผ่าน HTTPS

---

## 7. ปัญหา git ที่พบบ่อย

### push ไม่ได้: `src refspec master does not match any`
ไม่มี branch ชื่อ `master` ในเครื่อง (มักเพราะยังไม่เคย commit)
```powershell
git branch            # ดูชื่อ branch จริง (มี * นำหน้า)
git add .
git commit -m "..."
git push -u origin <ชื่อbranchจริง>
```

### ติดค้างกลาง rebase: ขึ้น `interactive rebase in progress`
```powershell
git rebase --continue   # รันซ้ำจนขึ้น Successfully rebased
# หรือยกเลิกแล้วใช้ merge แทน:
git rebase --abort
git pull origin main --no-rebase --allow-unrelated-histories
```

### pull แล้ว conflict
```powershell
git status              # ดูไฟล์ที่ conflict (สีแดง)
# แก้ไฟล์ให้เรียบร้อย แล้ว:
git add .
git rebase --continue   # หรือ git commit ถ้าเป็น merge
```

### อยากกลับไปเวอร์ชันก่อนหน้า (ยกเลิกการเปลี่ยนแปลงที่ยังไม่ commit)
```powershell
git checkout -- .       # ระวัง: ทิ้งการแก้ไขทั้งหมดที่ยังไม่ commit
```

---

## 8. สลับไปใช้ดีไซน์เก่า / ใหม่

```powershell
cd D:\POS_V2
git checkout main                          # ดีไซน์เก่า (ก่อน merge PR)
# หรือ
git checkout cursor/redesign-web-app-97f3  # ดีไซน์ใหม่ (ก่อน merge PR)

cd customer-web
npm install
npm run build
D:\POS_V2\deploy\services\pos-v2-web.exe restart
```

> ทุกครั้งที่สลับ branch ต้อง build + restart เสมอ (ดูข้อ 1)

---

## 9. เช็คลิสต์มาตรฐานหลัง deploy ทุกครั้ง

1. `http://localhost:4000/api/discovery/info` ตอบ JSON ✓
2. `http://localhost:3000/login` ขึ้นหน้าล็อกอิน ✓ (ดีไซน์ใหม่: ปุ่มเข้าสู่ระบบสีส้ม)
3. ล็อกอิน admin → ไล่ดู tab ภาพรวม / เมนู / โต๊ะ ✓
4. ล็อกอิน staff → เลือกโต๊ะ → เพิ่มสินค้า → เห็น cart bar ✓
5. ล็อกอิน kitchen → หน้าจอครัวขึ้น (ธีมมืด) ✓
6. สแกน QR โต๊ะจริง 1 ใบ → สั่งอาหารทดสอบ 1 ออเดอร์ → เห็นในครัว ✓
