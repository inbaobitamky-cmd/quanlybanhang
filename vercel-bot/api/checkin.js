/**
 * /api/checkin — Client gọi khi khởi động với license hợp lệ.
 * Nếu machine đang bị đánh dấu revoked trong shops.json nhưng
 * license local vẫn còn hạn → tự động unrevoke.
 */

const GH_TOKEN = process.env.GITHUB_TOKEN;
const BOT_TOKEN = process.env.BOT_TOKEN;
const GH_REPO  = 'inbaobitamky-cmd/quanlybanhang';

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
    if (revokedList.includes(mid)) {
        // Máy đang bị khóa bởi admin → không tự mở khóa, để client bị block bình thường
        return res.json({ ok: true, action: 'none', reason: 'genuinely_revoked' });
    }

    // Máy KHÔNG có trong revoked.json nhưng shops.json vẫn còn cờ revoked: true (stale data)
    // → chỉ fix display trong shops.json, không động đến revoked.json
    const { shops, sha } = await getShops();
    if (!shops) return res.json({ ok: false, error: 'failed to read shops' });

    const shop = shops.find(s => s.machineId === mid);
    if (!shop || !shop.revoked) {
        return res.json({ ok: true, action: 'none' }); // không có gì cần fix
    }

    // Fix stale display: shops.json có revoked:true nhưng thực tế không bị lock
    shop.revoked = false;
    delete shop.revokedAt;
    await saveShops(shops, sha);

    console.log(`[checkin] Fixed stale revoked display for ${mid} — daysLeft=${daysLeft}`);
    return res.json({ ok: true, action: 'fixed_display', machineId: mid });
};
