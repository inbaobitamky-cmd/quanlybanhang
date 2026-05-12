const https   = require('https');
const http    = require('http');
const db      = require('./db');
const { generateKey, generateResetCode } = require('../license');

// Lấy machine info từ server chính (cùng máy, port 3000)
function fetchMachineInfo(machineId) {
    return new Promise(resolve => {
        const req = http.get(`http://localhost:3000/api/machine-info/${machineId}`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(d);
                    resolve(json.found ? json : null);
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    });
}

let _token   = null;
let _adminId = null;
let _polling = false;
let _offset  = 0;

// Chờ nhập tên cửa hàng (kích hoạt)
const _step = new Map(); // userId -> { machineId, machineInfo, userName }

// Yêu cầu reset đang chờ admin duyệt
const _resetPending = new Map(); // machineId -> { userId, userName, shopName, requestedAt }

// ── Gọi Telegram API ──
function api(method, params = {}) {
    return new Promise(resolve => {
        const body = JSON.stringify(params);
        const opts = {
            hostname: 'api.telegram.org',
            path:     `/bot${_token}/${method}`,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const req = https.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); } });
        });
        req.on('error', () => resolve({ ok: false }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false }); });
        req.write(body);
        req.end();
    });
}

// ── Gửi tin nhắn (dùng cho approve từ web UI) ──
function sendMessage(chatId, text) {
    if (!_token || !chatId) return Promise.resolve({ ok: false });
    return api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

// ── Xử lý tin nhắn ──
async function handleMessage(msg) {
    const userId   = String(msg.from.id);
    const text     = (msg.text || '').trim();
    const userName = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'Khách');
    const isAdmin  = userId === String(_adminId);

    // ── Admin: /list, /help ──
    if (isAdmin) {
        if (text === '/list') {
            const pending = db.getPending();
            if (!pending.length) return api('sendMessage', { chat_id: _adminId, text: 'Không có yêu cầu đang chờ.' });
            let m = '📋 <b>Yêu cầu đang chờ:</b>\n\n';
            pending.forEach(p => {
                m += `🏪 <b>${p.shopName || '?'}</b> — ${p.userName}\n<code>${p.machineId}</code>\n\n`;
            });
            return api('sendMessage', { chat_id: _adminId, text: m, parse_mode: 'HTML' });
        }
        if (text === '/help') {
            return api('sendMessage', { chat_id: _adminId,
                text: '🤖 <b>Lệnh Admin:</b>\n/list — Xem yêu cầu đang chờ\n/help — Hướng dẫn',
                parse_mode: 'HTML' });
        }
    }

    // ── Deep link: /start {payload} ──
    if (text.startsWith('/start ')) {
        const payload = text.slice(7).trim().toUpperCase();

        // ── RESET MẬT KHẨU: /start RESET_machineId ──
        if (payload.startsWith('RESET_')) {
            const machineId = payload.slice(6).replace(/_/g, '-'); // RESET_ABC_DEF → ABC-DEF

            if (machineId.length < 10) {
                return api('sendMessage', { chat_id: userId,
                    text: '❌ Mã máy không hợp lệ. Vui lòng thử lại từ phần mềm.', parse_mode: 'HTML' });
            }

            // Lưu yêu cầu reset
            _resetPending.set(machineId, {
                userId, userName,
                shopName: 'Đang tải...',
                requestedAt: new Date().toLocaleString('vi-VN')
            });

            // Báo khách đã nhận
            await api('sendMessage', { chat_id: userId, parse_mode: 'HTML',
                text: `🔐 <b>Đã nhận yêu cầu đặt lại mật khẩu!</b>\n\n⏳ Admin đang xem xét và sẽ gửi <b>mã OTP</b> về đây cho bạn trong giây lát.\n\n💡 Giữ cửa sổ này mở để nhận mã.` });

            // Thông báo admin + nút "Gửi OTP"
            const d = new Date();
            const dateStr = d.toLocaleString('vi-VN');
            return api('sendMessage', {
                chat_id: _adminId,
                parse_mode: 'HTML',
                text: `🆘 <b>YÊU CẦU ĐẶT LẠI MẬT KHẨU ADMIN</b>\n\n👤 <b>Telegram:</b> ${userName} (ID: <code>${userId}</code>)\n💻 <b>Machine ID:</b>\n<code>${machineId}</code>\n⏰ ${dateStr}`,
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🔑 Gửi OTP cho khách', callback_data: `reset|${userId}|${machineId}` }
                    ], [
                        { text: '❌ Từ chối',            callback_data: `resetno|${userId}|${machineId}` }
                    ]]
                }
            });
        }

        // ── KÍCH HOẠT: /start {machineId} ──
        const machineId = payload;

        if (machineId.length < 10) {
            return api('sendMessage', { chat_id: userId,
                text: '👋 Hãy mở phần mềm và nhấn <b>"Yêu cầu kích hoạt"</b>.', parse_mode: 'HTML' });
        }

        // Lấy machine info từ server chính (nếu có)
        const fetchedInfo = await fetchMachineInfo(machineId);
        const machineInfo = fetchedInfo
            ? { cpu: fetchedInfo.cpu, board: fetchedInfo.board, ram: fetchedInfo.ram, os: fetchedInfo.os }
            : { cpu: '—', board: '—', os: '—', ram: '—' };

        _step.set(userId, { machineId, machineInfo, userName });
        return api('sendMessage', { chat_id: userId,
            text: `👋 Xin chào <b>${msg.from.first_name || ''}</b>!\n\n✅ Đã nhận Machine ID:\n<code>${machineId}</code>\n\n📝 Vui lòng nhập <b>tên cửa hàng</b> của bạn để gửi yêu cầu kích hoạt:`,
            parse_mode: 'HTML' });
    }

    if (text === '/start') {
        return api('sendMessage', { chat_id: userId,
            text: '👋 Đây là bot kích hoạt <b>Quản Lý Bán Hàng</b>.\nHãy mở phần mềm và nhấn <b>"Yêu cầu kích hoạt"</b>.',
            parse_mode: 'HTML' });
    }

    // ── Nhập tên cửa hàng ──
    if (_step.has(userId)) {
        const w = _step.get(userId);
        _step.delete(userId);

        const pending = {
            machineId:      w.machineId,
            machineInfo:    w.machineInfo,
            userName:       w.userName,
            telegramUserId: userId,
            shopName:       text
        };
        db.addPending(pending);

        await api('sendMessage', { chat_id: userId,
            text: '✅ Yêu cầu đã gửi thành công!\n⏳ Vui lòng chờ — bạn sẽ nhận key kích hoạt tại đây.' });

        // Thông báo admin
        const mi = w.machineInfo;
        return api('sendMessage', {
            chat_id: _adminId,
            parse_mode: 'HTML',
            text: `🔔 <b>YÊU CẦU KÍCH HOẠT MỚI</b>\n\n🏪 <b>Cửa hàng:</b> ${text}\n👤 <b>Telegram:</b> ${w.userName} (ID: <code>${userId}</code>)\n\n💻 <b>Machine ID:</b>\n<code>${w.machineId}</code>\n\n🖥 CPU: ${mi.cpu||'—'}\n🔧 Mainboard: ${mi.board||'—'}\n💾 RAM: ${mi.ram||'—'}\n🪟 OS: ${mi.os||'—'}\n\n⏰ ${new Date().toLocaleString('vi-VN')}\n\n<b>Chọn gói kích hoạt:</b>`,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🧪 15 Ngày (thử)', callback_data: `ok|${userId}|${w.machineId}|-15` },
                        { text: '🧪 30 Ngày (thử)', callback_data: `ok|${userId}|${w.machineId}|-30` }
                    ],
                    [
                        { text: '🕕 6 Tháng',        callback_data: `ok|${userId}|${w.machineId}|6`  },
                        { text: '1️⃣ 1 Năm',         callback_data: `ok|${userId}|${w.machineId}|12` }
                    ],
                    [
                        { text: '2️⃣ 2 Năm',         callback_data: `ok|${userId}|${w.machineId}|24` },
                        { text: '3️⃣ 3 Năm',         callback_data: `ok|${userId}|${w.machineId}|36` }
                    ],
                    [
                        { text: '♾️ Vĩnh viễn',     callback_data: `ok|${userId}|${w.machineId}|0`  },
                        { text: '❌ Từ chối',        callback_data: `no|${userId}|${w.machineId}`    }
                    ]
                ]
            }
        });
    }

    // ── Tin nhắn khác ──
    if (!isAdmin) {
        api('sendMessage', { chat_id: userId,
            text: 'Hãy mở phần mềm và nhấn <b>"Yêu cầu kích hoạt"</b>.', parse_mode: 'HTML' });
    }
}

// ── Xử lý inline button ──
async function handleCallback(cb) {
    const [action, userId, machineId, monthsStr] = cb.data.split('|');
    const months  = parseInt(monthsStr || '0');
    const pending = db.getPending().find(p => p.machineId === machineId);

    // ── RESET MẬT KHẨU: Admin nhấn "Gửi OTP" ──
    if (action === 'reset') {
        try {
            const otp = generateResetCode(machineId); // 8 ký tự, hết hạn cuối ngày

            // Gửi OTP cho khách
            await api('sendMessage', { chat_id: userId, parse_mode: 'HTML',
                text: `🔑 <b>MÃ ĐẶT LẠI MẬT KHẨU CỦA BẠN</b>\n\n<code>${otp}</code>\n\n⏳ Mã có hiệu lực đến <b>23:59 hôm nay</b>\n\n📋 Sao chép mã trên → quay lại phần mềm → nhập vào ô OTP → đặt mật khẩu mới.` });

            // Cập nhật tin nhắn admin (ẩn nút đi)
            await api('editMessageReplyMarkup', {
                chat_id: cb.message.chat.id, message_id: cb.message.message_id,
                reply_markup: { inline_keyboard: [] }
            });
            await api('editMessageText', {
                chat_id: cb.message.chat.id, message_id: cb.message.message_id,
                parse_mode: 'HTML',
                text: cb.message.text + `\n\n✅ <b>Đã gửi OTP:</b> <code>${otp}</code>`
            });

            await api('answerCallbackQuery', { callback_query_id: cb.id, text: `✅ Đã gửi OTP cho khách` });
            _resetPending.delete(machineId);
        } catch(e) {
            await api('answerCallbackQuery', { callback_query_id: cb.id, text: `❌ Lỗi: ${e.message}` });
        }
        return;
    }

    if (action === 'resetno') {
        await api('sendMessage', { chat_id: userId,
            text: '❌ Yêu cầu đặt lại mật khẩu của bạn đã bị từ chối.\nVui lòng liên hệ trực tiếp nhà cung cấp.' });
        await api('editMessageReplyMarkup', {
            chat_id: cb.message.chat.id, message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: [] }
        });
        await api('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Đã từ chối' });
        _resetPending.delete(machineId);
        return;
    }

    if (action === 'ok') {
        const keyData   = generateKey(machineId, months);
        const planLabel = months === 0       ? 'Vĩnh viễn ♾️'
                        : months === -15   ? '15 ngày dùng thử 🧪'
                        : months === -30   ? '30 ngày dùng thử 🧪'
                        : months < 0      ? `${Math.abs(months)} ngày dùng thử 🧪`
                        : months < 12     ? `${months} tháng`
                        : months % 12 === 0 ? `${months / 12} năm`
                        : `${months} tháng`;
        const expiryFmt = months === 0 ? 'Không hết hạn' : new Date(keyData.expiry).toLocaleDateString('vi-VN');

        db.addLicense({
            machineId, key: keyData.key, expiry: keyData.expiry,
            months, isLifetime: months === 0,
            shopName: pending?.shopName || '', telegramUserId: userId,
            userName: pending?.userName || '', machineInfo: pending?.machineInfo || {},
            status: 'active'
        });
        if (pending) db.removePending(pending.id);

        await api('sendMessage', { chat_id: userId, parse_mode: 'HTML',
            text: `🎉 <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n🔑 <b>Key của bạn:</b>\n<code>${keyData.key}</code>\n\n📅 <b>Gói:</b> ${planLabel}\n⏳ <b>Hạn:</b> ${expiryFmt}\n\n📋 Sao chép key trên → nhập vào phần mềm.\n💾 <i>Lưu lại key này để dùng khi cài lại.</i>` });

        await api('answerCallbackQuery', { callback_query_id: cb.id, text: `✅ Đã cấp key ${planLabel}` });
        await api('editMessageReplyMarkup', {
            chat_id: cb.message.chat.id, message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: [] }
        });

    } else if (action === 'no') {
        if (pending) db.removePending(pending.id);
        await api('sendMessage', { chat_id: userId,
            text: '❌ Yêu cầu kích hoạt của bạn đã bị từ chối.\nVui lòng liên hệ nhà cung cấp.' });
        await api('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Đã từ chối' });
        await api('editMessageReplyMarkup', {
            chat_id: cb.message.chat.id, message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: [] }
        });
    }
}

// ── Polling loop ──
async function poll() {
    if (!_polling || !_token) return;
    try {
        const res = await api('getUpdates', { offset: _offset, timeout: 20, allowed_updates: ['message', 'callback_query'] });
        if (res.ok && res.result) {
            for (const upd of res.result) {
                _offset = upd.update_id + 1;
                try {
                    if (upd.callback_query) await handleCallback(upd.callback_query);
                    else if (upd.message)   await handleMessage(upd.message);
                } catch(e) { console.error('[Bot]', e.message); }
            }
        }
    } catch {}
    if (_polling) setTimeout(poll, 500);
}

function start(token, adminChatId) {
    if (!token || !adminChatId) return false;
    _token   = token;
    _adminId = String(adminChatId);
    _polling = true;
    _offset  = 0;
    console.log('🤖 Telegram bot khởi động...');
    poll();
    return true;
}

function stop() { _polling = false; _token = null; }
function isRunning() { return _polling && !!_token; }

module.exports = { start, stop, isRunning, sendMessage };
