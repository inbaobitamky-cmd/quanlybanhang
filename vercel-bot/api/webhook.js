const { generateKey } = require('../lib/keygen');

const TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;
const SECRET   = process.env.WEBHOOK_SECRET;
const GH_TOKEN = process.env.GITHUB_TOKEN;          // Personal Access Token, scope: repo
const GH_REPO  = 'inbaobitamky-cmd/quanlybanhang';  // repo chứa revoked.json + shops.json

// ============ TELEGRAM API ============
async function tg(method, params) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
    });
    return res.json();
}

// ============ GITHUB API ============
async function ghGet(filePath) {
    if (!GH_TOKEN) return null;
    try {
        const res = await fetch(
            `https://api.github.com/repos/${GH_REPO}/contents/${filePath}`,
            { headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'QLBH-Bot/1.0' } }
        );
        if (!res.ok) return null;
        const data = await res.json();
        return { content: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')), sha: data.sha };
    } catch { return null; }
}

async function ghPut(filePath, content, sha, message) {
    if (!GH_TOKEN) return false;
    try {
        const body = { message, content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64') };
        if (sha) body.sha = sha;
        const res = await fetch(
            `https://api.github.com/repos/${GH_REPO}/contents/${filePath}`,
            {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'QLBH-Bot/1.0' },
                body: JSON.stringify(body)
            }
        );
        return res.ok;
    } catch { return false; }
}

// ── Đọc / ghi danh sách cửa hàng ──
async function getShops() {
    const result = await ghGet('shops.json');
    if (!result) return { shops: [], sha: null };
    const shops = Array.isArray(result.content) ? result.content : [];
    return { shops, sha: result.sha };
}

async function saveShops(shops, sha) {
    return ghPut('shops.json', shops, sha, 'Update shops list');
}

// ── Đọc / ghi danh sách bị thu hồi ──
async function getRevokedList() {
    const result = await ghGet('revoked.json');
    if (!result) return { list: [], sha: null };
    return { list: Array.isArray(result.content) ? result.content : [], sha: result.sha };
}

async function revokeShop(machineId) {
    const { list, sha } = await getRevokedList();
    if (!list.includes(machineId)) {
        list.push(machineId);
        await ghPut('revoked.json', list, sha, `Revoke ${machineId}`);
    }
    const { shops, sha: s2 } = await getShops();
    const shop = shops.find(s => s.machineId === machineId);
    if (shop) { shop.revoked = true; shop.revokedAt = new Date().toISOString(); await saveShops(shops, s2); }
}

async function unrevokeShop(machineId) {
    const { list, sha } = await getRevokedList();
    await ghPut('revoked.json', list.filter(id => id !== machineId), sha, `Unrevoke ${machineId}`);
    const { shops, sha: s2 } = await getShops();
    const shop = shops.find(s => s.machineId === machineId);
    if (shop) { shop.revoked = false; delete shop.revokedAt; await saveShops(shops, s2); }
}

// ── Format danh sách cửa hàng ──
const PAGE_SIZE = 5;
function buildShopListMessage(shops, page) {
    const total  = shops.length;
    const active = shops.filter(s => !s.revoked).length;
    const locked = shops.filter(s =>  s.revoked).length;
    const pages  = Math.max(1, Math.ceil(total / PAGE_SIZE));
    page = Math.min(page, pages - 1);

    let text = `📋 <b>Danh sách cửa hàng</b>\n`;
    text += `📊 Tổng: <b>${total}</b> | 🟢 Hoạt động: <b>${active}</b> | 🔴 Bị khóa: <b>${locked}</b>\n\n`;

    if (total === 0) {
        text += '<i>Chưa có cửa hàng nào được kích hoạt.</i>';
        return { text, buttons: [] };
    }

    const slice   = shops.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const buttons = [];

    slice.forEach(shop => {
        const icon   = shop.revoked ? '🔴' : '🟢';
        const expiry = shop.expiry === '9999-12-31' ? '♾️ Vĩnh viễn' : shop.expiry;
        const name   = shop.shopName || '(chưa đặt tên)';
        text += `${icon} <b>${name}</b>\n`;
        text += `   💻 <code>${shop.machineId}</code>\n`;
        text += `   📅 ${shop.plan || '?'} — Hết: ${expiry}\n`;
        text += `   👤 ${shop.userName || '—'}\n\n`;

        const shortName = name.substring(0, 12);
        if (shop.revoked) {
            buttons.push([{ text: `🟢 Mở khóa: ${shortName}`, callback_data: `unrevoke|${shop.machineId}|${page}` }]);
        } else {
            buttons.push([{ text: `🔴 Khóa: ${shortName}`, callback_data: `revoke|${shop.machineId}|${page}` }]);
        }
    });

    // Nút điều hướng trang
    const nav = [];
    if (page > 0)        nav.push({ text: '◀️ Trước', callback_data: `listpage|${page - 1}` });
    nav.push({ text: `📄 ${page + 1}/${pages}`, callback_data: `listpage|${page}` });
    if ((page + 1) < pages) nav.push({ text: 'Tiếp ▶️', callback_data: `listpage|${page + 1}` });
    if (nav.length > 1) buttons.push(nav);

    return { text, buttons };
}

// ============ XỬ LÝ TIN NHẮN ============
async function handleMessage(msg) {
    const userId   = String(msg.from.id);
    const text     = (msg.text || '').trim();
    const userName = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'Khách');
    const isAdmin  = userId === String(ADMIN_ID);

    // ── Deep link từ phần mềm: /start MACHINEID ──
    if (text.startsWith('/start ')) {
        const payload = text.replace('/start ', '').trim().toUpperCase();
        if (payload.length < 10) { await sendWelcome(userId); return; }

        let cleanId = payload;
        let mInfo   = { cpu: '—', board: '—', os: '—', ram: '—' };
        if (payload.includes('__')) {
            const parts = payload.split('__');
            cleanId = parts[0];
            try { mInfo = JSON.parse(Buffer.from(parts[1], 'base64').toString()); } catch {}
        }

        const ref = Buffer.from(JSON.stringify({ id: cleanId, mi: mInfo, uid: userId, un: userName })).toString('base64');
        await tg('sendMessage', {
            chat_id: userId, parse_mode: 'HTML',
            text: `👋 Xin chào <b>${msg.from.first_name || ''}</b>!\n\n✅ Đã nhận Machine ID của bạn.\n\n📝 Vui lòng nhập <b>tên cửa hàng</b> của bạn rồi gửi:\n\n<i>🔐 REF:${ref}</i>`,
            reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Nhập tên cửa hàng...' }
        });
        return;
    }

    if (text === '/start') { await sendWelcome(userId); return; }

    // ── Lệnh admin ──
    if (isAdmin) {
        if (text === '/danhsach' || text === '/list' || text === '/ds') {
            const { shops } = await getShops();
            const { text: msgText, buttons } = buildShopListMessage(shops, 0);
            await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: msgText, reply_markup: { inline_keyboard: buttons } });
            return;
        }

        if (text.startsWith('/khoa ')) {
            const machineId = text.slice(6).trim().toUpperCase();
            await tg('sendMessage', { chat_id: userId, text: '⏳ Đang khóa...' });
            await revokeShop(machineId);
            await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: `🔴 <b>Đã khóa!</b>\n<code>${machineId}</code>` });
            return;
        }

        if (text.startsWith('/mokhoa ')) {
            const machineId = text.slice(8).trim().toUpperCase();
            await tg('sendMessage', { chat_id: userId, text: '⏳ Đang mở khóa...' });
            await unrevokeShop(machineId);
            await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: `🟢 <b>Đã mở khóa!</b>\n<code>${machineId}</code>` });
            return;
        }

        if (text === '/help' || text === '/huongdan') {
            await tg('sendMessage', {
                chat_id: userId, parse_mode: 'HTML',
                text: `📖 <b>Lệnh Admin</b>\n\n/danhsach — Xem danh sách + nút khóa/mở khóa\n/khoa <code>MACHINEID</code> — Khóa ngay\n/mokhoa <code>MACHINEID</code> — Mở khóa ngay\n/help — Xem lệnh này`
            });
            return;
        }
    }

    // ── Khách reply tên cửa hàng ──
    if (msg.reply_to_message) {
        const refMatch = (msg.reply_to_message.text || '').match(/REF:([A-Za-z0-9+/=]+)/);
        if (refMatch) {
            try {
                const data = JSON.parse(Buffer.from(refMatch[1], 'base64').toString());
                await tg('sendMessage', { chat_id: userId, text: '✅ Yêu cầu đã được gửi!\n\n⏳ Vui lòng đợi — bạn sẽ nhận được key kích hoạt tại đây sau khi được duyệt.' });
                await sendActivationRequest(data.uid, data.id, data.mi, data.un, text);
            } catch {}
            return;
        }
    }

    if (!isAdmin) {
        await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: 'Để kích hoạt phần mềm, hãy mở phần mềm và nhấn nút <b>"Yêu cầu kích hoạt"</b>.' });
    }
}

async function sendWelcome(userId) {
    await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: '👋 Xin chào!\n\nĐây là bot kích hoạt phần mềm <b>Quản Lý Bán Hàng</b>.\n\n🖥 Hãy mở phần mềm và nhấn nút <b>"Yêu cầu kích hoạt"</b>.' });
}

// ============ GỬI YÊU CẦU LÊN ADMIN ============
async function sendActivationRequest(userId, machineId, mInfo, userName, shopName) {
    const mi = mInfo || {};
    await tg('sendMessage', {
        chat_id: ADMIN_ID, parse_mode: 'HTML',
        text: `🔔 <b>YÊU CẦU KÍCH HOẠT MỚI</b>\n\n🏪 <b>Cửa hàng:</b> ${shopName}\n👤 <b>Telegram:</b> ${userName} (ID: <code>${userId}</code>)\n\n💻 <b>Machine ID:</b>\n<code>${machineId}</code>\n\n🖥 CPU: ${mi.cpu || '—'}\n🔧 Mainboard: ${mi.board || '—'}\n💾 RAM: ${mi.ram || '—'}\n🪟 OS: ${mi.os || '—'}\n\n⏰ ${new Date().toLocaleString('vi-VN')}\n\n<b>Chọn thời hạn kích hoạt:</b>`,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🧪 3 Ngày thử', callback_data: `ok|${userId}|${machineId}|-3` },
                    { text: '📅 6 Tháng',    callback_data: `ok|${userId}|${machineId}|6`  }
                ],
                [
                    { text: '1️⃣ 1 Năm',     callback_data: `ok|${userId}|${machineId}|12` },
                    { text: '2️⃣ 2 Năm',     callback_data: `ok|${userId}|${machineId}|24` }
                ],
                [
                    { text: '3️⃣ 3 Năm',     callback_data: `ok|${userId}|${machineId}|36` },
                    { text: '♾️ Vĩnh viễn', callback_data: `ok|${userId}|${machineId}|0`  }
                ],
                [
                    { text: '❌ Từ chối',    callback_data: `no|${userId}|${machineId}`    }
                ]
            ]
        }
    });
}

// ============ XỬ LÝ NÚT ADMIN ============
async function handleCallback(cb) {
    const parts   = cb.data.split('|');
    const action  = parts[0];
    const isAdmin = String(cb.from.id) === String(ADMIN_ID);

    // ── Duyệt kích hoạt ──
    if (action === 'ok' && isAdmin) {
        const userId    = parts[1];
        const machineId = parts[2];
        const months    = parseInt(parts[3] || '0');
        const { key, expiry } = generateKey(machineId, months);

        let planLabel;
        if (months === 0)       planLabel = 'Vĩnh viễn ♾️';
        else if (months < 0)    planLabel = `${Math.abs(months)} ngày thử 🧪`;
        else if (months < 12)   planLabel = `${months} tháng 📅`;
        else                    planLabel = `${months / 12} năm`;

        const expiryFmt = months === 0 ? 'Không hết hạn' : new Date(expiry).toLocaleDateString('vi-VN');

        // Gửi key cho khách
        await tg('sendMessage', {
            chat_id: userId, parse_mode: 'HTML',
            text: `🎉 <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n🔑 <b>Key của bạn:</b>\n<code>${key}</code>\n\n📅 <b>Gói:</b> ${planLabel}\n⏳ <b>Hạn sử dụng:</b> ${expiryFmt}\n\n📋 Sao chép key trên và nhập vào phần mềm.\n💾 <i>Lưu lại key — cần dùng khi cài lại máy.</i>`
        });

        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: `✅ Đã cấp key ${planLabel}` });
        await tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
        await tg('sendMessage', {
            chat_id: ADMIN_ID, parse_mode: 'HTML',
            text: `✅ <b>Đã cấp key ${planLabel}</b>\n🔑 <code>${key}</code>\n💻 <code>${machineId}</code>`
        });

        // Lưu vào shops.json
        try {
            const msgText   = cb.message?.text || '';
            const shopMatch = msgText.match(/🏪 Cửa hàng: (.+)/);
            const userMatch = msgText.match(/👤 Telegram: (.+?) \(/);
            const shopName  = shopMatch ? shopMatch[1].trim() : '(chưa đặt tên)';
            const userName  = userMatch ? userMatch[1].trim() : '—';

            const { shops, sha } = await getShops();
            const idx   = shops.findIndex(s => s.machineId === machineId);
            const entry = { machineId, shopName, userId, userName, plan: planLabel, months, expiry, activatedAt: new Date().toISOString(), revoked: false };
            if (idx >= 0) shops[idx] = { ...shops[idx], ...entry };
            else          shops.push(entry);
            await saveShops(shops, sha);
        } catch {}

        return;
    }

    // ── Từ chối kích hoạt ──
    if (action === 'no' && isAdmin) {
        const userId = parts[1];
        await tg('sendMessage', { chat_id: userId, text: '❌ Yêu cầu kích hoạt của bạn đã bị từ chối.\nVui lòng liên hệ lại với nhà cung cấp.' });
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Đã từ chối' });
        await tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
        return;
    }

    // ── Khóa cửa hàng ──
    if (action === 'revoke' && isAdmin) {
        const machineId = parts[1];
        const page      = parseInt(parts[2] || '0');
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '🔴 Đang khóa...' });
        await revokeShop(machineId);
        const { shops } = await getShops();
        const { text, buttons } = buildShopListMessage(shops, page);
        await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML', text, reply_markup: { inline_keyboard: buttons } });
        return;
    }

    // ── Mở khóa cửa hàng ──
    if (action === 'unrevoke' && isAdmin) {
        const machineId = parts[1];
        const page      = parseInt(parts[2] || '0');
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '🟢 Đang mở khóa...' });
        await unrevokeShop(machineId);
        const { shops } = await getShops();
        const { text, buttons } = buildShopListMessage(shops, page);
        await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML', text, reply_markup: { inline_keyboard: buttons } });
        return;
    }

    // ── Phân trang danh sách ──
    if (action === 'listpage') {
        const page = parseInt(parts[1] || '0');
        const { shops } = await getShops();
        const { text, buttons } = buildShopListMessage(shops, page);
        await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML', text, reply_markup: { inline_keyboard: buttons } });
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
        return;
    }

    await tg('answerCallbackQuery', { callback_query_id: cb.id });
}

// ============ ENTRY POINT (Vercel Serverless) ============
module.exports = async function handler(req, res) {
    if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
        res.status(403).json({ error: 'Forbidden' }); return;
    }
    if (req.method === 'GET') { res.status(200).send('✅ Bot đang hoạt động'); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
        const update = req.body;
        if (update.callback_query) await handleCallback(update.callback_query);
        else if (update.message)   await handleMessage(update.message);
    } catch (e) {
        console.error('Webhook error:', e.message);
    }

    res.status(200).json({ ok: true });
};
