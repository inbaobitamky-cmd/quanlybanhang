/**
 * /api/checkin — Client gọi khi khởi động với license hợp lệ.
 * Nếu machine đang bị đánh dấu revoked trong shops.json nhưng
 * license local vẫn còn hạn → tự động unrevoke.
 */

const GH_TOKEN   = process.env.GITHUB_TOKEN;
const BOT_TOKEN  = process.env.BOT_TOKEN;
const ADMIN_ID   = process.env.ADMIN_CHAT_ID;
const GH_REPO    = 'inbaobitamky-cmd/quanlybanhang';

// ── GitHub helpers ──────────────────────────────────────────────────────────
async function ghGet(filePath) {
    try {
        const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'QLBH-Checkin/1.0' };
        if (GH_TOKEN) headers['Authorization'] = `Bearer ${GH_TOKEN}`;
        const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${filePath}`, { headers });
        if (!res.ok) return null;
        const data = await res.json();
        const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8').replace(/^﻿/, ''));
        return { content: parsed, sha: data.sha };
    } catch { return null; }
}

async function ghPut(filePath, content, sha, message) {
    if (!GH_TOKEN) return false;
    try {
        const body = { message, content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64') };
        if (sha) body.sha = sha;
        const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${filePath}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'QLBH-Checkin/1.0' },
            body: JSON.stringify(body)
        });
        return res.ok;
    } catch { return false; }
}

async function getShops() {
    const r = await ghGet('shops.json');
    if (!r) return { shops: [], sha: null };
    return { shops: Array.isArray(r.content) ? r.content : [], sha: r.sha };
}

async function saveShops(shops, sha) {
    return ghPut('shops.json', shops, sha, `Auto-unrevoke via checkin`);
}

// ── Gửi cảnh báo phát hiện nhiều exe cùng machineId lên Telegram admin ──────
async function sendDupAlert(mid, shop) {
    if (!ADMIN_ID || !BOT_TOKEN) return;
    const timeStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const shopName = shop ? (shop.shopName || 'N/A') : 'N/A';
    const expiry = shop ? (shop.expiry === '9999-12-31' ? '♾️ Vĩnh viễn' : (shop.expiry || 'N/A')) : 'N/A';

    const text =
        `⚠️ <b>PHÁT HIỆN: 2 EXE CÙNG CHẠY 1 MÁY!</b>\n\n` +
        `💻 <code>${mid}</code>\n` +
        `🏪 Shop: <b>${shopName}</b> — hết hạn: ${expiry}\n\n` +
        `📋 Cùng Machine ID đã check-in 2 lần trong vòng 3 phút.\n` +
        `→ Máy này đang chạy <b>2 phần mềm khác nhau</b> (2 license.dat).\n\n` +
        `⏰ Lúc: ${timeStr}\n\n` +
        `👉 Dùng /thongke để kiểm tra hoặc bấm nút để xóa & thu hồi license.`;

    const inline_keyboard = [
        [{ text: `🗑️ Xóa & Thu hồi license`, callback_data: `delete_confirm|${mid}|0` }]
    ];

    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: ADMIN_ID, text, parse_mode: 'HTML', reply_markup: { inline_keyboard } })
        });
    } catch (e) {
        console.error('[checkin] sendDupAlert error:', e.message);
    }
}

async function getRevokedList() {
    const r = await ghGet('revoked.json');
    if (!r) return { list: [], sha: null };
    return { list: Array.isArray(r.content) ? r.content : [], sha: r.sha };
}

// ── Handler ─────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

    const { machineId, secret, daysLeft } = req.body || {};

    // Xác thực: client dùng BOT_TOKEN làm secret
    if (!secret || secret !== BOT_TOKEN) {
        return res.status(403).json({ ok: false, error: 'unauthorized' });
    }
    if (!machineId) {
        return res.status(400).json({ ok: false, error: 'missing machineId' });
    }

    const mid = machineId.toUpperCase();

    // License đã hết hạn → không làm gì
    const days = typeof daysLeft === 'number' ? daysLeft : parseInt(daysLeft);
    if (!isNaN(days) && days <= 0) {
        return res.json({ ok: true, action: 'none', reason: 'expired' });
    }

    // Kiểm tra revoked.json — nếu admin đang THỰC SỰ khóa → KHÔNG can thiệp
    const { list: revokedList } = await getRevokedList();
    if (revokedList.map(x => x.toUpperCase()).includes(mid)) {
        // Máy đang bị khóa bởi admin → không tự mở khóa, để client bị block bình thường
        return res.json({ ok: true, action: 'none', reason: 'genuinely_revoked' });
    }

    // Luôn load shops để kiểm tra trùng machineId và fix stale revoked
    const { shops, sha } = await getShops();
    if (!shops) return res.json({ ok: false, error: 'failed to read shops' });

    const now = Date.now();
    let needsSave = false;
    let action = 'none';

    // ── Tìm entry shop hiện tại của machineId này ────────────────────────────
    const shop = shops.find(s => (s.machineId || '').toUpperCase() === mid);

    // ── Phát hiện trùng machineId (rapid double check-in) ───────────────────
    // Nếu cùng 1 machineId check-in 2 lần trong vòng 3 phút → nhiều exe đang chạy cùng lúc
    const RAPID_WINDOW = 3 * 60 * 1000;   // 3 phút
    const ALERT_COOLDOWN = 24 * 60 * 60 * 1000; // 24h không spam

    if (shop && shop.lastCheckinAt && (now - shop.lastCheckinAt) < RAPID_WINDOW) {
        const recentAlerted = shop.lastDupAlert && (now - shop.lastDupAlert) < ALERT_COOLDOWN;
        if (!recentAlerted) {
            await sendDupAlert(mid, shop);
            shop.lastDupAlert = now;
            needsSave = true;
            action = 'dup_alert';
            console.log(`[checkin] Rapid double check-in detected for ${mid} — gap=${Math.round((now - shop.lastCheckinAt)/1000)}s`);
        }
    }

    // ── Cập nhật lastCheckinAt để track thời điểm check-in gần nhất ─────────
    if (shop) {
        shop.lastCheckinAt = now;
        needsSave = true;
    }

    // ── Fix stale revoked display ────────────────────────────────────────────
    // Máy KHÔNG có trong revoked.json nhưng shops.json vẫn còn cờ revoked: true (stale data)
    if (shop && shop.revoked) {
        shop.revoked = false;
        delete shop.revokedAt;
        needsSave = true;
        if (action === 'none') action = 'fixed_display';
        console.log(`[checkin] Fixed stale revoked display for ${mid} — daysLeft=${daysLeft}`);
    }

    if (needsSave) {
        await saveShops(shops, sha);
    }

    return res.json({ ok: true, action, machineId: mid });
};
