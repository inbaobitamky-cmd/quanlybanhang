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
| Build exe | `pkg` v6.15.0 → `QuanLyBanHang.exe` (~48MB) |
| Obfuscation | `javascript-obfuscator` (chạy khi `npm run build`) |
| UI framework | Tabler UI Beta17 + Tabler Icons webfont v2.40.0 (CDN) |
| CSS chính | `public/css/style.css` |
| Version hiện tại | `1.0.31` (config.js + version.json) |

---

## 2. Cấu trúc thư mục

```
quanlybanhang/                    ← THƯ MỤC GỐC (luôn sửa ở đây)
├── server.js                     ← Express routes + khởi động app (PORT 3000)
├── database.js                   ← Toàn bộ logic đọc/ghi data.json
├── data.json                     ← CƠ SỞ DỮ LIỆU chính (JSON, không phải SQLite)
├── config.js                     ← VERSION, BOT_TOKEN, PORT, APP_NAME, DEVELOPER_CHAT_ID
├── version.json                  ← {"version":"1.0.31","name":"Quản Lý Bán Hàng"}
├── license.js                    ← generateKey(machineId, months) + generateResetCode()
├── updater.js                    ← Kiểm tra update từ GitHub Releases API
├── heartbeat.js                  ← Gửi Telegram khi khách mở phần mềm
├── shops.json                    ← Danh sách cửa hàng được kích hoạt (dùng bởi vercel-bot)
├── revoked.json                  ← Danh sách machineId bị thu hồi license
├── views/
│   ├── index.ejs                 ← Layout chính (sidebar + header + include page con)
│   ├── sell.ejs                  ← Bán hàng + giỏ hàng + dịch vụ
│   ├── warranty.ejs              ← Tra cứu bảo hành
│   ├── invoice-print.ejs         ← In hóa đơn (file HTML ĐỘC LẬP, KHÔNG qua index.ejs)
│   ├── history.ejs               ← Lịch sử đơn hàng
│   ├── products.ejs              ← Danh sách linh kiện
│   ├── customers.ejs             ← Quản lý khách hàng
│   ├── suppliers.ejs             ← Nhà cung cấp
│   ├── revenue.ejs               ← Báo cáo doanh thu (Chart.js)
│   ├── transactions.ejs          ← Thu chi
│   ├── settings.ejs              ← Cài đặt + backup + danh mục
│   ├── login.ejs                 ← Đăng nhập (mật khẩu admin)
│   └── activate.ejs              ← Kích hoạt license (nhập key)
├── public/
│   └── css/style.css             ← CSS toàn bộ giao diện (sidebar màu, per-page theming)
├── admin-panel/
│   ├── bot.js                    ← Bot Telegram LOCAL (long polling, /list, kích hoạt)
│   ├── db.js                     ← Đọc/ghi admin-panel/data.json (licenses + pending)
│   ├── data.json                 ← DB của admin panel: licenses[], pending[], settings{}
│   ├── index.js                  ← Web UI admin panel (Express, port khác)
│   └── views/                   ← Giao diện web admin panel
├── vercel-bot/
│   ├── api/webhook.js            ← Bot Telegram trên Vercel (/danhsach, /thongke, /khoa)
│   └── lib/keygen.js             ← generateKey() dùng trong vercel-bot
├── scripts/
│   └── build.js                  ← npm run build: obfuscate + copy → release/
├── release/
│   ├── QuanLyBanHang/            ← Thư mục build (bị OVERWRITE mỗi lần build)
│   └── QuanLyBanHang.exe         ← File exe cuối cùng (copy cái này cho khách)
└── backups/                      ← Auto-backup data.json mỗi 1 tiếng, giữ 7 ngày
```

---

## 3. Hệ thống License

### 3a. Cách tạo key
```javascript
// license.js
generateKey(machineId, months)
// months > 0  → gói theo tháng (6, 12, 24, 36...)
// months = 0  → Vĩnh viễn (expiry = '9999-12-31')
// months < 0  → Dùng thử theo ngày (-15 = 15 ngày, -30 = 30 ngày)
```

**Brute-force range:** license.js tìm key trong 60 ngày tới → đủ cho -15 và -30 ngày thử.

### 3b. Kiểm tra license khi khởi động
```
exe khởi động → license.js checkLicense(machineId)
  → Tìm trong thư mục AppData/License/
  → Brute-force giải key (duyệt ngày trong vòng 60 ngày)
  → Nếu hết hạn → redirect sang activate.ejs
  → Nếu còn hạn → chạy bình thường
```

### 3c. Gói kích hoạt hiện tại (bot Telegram)
| Nút | callback_data | Ghi chú |
|---|---|---|
| 🧪 15 Ngày (thử) | `ok\|userId\|machineId\|-15` | Thử nghiệm |
| 🧪 30 Ngày (thử) | `ok\|userId\|machineId\|-30` | Thử nghiệm dài |
| 🕕 6 Tháng | `ok\|userId\|machineId\|6` | |
| 1️⃣ 1 Năm | `ok\|userId\|machineId\|12` | |
| 2️⃣ 2 Năm | `ok\|userId\|machineId\|24` | |
| 3️⃣ 3 Năm | `ok\|userId\|machineId\|36` | |
| ♾️ Vĩnh viễn | `ok\|userId\|machineId\|0` | |
| ❌ Từ chối | `no\|userId\|machineId` | |

---

## 4. Hệ thống hai Bot Telegram (RẤT QUAN TRỌNG)

### ⚠️ Có HAI bot khác nhau, KHÔNG được nhầm lẫn:

| | Bot LOCAL (admin-panel/bot.js) | Bot VERCEL (vercel-bot/api/webhook.js) |
|---|---|---|
| Chạy ở đâu | Máy tính của admin (long polling) | Vercel serverless (webhook) |
| Lệnh admin | `/list`, `/help` | `/danhsach`, `/thongke`, `/khoa`, `/mokhoa` |
| Lưu data | `admin-panel/data.json` (local) | `shops.json` trên GitHub (qua API) |
| Kích hoạt | Nút inline keyboard từ pending | Nút inline keyboard từ pending |
| Lưu license | `db.addLicense()` → local data.json | `saveShops()` → GitHub shops.json |

### Lệnh bot VERCEL (`vercel-bot/api/webhook.js`)
- `/danhsach` hoặc `📋 Danh sách cửa hàng` → Xem danh sách + nút khóa/mở
- `/thongke` hoặc `📊 Thống kê` → Thống kê tổng quan
- `/khoa MACHINEID` → Khóa cửa hàng
- `/mokhoa MACHINEID` → Mở khóa cửa hàng
- `/help` → Hướng dẫn

### shops.json (GitHub) vs data.json (local)
- `shops.json`: chỉ chứa shop kích hoạt QUA vercel-bot
- `admin-panel/data.json`: chứa shop kích hoạt QUA local bot
- **HAI HỆ THỐNG KHÔNG ĐỒNG BỘ VỚI NHAU**

### Lỗi đã gặp với shops.json:
Khi vercel-bot kích hoạt, nó gọi `getShops()` → nếu GitHub API lỗi tạm thời → trả về `[]` → `saveShops([1 shop])` → **MẤT HẾT dữ liệu cũ**. Đây là bug đã xảy ra, cần cẩn thận.

### Env vars cần thiết trên Vercel:
- `BOT_TOKEN` — Token bot Telegram
- `ADMIN_CHAT_ID` — Chat ID của admin
- `GITHUB_TOKEN` — Personal Access Token (scope: repo) để đọc/ghi shops.json
- `WEBHOOK_SECRET` — Bí mật xác thực webhook (tùy chọn)

---

## 5. Hệ thống Update Check

### Cách hoạt động:
```
Client (index.ejs) → fetch('/api/update-check') mỗi 60 giây
  → server.js (cache 5 phút, key _updateCheckCache)
    → updater.js → GitHub Releases API
      → So sánh tag_name với config.js VERSION
        → Nếu version mới → trả về {hasUpdate:true, ...}
          → index.ejs hiện banner + dot đỏ trên sidebar
```

### Cache:
- **Server-side:** 5 phút TTL (`UPDATE_CHECK_TTL = 5 * 60_000`)
- **Client-side:** localStorage key `updateInfo_v3`, TTL 60 giây
- ⚠️ Nếu network error → `{ upToDate: true, _networkError: true }` → **KHÔNG cache** client

### Quy trình publish version mới:
1. Tăng `VERSION` trong `config.js` và `version.json`
2. Build: `npm run build` → `npx pkg . --output dist/QuanLyBanHang.exe`
3. Tạo GitHub Release với tag `v1.0.XX`
4. Upload file exe vào Release
5. Khách đang dùng phiên bản cũ sẽ thấy thông báo sau tối đa 1 phút

---

## 6. Giao diện (UI)

### Sidebar multi-color (public/css/style.css)
Mỗi mục sidebar có class `.ni-*` với màu riêng:
- `.ni-sell` → xanh dương (#2563eb)
- `.ni-customers` → tím (#7c3aed)
- `.ni-products` → cam (#ea580c)
- `.ni-history` → xanh lá (#16a34a)
- `.ni-warranty` → đỏ (#dc2626)
- `.ni-revenue` → vàng (#d97706)
- `.ni-transactions` → hồng (#db2777)
- `.ni-suppliers` → xanh cyan (#0891b2)
- `.ni-staff` → indigo (#4338ca)
- `.ni-settings-link` → xám (#374151)

### Per-page background theming
Mỗi trang có class `.page-<name>` trên `.page-wrapper`:
```html
<div class="page-wrapper page-<%= page %>">
```
CSS định nghĩa gradient nền và màu header theo từng page:
- `.page-sell` → xanh dương nhạt
- `.page-customers` → tím nhạt
- `.page-products` → cam nhạt
- `.page-history` → xanh lá nhạt
- `.page-warranty` → đỏ nhạt
- `.page-revenue` → vàng nhạt
- `.page-transactions` → hồng nhạt
- `.page-suppliers` → cyan nhạt

### Tên cửa hàng dynamic trên sidebar (index.ejs)
```javascript
// Sidebar brand name — lấy từ settings.shopName
<%= (settings && settings.shopName && settings.shopName.trim())
    ? settings.shopName.trim().toUpperCase()
    : 'TÊN CỬA HÀNG' %>
```
Khi lưu cài đặt → `settings.ejs` gọi `window.location.reload()` để cập nhật sidebar ngay.

---

## 7. Cấu trúc data.json (DB chính)

```json
{
  "products": [],
  "categories": [],
  "subcategories": [],
  "suppliers": [],
  "sales": [],
  "warranties": [],
  "customers": [],
  "serials": [],
  "transactions": [],
  "settings": {},
  "expenseCategories": []
}
```

### Schema quan trọng

**products[]**
```json
{
  "id": 1700000000000,
  "name": "Chuột Dareu LM106G",
  "category": 10,
  "subcategory": null,
  "costPrice": 80000,
  "retailPrice": 170000,
  "wholesalePrice": 150000,
  "warrantyMonths": 12,
  "stock": 91,
  "colors": [],
  "hasSerial": false,
  "supplierId": null,
  "supplierWarrantyMonths": 0,
  "createdAt": "2024-..."
}
```

**sales[]**
```json
{
  "id": 1700000000001,
  "code": "DH1700000000001",
  "customerId": 123,
  "items": [
    {
      "productId": 456,
      "price": 170000,
      "quantity": 2,
      "serial": "",
      "color": "",
      "warrantyMonths": 12,
      "isService": false
    }
  ],
  "subtotal": 340000,
  "discount": 0,
  "total": 340000,
  "date": "2024-..."
}
```

---

## 8. Quy trình Build exe

```bash
# Bước 1: Build + obfuscate + copy sang release/
npm run build

# Bước 2: Đóng gói thành exe
cd release/QuanLyBanHang
npx pkg .
# → release/QuanLyBanHang.exe (~48MB)
```

**⚠️ Warnings "Cannot resolve dynamic require"** khi pkg: BÌNH THƯỜNG, bỏ qua.

**Khi phát hành version mới:**
1. Tăng `VERSION` trong `config.js` và `version.json`
2. `npm run build` → `npx pkg .`
3. Tạo GitHub Release với tag `v1.0.XX`, upload exe

---

## 9. Quy trình Git Push (LƯU Ý ĐẶC BIỆT)

### ⚠️ Git index bị LOCK thường xuyên trên máy này
File `.git/index` hay bị khóa → `git add` báo lỗi `unable to write new index file`.

**Cách bypass (đã test thành công):**
```powershell
# Bước 1: Copy index ra temp file
$tmpIdx = "$env:TEMP\git-index-tmp-$(New-Guid)"
Copy-Item ".git\index" $tmpIdx
$env:GIT_INDEX_FILE = $tmpIdx

# Bước 2: Add files vào temp index (trong 1 PowerShell session)
Set-Location "D:\file DEv quan trong\quanlybanhang"
git add file1.js file2.js ...

# Bước 3: Write tree
$tree = git write-tree

# Bước 4: Tạo commit (dùng commit-tree)
$parent = Get-Content ".git\refs\heads\main"
$commit = "commit message" | git -c user.email="dev@quanlybanhang.vn" -c user.name="QuanLyBanHang Dev" commit-tree $tree -p $parent.Trim()

# Bước 5: Cập nhật ref trực tiếp (vì update-ref cũng bị khóa)
Set-Content -Path ".git\refs\heads\main" -Value $commit -Encoding ascii

# Bước 6: Push
git push origin main
# Sau push fix ref tracking:
Set-Content -Path ".git\refs\remotes\origin\main" -Value $commit -Encoding ascii
```

### ⚠️ Remote có thể có commits mới (vercel-bot cập nhật shops.json)
Luôn fetch trước khi push. Nếu bị non-fast-forward:
1. `git fetch origin`
2. Tạo commit từ REMOTE tree (`git read-tree origin/main`) + apply thay đổi local
3. Commit trên đầu remote HEAD
4. Push

### ⚠️ KHÔNG dùng `git cat-file -p ... | Set-Content` để copy file lớn
Pipe PowerShell bị cắt ngắn output → file không đầy đủ → commit sai.
Thay vào đó dùng: `git show COMMIT:path/to/file > localfile` hoặc `git show COMMIT:path/to/file | Out-File -Encoding utf8`

---

## 10. Luồng dữ liệu quan trọng

### 10a. Bán hàng → Bảo hành
```
sell.ejs (completeSale)
  → POST /api/sales (server.js)
    → db.addSale() (database.js)
      → Trừ tồn kho (product.stock / colors[].stock / serial.status)
      → Tạo bản ghi warranties[] cho TỪNG item
      → Gắn saleId + saleCode vào tất cả warranties
      → Tự động tạo/cập nhật customers[]
```

**⚠️ Khi sửa addSale():** `_warrantyStart` dùng để tag saleId/saleCode SAU vòng forEach. Đừng add `data.warranties.push()` sau forEach mà không cập nhật logic tagging.

### 10b. Tra cứu bảo hành
```
warranty.ejs → GET /api/warranty/search?serial=|phone=|name=|code=
  → db.searchWarranty()
    - serial/phone/name: tìm includes()
    - code: tìm sale.code → lấy w.saleId === sale.id → fallback: serial trong đơn
```

**⚠️ Records trước 4/2026** chưa có `saleId` → tìm theo code chỉ thấy nếu có serial.

### 10c. In hóa đơn
```
sell.ejs → window.open('/invoice/DH...')
  → server.js GET /invoice/:code → render invoice-print.ejs (STANDALONE HTML)
```

### 10d. Tồn kho theo loại sản phẩm

| Loại | Điều kiện | Trừ tồn kho | Bảo hành |
|---|---|---|---|
| Serial | `hasSerial: true` | `serials[].status = 'Đã bán'` | 1 BH/serial |
| Màu | `colors.length > 0` | `colors[i].stock -= qty` | 1 BH/item |
| Đơn giản | else | `product.stock -= qty` | 1 BH/item |
| Dịch vụ | `isService: true` | Không trừ | 1 BH/service |

---

## 11. API Routes chính (server.js)

| Method | Path | Chức năng |
|---|---|---|
| GET | `/` | Trang bán hàng |
| GET | `/products` | Danh sách linh kiện |
| GET | `/history` | Lịch sử bán |
| GET | `/warranty` | Tra cứu bảo hành |
| GET | `/customers` | Khách hàng |
| GET | `/suppliers` | Nhà cung cấp |
| GET | `/revenue?type=&year=&month=` | Báo cáo |
| GET | `/transactions` | Thu chi |
| GET | `/settings` | Cài đặt |
| GET | `/invoice/:code` | In hóa đơn (standalone) |
| POST | `/api/sales` | Tạo đơn hàng |
| GET | `/api/warranty/search` | Tra cứu BH |
| PUT | `/api/warranty/:id` | Cập nhật BH |
| GET | `/api/settings` | Lấy cài đặt |
| POST | `/api/settings` | Lưu cài đặt |
| GET | `/api/update-check` | Kiểm tra version mới (cache 5 phút) |
| GET | `/api/machine-info/:id` | Thông tin máy (cho bot) |

---

## 12. Gotchas – Những điều HAY GÂY LỖI

### 12a. CRLF trong EJS files (Windows)
EJS files có line ending `\r\n`. Edit tool của Claude dùng `\n` → không match → NO CHANGE.

**Fix:** Dùng Node.js script:
```javascript
let c = fs.readFileSync(filepath, 'utf8').replace(/\r\n/g, '\n');
c = c.replace('OLD', 'NEW');
fs.writeFileSync(filepath, c, 'utf8');
```

### 12b. Server load data vào RAM
`database.js` load `data.json` vào RAM khi khởi động. Sửa file trực tiếp khi server chạy → không có tác dụng, phải restart.

### 12c. invoice-print.ejs là file HTML HOÀN CHỈNH
Không phải partial. Có đầy đủ `<html><head><body>`. Không dùng layout index.ejs.

### 12d. printQuote() trong sell.ejs
Build HTML string (template literal) rồi `w.document.write(html)`.
**⚠️ KHÔNG** đặt `</script>` bên trong template literal → sẽ đóng `<script>` sớm, hỏng toàn bộ JS.

### 12e. Backup tự động
- Interval: 1 tiếng
- Giữ 168 bản (7 ngày × 24)
- Nếu `data.json` hỏng → tự khôi phục từ backup gần nhất khi restart

### 12f. shops.json race condition
Khi vercel-bot kích hoạt mà GitHub API lỗi tạm thời → `getShops()` trả về `[]` → `saveShops([1 shop])` → mất hết dữ liệu cũ. Nếu `/danhsach` hiện 0, kiểm tra:
1. shops.json trên GitHub còn đầy đủ không
2. `GITHUB_TOKEN` trong Vercel còn hiệu lực không

### 12g. Hai thư mục project
- **CHỈNH SỬA Ở:** `D:\file DEv quan trong\quanlybanhang\`
- **KHÔNG sửa:** `D:\file DEv quan trong\quanlybanhang\release\QuanLyBanHang\` (bị overwrite khi build)

### 12h. admin-panel/data.json vs shops.json
- **admin-panel/data.json**: license data từ LOCAL bot (không tự đồng bộ lên GitHub)
- **shops.json**: dữ liệu hiển thị trên `/danhsach` (chỉ cập nhật khi kích hoạt qua vercel-bot)
- `/danhsach` trên Telegram chỉ thấy shop kích hoạt qua vercel-bot, KHÔNG thấy shop kích hoạt qua local bot

---

## 13. Thông tin Bot & Config

```javascript
// config.js
BOT_USERNAME: 'QLBHMayTinh_Bot'
BOT_TOKEN: '8609402555:AAHv2VmO0K0oVPext8LBUf7YGfyBfSogX_o'
PORT: 3000
APP_NAME: 'Quản Lý Bán Hàng'
VERSION: '1.0.31'
DEVELOPER_CHAT_ID: '5240628702'   // Admin Telegram ID
```

```javascript
// admin-panel/data.json → settings
githubToken: 'ghp_e3ui...'         // GitHub PAT (dùng trong admin panel)
githubRepo: 'inbaobitamky-cmd/quanlybanhang'
```

**GitHub Repo:** `https://github.com/inbaobitamky-cmd/quanlybanhang`

---

## 14. Danh sách cửa hàng hiện tại (shops.json)

| Cửa hàng | Machine ID | Gói | Trạng thái |
|---|---|---|---|
| TRẦN PHÚ COMPUTER | BF87B1-E5EEEE-3AD64B-FE8F90 | Vĩnh viễn ♾️ | Hoạt động |
| Quân | 6E1DE5-D7A968-77006E-6632D3 | 6 tháng | Bị khóa |
| ÁNH DƯƠNG COMPUTER | 586233-7103A7-85FCBC-CD1902 | Vĩnh viễn ♾️ | Hoạt động |
| ÁNH DƯƠNG COMPUTER | 76C948-7F8062-6BD856-6F6BEA | Vĩnh viễn ♾️ | Hoạt động |
| THIÊN AN | AC86AF-FB1A7F-06BE56-658EE3 | 3 ngày thử | Hết hạn |
| THỦ ĐỨC COMPUTER | BF0B35-6DCBEB-4A3DFC-B35BC0 | 3 ngày thử | Hết hạn |
| HBACK COMPUTER | 7DB0F9-E67BFD-13F0FF-EAD981 | 3 ngày thử | Hết hạn |
| BÁC SĨ TIN HỌC | D785E5-97B350-31DB7F-643CA9 | 3 ngày thử | Hết hạn |

---

## 15. Liên kết giữa các file (không được phá vỡ)

```
database.js.addSale()
    ↕ gọi
server.js POST /api/sales
    ↕ dữ liệu
sell.ejs completeSale()

database.js.searchWarranty()
    ↕ gọi
server.js GET /api/warranty/search
    ↕ gọi
warranty.ejs searchWarrantyInfo()

invoice-print.ejs
    ↕ render bởi
server.js GET /invoice/:code
    ↕ link từ
sell.ejs (sau completeSale) + history.ejs

updater.js.checkForUpdate()
    ↕ gọi
server.js GET /api/update-check (cache 5 phút)
    ↕ fetch mỗi 60 giây
index.ejs (setInterval auto-check)

heartbeat.js
    ↕ chạy khi khởi động exe
    ↕ gửi Telegram đến DEVELOPER_CHAT_ID
    ↕ thông tin: shopName, machineId, licenseStatus

admin-panel/bot.js (local polling)
    ↕ nhận yêu cầu kích hoạt từ khách
    ↕ ghi vào admin-panel/data.json

vercel-bot/api/webhook.js (Vercel webhook)
    ↕ nhận yêu cầu kích hoạt từ khách
    ↕ đọc/ghi shops.json trên GitHub via API
    ↕ lệnh admin: /danhsach /thongke /khoa /mokhoa
```
