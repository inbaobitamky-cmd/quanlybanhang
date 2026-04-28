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

// ── Khởi động toàn bộ heartbeat system ────────────────────────────────────
function start({ token, chatId, shopName, db, license }) {
    const { getLicenseStatus, getMachineId, checkOnlineRevocation, invalidateLicenseCache } = license;
    const machineId = getMachineId();

    // Helper xóa license khi bị thu hồi
    function killLicense() {
        invalidateLicenseCache();
        try {
            // Xóa từ AppData (cùng path với license.js getLicenseFile())
            const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
            const licPath = typeof process.pkg !== 'undefined'
                ? path.join(appData, 'QuanLyBanHang', 'license.dat')
                : path.join(__dirname, 'license.dat');
            fs.unlinkSync(licPath);
        } catch {}
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
    }

    // ── 2. Check revocation ngay khi khởi động (force — reset cache 24h) ──
    // licCheckFile phải cùng path với license.js (AppData khi chạy exe)
    const appDataDir = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
    const licCheckFile = typeof process.pkg !== 'undefined'
        ? path.join(appDataDir, 'QuanLyBanHang', 'license.check')
        : path.join(__dirname, 'license.check');
    try { fs.writeFileSync(licCheckFile, '0'); } catch {} // reset để ép check ngay

    if (licStatus.active) {
        checkOnlineRevocation(machineId).then(notRevoked => {
            if (!notRevoked) {
                console.log('[License] ⛔ Bị thu hồi (startup check)');
                sendRevokedAlert({ token, chatId, shopName, machineId });
                killLicense();
            }
        }).catch(() => {});
    }

    // ── 3. Kiểm tra định kỳ mỗi 2 tiếng ──
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    setInterval(() => {
        const st = getLicenseStatus();
        if (!st.active) return; // đã bị block rồi

        try { fs.writeFileSync(licCheckFile, '0'); } catch {}

        checkOnlineRevocation(machineId).then(notRevoked => {
            if (!notRevoked) {
                console.log('[License] ⛔ Bị thu hồi (periodic check)');
                sendRevokedAlert({ token, chatId, shopName, machineId });
                killLicense();
            } else if (st.expiringSoon) {
                sendExpiryAlert({ token, chatId, shopName, machineId,
                    daysLeft: st.daysLeft, expiry: st.expiry });
            }
        }).catch(() => {});
    }, TWO_HOURS);
}

module.exports = { start, sendAlert };
