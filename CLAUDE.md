# Tài liệu kiến trúc – Phần mềm Quản Lý Bán Hàng
> **ĐỌC FILE NÀY TRƯỚC KHI SỬA BẤT KỲ CODE NÀO.**
> Mỗi phần ghi rõ những điểm nguy hiểm và liên kết giữa các file.

---

## 1. Stack kỹ thuật

| Thành phần | Chi tiết |
|---|---|
| Runtime | Node.js 18 |
| Web framework | Express 4 |
| Template engine | EJS 3 (`views/*.ejs`) |
| Lưu trữ dữ liệu | **JSON file** (`data.json`) – KHÔNG phải SQLite |
| Build exe | `pkg` v6.15.0 → `QuanLyBanHang.exe` (~49MB) |
| Obfuscation | `javascript-obfuscator` (chạy khi `npm run build`) |
| UI framework | Tabler UI Beta17 + Tabler Icons webfont v2.40.0 (CDN) |
| CSS chính | `public/css/style.css` |
| Version hiện tại | `1.0.33` (config.js + version.json) |

---

## 2. Cấu trúc thư mục

```
quanlybanhang/                    ← THƯ MỤC GỐC (luôn sửa ở đây)
├── server.js                     ← Express routes + khởi động app (PORT 3000)
├── database.js                   ← Toàn bộ logic đọc/ghi data.json
├── data.json                     ← CƠ SỞ DỮ LIỆU chính (JSON, không phải SQLite)
├── config.js                     ← VERSION, BOT_TOKEN, PORT, APP_NAME, DEVELOPER_CHAT_ID, VERCEL_CHECKIN_URL
├── version.json                  ← {"version":"1.0.33","name":"Quản Lý Bán Hàng"}
├── license.js                    ← generateKey() + checkOnlineRevocation() + blockLicense()
├── updater.js                    ← Kiểm tra update từ GitHub Releases API
├── heartbeat.js                  ← Gửi Telegram khi khách mở + check revocation
├── tray.js                       ← System tray icon
├── shops.json                    ← Danh sách cửa hàng được kích hoạt (dùng bởi vercel-bot)
├── revoked.json                  ← Danh sách machineId bị thu hồi license (client check khi khởi động)
├── views/
│   ├── activate.ejs              ← Kích hoạt license (xanh khi active, đỏ khi revoked, có polling)
│   └── ...                       ← Các view khác
├── vercel-bot/
│   ├── api/webhook.js            ← Bot Telegram trên Vercel (/danhsach, /thongke, /khoa, /mokhoa, xóa shop)
│   └── api/checkin.js            ← API endpoint: client gọi khi startup để fix stale revoked display
├── scripts/
│   ├── build.js                  ← npm run build: obfuscate + copy → release/ (heartbeat.js + tray.js + config.js đã thêm vào)
│   └── publish.ps1               ← Tự động tăng version + build exe + mở GitHub
├── dist/
│   └── QuanLyBanHang.exe         ← File exe cuối cùng (copy cái này cho khách)
└── release/QuanLyBanHang/        ← Thư mục build trung gian (bị OVERWRITE mỗi lần build)
```

---

## 3. Hệ thống License & Revocation

### 3a. Cách tạo key
```javascript
// license.js
generateKey(machineId, months)
// months > 0  → gói theo tháng (6, 12, 24, 36...)
// months = 0  → Vĩnh viễn (expiry = '9999-12-31')
// months < 0  → Dùng thử theo ngày (-15 = 15 ngày, -30 = 30 ngày)
```

### 3b. Gói kích hoạt (bot Telegram)
| Nút | months | Ghi chú |
|---|---|---|
| 🧪 15 Ngày (thử) | -15 | |
| 🧪 30 Ngày (thử) | -30 | |
| 🕕 6 Tháng | 6 | |
| 1️⃣ 1 Năm | 12 | |
| 2️⃣ 2 Năm | 24 | |
| 3️⃣ 3 Năm | 36 | |
| ♾️ Vĩnh viễn | 0 | |

### 3c. Hệ thống Revocation (THU HỒI LICENSE) — ĐỌC KỸ

**Cơ chế:**
- `revoked.json` trên GitHub chứa mảng machineId bị thu hồi
- `license.blocked` là file flag local — khi tồn tại → phần mềm bị khóa
- `blockLicense()` → tạo file + invalidate cache
- `unblockLicense()` → xóa file + invalidate cache
- `isLicenseBlocked()` → kiểm tra file có tồn tại không

**Luồng khóa (admin nhấn 🔴 Khóa):**
```
Bot webhook.js revokeShop(machineId)
  → Thêm vào revoked.json trên GitHub
  → Set revoked:true trong shops.json
  
Client (exe) mỗi 5 phút (setInterval trong heartbeat.js):
  → checkOnlineRevocation(machineId)
  → Nếu có trong revoked.json → blockLicense()
  → Màn hình chuyển sang /activate với banner "Bị thu hồi"
  
Khi client mở lại (startup):
  → Sau ~3 giây (setTimeout trong server.js startRevocationWatcher)
  → checkOnlineRevocation(machineId, forceCheck=true)
  → Nếu có → blockLicense() → kẹt trang activate
```

**Luồng mở khóa (admin nhấn 🟢 Mở khóa):**
```
Bot webhook.js unrevokeShop(machineId)
  → Xóa khỏi revoked.json trên GitHub
  → Set revoked:false trong shops.json

Client (đang bị kẹt trang activate):
  → Polling script trong activate.ejs gọi /api/license-status mỗi 10 giây
  → /api/license-status reset cache + checkOnlineRevocation()
  → Nếu không còn trong revoked.json → unblockLicense()
  → Polling thấy active:true → redirect về '/'
  
Client mở lại sau khi admin mở khóa:
  → heartbeat startup: checkOnlineRevocation() → không còn bị lock → restoreLicense()
  → Server 3-second check → unblockLicense()
  → Phần mềm tự mở bình thường
```

### ⚠️ CẢNH BÁO QUAN TRỌNG về Revocation

**1. KHÔNG BAO GIỜ thêm bypass validateKey vào revocation check:**
```javascript
// ❌ TUYỆT ĐỐI KHÔNG LÀM THẾ NÀY:
checkOnlineRevocation(machineId).then(notRevoked => {
    if (!notRevoked) {
        const lic = loadLicense();
        if (lic && validateKey(lic)) { restoreLicense(); return; } // ← BUG! Bỏ qua lock
        killLicense();
    }
});

// ✅ ĐÚNG: Revoke luôn thắng, dù key local còn hạn
checkOnlineRevocation(machineId).then(notRevoked => {
    if (!notRevoked) {
        killLicense(); // Block ngay, không bypass
    } else {
        restoreLicense(); // Tự phục hồi nếu đã được mở khóa
    }
});
```

**2. GitHub raw URL bị CDN cache ~5 phút:**
```javascript
// ❌ Bị cache:
const url = `https://raw.githubusercontent.com/.../revoked.json`;

// ✅ Bypass cache:
const url = `https://raw.githubusercontent.com/.../revoked.json?t=${Date.now()}`;
// + header: 'Cache-Control': 'no-cache'
```
Nếu không có cache-busting, sau khi admin mở khóa, client có thể mất tới 5 phút mới detect được.

**3. `revoked.json` vs `shops.json revoked:true` — HAI THỨ KHÁC NHAU:**
- `revoked.json`: danh sách machineId bị block thực sự → client check khi startup
- `shops.json[].revoked: true`: CHỈ là display trong bot `/danhsach` → KHÔNG ảnh hưởng client
- Khi admin nhấn 🔴 Khóa → CẢ HAI được cập nhật
- Khi admin nhấn 🟢 Mở khóa → CẢ HAI được cập nhật
- Nếu chỉ shops.json có `revoked:true` mà revoked.json không có machineId → client KHÔNG bị block (chỉ hiện sai màu trong bot)

**4. checkin.js endpoint — chỉ fix display, KHÔNG can thiệp revocation:**
```
Client startup với license hợp lệ → POST /api/checkin (Vercel)
  → Nếu machineId CÓ trong revoked.json → KHÔNG làm gì (để client bị block bình thường)
  → Nếu machineId KHÔNG có trong revoked.json nhưng shops.json có revoked:true (stale)
    → Xóa cờ revoked:true trong shops.json (fix display trong bot)
```

**5. Thứ tự kiểm tra khi startup (exe mới):**
```
t=0s: startRevocationWatcher() trong server.js — schedule setTimeout(3s)
t=1s: heartbeat.start() — reset licCheckFile, async check GitHub
t=1-3s: heartbeat check hoàn thành → kill/restoreLicense
t=3s: server.js doCheck(forceCheck=true) → check GitHub lần nữa → kill/restoreLicense
t=every 5min: setInterval check từ heartbeat + server.js
```

---

## 4. Hệ thống hai Bot Telegram (RẤT QUAN TRỌNG)

### ⚠️ Có HAI bot khác nhau, KHÔNG được nhầm lẫn:

| | Bot LOCAL (admin-panel/bot.js) | Bot VERCEL (vercel-bot/api/webhook.js) |
|---|---|---|
| Chạy ở đâu | Máy tính của admin (long polling) | Vercel serverless (webhook) |
| Lệnh admin | `/list`, `/help` | `/danhsach`, `/thongke`, `/khoa`, `/mokhoa` |
| Lưu data | `admin-panel/data.json` (local) | `shops.json` trên GitHub (qua API) |
| Lưu license | `db.addLicense()` → local data.json | `saveShops()` → GitHub shops.json |

### Nút trong bot VERCEL — mỗi shop có:
```
[🔴 Khóa: TÊN SHOP]  [🗑️ Xóa]   ← nếu đang active
[🟢 Mở khóa: TÊN]   [🗑️ Xóa]   ← nếu đang revoked
```
Nút 🗑️ Xóa → hỏi xác nhận 2 bước → xóa khỏi shops.json + revoked.json

### Env vars cần thiết trên Vercel:
- `BOT_TOKEN` — Token bot Telegram
- `ADMIN_CHAT_ID` — Chat ID của admin
- `GITHUB_TOKEN` — Personal Access Token (scope: repo) để đọc/ghi shops.json
- `WEBHOOK_SECRET` — Bí mật xác thực webhook
- **Nếu GITHUB_TOKEN hết hạn** → `/danhsach` hiện 0 shop → vào Vercel tạo PAT mới, update env var, redeploy

### shops.json race condition (lỗi đã xảy ra):
Khi vercel-bot kích hoạt mà GitHub API lỗi tạm thời → `getShops()` trả về `[]` → `saveShops([1 shop])` → **MẤT HẾT dữ liệu cũ**. Nếu `/danhsach` hiện 0, kiểm tra shops.json trên GitHub còn đủ không.

---

## 5. Hệ thống Update Check

```
Client (index.ejs) → fetch('/api/update-check') mỗi 5 phút
  → server.js (cache 5 phút)
    → updater.js → GitHub Releases API
      → So sánh tag_name với config.js VERSION
        → Nếu có version mới → badge đỏ "MỚI" ở menu sidebar "Cập nhật phần mềm"
```

### UI Update (index.ejs):
- **KHÔNG còn banner xanh phía trên** — đã xóa hoàn toàn
- Menu **"Cập nhật phần mềm"** luôn hiện dưới "Nhân viên" (admin only)
- Khi có bản mới: badge đỏ **"MỚI"** nhấp nháy bên cạnh menu item
- Click vào → modal hiện rõ: phiên bản đang dùng → phiên bản mới, kích thước file, release notes
- Khi đang dùng bản mới nhất: modal hiện "✅ Bạn đang dùng phiên bản mới nhất!"

### ⚠️ CẢNH BÁO: Xung đột tên hàm openUpdateModal
```javascript
// index.ejs định nghĩa: openUpdateModal() — mở modal CẬP NHẬT PHẦN MỀM
// repairs.ejs CŨ định nghĩa: openUpdateModal(id) — mở modal sửa phiếu sửa chữa
// → XUNG ĐỘT: index.ejs load sau → ghi đè hàm của repairs.ejs
// → Khi click "Cập nhật" trong bảng sửa chữa → mở nhầm modal cập nhật phần mềm!

// ✅ ĐÃ FIX: repairs.ejs dùng tên riêng:
function openRepairUpdateModal(id) { ... }  // ← tên khác, không bị ghi đè
```
**KHÔNG BAO GIỜ** đặt hàm trong partial EJS (repairs, customers, v.v.) trùng tên với hàm global trong index.ejs.

### ⚠️ CẢNH BÁO: Auto-update restart — KHÔNG dùng VBS/wscript
```javascript
// ❌ BUG CŨ (server.js PS1 script):
// Start-Process 'wscript.exe' -ArgumentList 'QuanLyBanHang.vbs'
// → VBS kiểm tra IsAdmin() → gọi runas → popup UAC trong cửa sổ ẨN
// → Không ai thấy UAC dialog → exe không bao giờ khởi động lại được
// → Browser kẹt mãi ở "Đang kết nối lại..."

// ✅ FIX ĐÚNG (hiện tại):
// Start-Process 'QuanLyBanHang.exe' -ArgumentList '--via-vbs' -WindowStyle Hidden
// → PS1 kế thừa quyền Admin từ exe gốc → không cần UAC thêm
// → exe thấy --via-vbs → bỏ qua bootstrap VBS → server lên bình thường
```
**Lưu ý:** Khách dùng exe CŨ (trước khi có fix này) phải cài exe mới thủ công 1 lần. Từ version có fix trở đi, auto-update hoạt động bình thường.

---

## 6. activate.ejs — Trang kích hoạt

Trang này hiển thị trong **mọi trường hợp** license không active (không redirect đi nữa):

| Trạng thái | Banner | Hành động |
|---|---|---|
| `status.active = true` | 🟢 Xanh — "Giấy phép đang hoạt động" | Hiện ngày hết hạn + nút "Vào phần mềm" |
| `status.revoked = true` | ⛔ Đỏ đậm — "Bị thu hồi" | Polling 10s → auto-redirect khi mở khóa |
| `status.expired = true` | 🟠 Cam — "Đã hết hạn" | Nhập key mới |
| else | 🔴 Đỏ — "Chưa kích hoạt" | Nhập key / mở Telegram |

**Polling script** (chỉ chạy khi `status.revoked`):
```javascript
setInterval(function() {
    fetch('/api/license-status')
        .then(d => d.json())
        .then(d => {
            if (d.active) → redirect về '/'  // Đã được mở khóa
            if (!d.revoked) → reload trang    // Trạng thái khác
        });
}, 10000); // mỗi 10 giây
```

---

## 7. Quy trình Build exe

### ⚠️ Build từ ROOT directory, KHÔNG phải release/

```bash
# Bước 1: Obfuscate source → release/QuanLyBanHang/
npm run build
# (scripts/build.js — đã bao gồm heartbeat.js, tray.js, config.js)

# Bước 2: Đóng gói thành exe từ ROOT directory
npx pkg . --target node18-win-x64 --output dist/QuanLyBanHang.exe
# pkg tự follow require() chains để bundle heartbeat.js, tray.js, etc.
# ⚠️ Chạy từ ROOT, không chạy từ release/
```

**Hoặc dùng publish script (tự động tăng version + build + mở GitHub):**
```powershell
.\scripts\publish.ps1
# → Tăng version, build exe, mở File Explorer + GitHub Releases
```

**⚠️ `release/QuanLyBanHang/` chứa code obfuscated** — không đọc được. Exe được build từ ROOT source files (không obfuscated). release/ chỉ là bản "portable node" để chạy `node server.js` thủ công.

**Sau khi build exe mới:**
1. Tạo GitHub Release với tag `v1.0.XX`
2. Upload `dist/QuanLyBanHang.exe` vào Release
3. Khách tải về và thay thế exe cũ

---

## 8. Quy trình Git Push (LƯU Ý ĐẶC BIỆT)

### ⚠️ Git index bị LOCK thường xuyên — dùng temp index

```bash
# Luôn dùng cách này (Bash):
GIT_INDEX_FILE=/tmp/idx_xxx git read-tree HEAD
GIT_INDEX_FILE=/tmp/idx_xxx git add file1.js file2.js
TREE=$(GIT_INDEX_FILE=/tmp/idx_xxx git write-tree)
COMMIT=$(GIT_AUTHOR_NAME="QLBH" GIT_AUTHOR_EMAIL="qlbh@local" \
         GIT_COMMITTER_NAME="QLBH" GIT_COMMITTER_EMAIL="qlbh@local" \
         git commit-tree $TREE -p HEAD -m "commit message")
printf "$COMMIT" > .git/refs/heads/main
git push origin main
```

### ⚠️ Remote thường có commits mới hơn local
Vercel-bot tự cập nhật shops.json → remote có commits mới → push bị reject.

**Cách xử lý:**
1. `cat .git/FETCH_HEAD` để lấy remote SHA sau khi fetch
2. `git read-tree <REMOTE_SHA>` → add files → commit với `-p <REMOTE_SHA>` → push

### ⚠️ KHÔNG dùng pipe PowerShell để copy file lớn
`git cat-file -p ... | Set-Content` bị cắt ngắn output → file không đầy đủ.

---

## 9. Thông tin Config & Bot

```javascript
// config.js (v1.0.44) — KHÔNG commit file này lên git (trong .gitignore)
BOT_USERNAME: 'QLBHMayTinh_Bot'
BOT_TOKEN: '[HIDDEN — xem config.js trên máy local, không được commit]'
PORT: 3000
DEVELOPER_CHAT_ID: '[HIDDEN — xem config.js trên máy local]'
VERCEL_CHECKIN_URL: 'https://quanlybanhang-umber.vercel.app/api/checkin'
```

**GitHub Repo:** `https://github.com/inbaobitamky-cmd/quanlybanhang`
**Vercel Bot URL:** `https://quanlybanhang-umber.vercel.app`
**Bot webhook:** `https://quanlybanhang-umber.vercel.app/api/webhook`

---

## 10. Gotchas – Những điều HAY GÂY LỖI

### 10a. GitHub CDN cache raw URL (~5 phút)
Khi đọc `raw.githubusercontent.com`, response bị cache Fastly ~5 phút. Luôn thêm `?t=${Date.now()}` + header `Cache-Control: no-cache` để bypass. Đã fix trong license.js.

### 10b. CRLF trong EJS files (Windows)
EJS files có line ending `\r\n`. Edit tool của Claude dùng `\n` → không match.
Fix: dùng Node.js script với `.replace(/\r\n/g, '\n')`.

### 10c. Server load data vào RAM
`database.js` load `data.json` vào RAM khi khởi động. Sửa file trực tiếp khi server chạy → không có tác dụng, phải restart.

### 10d. invoice-print.ejs là file HTML HOÀN CHỈNH
Không phải partial. Có đầy đủ `<html><head><body>`. Không dùng layout index.ejs.

### 10e. printQuote() trong sell.ejs
Build HTML string rồi `w.document.write(html)`.
⚠️ KHÔNG đặt `</script>` bên trong template literal.

### 10f. shops.json race condition
Khi GitHub API lỗi tạm thời → `getShops()` trả về `[]` → `saveShops([1 shop])` → mất hết. Nếu `/danhsach` hiện 0 → kiểm tra shops.json + GITHUB_TOKEN.

### 10g. Hai thư mục project
- **CHỈNH SỬA Ở:** `D:\file DEv quan trong\quanlybanhang\`
- **KHÔNG sửa:** `release\QuanLyBanHang\` (bị overwrite khi build)

### 10h. admin-panel/data.json vs shops.json KHÔNG đồng bộ
- `admin-panel/data.json`: license từ LOCAL bot
- `shops.json`: dữ liệu cho `/danhsach` (chỉ cập nhật khi kích hoạt qua vercel-bot)
- `/danhsach` trên Telegram chỉ thấy shop kích hoạt qua vercel-bot

### 10i. Khi build exe, heartbeat.js và tray.js PHẢI có trong obfuscate list
scripts/build.js đã bao gồm `heartbeat.js`, `tray.js`, `config.js`. Nếu thiếu → exe không có code mới nhất cho các file này.

### 10j. getLicenseStatus() được cache 60 giây
Sau khi `blockLicense()` hoặc `unblockLicense()`, cache bị invalidate ngay (hàm đã gọi `invalidateLicenseCache()`). Middleware sẽ nhận trạng thái mới ở request tiếp theo.

### 10k. callCheckin() KHÔNG được xóa revoked.json
`vercel-bot/api/checkin.js` chỉ fix stale display trong `shops.json`. Nếu machineId CÓ trong `revoked.json` → return ngay, không làm gì → để client bị block bình thường.

### 10l. Xung đột hàm JavaScript giữa partial EJS và index.ejs
Tất cả partial EJS (repairs.ejs, customers.ejs, v.v.) được nhúng vào index.ejs qua `<%- include(...) %>`. Tất cả `<script>` trong các file này chạy cùng 1 scope trình duyệt. **Nếu partial dùng tên hàm trùng với hàm global trong index.ejs → hàm nào khai báo SAU sẽ ghi đè.** Đặt tên hàm đặc trưng cho từng module:
- `openRepairUpdateModal(id)` ← repairs.ejs (KHÔNG phải `openUpdateModal`)
- `openUpdateModal()` ← index.ejs (phần mềm update)

### 10m. Tiếp nhận sửa chữa (repairs) — cấu trúc dữ liệu và đồng bộ bảo hành
```javascript
// data.repairs[]:
{ id, code, type, status, customerName, customerPhone,
  deviceName, serial, issue, accessories, estimatedCost,
  warrantyMonths, warrantyNote, note, receivedAt, receivedBy,
  returnedAt, returnedBy, finalCost, paymentMethod, paid }

// Khi returnRepair() chạy với warrantyMonths > 0:
//   → tạo data.warranties[] entry với repairId: repair.id
//   → expiryDate tính từ saleDate (ngày trả máy)

// Khi updateRepair() sửa warrantyMonths/warrantyNote:
//   → TÌM data.warranties.find(w => w.repairId === repair.id)
//   → Cập nhật warranty.warrantyMonths, tính lại expiryDate từ warranty.saleDate gốc
//   → KHÔNG dùng Date.now() để tránh drift thời gian
//   → Cập nhật warranty.status + warranty.note
```
**Nút "Cập nhật" trong bảng sửa chữa hiện với MỌI trạng thái kể cả "Đã trả"** (để sửa bảo hành nhập sai). Modal ẩn dropdown Trạng thái khi repair đã ở "Đã trả".

---

## 11. Luồng dữ liệu chính

```
database.js.addSale() ← server.js POST /api/sales ← sell.ejs
database.js.searchWarranty() ← server.js GET /api/warranty/search ← warranty.ejs
invoice-print.ejs ← server.js GET /invoice/:code ← sell.ejs + history.ejs
updater.js ← server.js GET /api/update-check (cache 5p) ← index.ejs (60s interval)

heartbeat.js (startup):
  → Gửi Telegram "Khách vừa mở phần mềm" đến DEVELOPER_CHAT_ID
  → checkOnlineRevocation() → kill/restoreLicense (NO bypass)
  → callCheckin() → Vercel /api/checkin (fix stale shops.json display only)

server.js startRevocationWatcher:
  → setTimeout(3s): doCheck(forceCheck=true) → kill/restoreLicense
  → setInterval(5min): doCheck(false) → kill/restoreLicense

vercel-bot/api/webhook.js:
  → /danhsach → buildShopListMessage(shops) → buttons [🔴/🟢 + 🗑️]
  → revoke/unrevoke: cập nhật revoked.json + shops.json
  → delete_confirm/delete_yes: xóa khỏi cả hai
  → /ok callback: saveShops + auto-unrevoke từ revoked.json khi cấp key mới

vercel-bot/api/checkin.js:
  → POST { machineId, secret=BOT_TOKEN, daysLeft }
  → Nếu machineId trong revoked.json → return (không can thiệp)
  → Nếu shops.json có revoked:true nhưng không trong revoked.json → fix display
```

---

## 12. sell.ejs — Trang bán hàng (Giỏ hàng)

### 12a. Sửa giá inline trong giỏ hàng
```javascript
// Pattern: editingPriceIndex (đã có sẵn)
let editingPriceIndex = -1;
// Click vào giá → set editingPriceIndex = index → renderCart() → hiện <input>
// Enter / blur → savePrice(index) → set cart[index].price → renderCart()
// Escape → cancelPriceEdit() → editingPriceIndex = -1 → renderCart()
```

### 12b. Sửa bảo hành inline trong giỏ hàng (ĐÃ THÊM)
```javascript
// Pattern GIỐNG HỆT editingPriceIndex — đã triển khai:
let editingWarrantyIndex = -1;

function editWarranty(index) { editingWarrantyIndex = index; renderCart(); ... }
function saveWarrantyEdit(index) { cart[index].warrantyMonths = val; editingWarrantyIndex = -1; renderCart(); }
function cancelWarrantyEdit() { editingWarrantyIndex = -1; renderCart(); }
```

**warrantyCell trong renderCart():**
- Khi `editingWarrantyIndex === index`: hiện `<input id="warrantyEditInput" type="number">`
- Khi không editing: hiện `<span onclick="editWarranty(index)">🛡️ X tháng / Không BH</span>`
- Màu xanh `#2fb344` nếu > 0, màu xám `#aaa` nếu = 0
- Border-bottom dashed để gợi ý có thể click edit
- **Hiện với CẢ sản phẩm lẫn dịch vụ** (không lọc theo type)

**Đồng bộ dữ liệu — KHÔNG cần sửa backend:**
```
cart[index].warrantyMonths được sửa trực tiếp trong JS
  → completeSale() gửi items[] với warrantyMonths mới
  → server.js POST /api/sales → database.js addSale()
  → addSale() dùng item.warrantyMonths để tạo warranty record
  → warranty.expiryDate = saleDate + warrantyMonths * 30 ngày
```
Kết quả: lịch sử bán + bảo hành đều phản ánh đúng số tháng đã sửa.

---

## 13. products.ejs — Nhập giá có định dạng & gợi ý

### 13a. 3 input giá (Giá vốn / Giá lẻ / Giá sỉ)
Các input `productCostPrice`, `productRetailPrice`, `productWholesalePrice` là **type="text"** (KHÔNG phải number).
Mỗi input bọc trong `<div class="price-wrap">` để dropdown gợi ý định vị absolute.

```html
<div class="price-wrap">
    <input type="text" id="productCostPrice" value="0" placeholder="0"
        oninput="onPriceInput(this)"
        onfocus="onPriceFocus(this)"
        onblur="onPriceBlur(this)">
</div>
```

### 13b. Hàm helper giá (trong <script> của products.ejs)

| Hàm | Mục đích |
|---|---|
| `getPriceVal(id)` | Đọc giá trị: bỏ dấu chấm → `parseInt` → số nguyên |
| `setPriceVal(id, num)` | Ghi giá trị: `num.toLocaleString('vi-VN')` → input.value |
| `onPriceFocus(el)` | Strip định dạng khi focus (để gõ tự do), `el.select()` |
| `onPriceBlur(el)` | Format lại `1.000.000` khi blur; ẩn dropdown sau 180ms |
| `onPriceInput(el)` | Lấy raw digits → gọi `_showPriceSuggestions()` |
| `_showPriceSuggestions(el, num, digits)` | Tạo dropdown ×1K/×10K/×100K/×1M/×10M |
| `selectPriceSug(e, id, val)` | `e.preventDefault()` (chặn blur) → điền giá → ẩn dropdown |

**Lưu ý `selectPriceSug` dùng `e.preventDefault()`** — bắt buộc để mousedown không trigger blur trước khi điền giá.

### 13c. Lấy/gán giá trong saveProduct() và editProductFromRow()
```javascript
// ✅ ĐÚNG — dùng helper:
costPrice: getPriceVal('productCostPrice'),
retailPrice: getPriceVal('productRetailPrice'),
wholesalePrice: getPriceVal('productWholesalePrice'),

// Khi edit (editProductFromRow):
setPriceVal('productCostPrice', product.costPrice || 0);
setPriceVal('productRetailPrice', product.retailPrice || product.price);
setPriceVal('productWholesalePrice', product.wholesalePrice || product.price);

// Khi mở modal thêm mới (openProductModal):
setPriceVal('productCostPrice', 0);
// (productRetailPrice và productWholesalePrice để trống — user nhập)
```

### 13d. CSS class liên quan
```css
.price-wrap { position:relative; }
.price-suggestions { position:absolute; top:100%; left:0; right:0; z-index:999; display:none; ... }
.price-sug-item { padding:9px 14px; cursor:pointer; ... }
.price-sug-item:hover { background:#f0f7ff; color:#206bc4; font-weight:600; }
```

### 13e. UX hoạt động như thế nào
```
User click vào input → focus → strip dấu chấm → select all
User gõ "26"        → input event → _showPriceSuggestions → dropdown hiện:
                         26.000đ / 260.000đ / 2.600.000đ / 26.000.000đ / 260.000.000đ
User click "2.600.000đ" → mousedown e.preventDefault() → el.value = "2.600.000" → dropdown ẩn
User click ra ngoài → blur → format lại "2.600.000" (nếu chưa format)
```

---

## 14. vercel-bot/api/webhook.js — deleteShop & revokeShop

### 14a. Logic deleteShop (ĐÃ FIX — phải revoke trước khi xóa)
```javascript
async function deleteShop(machineId) {
    const mid = machineId.toUpperCase();
    // 1. Thêm vào revoked.json TRƯỚC (đảm bảo client bị khóa ngay)
    const { list, sha } = await getRevokedList();
    const alreadyRevoked = list.some(id => id.toUpperCase() === mid);
    if (!alreadyRevoked) {
        const revokeOk = await ghPut('revoked.json', [...list, mid], sha, `Delete+revoke ${mid}`);
        if (!revokeOk) {
            // Nếu GitHub API lỗi → ABORT, không xóa khỏi shops.json
            return { error: 'revoke_failed' };
        }
    }
    // 2. Chỉ xóa khỏi shops.json sau khi revoke thành công
    const { shops, sha: s2 } = await getShops();
    const filtered = shops.filter(s => (s.machineId || '').toUpperCase() !== mid);
    await saveShops(filtered, s2);
    return { ok: true };
}
```

**Handler delete_yes kiểm tra:**
```javascript
if (result.error === 'revoke_failed') {
    // Báo admin lỗi, KHÔNG xóa
} else {
    // Xóa thành công
}
```

### 14b. Tại sao quan trọng
- **Bug cũ:** deleteShop GỌI unrevoke (xóa khỏi revoked.json) rồi mới xóa shops.json
  → Máy bị xóa khỏi list nhưng KHÔNG bị khóa → vẫn chạy phần mềm như thường
- **Fix mới:** deleteShop ADD vào revoked.json TRƯỚC → máy bị khóa ngay lập tức → rồi mới xóa khỏi shops.json
- `revokeShop()` và `deleteShop()` đều dùng `.toUpperCase()` cho machineId (case-insensitive)

### 14c. Nếu thấy máy không bị khóa sau khi xóa
→ Gửi `/khoa MACHINEID` trực tiếp vào bot để add vào revoked.json thủ công
