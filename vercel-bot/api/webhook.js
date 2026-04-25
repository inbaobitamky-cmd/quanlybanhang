const { generateKey } = require('../lib/keygen');

const TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;
const SECRET   = process.env.WEBHOOK_SECRET; // tuỳ chọn, để bảo mật webhook URL

// ============ GỌI TELEGRAM API ============
async function tg(method, params) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
    });
    return res.json();
}

// ============ XỬ LÝ TIN NHẮN ============
async function handleMessage(msg) {
    const userId   = String(msg.from.id);
    const text     = (msg.text || '').trim();
    const userName = msg.from.username
        ? `@${msg.from.username}`
        : (msg.from.first_name || 'Khách');

    // /start MACHINEID__base64info (deep link từ phần mềm)
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

        // Mã hoá toàn bộ thông tin vào base64, nhúng vào tin nhắn bot
        // Khi khách reply → bot đọc lại từ reply_to_message.text (không cần lưu state)
        const ref = Buffer.from(JSON.stringify({
            id: cleanId, mi: mInfo, uid: userId, un: userName
        })).toString('base64');

        await tg('sendMessage', {
            chat_id: userId,
            parse_mode: 'HTML',
            text: `👋 Xin chào <b>${msg.from.first_name || ''}</b>!\n\n✅ Đã nhận Machine ID của bạn.\n\n📝 Vui lòng nhập <b>tên cửa hàng</b> của bạn rồi gửi:\n\n<i>🔐 REF:${ref}</i>`,
            reply_markup: {
                force_reply: true,
                selective: true,
                input_field_placeholder: 'Nhập tên cửa hàng...'
            }
        });
        return;
    }

    if (text === '/start') { await sendWelcome(userId); return; }

    // Khách reply tin nhắn hỏi tên cửa hàng → đọc REF từ tin nhắn gốc
    if (msg.reply_to_message) {
        const refMatch = (msg.reply_to_message.text || '').match(/REF:([A-Za-z0-9+/=]+)/);
        if (refMatch) {
            try {
                const data = JSON.parse(Buffer.from(refMatch[1], 'base64').toString());
                await tg('sendMessage', {
                    chat_id: userId,
                    text: '✅ Yêu cầu đã được gửi!\n\n⏳ Vui lòng đợi — bạn sẽ nhận được key kích hoạt tại đây sau khi được duyệt.'
                });
                await sendActivationRequest(data.uid, data.id, data.mi, data.un, text);
            } catch {}
            return;
        }
    }

    // Tin nhắn không xác định (không phải admin)
    if (userId !== String(ADMIN_ID)) {
        await tg('sendMessage', {
            chat_id: userId,
            parse_mode: 'HTML',
            text: 'Để kích hoạt phần mềm, hãy mở phần mềm và nhấn nút <b>"Yêu cầu kích hoạt"</b>.'
        });
    }
}

async function sendWelcome(userId) {
    await tg('sendMessage', {
        chat_id: userId,
        parse_mode: 'HTML',
        text: '👋 Xin chào!\n\nĐây là bot kích hoạt phần mềm <b>Quản Lý Bán Hàng</b>.\n\n🖥 Hãy mở phần mềm và nhấn nút <b>"Yêu cầu kích hoạt"</b>.'
    });
}

// ============ GỬI YÊU CẦU LÊN ADMIN ============
async function sendActivationRequest(userId, machineId, mInfo, userName, shopName) {
    const mi = mInfo || {};
    await tg('sendMessage', {
        chat_id: ADMIN_ID,
        parse_mode: 'HTML',
        text: `🔔 <b>YÊU CẦU KÍCH HOẠT MỚI</b>\n\n🏪 <b>Cửa hàng:</b> ${shopName}\n👤 <b>Telegram:</b> ${userName} (ID: <code>${userId}</code>)\n\n💻 <b>Machine ID:</b>\n<code>${machineId}</code>\n\n🖥 CPU: ${mi.cpu || '—'}\n🔧 Mainboard: ${mi.board || '—'}\n💾 RAM: ${mi.ram || '—'}\n🪟 OS: ${mi.os || '—'}\n\n⏰ ${new Date().toLocaleString('vi-VN')}\n\n<b>Chọn thời hạn kích hoạt:</b>`,
        reply_markup: {
            inline_keyboard: [
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
    const parts     = cb.data.split('|');
    const action    = parts[0];
    const userId    = parts[1];
    const machineId = parts[2];
    const months    = parseInt(parts[3] || '0');

    if (action === 'ok') {
        const { key, expiry } = generateKey(machineId, months);
        const planLabel = months === 0 ? 'Vĩnh viễn ♾️' : `${months / 12} năm`;
        const expiryFmt = months === 0 ? 'Không hết hạn' : new Date(expiry).toLocaleDateString('vi-VN');

        await tg('sendMessage', {
            chat_id: userId,
            parse_mode: 'HTML',
            text: `🎉 <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n🔑 <b>Key của bạn:</b>\n<code>${key}</code>\n\n📅 <b>Gói:</b> ${planLabel}\n⏳ <b>Hạn sử dụng:</b> ${expiryFmt}\n\n📋 Sao chép key trên và nhập vào phần mềm.\n💾 <i>Lưu lại key — cần dùng khi cài lại máy.</i>`
        });
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: `✅ Đã cấp key ${planLabel}` });
        await tg('editMessageReplyMarkup', {
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: [] }
        });
        await tg('sendMessage', {
            chat_id: ADMIN_ID,
            parse_mode: 'HTML',
            text: `✅ <b>Đã cấp key ${planLabel}</b>\n🔑 <code>${key}</code>\n💻 <code>${machineId}</code>`
        });

    } else if (action === 'no') {
        await tg('sendMessage', {
            chat_id: userId,
            text: '❌ Yêu cầu kích hoạt của bạn đã bị từ chối.\nVui lòng liên hệ lại với nhà cung cấp.'
        });
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Đã từ chối' });
        await tg('editMessageReplyMarkup', {
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: [] }
        });
    }
}

// ============ ENTRY POINT (Vercel Serverless Function) ============
module.exports = async function handler(req, res) {
    // Kiểm tra bảo mật webhook
    if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }

    if (req.method === 'GET') {
        res.status(200).send('✅ Bot đang hoạt động');
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const update = req.body;
        if (update.callback_query) await handleCallback(update.callback_query);
        else if (update.message)   await handleMessage(update.message);
    } catch (e) {
        console.error('Webhook error:', e.message);
    }

    res.status(200).json({ ok: true });
};
