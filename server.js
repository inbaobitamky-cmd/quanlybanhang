const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const db = require('./database');
const telegram = require('./telegram');
const license = require('./license');
const updater   = require('./updater');
const config    = require('./config');
const heartbeat = require('./heartbeat');
const tray      = require('./tray');

// ── VBS Launcher: tạo + tự redirect nếu chạy thẳng exe ─────────
(function bootstrapVbs() {
    if (typeof process.pkg === 'undefined') return; // bỏ qua khi dev

    const exeDir  = path.dirname(process.execPath);
    const vbsPath = path.join(exeDir, 'QuanLyBanHang.vbs');

    // Nội dung VBS — truyền --via-vbs để exe biết đã qua launcher
    const vbsContent = [
        'Option Explicit',
        "' QuanLyBanHang.vbs - Tu dong tao boi phan mem, KHONG XOA",
        'Dim oFSO, oWSH, scriptDir, exePath',
        'Set oFSO  = CreateObject("Scripting.FileSystemObject")',
        'Set oWSH  = CreateObject("WScript.Shell")',
        'scriptDir = oFSO.GetParentFolderName(WScript.ScriptFullName)',
        'exePath   = scriptDir & "\\QuanLyBanHang.exe"',
        'If Not oFSO.FileExists(exePath) Then',
        '    MsgBox "Khong tim thay QuanLyBanHang.exe!", vbCritical, "Loi"',
        '    WScript.Quit',
        'End If',
        'Dim oProcs, oProc, n : n = 0',
        'Set oProcs = GetObject("winmgmts:\\\\.\\root\\cimv2").ExecQuery("SELECT * FROM Win32_Process WHERE Name=\'QuanLyBanHang.exe\'")',
        'For Each oProc In oProcs : n = n + 1 : Next',
        'If n > 0 Then',
        '    MsgBox "Phan mem dang chay roi!" & vbCrLf & "Nhin goc phai man hinh (System Tray).", vbInformation, "Quan Ly Ban Hang"',
        '    WScript.Quit',
        'End If',
        'If Not IsAdmin() Then',
        '    Dim oShell : Set oShell = CreateObject("Shell.Application")',
        '    oShell.ShellExecute "wscript.exe", Chr(34) & WScript.ScriptFullName & Chr(34), scriptDir, "runas", 0',
        '    WScript.Quit',
        'End If',
        // Truyền --via-vbs để exe không redirect lại VBS
        'oWSH.Run Chr(34) & exePath & Chr(34) & " --via-vbs", 0, False',
        'Function IsAdmin()',
        '    On Error Resume Next',
        '    Dim r : r = oWSH.Run("cmd /c net session >nul 2>&1", 0, True)',
        '    IsAdmin = (r = 0)',
        '    On Error GoTo 0',
        'End Function'
    ].join('\r\n');

    // Luôn ghi VBS (cập nhật nội dung nếu có thay đổi)
    try { fs.writeFileSync(vbsPath, vbsContent, 'utf8'); } catch(e) {}

    // Nếu exe được mở TRỰC TIẾP (không qua VBS) → tự redirect sang VBS
    // VBS sẽ yêu cầu admin + khởi động lại exe ẩn hoàn toàn
    if (!process.argv.includes('--via-vbs')) {
        try {
            const { spawn } = require('child_process');
            // spawn detached — wscript.exe tồn tại độc lập sau khi ta exit
            const child = spawn('wscript.exe', [vbsPath], {
                detached:    true,
                stdio:       'ignore',
                windowsHide: true
            });
            child.unref();
        } catch(e) {}
        process.exit(0); // Thoát ngay — VBS sẽ mở lại exe đúng cách (ẩn + admin)
    }
})();

// Đọc bot username theo thứ tự ưu tiên:
// 1. admin-panel/data.json (máy dev — luôn mới nhất, không cần restart)
// 2. config.js (baked-in khi build .exe cho khách)
function getBotUsername() {
    try {
        const adminData = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'admin-panel', 'data.json'), 'utf8')
        );
        const u = (adminData?.settings?.telegramBotUsername || '').replace('@', '').trim();
        if (u) return u;
    } catch {}
    const u = config.BOT_USERNAME || '';
    return (u && u !== 'YourBotUsername') ? u : null;
}

const app = express();
const PORT = config.PORT || 3000;

db.initData();
db.autoBackup();
setInterval(db.autoBackup, 1 * 60 * 60 * 1000);

// ============ CRON TELEGRAM (kiểm tra mỗi phút) ============
let _lastDebtNotifDay = -1;   // tránh gửi 2 lần cùng ngày
let _lastRevenueDay = -1;
setInterval(() => {
    const now = new Date();
    const hh = now.getHours();
    const mm = now.getMinutes();
    const today = now.getDate();

    // Nhắc công nợ lúc 08:00 sáng mỗi ngày
    if (hh === 8 && mm === 0 && _lastDebtNotifDay !== today) {
        _lastDebtNotifDay = today;
        db.runDebtNotifications();
    }

    // Báo cáo doanh thu lúc 00:05 (sau nửa đêm 5 phút, báo cho ngày hôm qua)
    if (hh === 0 && mm === 5 && _lastRevenueDay !== today) {
        _lastRevenueDay = today;
        db.runDailyRevenue();
    }
}, 60 * 1000);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
    secret: 'quanlybanhang-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// ============== SERVER-SIDE REVOCATION POLL ==============
(function startRevocationWatcher() {
    const machineId = license.getMachineId();

    function doCheck(forceCheck) {
        const st = license.getLicenseStatus();
        // Chạy khi active HOẶC khi đang bị revoke (để tự phục hồi khi được mở khóa)
        if (!st.active && !st.revoked) return;

        license.checkOnlineRevocation(machineId, forceCheck).then(notRevoked => {
            if (!notRevoked) {
                // GitHub nói bị thu hồi → block ngay, kể cả key local còn hạn
                license.blockLicense();
            } else if (notRevoked && st.revoked) {
                // GitHub nói không còn bị thu hồi → unblock ngay (đã được kích hoạt lại)
                license.unblockLicense();
                license.invalidateLicenseCache();
            }
        }).catch(() => {});
    }

    // ── Check NGAY KHI KHỞI ĐỘNG (forceCheck=true, bỏ qua throttle) ──
    setTimeout(() => doCheck(true), 3000); // đợi 3s để server ổn định

    // ── Check định kỳ mỗi 5 phút ──
    setInterval(() => doCheck(false), 5 * 60 * 1000);
})();

// ============== LICENSE MIDDLEWARE ==============
const _licenseExcluded = ['/activate', '/api/activate', '/login', '/logout'];
app.use((req, res, next) => {
    // Bỏ qua API calls, static assets, và các route không cần license
    if (req.path.startsWith('/api/')) return next();
    if (_licenseExcluded.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
    if (req.path.match(/\.(css|js|png|jpg|jpeg|ico|woff|woff2|ttf|svg|gif)$/i)) return next();

    const status = license.getLicenseStatus(); // đã được cache 60s
    if (!status.active) return res.redirect('/activate');
    next();
});

// ============== AUTH MIDDLEWARE ==============
function requireAuth(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ Admin được phép thực hiện thao tác này' });
    next();
}

function requireAdminPage(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== 'admin') return res.redirect('/');
    next();
}

// Helper: build render data — chỉ những gì thực sự cần
function baseData(req, extra = {}) {
    return {
        currentUser: req.session.user,
        products: db.getProductsWithStock(),
        sales: db.getSales(),
        categories: db.getCategories(),
        subcategories: db.getSubcategories(),
        suppliers: db.getSuppliers(),
        warranties: db.getWarranties(),
        customers: db.getCustomers(),
        settings: db.getSettings(),
        serials: db.getSerials(),
        transactions: db.getTransactions(),
        licenseStatus: license.getLicenseStatus(), // đã cached — gọi nhanh
        appVersion: updater.getCurrentVersion(),
        ...extra
    };
}

// Cache tạm machine info theo machineId để bot admin lấy được
const _machineInfoCache = {};

// ============== ACTIVATE ==============
app.get('/activate', (req, res) => {
    const status      = license.getLicenseStatus();
    if (status.active) return res.redirect(req.session.user ? '/' : '/login');
    const machineId   = license.getMachineId();
    const machineInfo = license.getMachineInfo();
    const botUsername = getBotUsername();

    // Lưu machine info vào cache (bot admin sẽ lấy qua /api/machine-info/:id)
    _machineInfoCache[machineId] = { ...machineInfo, cachedAt: Date.now() };

    // Telegram deep link chỉ gửi machineId — max 27 ký tự, luôn hợp lệ
    // (base64 full info bị Telegram cắt vì > 64 ký tự)
    const machineIdPayload = machineId;

    res.render('activate', { status, machineId, machineInfo, botUsername, machineIdPayload });
});

// Trạng thái license — dùng để trang /activate polling tự động redirect khi được mở khóa
// Khi đang bị revoked: force check GitHub ngay để phát hiện unrevoke tức thì
app.get('/api/license-status', (req, res) => {
    const st = license.getLicenseStatus();
    if (!st.revoked) {
        return res.json({ active: st.active, revoked: false });
    }
    // Đang bị block → force check online ngay (reset cache)
    const fs2 = require('fs'), path2 = require('path'), os2 = require('os');
    const appData = process.env.APPDATA || path2.join(os2.homedir(), 'AppData', 'Roaming');
    const checkFile = typeof process.pkg !== 'undefined'
        ? path2.join(appData, 'QuanLyBanHang', 'license.check')
        : path2.join(__dirname, 'license.check');
    try { fs2.writeFileSync(checkFile, '0'); } catch {} // reset cache → force check

    const machineId = license.getMachineId();
    license.checkOnlineRevocation(machineId).then(notRevoked => {
        if (notRevoked) {
            license.unblockLicense(); // xóa license.blocked → mở khóa ngay
            const newSt = license.getLicenseStatus();
            res.json({ active: newSt.active, revoked: false });
        } else {
            res.json({ active: false, revoked: true });
        }
    }).catch(() => res.json({ active: st.active, revoked: true }));
});

// Bot admin lấy machine info từ cache (gọi nội bộ từ admin-panel nếu cùng máy)
app.get('/api/machine-info/:id', (req, res) => {
    const info = _machineInfoCache[req.params.id.toUpperCase()];
    if (!info) return res.json({ found: false });
    res.json({ found: true, ...info });
});

app.post('/api/activate', (req, res) => {
    try {
        const { key } = req.body || {};
        if (!key) return res.json({ success: false, error: 'Vui lòng nhập key kích hoạt' });
        const result = license.activateKey(key);
        res.json(result);
    } catch(err) {
        console.error('[Activate] Error:', err.message);
        res.json({ success: false, error: 'Lỗi xử lý: ' + err.message });
    }
});

// ============== LOGIN / LOGOUT ==============
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.validateLogin(username, password);
    if (!user) return res.render('login', { error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    req.session.user = user;
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ============== RESET MẬT KHẨU ADMIN ==============
app.get('/reset-admin', (req, res) => {
    const machineId = license.getMachineId();
    const botUsername = config.BOT_USERNAME || '';
    res.render('reset-admin', { machineId, botUsername });
});

// Khách gửi yêu cầu reset → bot nhắn thẳng đến developer
app.post('/api/reset-admin/request', async (req, res) => {
    try {
        const machineId  = license.getMachineId();
        const shopSettings = db.getSettings();
        const shopName   = shopSettings.shopName || 'Không rõ';

        // Ưu tiên: token + chatId của cửa hàng → gửi đến dev chat ID
        // Fallback: đọc từ admin-panel/data.json (bot riêng của developer)
        let token, devChatId;

        // Thử lấy từ config.js (được sync từ admin panel)
        if (config.DEVELOPER_CHAT_ID && shopSettings.telegramBotToken) {
            token     = shopSettings.telegramBotToken;
            devChatId = config.DEVELOPER_CHAT_ID;
        }

        // Fallback: đọc trực tiếp từ admin-panel/data.json
        if (!token || !devChatId) {
            try {
                const adminData = JSON.parse(
                    fs.readFileSync(path.join(__dirname, 'admin-panel', 'data.json'), 'utf8')
                );
                token     = token     || adminData.settings?.telegramBotToken;
                devChatId = devChatId || adminData.settings?.telegramAdminChatId;
            } catch {}
        }

        if (!token || !devChatId) {
            return res.json({ ok: false, reason: 'no_bot' });
        }

        const d = new Date();
        const dateStr = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

        const text = `🆘 <b>YÊU CẦU ĐẶT LẠI MẬT KHẨU ADMIN</b>\n\n🏪 <b>Cửa hàng:</b> ${shopName}\n🖥 <b>Mã máy:</b>\n<code>${machineId}</code>\n📅 <b>Thời gian:</b> ${dateStr}\n\n▶️ Chạy lệnh để lấy OTP:\n<code>node scripts/gen-reset.js ${machineId}</code>`;

        const result = await telegram.sendTelegram(token, devChatId, text);
        res.json({ ok: result.ok });
    } catch(e) {
        console.error('[ResetRequest] lỗi:', e.message);
        res.json({ ok: false, reason: 'error' });
    }
});

app.post('/api/reset-admin', (req, res) => {
    try {
        const { code, newPassword } = req.body;
        if (!code || !newPassword) return res.json({ error: 'Thiếu thông tin' });
        if (newPassword.length < 6) return res.json({ error: 'Mật khẩu phải ít nhất 6 ký tự' });

        if (!license.validateResetCode(code)) {
            return res.json({ error: 'Mã không hợp lệ hoặc đã hết hạn (mã chỉ dùng được trong ngày)' });
        }

        const result = db.resetAdminPassword(newPassword);
        if (result.error) return res.json({ error: result.error });

        console.log(`[ResetAdmin] Đã đặt lại mật khẩu admin lúc ${new Date().toLocaleString('vi-VN')}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[ResetAdmin] Lỗi:', err);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// ============== TRANG CHỦ ==============
app.get('/', requireAuth, (req, res) => {
    res.render('index', { page: 'sell', ...baseData(req) });
});

app.get('/products', requireAuth, (req, res) => {
    res.render('index', { page: 'products', ...baseData(req) });
});

app.get('/history', requireAuth, (req, res) => {
    res.render('index', { page: 'history', repairs: db.getRepairs(), ...baseData(req) });
});

app.get('/warranty', requireAuth, (req, res) => {
    res.render('index', { page: 'warranty', ...baseData(req) });
});

app.get('/customers', requireAuth, (req, res) => {
    res.render('index', { page: 'customers', ...baseData(req) });
});

app.get('/settings', requireAdminPage, (req, res) => {
    res.render('index', { page: 'settings', ...baseData(req) });
});

app.get('/revenue', requireAdminPage, (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    const month = req.query.month || new Date().getMonth() + 1;
    const reportType = req.query.type || 'daychart';
    const selectedDay = req.query.day ? parseInt(req.query.day) : (reportType === 'day' ? new Date().getDate() : null);
    // 'daychart' dùng cùng logic tính toán như 'day' nhưng không lọc theo ngày cụ thể
    const dbReportType = reportType === 'daychart' ? 'day' : reportType;
    const dbSelectedDay = reportType === 'daychart' ? null : selectedDay;
    const reportData = db.getAdvancedRevenueReport(year, month, dbReportType, dbSelectedDay);

    res.render('index', {
        page: 'revenue', year, month, reportType, selectedDay,
        inventory: db.getInventoryValue(),
        totalSalesRevenue: reportData.totalSalesRevenue || 0,
        totalOtherIncome: reportData.totalOtherIncome || 0,
        totalCost: reportData.totalCost || 0,
        totalExpense: reportData.totalExpense || 0,
        daysInMonth: reportData.daysInMonth || 30,
        dailyData: reportData.dailyData || [],
        monthlyData: reportData.monthlyData || {},
        yearlyData: reportData.yearlyData || {},
        ...baseData(req)
    });
});

app.get('/transactions', requireAdminPage, (req, res) => {
    res.render('index', { page: 'transactions', expenseCategories: db.getExpenseCategories(), ...baseData(req) });
});

app.get('/suppliers', requireAdminPage, (req, res) => {
    res.render('index', { page: 'suppliers', ...baseData(req) });
});

app.get('/admin/users', requireAdminPage, (req, res) => {
    res.render('index', { page: 'admin-users', users: db.getUsers(), ...baseData(req) });
});

app.get('/repairs', requireAuth, (req, res) => {
    res.render('index', { page: 'repairs', ...baseData(req) });
});

// ============== API REPAIRS ==============
app.get('/api/repairs', requireAuth, (req, res) => {
    const { q, status } = req.query;
    res.json(db.searchRepairs({ q, status }));
});

app.post('/api/repairs', requireAuth, (req, res) => {
    const repair = db.addRepair({ ...req.body, receivedBy: req.session.user.displayName });
    res.json({ ok: true, repair });
});

app.put('/api/repairs/:id', requireAuth, (req, res) => {
    const repair = db.updateRepair(req.params.id, req.body);
    if (!repair) return res.json({ ok: false, error: 'Không tìm thấy phiếu' });
    res.json({ ok: true, repair });
});

app.post('/api/repairs/:id/return', requireAuth, (req, res) => {
    const result = db.returnRepair(req.params.id, { ...req.body, returnedBy: req.session.user.displayName });
    if (result.error) return res.json({ ok: false, error: result.error });
    res.json({ ok: true, repair: result });
});

app.post('/api/repairs/:id/cancel', requireAuth, (req, res) => {
    const result = db.cancelRepair(req.params.id);
    if (result.error) return res.json({ ok: false, error: result.error });
    res.json({ ok: true });
});

app.get('/debts', requireAuth, (req, res) => {
    res.render('index', { page: 'debts', ...baseData(req) });
});

// ============== API SUPPLIERS ==============
app.get('/api/suppliers', requireAuth, (req, res) => res.json(db.getSuppliers()));
app.post('/api/suppliers', requireAdmin, (req, res) => res.json(db.addSupplier(req.body)));
app.put('/api/suppliers/:id', requireAdmin, (req, res) => res.json(db.updateSupplier(req.params.id, req.body)));
app.delete('/api/suppliers/:id', requireAdmin, (req, res) => res.json({ success: db.deleteSupplier(req.params.id) }));

// API Backup
app.post('/api/backup', requireAdmin, (req, res) => res.json(db.manualBackup(req.body.destDir || null)));
app.get('/api/backup/download', requireAdmin, (req, res) => {
    const ts = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const filename = `data_backup_${ts}.json`;
    res.setHeader('X-Filename', filename);
    res.download(db.getDataFile(), filename);
});

app.get('/invoice/:code', requireAuth, (req, res) => {
    const sale = db.getSales().find(s => s.code === req.params.code);
    if (!sale) return res.status(404).send('Không tìm thấy hóa đơn');
    res.render('invoice-print', { sale, settings: db.getSettings() });
});

// ============== API PRODUCTS ==============
app.get('/api/products', requireAuth, (req, res) => res.json(db.getProducts()));
app.post('/api/products', requireAdmin, (req, res) => res.json(db.addProduct(req.body)));
app.put('/api/products/:id', requireAdmin, (req, res) => res.json(db.updateProduct(req.params.id, req.body)));
app.delete('/api/products/:id', requireAdmin, (req, res) => res.json({ success: db.deleteProduct(req.params.id) }));

// API Serials
app.get('/api/serials', requireAuth, (req, res) => res.json(db.getSerials()));
app.get('/api/serials/:productId', requireAuth, (req, res) => res.json(db.getAvailableSerials(req.params.productId, req.query.color)));
app.post('/api/serials', requireAdmin, (req, res) => res.json(db.addSerial(req.body)));

// API Sales
app.get('/api/sales', requireAuth, (req, res) => res.json(db.getSales()));
app.post('/api/sales', requireAuth, (req, res) => {
    const saleData = {
        ...req.body,
        createdById: req.session.user.id,
        createdByName: req.session.user.displayName
    };
    res.json(db.addSale(saleData));
});
app.put('/api/sales/:id', requireAdmin, (req, res) => {
    try {
        const saleBefore = (db.getSales() || []).find(s => String(s.id) === String(req.params.id));
        const result = db.updateSale(req.params.id, { ...req.body, updatedBy: req.session.user.displayName });
        if (!result.error && saleBefore) {
            try { telegram.notifySaleModified('edit', saleBefore, db.getSettings(), req.session.user.displayName).catch(() => {}); } catch(_) {}
        }
        res.json(result);
    } catch(err) {
        console.error('PUT /api/sales/:id lỗi:', err);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// Xóa đơn hàng: ?returnStock=true → trả hàng về kho; ?returnStock=false → chỉ xóa bản ghi
app.delete('/api/sales/:id', requireAdmin, (req, res) => {
    try {
        const returnStock = req.query.returnStock !== 'false';
        const saleBefore = (db.getSales() || []).find(s => String(s.id) === String(req.params.id));
        const result = db.deleteSale(req.params.id, returnStock);
        if (!result.error && saleBefore) {
            const action = returnStock ? 'delete_return' : 'delete_keep';
            try { telegram.notifySaleModified(action, saleBefore, db.getSettings(), req.session.user.displayName).catch(() => {}); } catch(_) {}
        }
        res.json(result);
    } catch(err) {
        console.error('DELETE /api/sales/:id lỗi:', err);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// API Shifts (Ca làm việc)
app.get('/api/shifts', requireAdmin, (req, res) => res.json(db.getShifts(req.query.userId)));
app.get('/api/shifts/active', requireAuth, (req, res) => res.json(db.getActiveShift(req.session.user.id) || {}));
app.post('/api/shifts/clockin', requireAuth, (req, res) => res.json(db.clockIn(req.session.user)));
app.post('/api/shifts/clockout', requireAuth, (req, res) => res.json(db.clockOut(req.session.user.id)));

// API Categories
app.get('/api/categories', requireAuth, (req, res) => res.json(db.getCategories()));
app.post('/api/categories', requireAdmin, (req, res) => res.json(db.addCategory(req.body)));
app.put('/api/categories/:id', requireAdmin, (req, res) => res.json(db.updateCategory(req.params.id, req.body)));
app.delete('/api/categories/:id', requireAdmin, (req, res) => res.json({ success: db.deleteCategory(req.params.id) }));

// API Subcategories
app.get('/api/subcategories', requireAuth, (req, res) => res.json(db.getSubcategories()));
app.get('/api/subcategories/:categoryId', requireAuth, (req, res) => res.json(db.getSubcategoriesByCategory(req.params.categoryId)));
app.post('/api/subcategories', requireAdmin, (req, res) => res.json(db.addSubcategory(req.body)));
app.put('/api/subcategories/:id', requireAdmin, (req, res) => res.json(db.updateSubcategory(req.params.id, req.body)));
app.delete('/api/subcategories/:id', requireAdmin, (req, res) => res.json({ success: db.deleteSubcategory(req.params.id) }));

// API Warranty
app.get('/api/warranty/search', requireAuth, (req, res) => res.json(db.searchWarranty({ serial: req.query.serial, phone: req.query.phone, name: req.query.name, code: req.query.code })));
app.get('/api/warranty/suggest', requireAuth, (req, res) => res.json(db.suggestWarranty({ type: req.query.type, q: req.query.q })));
app.put('/api/warranty/:id', requireAdmin, (req, res) => res.json(db.updateWarrantyStatus(req.params.id, req.body.status, req.body.note)));

// API Customers
app.get('/api/customers', requireAuth, (req, res) => res.json(db.getCustomers()));
app.get('/api/customers/search', requireAuth, (req, res) => res.json(db.searchCustomer(req.query.q)));
app.post('/api/customers', requireAuth, (req, res) => res.json(db.addCustomer(req.body)));
app.put('/api/customers/:id', requireAuth, (req, res) => res.json(db.updateCustomer(req.params.id, req.body)));
app.delete('/api/customers/:id', requireAdmin, (req, res) => res.json({ success: db.deleteCustomer(req.params.id) }));

// API Transactions
app.get('/api/transactions', requireAdmin, (req, res) => res.json(db.getTransactions()));
app.post('/api/transactions', requireAdmin, (req, res) => res.json(db.addTransaction(req.body)));
app.put('/api/transactions/:id', requireAdmin, (req, res) => res.json(db.updateTransaction(req.params.id, req.body)));
app.delete('/api/transactions/:id', requireAdmin, (req, res) => res.json({ success: db.deleteTransaction(req.params.id) }));

// API Settings
app.get('/api/settings', requireAuth, (req, res) => res.json(db.getSettings()));
app.post('/api/settings', requireAdmin, (req, res) => {
    db.saveSettings(req.body);
    res.json({ success: true });
});

// API Update check
// Server-side cache cho update check — 5 phút, tránh spam GitHub API
let _updateCheckCache = null;
let _updateCheckAt    = 0;
const UPDATE_CHECK_TTL = 5 * 60_000; // 5 phút

app.get('/api/update-check', requireAuth, async (req, res) => {
    try {
        const now = Date.now();
        // Dùng cache nếu còn hiệu lực
        if (_updateCheckCache !== null && now - _updateCheckAt < UPDATE_CHECK_TTL) {
            return res.json(_updateCheckCache);
        }
        const info = await updater.checkForUpdate();
        const result = info || { upToDate: true };
        // Chỉ cache kết quả hợp lệ (không cache lỗi)
        _updateCheckCache = result;
        _updateCheckAt    = now;
        res.json(result);
    } catch {
        // Lỗi network — trả về flag để client không cache
        res.json({ upToDate: true, _networkError: true });
    }
});

// API Update download — Server-Sent Events (stream tiến trình về client)
app.get('/api/update/download', requireAdmin, async (req, res) => {
    // SSE headers
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj) => {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };

    try {
        // 1. Kiểm tra phiên bản
        send({ step: 'check', msg: 'Đang kiểm tra phiên bản mới...' });
        const info = await updater.checkForUpdate();

        if (!info) {
            send({ step: 'error', msg: 'Không tìm thấy bản cập nhật mới.' });
            return res.end();
        }
        if (!info.downloadUrl) {
            send({ step: 'error', msg: `Tìm thấy v${info.version} nhưng không có file .exe trong release. Tải thủ công tại: ${info.releaseUrl}` });
            return res.end();
        }

        send({ step: 'found', msg: `Tìm thấy v${info.version} — bắt đầu tải về...`, version: info.version });

        // 2. Xác định đường dẫn
        const exePath = updater.getExePath();
        const baseDir = exePath ? path.dirname(exePath) : __dirname;
        const exeName = exePath ? path.basename(exePath) : 'QuanLyBanHang.exe';
        const tempPath = path.join(baseDir, exeName + '.update_tmp');
        const ps1Path  = path.join(baseDir, 'do_update.ps1');

        // Xóa file tạm cũ nếu còn sót
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

        // 3. Tải file mới
        await updater.downloadUpdate(info.downloadUrl, tempPath, (pct, downloaded, total) => {
            const mb = (downloaded / 1048576).toFixed(1);
            const totalMb = (total / 1048576).toFixed(1);
            send({ step: 'progress', pct, msg: `Đang tải... ${mb} / ${totalMb} MB (${pct}%)` });
        });

        send({ step: 'preparing', msg: 'Tải xong! Đang chuẩn bị cập nhật...' });

        // 4. Tạo PowerShell script thay thế exe + restart (đáng tin cậy hơn bat)
        if (exePath) {
            const vbsPath = path.join(path.dirname(exePath), 'QuanLyBanHang.vbs');
            // Dùng single-quote để tránh lỗi path có dấu cách trong PS
            const esc = p => p.replace(/'/g, "''"); // escape single quote cho PS
            const ps1 = [
                '# Auto-update script — tu xoa sau khi chay',
                'Start-Sleep -Seconds 3',
                '',
                '# Thay the exe moi (thu nhieu lan neu bi lock)',
                '$i = 0',
                'while ($i -lt 30) {',
                '    try {',
                `        Move-Item -Path '${esc(tempPath)}' -Destination '${esc(exePath)}' -Force -ErrorAction Stop`,
                '        break',
                '    } catch {',
                '        Start-Sleep -Seconds 1',
                '        $i++',
                '    }',
                '}',
                '',
                '# Khoi dong lai: dung VBS neu co (an CMD + admin), fallback ve exe',
                `if (Test-Path '${esc(vbsPath)}') {`,
                `    Start-Process 'wscript.exe' -ArgumentList '${esc(vbsPath)}'`,
                '} else {',
                `    Start-Process '${esc(exePath)}'`,
                '}',
                '',
                '# Tu xoa script nay',
                'Start-Sleep -Seconds 1',
                `Remove-Item -Path '${esc(ps1Path)}' -Force -ErrorAction SilentlyContinue`
            ].join('\r\n');
            fs.writeFileSync(ps1Path, ps1, 'utf8');

            send({ step: 'done', msg: 'Đang khởi động lại phần mềm...', restart: true });
            res.end();

            // Chạy PS1 sau khi SSE đóng, rồi thoát process
            setTimeout(() => {
                const { spawn } = require('child_process');
                spawn('powershell.exe', [
                    '-WindowStyle',   'Hidden',
                    '-NonInteractive',
                    '-ExecutionPolicy','Bypass',
                    '-File',           ps1Path
                ], {
                    detached:    true,
                    stdio:       'ignore',
                    windowsHide: true
                }).unref();
                // Cho thêm 500ms để spawn kịp fork trước khi exit
                setTimeout(() => process.exit(0), 500);
            }, 2000);

        } else {
            // Dev mode (node server.js) — không tự thay thế được
            send({
                step: 'done_manual',
                msg:  `Đã tải xong → ${tempPath}\n(Đang chạy chế độ dev, tự thay thế thủ công)`,
                restart: false
            });
            res.end();
        }

    } catch (e) {
        send({ step: 'error', msg: `Lỗi: ${e.message}` });
        res.end();
    }
});

// ============== API ADMIN USERS ==============
app.get('/api/admin/users', requireAdmin, (req, res) => res.json(db.getUsers()));
app.post('/api/admin/users', requireAdmin, (req, res) => res.json(db.addUser(req.body)));
app.put('/api/admin/users/:id', requireAdmin, (req, res) => res.json(db.updateUser(req.params.id, req.body)));
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => res.json({ success: db.deleteUser(req.params.id) }));
app.post('/api/admin/change-password', requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.json({ error: 'Mật khẩu mới phải ít nhất 6 ký tự' });
    res.json(db.changePassword(req.session.user.id, oldPassword, newPassword));
});

// ============== API CÔNG NỢ ==============
app.get('/api/debts', requireAuth, (req, res) => res.json(db.getDebts()));
app.post('/api/debts/:id/payment', requireAuth, (req, res) => {
    try {
        const payment = { ...req.body, by: req.session.user.displayName };
        const result  = db.addDebtPayment(req.params.id, payment);
        if (!result.error) {
            // Thông báo Telegram khi khách trả nợ (async, không block response)
            const settings = db.getSettings();
            console.log('[DebtPayment] enabled:', settings.telegramEnabled, '| token:', !!settings.telegramBotToken, '| chatId:', !!settings.telegramChatId, '| customer:', result.customerName);
            try {
                telegram.notifyDebtPayment(result, payment, settings).catch(err => {
                    console.error('[DebtPayment] Telegram async lỗi:', err);
                });
            } catch(err) {
                console.error('[DebtPayment] Telegram sync lỗi:', err);
            }
        }
        res.json(result);
    } catch (err) {
        console.error('POST /api/debts/:id/payment lỗi:', err);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});
app.get('/api/notifications/debts', requireAuth, (req, res) => res.json(db.getDebtNotifications()));

// ============== API TELEGRAM ==============
app.post('/api/telegram/get-chat-id', requireAdmin, async (req, res) => {
    const { token } = req.body;
    if (!token || !token.trim()) return res.json({ ok: false, error: 'Chưa nhập Bot Token' });
    const result = await telegram.fetchChatId(token.trim());
    res.json(result);
});

app.post('/api/telegram/test', requireAdmin, async (req, res) => {
    const { token, chatId } = req.body;
    if (!token || !chatId) return res.json({ ok: false, error: 'Thiếu token hoặc chatId' });
    const result = await telegram.sendTelegram(token, chatId,
        `✅ <b>Kết nối thành công!</b>\n\nBot đã được cấu hình cho cửa hàng <b>${(db.getSettings().shopName || 'Quản lý bán hàng')}</b>.\nBạn sẽ nhận thông báo bán hàng, công nợ và báo cáo doanh thu tại đây.`
    );
    res.json(result);
});

app.post('/api/telegram/send-debt-now', requireAdmin, async (req, res) => {
    db.runDebtNotifications();
    res.json({ ok: true });
});

app.post('/api/telegram/send-revenue-now', requireAdmin, async (req, res) => {
    db.runDailyRevenue();
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server: http://localhost:${PORT}\n`);

    // ── Ẩn CMD + tạo tray icon + mở trình duyệt ──
    tray.setup(PORT);

    // ── Khởi động hệ thống heartbeat + kiểm tra thu hồi ──
    const shopName = db.getSettings().shopName || '';
    heartbeat.start({
        token:     config.BOT_TOKEN,
        chatId:    config.DEVELOPER_CHAT_ID,
        shopName,
        db,
        license
    });
});
