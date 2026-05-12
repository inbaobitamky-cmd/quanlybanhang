const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// =====================================================================
// ⚠️  THAY ĐỔI TRƯỚC KHI BUILD .EXE — đây là mật khẩu bí mật của bạn
// Sau khi thay đổi, chạy: npm run build
// Không chia sẻ chuỗi này với bất kỳ ai
// =====================================================================
// Secret reconstruct tại runtime qua XOR — không lưu plaintext trong source
// Mảng _raw = từng byte của secret XOR với 0x1F
// Giải mã: QLBH_PHANMEM_SECRET_2024_XZ9  (28 ký tự)
const _raw = [0x4E,0x53,0x5D,0x57,0x40,0x4F,0x57,0x5E,0x51,0x52,0x5A,0x52,0x40,
              0x4C,0x5A,0x5C,0x4D,0x5A,0x4B,0x40,0x2D,0x2F,0x2D,0x2B,0x40,0x47,0x45,0x26];
const MASTER_SECRET = _raw.map(c => String.fromCharCode(c ^ 0x1F)).join('');

// GitHub repo của bạn để check danh sách bị thu hồi
// Định dạng: 'username/repo-name'
// File revoked.json trong repo chứa: ["MACHINEID1", "MACHINEID2", ...]
const GITHUB_REVOKE_REPO = 'inbaobitamky-cmd/quanlybanhang';

// =====================================================================

// ── License lưu trong AppData (dùng chung toàn máy, không phụ thuộc thư mục exe) ──
function getLicenseFile() {
    if (typeof process.pkg !== 'undefined') {
        // Chạy qua .exe: lưu vào %APPDATA%\QuanLyBanHang\
        const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
        const dir = path.join(appData, 'QuanLyBanHang');
        if (!fs.existsSync(dir)) {
            try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
        }

        const newPath = path.join(dir, 'license.dat');

        // Migration: nếu license.dat cũ còn cạnh exe → chuyển sang AppData
        const oldPath = path.join(path.dirname(process.execPath), 'license.dat');
        if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
            try {
                fs.copyFileSync(oldPath, newPath);
                // Giữ lại file cũ (không xóa) để tránh mất dữ liệu
            } catch(e) {}
        }

        return newPath;
    }
    // Dev mode: lưu cạnh source
    return path.join(__dirname, 'license.dat');
}
const licenseFile = getLicenseFile();

// ============ LẤY THÔNG TIN PHẦN CỨNG ============
function runWmic(query) {
    try {
        return execSync(`wmic ${query}`, { timeout: 5000, windowsHide: true })
            .toString()
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.toLowerCase().includes('serialnumber') && !l.toLowerCase().includes('processorid') && l !== '')
            .join('').trim() || 'UNKNOWN';
    } catch { return 'UNKNOWN'; }
}

// Cache machine ID vĩnh viễn — phần cứng không đổi trong 1 phiên chạy
let _cachedMachineId = null;
function getMachineId() {
    if (_cachedMachineId) return _cachedMachineId;
    try {
        const cpu   = runWmic('cpu get ProcessorId');
        const board = runWmic('baseboard get SerialNumber');
        const bios  = runWmic('bios get SerialNumber');
        const disk  = runWmic('diskdrive get SerialNumber');
        const raw   = `${cpu}|${board}|${bios}|${disk}`;
        const hash  = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
        _cachedMachineId = `${hash.substring(0,6)}-${hash.substring(6,12)}-${hash.substring(12,18)}-${hash.substring(18,24)}`;
        return _cachedMachineId;
    } catch { return 'ERROR-CANNOT-READ'; }
}

function getMachineInfo() {
    try {
        const cpuRaw   = execSync('wmic cpu get Name /value', { timeout: 5000, windowsHide: true }).toString();
        const boardRaw = execSync('wmic baseboard get Manufacturer,Product /value', { timeout: 5000, windowsHide: true }).toString();
        const osRaw    = execSync('wmic os get Caption /value', { timeout: 5000, windowsHide: true }).toString();
        const ramRaw   = execSync('wmic computersystem get TotalPhysicalMemory /value', { timeout: 5000, windowsHide: true }).toString();

        const cpu  = cpuRaw.match(/Name=(.+)/)?.[1]?.trim() || 'Unknown CPU';
        const mfr  = boardRaw.match(/Manufacturer=(.+)/)?.[1]?.trim() || '';
        const prd  = boardRaw.match(/Product=(.+)/)?.[1]?.trim() || '';
        const os   = osRaw.match(/Caption=(.+)/)?.[1]?.trim() || 'Unknown OS';
        const ramB = parseInt(ramRaw.match(/TotalPhysicalMemory=(.+)/)?.[1] || '0');
        const ram  = ramB > 0 ? `${Math.round(ramB / 1073741824)} GB` : 'Unknown';

        return { cpu, board: `${mfr} ${prd}`.trim() || 'Unknown Board', os, ram };
    } catch { return { cpu: 'Unknown', board: 'Unknown', os: 'Windows', ram: 'Unknown' }; }
}

// ============ TẠO KEY ============
// months: 0 = vĩnh viễn, dương = tháng (6=6tháng, 12=1năm...), âm = ngày (-3 = 3 ngày thử)
function generateKey(machineId, months) {
    let expiry;
    if (months === 0) {
        expiry = '9999-12-31';
    } else if (months < 0) {
        // Âm = số ngày (ví dụ: -3 = 3 ngày thử nghiệm)
        expiry = new Date(Date.now() + Math.abs(months) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    } else {
        expiry = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    }

    const hmac = crypto.createHmac('sha256', MASTER_SECRET)
        .update(`${machineId}|${expiry}`)
        .digest('hex')
        .substring(0, 20)
        .toUpperCase();

    const key = `${hmac.substring(0,5)}-${hmac.substring(5,10)}-${hmac.substring(10,15)}-${hmac.substring(15,20)}`;
    return { key, expiry, machineId, months, generatedAt: new Date().toISOString() };
}

// ============ XÁC THỰC KEY ============
function validateKey(licData) {
    if (!licData || !licData.key || !licData.expiry || !licData.machineId) return false;
    try {
        // 1. Kiểm tra Machine ID khớp
        const currentId = getMachineId();
        if (currentId !== licData.machineId) return false;

        // 2. Kiểm tra HMAC
        const expected = crypto.createHmac('sha256', MASTER_SECRET)
            .update(`${licData.machineId}|${licData.expiry}`)
            .digest('hex')
            .substring(0, 20)
            .toUpperCase();

        if (licData.key.replace(/-/g, '') !== expected) return false;

        // 3. Kiểm tra hết hạn
        if (licData.expiry !== '9999-12-31') {
            if (new Date(licData.expiry + 'T23:59:59') < new Date()) return false;
        }

        // 4. Chống tua ngược đồng hồ: ngày hiện tại không được nhỏ hơn ngày kích hoạt
        if (licData.activatedAt) {
            const activatedDate = new Date(licData.activatedAt);
            const now = new Date();
            // Cho phép sai lệch 1 ngày (timezone, ntp sync...)
            if (now < new Date(activatedDate.getTime() - 86400000)) return false;
        }

        // 5. Chống tua ngược đồng hồ: kiểm tra lastSeenDate
        if (licData.lastSeenDate) {
            const lastSeen = new Date(licData.lastSeenDate);
            const now = new Date();
            // Nếu đồng hồ hiện tại sớm hơn lần check trước > 2 ngày → cảnh báo clock rollback
            if (now < new Date(lastSeen.getTime() - 2 * 86400000)) return false;
        }

        return true;
    } catch { return false; }
}

// ============ LƯU / ĐỌC LICENSE ============
function loadLicense() {
    try {
        if (!fs.existsSync(licenseFile)) return null;
        return JSON.parse(fs.readFileSync(licenseFile, 'utf8'));
    } catch { return null; }
}

function saveLicense(licData) {
    try {
        fs.writeFileSync(licenseFile, JSON.stringify(licData, null, 2));
        return true;
    } catch { return false; }
}

// ============ TRẠNG THÁI LICENSE ============
// Cache 60 giây — không cần check mỗi request
let _licenseStatusCache = null;
let _licenseStatusCachedAt = 0;

function getLicenseStatus() {
    const now = Date.now();
    if (_licenseStatusCache && now - _licenseStatusCachedAt < 60_000) {
        return _licenseStatusCache;
    }
    const result = _computeLicenseStatus();
    _licenseStatusCache = result;
    _licenseStatusCachedAt = now;
    return result;
}

function invalidateLicenseCache() {
    _licenseStatusCache = null;
    _cachedMachineId = null;
}

function _computeLicenseStatus() {
    // Kiểm tra bị thu hồi online (file flag — không xóa license.dat)
    if (isLicenseBlocked()) {
        return { active: false, reason: 'Giấy phép đã bị thu hồi bởi nhà cung cấp', revoked: true, machineId: getMachineId() };
    }

    const lic = loadLicense();
    if (!lic) return { active: false, reason: 'Chưa kích hoạt', machineId: getMachineId() };

    const currentId = getMachineId();
    if (currentId !== lic.machineId) {
        return { active: false, reason: 'Key không khớp với máy tính này', machineId: currentId };
    }

    if (!validateKey(lic)) {
        if (lic.expiry && lic.expiry !== '9999-12-31' && new Date(lic.expiry) < new Date()) {
            return { active: false, reason: 'Giấy phép đã hết hạn', expired: true, expiry: lic.expiry, machineId: currentId };
        }
        return { active: false, reason: 'Key không hợp lệ hoặc đồng hồ hệ thống bị chỉnh sai', machineId: currentId };
    }

    // Cập nhật lastSeenDate mỗi lần validate thành công (chống clock rollback)
    const today = new Date().toISOString().split('T')[0];
    if (lic.lastSeenDate !== today) {
        lic.lastSeenDate = today;
        saveLicense(lic);
    }

    const isLifetime = lic.expiry === '9999-12-31';
    const daysLeft   = isLifetime ? null : Math.ceil((new Date(lic.expiry + 'T23:59:59') - new Date()) / 86400000);
    const expiringSoon = daysLeft !== null && daysLeft <= 30;

    return {
        active: true,
        expiry: lic.expiry,
        isLifetime,
        daysLeft,
        expiringSoon,
        machineId: currentId,
        activatedAt: lic.activatedAt || lic.generatedAt
    };
}

// ============ KÍCH HOẠT KEY ============
function activateKey(keyInput) {
    const keyClean = (keyInput || '').trim().toUpperCase().replace(/\s/g, '');
    const machineId = getMachineId();

    // Tìm expiry bằng cách thử các ngày có thể (brute force nhẹ cho offline)
    // Cách đơn giản hơn: user nhập key, server gửi kèm expiry
    // Ở đây key input là JSON hoặc chỉ key string?
    // → Nhận dạng: nếu có dấu | thì là "key|expiry", nếu không thì thử validate

    let expiry = null;
    let key = keyClean;

    if (keyClean.includes('|')) {
        [key, expiry] = keyClean.split('|');
    }

    if (!expiry) {
        // Thử tìm expiry bằng cách duyệt các ngày có thể
        const testExpiries = ['9999-12-31'];
        const now = new Date();
        // Từng ngày cho 60 ngày tới (bắt key 15 ngày, 30 ngày thử nghiệm)
        for (let d = 1; d <= 60; d++) {
            const date = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
            testExpiries.push(date.toISOString().split('T')[0]);
        }
        // Từng tháng cho 72 tháng tới (key 6 tháng, 1-6 năm)
        for (let m = 1; m <= 72; m++) {
            const date = new Date(now.getTime() + m * 30 * 24 * 60 * 60 * 1000);
            testExpiries.push(date.toISOString().split('T')[0]);
        }
        // Loại trùng
        const uniqueExpiries = [...new Set(testExpiries)];
        for (const e of uniqueExpiries) {
            const expected = crypto.createHmac('sha256', MASTER_SECRET)
                .update(`${machineId}|${e}`)
                .digest('hex').substring(0, 20).toUpperCase();
            if (key.replace(/-/g, '') === expected) {
                expiry = e;
                break;
            }
        }
    }

    if (!expiry) return { success: false, error: 'Key không hợp lệ hoặc không đúng máy này' };

    const licData = { key, expiry, machineId, activatedAt: new Date().toISOString() };
    if (!validateKey(licData)) return { success: false, error: 'Key không hợp lệ' };

    saveLicense(licData);
    unblockLicense(); // Xóa license.blocked nếu máy này từng bị thu hồi trước đó
    invalidateLicenseCache(); // Xóa cache sau khi kích hoạt
    return { success: true, expiry, isLifetime: expiry === '9999-12-31' };
}

// ============ BLOCK / UNBLOCK LICENSE (không xóa file) ============
// Khi thu hồi: tạo license.blocked → phần mềm chặn
// Khi mở khóa: xóa license.blocked → phần mềm tự phục hồi, không cần nhập lại key
const blockedFile = path.join(path.dirname(licenseFile), 'license.blocked');

function isLicenseBlocked() {
    return fs.existsSync(blockedFile);
}
function blockLicense() {
    try { fs.writeFileSync(blockedFile, new Date().toISOString()); } catch {}
    invalidateLicenseCache();
}
function unblockLicense() {
    try { if (fs.existsSync(blockedFile)) fs.unlinkSync(blockedFile); } catch {}
    invalidateLicenseCache();
}

// ============ CHECK THU HỒI ONLINE (mỗi 7 ngày) ============
const checkStateFile = path.join(path.dirname(licenseFile), 'license.check');
function getLastCheckTime() {
    try { return parseInt(fs.readFileSync(checkStateFile, 'utf8')) || 0; }
    catch { return 0; }
}
function saveLastCheckTime() {
    try { fs.writeFileSync(checkStateFile, String(Date.now())); } catch {}
}

// forceCheck = true → bỏ qua throttle, check ngay (dùng khi startup)
function checkOnlineRevocation(machineId, forceCheck = false) {
    // Throttle 5 phút — trừ khi gọi với forceCheck=true (startup)
    if (!forceCheck) {
        const lastCheck = getLastCheckTime();
        const intervalMs = 5 * 60 * 1000;
        if (Date.now() - lastCheck < intervalMs) {
            return Promise.resolve(!isLicenseBlocked());
        }
    }

    return new Promise(resolve => {
        // Thêm timestamp để bypass CDN cache của GitHub (~5 phút)
        const url = `https://raw.githubusercontent.com/${GITHUB_REVOKE_REPO}/main/revoked.json?t=${Date.now()}`;
        const req = https.get(url, { headers: { 'User-Agent': 'QLBH-App', 'Cache-Control': 'no-cache' } }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    saveLastCheckTime();
                    const revoked = JSON.parse(data);
                    if (Array.isArray(revoked) && revoked.includes(machineId)) {
                        resolve(false); // Bị thu hồi
                    } else {
                        resolve(true);  // Không bị thu hồi
                    }
                } catch { resolve(true); }
            });
        });
        req.on('error', () => resolve(true)); // Mất mạng → cho qua
        req.setTimeout(6000, () => { req.destroy(); resolve(true); });
    });
}

// ============ RESET MẬT KHẨU ADMIN ============
// Mã reset = 8 ký tự, dựa trên machineId + ngày hôm nay → có hiệu lực 1 ngày
function generateResetCode(machineId, dateStr) {
    // dateStr format: 'YYYY-MM-DD', mặc định hôm nay
    if (!dateStr) {
        const d = new Date();
        dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    return crypto.createHmac('sha256', MASTER_SECRET + '_RESET_ADMIN')
        .update(`${machineId}|${dateStr}`)
        .digest('hex')
        .substring(0, 8)
        .toUpperCase();
}

function validateResetCode(code) {
    const machineId = getMachineId();
    const expected = generateResetCode(machineId);
    return code.trim().toUpperCase() === expected;
}

module.exports = {
    getMachineId, getMachineInfo,
    generateKey, validateKey,
    loadLicense, saveLicense,
    invalidateLicenseCache,
    generateResetCode, validateResetCode,
    getLicenseStatus, activateKey,
    checkOnlineRevocation,
    blockLicense, unblockLicense, isLicenseBlocked
};
