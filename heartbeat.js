/**
 * heartbeat.js — Gửi thông báo Telegram cho admin khi client khởi động,
 * kiểm tra thu hồi license định kỳ và cảnh báo ngay khi phát hiện vi phạm.
 */
const https = require('https');
const path  = require('path');
const fs    = require('fs');

// ── Gửi tin nhắn Telegram ──────────────────────────────────────────────────
function sendAlert(token, chatId, message) {
    if (!token || !chatId) return;
    const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
    const req  = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${token}/sendMessage`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); });
    req.on('error', () => {});
    req.setTimeout(6000, () => req.destroy());
    req.write(body);
    req.end();
}

// ── Gửi heartbeat khi khởi động ───────────────────────────────────────────
function sendStartupHeartbeat({ token, chatId, shopName, machineId, licStatus }) {
    if (!token || !chatId) return;

    const shop = shopName || '(chưa đặt tên)';
    const licLine = licStatus.isLifetime
        ? '♾️ Vĩnh viễn'
        : licStatus.daysLeft !== null
            ? `📅 Còn <b>${licStatus.daysLeft}</b> ngày (hết ${licStatus.expiry})`
            : '❓ Không xác định';
    const expiringSoon = licStatus.expiringSoon
        ? '\n⚠️ <b>Sắp hết hạn — cần gia hạn!</b>'
        : '';

    const msg =
        `🟢 <b>Khách vừa mở phần mềm</b>\n` +
        `🏪 Cửa hàng: <b>${shop}</b>\n` +
        `🖥️ Machine ID: <code>${machineId}</code>\n` +
        `🔑 License: ${licLine}${expiringSoon}\n` +
        `⏰ ${new Date().toLocaleString('vi-VN')}`;

    sendAlert(token, chatId, msg);
}

// ── Cảnh báo khi phát hiện thu hồi ────────────────────────────────────────
function sendRevokedAlert({ token, chatId, shopName, machineId }) {
    if (!token || !chatId) return;
    const shop = shopName || '(chưa đặt tên)';
    const msg =
        `⛔ <b>PHÁT HIỆN LICENSE BỊ THU HỒI</b>\n\n` +
        `🏪 Cửa hàng: <b>${shop}</b>\n` +
        `🖥️ Machine ID: <code>${machineId}</code>\n` +
        `✅ Phần mềm đã tự động khoá\n` +
        `⏰ ${new Date().toLocaleString('vi-VN')}`;
    sendAlert(token, chatId, msg);
}

// ── Cảnh báo license dùng bất hợp lệ (chưa kích hoạt mà vượt qua) ─────────
function sendUnlicensedAlert({ token, chatId, machineId, reason }) {
    if (!token || !chatId) return;
    const msg =
        `🚨 <b>CẢNH BÁO: PHẦN MỀM KHÔNG CÓ LICENSE HỢP LỆ</b>\n\n` +
        `🖥️ Machine ID: <code>${machineId}</code>\n` +
        `❗ Lý do: ${reason}\n` +
        `⏰ ${new Date().toLocaleString('vi-VN')}`;
    sendAlert(token, chatId, msg);
}

// ── Cảnh báo license sắp hết hạn (gửi 1 lần / ngày) ──────────────────────
const _expiryAlertFile = path.join(
    typeof process.pkg !== 'undefined' ? path.dirname(process.execPath) : __dirname,
    'license.expiry-alert'
);
function sendExpiryAlert({ token, chatId, shopName, machineId, daysLeft, expiry }) {
    if (!token || !chatId || daysLeft === null || daysLeft > 7) return;
    const today = new Date().toISOString().split('T')[0];
    try { if (fs.readFileSync(_expiryAlertFile, 'utf8').trim() === today) return; } catch {}
    const shop = shopName || '(chưa đặt tên)';
    const msg =
        `⚠️ <b>LICENSE SẮP HẾT HẠN</b>\n\n` +
        `🏪 Cửa hàng: <b>${shop}</b>\n` +
        `🖥️ Machine ID: <code>${machineId}</code>\n` +
        `📅 Còn <b>${daysLeft}</b> ngày (hết ${expiry})\n` +
        `💬 Vui lòng liên hệ để gia hạn sớm!\n` +
        `⏰ ${new Date().toLocaleString('vi-VN')}`;
    sendAlert(token, chatId, msg);
    try { fs.writeFileSync(_expiryAlertFile, today); } catch {}
}

// ── Gọi API checkin để tự động unrevoke nếu license còn hợp lệ ────────────
function callCheckin(checkinUrl, machineId, token, daysLeft) {
    if (!checkinUrl || !machineId || !token) return;
    try {
        const body = JSON.stringify({ machineId, secret: token, daysLeft: daysLeft !== null ? daysLeft : 99999 });
        const url  = new URL(checkinUrl);
        const req  = https.request({
            hostname: url.hostname,
            path:     url.pathname,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, res => { res.resume(); });
        req.on('error', () => {});
        req.setTimeout(8000, () => req.destroy());
        req.write(body);
        req.end();
    } catch {}
}

// ── Khởi động toàn bộ heartbeat system ────────────────────────────────────
function start({ token, chatId, shopName, db, license, checkinUrl }) {
    const { getLicenseStatus, getMachineId, checkOnlineRevocation, invalidateLicenseCache,
            loadLicense, validateKey } = license;
    const machineId = getMachineId();

    // Helper chặn license khi bị thu hồi (KHÔNG xóa file — dùng flag để auto-phục hồi khi mở khóa)
    function killLicense() {
        license.blockLicense(); // tạo license.blocked, giữ nguyên license.dat
    }

    // Helper mở khóa khi admin unrevoke (xóa flag, phần mềm tự phục hồi)
    function restoreLicense() {
        license.unblockLicense(); // xóa license.blocked, không cần nhập lại key
    }

    // ── 1. Gửi heartbeat khởi động ──
    const licStatus = getLicenseStatus();
    if (licStatus.active) {
        sendStartupHeartbeat({ token, chatId, shopName, machineId, licStatus });

        // Cảnh báo sắp hết hạn khi mở app
        if (licStatus.expiringSoon) {
            sendExpiryAlert({ token, chatId, shopName, machineId,
                daysLeft: licStatus.daysLeft, expiry: licStatus.expiry });
        }

        // Cập nhật display shops.json nếu stale (KHÔNG xóa revoked.json — không can thiệp lock)
        callCheckin(checkinUrl, machineId, token, licStatus.isLifetime ? null : licStatus.daysLeft);
    }

    // ── 2. Check revocation ngay khi khởi động (force — reset cache) ──
    const appDataDir = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
    const licCheckFile = typeof process.pkg !== 'undefined'
        ? path.join(appDataDir, 'QuanLyBanHang', 'license.check')
        : path.join(__dirname, 'license.check');
    try { fs.writeFileSync(licCheckFile, '0'); } catch {} // reset để ép check ngay

    // Startup check — KHÔNG có bypass: revoke luôn thắng, kể cả key local còn hạn
    checkOnlineRevocation(machineId).then(notRevoked => {
        if (!notRevoked) {
            console.log('[License] ⛔ Bị thu hồi (startup check)');
            sendRevokedAlert({ token, chatId, shopName, machineId });
            killLicense();
        } else {
            restoreLicense(); // Đang bị block nhưng đã được mở khóa → tự phục hồi
        }
    }).catch(() => {});

    // ── 3a. Check thu hồi mỗi 5 phút — KHÔNG có bypass ──
    const FIVE_MIN  = 5 * 60 * 1000;
    const TWO_HOURS = 2 * 60 * 60 * 1000;

    setInterval(() => {
        const st = getLicenseStatus();
        // Bỏ qua nếu chưa kích hoạt hoặc hết hạn bình thường (không phải do revoke)
        if (!st.active && !st.revoked) return;

        try { fs.writeFileSync(licCheckFile, '0'); } catch {} // force check, bỏ cache

        checkOnlineRevocation(machineId).then(notRevoked => {
            if (!notRevoked) {
                if (!st.revoked) {
                    console.log('[License] ⛔ Bị thu hồi (5-min check)');
                    sendRevokedAlert({ token, chatId, shopName, machineId });
                }
                killLicense(); // Block ngay, không bypass dù key local còn hạn
            } else {
                restoreLicense(); // Admin đã mở khóa → tự phục hồi
            }
        }).catch(() => {});
    }, FIVE_MIN);

    // ── 3b. Cảnh báo sắp hết hạn mỗi 2 tiếng ──
    setInterval(() => {
        const st = getLicenseStatus();
        if (st.active && st.expiringSoon) {
            sendExpiryAlert({ token, chatId, shopName, machineId,
                daysLeft: st.daysLeft, expiry: st.expiry });
        }
    }, TWO_HOURS);
}

module.exports = { start, sendAlert };
