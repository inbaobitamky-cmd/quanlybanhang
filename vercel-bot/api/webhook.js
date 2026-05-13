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
    try {
        const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'QLBH-Bot/1.0' };
        if (GH_TOKEN) headers['Authorization'] = `Bearer ${GH_TOKEN}`;

        const res = await fetch(
            `https://api.github.com/repos/${GH_REPO}/contents/${filePath}`,
            { headers }
        );
        console.log(`[ghGet] ${filePath} status=${res.status} token=${GH_TOKEN ? 'yes' : 'no'}`);
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.log(`[ghGet] error body: ${errText.slice(0, 200)}`);
            if (GH_TOKEN && (res.status === 401 || res.status === 403)) {
                const res2 = await fetch(
                    `https://api.github.com/repos/${GH_REPO}/contents/${filePath}`,
                    { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'QLBH-Bot/1.0' } }
                );
                console.log(`[ghGet] no-auth fallback status=${res2.status}`);
                if (!res2.ok) return null;
                const data2 = await res2.json();
                return { content: JSON.parse(Buffer.from(data2.content, 'base64').toString('utf8')), sha: data2.sha };
            }
            return null;
        }
        const data = await res.json();
        const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8').replace(/^﻿/, ''));
        console.log(`[ghGet] ${filePath} parsed OK, items=${Array.isArray(parsed) ? parsed.length : 'not-array'}`);
        return { content: parsed, sha: data.sha };
    } catch(e) {
        console.log(`[ghGet] exception: ${e.message}`);
        return null;
    }
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
    // Đọc song song shops.json và revoked.json
    const [shopsResult, revokedResult] = await Promise.all([
        ghGet('shops.json'),
        ghGet('revoked.json')
    ]);
    if (!shopsResult) return { shops: [], sha: null };
    const shops    = Array.isArray(shopsResult.content) ? shopsResult.content : [];
    const revoked  = Array.isArray(revokedResult?.content) ? revokedResult.content : [];

    // Merge trạng thái revoked từ revoked.json (admin panel cũng ghi vào đây)
    shops.forEach(s => {
        if (revoked.includes(s.machineId)) {
            s.revoked = true;
        }
    });
    return { shops, sha: shopsResult.sha };
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
    const mid = machineId.toUpperCase();
    const { list, sha } = await getRevokedList();
    const alreadyRevoked = list.some(id => id.toUpperCase() === mid);
    let revokeOk = alreadyRevoked; // nếu đã có rồi thì coi như OK
    if (!alreadyRevoked) {
        list.push(mid);
        revokeOk = await ghPut('revoked.json', list, sha, `Revoke ${mid}`);
    }
    const { shops, sha: s2 } = await getShops();
    const shop = shops.find(s => s.machineId === mid || s.machineId?.toUpperCase() === mid);
    if (shop) { shop.revoked = true; shop.revokedAt = new Date().toISOString(); await saveShops(shops, s2); }
    return revokeOk; // true = ghi được revoked.json, false = token lỗi
}

async function unrevokeShop(machineId) {
    const mid = machineId.toUpperCase();
    const { list, sha } = await getRevokedList();
    const unrevokeOk = await ghPut('revoked.json', list.filter(id => id.toUpperCase() !== mid), sha, `Unrevoke ${mid}`);
    const { shops, sha: s2 } = await getShops();
    const shop = shops.find(s => s.machineId === mid || s.machineId?.toUpperCase() === mid);
    if (shop) { shop.revoked = false; delete shop.revokedAt; await saveShops(shops, s2); }
    return unrevokeOk;
}

async function deleteShop(machineId) {
    const mid = machineId.toUpperCase();
    // 1. Thêm vào revoked.json để thu hồi license (PHẢI thành công trước khi xóa)
    const { list, sha } = await getRevokedList();
    const alreadyRevoked = list.some(id => id.toUpperCase() === mid);
    if (!alreadyRevoked) {
        const revokeOk = await ghPut('revoked.json', [...list, mid], sha, `Delete+revoke ${mid}`);
        if (!revokeOk) {
            // revoked.json update thất bại → KHÔNG xóa khỏi shops.json để tránh ghost state
            console.log(`[deleteShop] WARN: ghPut revoked.json failed for ${mid} — aborting delete`);
            return { error: 'revoke_failed' };
        }
    }
    // 2. Xóa khỏi shops.json (chỉ sau khi revoked.json đã cập nhật thành công)
    const { shops, sha: s2 } = await getShops();
    const filtered = shops.filter(s => (s.machineId || '').toUpperCase() !== mid);
    await saveShops(filtered, s2);
    return { ok: true };
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

        const shortName = name.length > 15 ? name.substring(0, 13) + '…' : name;
        if (shop.revoked) {
            buttons.push([
                { text: `🟢 Mở khóa: ${shortName}`, callback_data: `unrevoke|${shop.machineId}|${page}` },
                { text: '🗑️ Xóa', callback_data: `delete_confirm|${shop.machineId}|${page}` }
            ]);
        } else {
            buttons.push([
                { text: `🔴 Khóa: ${shortName}`, callback_data: `revoke|${shop.machineId}|${page}` },
                { text: '🗑️ Xóa', callback_data: `delete_confirm|${shop.machineId}|${page}` }
            ]);
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

// ============ ADMIN KEYBOARD ============
const ADMIN_KEYBOARD = {
    keyboard: [
        [{ text: '📋 Danh sách cửa hàng' }, { text: '📊 Thống kê' }],
        [{ text: '❓ Hướng dẫn' }]
    ],
    resize_keyboard: true,
    persistent: true
};

// Đăng ký danh sách lệnh (gọi 1 lần hoặc khi /setup)
async function setupBotCommands() {
    // Lệnh cho admin (scope: chat cụ thể)
    if (ADMIN_ID) {
        await tg('setMyCommands', {
            commands: [
                { command: 'danhsach',  description: '📋 Xem danh sách cửa hàng' },
                { command: 'thongke',   description: '📊 Thống kê tổng quan' },
                { command: 'help',      description: '❓ Hướng dẫn sử dụng' },
                { command: 'khoa',      description: '🔴 Khóa tài khoản (nhập MachineID)' },
                { command: 'mokhoa',    description: '🟢 Mở khóa tài khoản (nhập MachineID)' },
            ],
            scope: { type: 'chat', chat_id: parseInt(ADMIN_ID) }
        });
    }
    // Lệnh mặc định cho tất cả user
    await tg('setMyCommands', {
        commands: [
            { command: 'start', description: '🚀 Bắt đầu / Kích hoạt phần mềm' },
            { command: 'help',  description: '❓ Trợ giúp' },
        ]
    });
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
        if (payload.length < 10) {
            if (isAdmin) { await sendAdminWelcome(userId, msg.from.first_name); }
            else         { await sendWelcome(userId); }
            return;
        }

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

    if (text === '/start') {
        if (isAdmin) { await sendAdminWelcome(userId, msg.from.first_name); }
        else         { await sendWelcome(userId); }
        return;
    }

    // ── Lệnh / nút admin ──
    if (isAdmin) {
        // Hỗ trợ cả lệnh /danhsach lẫn nút bấm "📋 Danh sách cửa hàng"
        if (text === '/danhsach' || text === '/list' || text === '/ds' || text === '📋 Danh sách cửa hàng') {
            const { shops } = await getShops();
            const { text: msgText, buttons } = buildShopListMessage(shops, 0);
            await tg('sendMessage', {
                chat_id: userId, parse_mode: 'HTML',
                text: msgText,
                reply_markup: { inline_keyboard: buttons }
            });
            return;
        }

        // Thống kê
        if (text === '/thongke' || text === '📊 Thống kê') {
            const { shops } = await getShops();
            const total    = shops.length;
            const active   = shops.filter(s => !s.revoked).length;
            const locked   = shops.filter(s =>  s.revoked).length;
            const lifetime = shops.filter(s => s.expiry === '9999-12-31').length;
            const expiring = shops.filter(s => {
                if (s.revoked || s.expiry === '9999-12-31') return false;
                const diff = (new Date(s.expiry) - Date.now()) / 86400000;
                return diff >= 0 && diff <= 30;
            }).length;
            const expired  = shops.filter(s => {
                if (s.expiry === '9999-12-31') return false;
                return new Date(s.expiry) < new Date();
            }).length;
            // Phát hiện machineId trùng (1 máy nhiều key)
            const midMap = {};
            shops.forEach(s => {
                const mid = (s.machineId || '').toUpperCase();
                if (!mid) return;
                if (!midMap[mid]) midMap[mid] = [];
                midMap[mid].push(s);
            });
            const duplicates = Object.entries(midMap).filter(([, list]) => list.length > 1);

            // Gửi thống kê chính
            await tg('sendMessage', {
                chat_id: userId, parse_mode: 'HTML',
                text: `📊 <b>Thống kê cửa hàng</b>\n\n` +
                      `🏪 Tổng cửa hàng: <b>${total}</b>\n` +
                      `🟢 Đang hoạt động: <b>${active}</b>\n` +
                      `🔴 Bị khóa: <b>${locked}</b>\n` +
                      `♾️ Vĩnh viễn: <b>${lifetime}</b>\n` +
                      `⚠️ Sắp hết hạn (≤30 ngày): <b>${expiring}</b>\n` +
                      `❌ Đã hết hạn: <b>${expired}</b>\n\n` +
                      `⏰ ${new Date().toLocaleString('vi-VN')}`,
                reply_markup: { keyboard: ADMIN_KEYBOARD.keyboard, resize_keyboard: true, persistent: true }
            });

            // Gửi cảnh báo riêng cho từng nhóm trùng, kèm nút xóa từng shop
            for (const [mid, list] of duplicates) {
                const lines = list.map(s => {
                    const status = s.revoked ? '🔴 Khóa' : '🟢 Active';
                    const expiry = s.expiry === '9999-12-31' ? '♾️ Vĩnh viễn' : s.expiry;
                    return `• <b>${s.shopName}</b>\n  ${status} | Hết hạn: ${expiry}`;
                }).join('\n\n');

                // Mỗi shop 1 nút xóa riêng
                const buttons = list.map(s =>
                    [{ text: `🗑 Xóa "${s.shopName}" (${s.expiry === '9999-12-31' ? '♾️' : s.expiry})`, callback_data: `delete_confirm|${s.machineId}|0` }]
                );

                await tg('sendMessage', {
                    chat_id: userId, parse_mode: 'HTML',
                    text: `🚨 <b>MACHINE ID TRÙNG</b>\n<code>${mid}</code>\n\n${lines}\n\n👇 Chọn shop cần xóa:`,
                    reply_markup: { inline_keyboard: buttons }
                });
            }
            return;
        }

        if (text.startsWith('/khoa ')) {
            const machineId = text.slice(6).trim().toUpperCase();
            await tg('sendMessage', { chat_id: userId, text: '⏳ Đang khóa...' });
            const ok = await revokeShop(machineId);
            if (ok) {
                await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: `🔴 <b>Đã khóa!</b>\n<code>${machineId}</code>` });
            } else {
                await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: `❌ <b>Khóa thất bại!</b>\nKhông ghi được vào revoked.json.\n⚠️ GITHUB_TOKEN trên Vercel có thể đã hết hạn — vào Vercel dashboard tạo token mới.\n\n<code>${machineId}</code>` });
            }
            return;
        }

        // ── Kích hoạt số ngày tùy chỉnh: /ngay <userId> <machineId> <days> ──
        if (text.startsWith('/ngay ')) {
            const args = text.slice(6).trim().split(/\s+/);
            if (args.length < 3) {
                await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML',
                    text: `❌ Cú pháp: <code>/ngay &lt;userId&gt; &lt;machineId&gt; &lt;số_ngày&gt;</code>\nVí dụ: <code>/ngay 524062870 6E1DE5-D7A968 176</code>` });
                return;
            }
            const targetUserId  = args[0];
            const targetMachine = args[1].toUpperCase();
            const days          = parseInt(args[2]);
            if (isNaN(days) || days <= 0) {
                await tg('sendMessage', { chat_id: userId, text: '❌ Số ngày không hợp lệ.' });
                return;
            }
            const { key, expiry } = generateKey(targetMachine, -days);
            const expiryFmt = new Date(expiry).toLocaleDateString('vi-VN');
            // Gửi key cho khách
            await tg('sendMessage', { chat_id: targetUserId, parse_mode: 'HTML',
                text: `🎉 <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n🔑 <b>Key của bạn:</b>\n<code>${key}</code>\n\n📅 <b>Gói:</b> ${days} ngày 📅\n⏳ <b>Hạn sử dụng:</b> ${expiryFmt}\n\n📋 Sao chép key trên và nhập vào phần mềm.\n💾 <i>Lưu lại key — cần dùng khi cài lại máy.</i>` });
            // Lưu vào shops.json
            try {
                const { shops: sl, sha: ss } = await getShops();
                const filtered = sl.filter(s => (s.machineId || '').toUpperCase() !== targetMachine);
                filtered.push({ machineId: targetMachine, shopName: `(${days}d custom)`, userId: targetUserId, userName: '—', plan: `${days} ngày 📅`, months: -days, expiry, activatedAt: new Date().toISOString(), revoked: false });
                await saveShops(filtered, ss);
            } catch(e) { console.log('[/ngay] save shops err:', e.message); }
            await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML',
                text: `✅ <b>Đã cấp key ${days} ngày</b>\n🔑 <code>${key}</code>\n💻 <code>${targetMachine}</code>\n⏳ Hết hạn: ${expiryFmt}` });
            return;
        }

        if (text.startsWith('/mokhoa ')) {
            const machineId = text.slice(8).trim().toUpperCase();
            await tg('sendMessage', { chat_id: userId, text: '⏳ Đang mở khóa...' });
            const ok = await unrevokeShop(machineId);
            if (ok) {
                await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: `🟢 <b>Đã mở khóa!</b>\n<code>${machineId}</code>` });
            } else {
                await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: `❌ <b>Mở khóa thất bại!</b>\nKhông ghi được vào revoked.json.\n⚠️ GITHUB_TOKEN trên Vercel có thể đã hết hạn.\n\n<code>${machineId}</code>` });
            }
            return;
        }

        if (text === '/help' || text === '/huongdan' || text === '❓ Hướng dẫn') {
            await tg('sendMessage', {
                chat_id: userId, parse_mode: 'HTML',
                text: `📖 <b>Hướng dẫn Admin</b>\n\n` +
                      `<b>Nút bấm nhanh (1 chạm):</b>\n` +
                      `📋 Danh sách cửa hàng — xem + khóa/mở\n` +
                      `📊 Thống kê — tổng quan số liệu\n\n` +
                      `<b>Lệnh:</b>\n` +
                      `/danhsach — Xem danh sách cửa hàng\n` +
                      `/thongke — Thống kê tổng quan\n` +
                      `/khoa <code>MACHINEID</code> — Khóa tài khoản\n` +
                      `/mokhoa <code>MACHINEID</code> — Mở khóa tài khoản\n` +
                      `/help — Xem hướng dẫn này`,
                reply_markup: { keyboard: ADMIN_KEYBOARD.keyboard, resize_keyboard: true, persistent: true }
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

async function sendAdminWelcome(userId, firstName) {
    await setupBotCommands().catch(() => {}); // đăng ký lệnh khi admin /start
    await tg('sendMessage', {
        chat_id: userId, parse_mode: 'HTML',
        text: `👑 Xin chào Admin <b>${firstName || ''}</b>!\n\n` +
              `Sử dụng các nút bên dưới hoặc gõ lệnh để quản lý.\n\n` +
              `📋 <b>Nút bấm nhanh đã sẵn sàng!</b>`,
        reply_markup: { keyboard: ADMIN_KEYBOARD.keyboard, resize_keyboard: true, persistent: true }
    });
}

async function sendWelcome(userId) {
    await tg('sendMessage', { chat_id: userId, parse_mode: 'HTML', text: '👋 Xin chào!\n\nĐây là bot kích hoạt phần mềm <b>Quản Lý Bán Hàng</b>.\n\n🖥 Hãy mở phần mềm và nhấn nút <b>"Yêu cầu kích hoạt"</b>.' });
}

// ============ GỬI YÊU CẦU LÊN ADMIN ============
async function sendActivationRequest(userId, machineId, mInfo, userName, shopName) {
    const mi  = mInfo || {};
    const mid = machineId.toUpperCase();

    // Kiểm tra machineId đã tồn tại chưa
    const { shops } = await getShops();
    const existing  = shops.filter(s => (s.machineId || '').toUpperCase() === mid);
    let warningBlock = '';
    let oldDaysHint  = '';   // gợi ý số ngày còn lại để admin dùng nút Tùy chỉnh
    if (existing.length > 0) {
        const today = new Date(); today.setHours(0,0,0,0);
        const lines = existing.map(s => {
            const status  = s.revoked ? '🔴 Đang khóa' : '🟢 Active';
            let expiryStr = '♾️ Vĩnh viễn';
            let daysLeft  = null;
            if (s.expiry && s.expiry !== '9999-12-31') {
                const exp = new Date(s.expiry);
                daysLeft  = Math.ceil((exp - today) / 86400000);
                expiryStr = `${s.expiry} (còn ${daysLeft > 0 ? daysLeft + ' ngày' : 'đã hết hạn'})`;
            }
            if (daysLeft !== null && daysLeft > 0 && !oldDaysHint) {
                oldDaysHint = ` (${daysLeft}d)`;   // dùng cho label nút Tùy chỉnh
            }
            return `  • <b>${s.shopName}</b> — ${status} — Hết: ${expiryStr}`;
        }).join('\n');
        warningBlock = `\n\n⚠️ <b>Machine ID này đã có ${existing.length} key trong hệ thống:</b>\n${lines}\n\n💡 Dùng nút <b>✏️ Tùy chỉnh</b> để kích hoạt đúng số ngày còn lại.`;
    }

    await tg('sendMessage', {
        chat_id: ADMIN_ID, parse_mode: 'HTML',
        text: `🔔 <b>YÊU CẦU KÍCH HOẠT MỚI</b>\n\n🏪 <b>Cửa hàng:</b> ${shopName}\n👤 <b>Telegram:</b> ${userName} (ID: <code>${userId}</code>)\n\n💻 <b>Machine ID:</b>\n<code>${machineId}</code>\n\n🖥 CPU: ${mi.cpu || '—'}\n🔧 Mainboard: ${mi.board || '—'}\n💾 RAM: ${mi.ram || '—'}\n🪟 OS: ${mi.os || '—'}\n\n⏰ ${new Date().toLocaleString('vi-VN')}${warningBlock}\n\n<b>Chọn thời hạn kích hoạt:</b>`,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🧪 7 Ngày thử',  callback_data: `ok|${userId}|${machineId}|-7`  },
                    { text: '🧪 15 Ngày thử', callback_data: `ok|${userId}|${machineId}|-15` }
                ],
                [
                    { text: '📅 6 Tháng',     callback_data: `ok|${userId}|${machineId}|6`   },
                    { text: '1️⃣ 1 Năm',      callback_data: `ok|${userId}|${machineId}|12`  }
                ],
                [
                    { text: '2️⃣ 2 Năm',      callback_data: `ok|${userId}|${machineId}|24`  },
                    { text: '3️⃣ 3 Năm',      callback_data: `ok|${userId}|${machineId}|36`  }
                ],
                [
                    { text: '♾️ Vĩnh viễn',  callback_data: `ok|${userId}|${machineId}|0`   },
                    { text: `✏️ Tùy chỉnh${oldDaysHint}`, callback_data: `custom_days|${userId}|${machineId}` }
                ],
                [
                    { text: '❌ Từ chối',     callback_data: `no|${userId}|${machineId}`     }
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
        const userId     = parts[1];
        const machineId  = parts[2];
        const monthsRaw  = parts[3] || '0';
        // d<N> = custom days (e.g. d176 = 176 ngày); negative = trial days; positive = months
        const isCustomDays = monthsRaw.startsWith('d');
        const months       = isCustomDays ? -parseInt(monthsRaw.slice(1)) : parseInt(monthsRaw);
        const { key, expiry } = generateKey(machineId, months);

        let planLabel;
        if (months === 0)        planLabel = 'Vĩnh viễn ♾️';
        else if (isCustomDays)   planLabel = `${Math.abs(months)} ngày 📅`;
        else if (months < 0)     planLabel = `${Math.abs(months)} ngày thử 🧪`;
        else if (months < 12)    planLabel = `${months} tháng 📅`;
        else                     planLabel = `${months / 12} năm`;

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

        // Lưu vào shops.json + tự động unrevoke nếu máy đang bị khóa
        try {
            const msgText   = cb.message?.text || '';
            const shopMatch = msgText.match(/🏪 Cửa hàng: (.+)/);
            const userMatch = msgText.match(/👤 Telegram: (.+?) \(/);
            const shopName  = shopMatch ? shopMatch[1].trim() : '(chưa đặt tên)';
            const userName  = userMatch ? userMatch[1].trim() : '—';

            // Tự động xóa khỏi revoked.json nếu đang bị khóa
            const { list: revokedList, sha: revokedSha } = await getRevokedList();
            if (revokedList.includes(machineId)) {
                await ghPut('revoked.json',
                    revokedList.filter(id => id !== machineId),
                    revokedSha,
                    `Unrevoke ${machineId} — new key issued`
                );
            }

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

    // ── Tùy chỉnh số ngày kích hoạt ──
    if (action === 'custom_days' && isAdmin) {
        const targetUserId  = parts[1];
        const targetMachine = parts[2];
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '✏️ Nhập số ngày bên dưới' });
        await tg('sendMessage', { chat_id: cb.message.chat.id, parse_mode: 'HTML',
            text: `✏️ <b>Kích hoạt số ngày tùy chỉnh</b>\n\n💻 <code>${targetMachine}</code>\n👤 UserID: <code>${targetUserId}</code>\n\nGõ lệnh sau để kích hoạt:\n<code>/ngay ${targetUserId} ${targetMachine} &lt;số_ngày&gt;</code>\n\nVí dụ kích hoạt 176 ngày:\n<code>/ngay ${targetUserId} ${targetMachine} 176</code>` });
        return;
    }

    // ── Xóa cửa hàng: xác nhận ──
    if (action === 'delete_confirm' && isAdmin) {
        const machineId = parts[1];
        const page      = parseInt(parts[2] || '0');
        const { shops } = await getShops();
        const shop = shops.find(s => s.machineId === machineId);
        const name = shop ? (shop.shopName || machineId) : machineId;
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⚠️ Xác nhận xóa?' });
        await tg('editMessageText', {
            chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML',
            text: `🗑️ <b>Xác nhận xóa và thu hồi license?</b>\n\n` +
                  `🏪 <b>${name}</b>\n💻 <code>${machineId}</code>\n\n` +
                  `⚠️ Thao tác này sẽ:\n` +
                  `• Xóa khỏi danh sách cửa hàng\n` +
                  `• <b>Thu hồi license — máy khách bị khóa ngay khi mở lại</b>\n` +
                  `• <b>Không thể hoàn tác!</b>`,
            reply_markup: { inline_keyboard: [
                [
                    { text: '✅ Xác nhận xóa', callback_data: `delete_yes|${machineId}|${page}` },
                    { text: '❌ Hủy', callback_data: `delete_no|${machineId}|${page}` }
                ]
            ]}
        });
        return;
    }

    // ── Xóa cửa hàng: thực hiện ──
    if (action === 'delete_yes' && isAdmin) {
        const machineId = parts[1];
        const page      = parseInt(parts[2] || '0');
        const { shops } = await getShops();
        const shop = shops.find(s => (s.machineId || '').toUpperCase() === machineId.toUpperCase());
        const name = shop ? (shop.shopName || machineId) : machineId;
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '🗑️ Đang xóa...' });
        const result = await deleteShop(machineId);
        if (result && result.error === 'revoke_failed') {
            // revoked.json thất bại → cảnh báo admin, KHÔNG xóa
            await tg('sendMessage', { chat_id: cb.message.chat.id, parse_mode: 'HTML',
                text: `⚠️ <b>Lỗi thu hồi license cho ${name}</b>\n` +
                      `Không thể cập nhật revoked.json (GitHub API error).\n` +
                      `→ Máy khách CHƯA bị khóa và CHƯA bị xóa khỏi danh sách.\n` +
                      `Thử lại sau vài giây hoặc dùng /khoa <code>${machineId.toUpperCase()}</code> để khóa thủ công trước.` });
            return;
        }
        const { shops: newShops } = await getShops();
        const safePage = Math.max(0, Math.min(page, Math.ceil(newShops.length / 5) - 1));
        const { text, buttons } = buildShopListMessage(newShops, safePage);
        await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML', text, reply_markup: { inline_keyboard: buttons } });
        await tg('sendMessage', { chat_id: cb.message.chat.id, parse_mode: 'HTML', text: `🗑️ Đã xóa <b>${name}</b> khỏi danh sách.\n⛔ License đã bị thu hồi — máy khách sẽ bị khóa khi mở lại phần mềm.` });
        return;
    }

    // ── Xóa cửa hàng: hủy → trả về danh sách ──
    if (action === 'delete_no' && isAdmin) {
        const page = parseInt(parts[2] || '0');
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '↩️ Đã hủy' });
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
    // ── Setup endpoint: GET /api/webhook?setup=1 ──
    if (req.method === 'GET' && req.query?.setup === '1') {
        try {
            await setupBotCommands();
            res.status(200).json({ ok: true, message: 'Bot commands registered!' });
        } catch(e) {
            res.status(500).json({ ok: false, error: e.message });
        }
        return;
    }

    if (req.method === 'GET') { res.status(200).send('✅ Bot đang hoạt động'); return; }

    if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
        res.status(403).json({ error: 'Forbidden' }); return;
    }
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
