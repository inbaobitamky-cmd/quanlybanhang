const crypto = require('crypto');

// Cùng secret với license.js gốc — KHÔNG thay đổi
const _raw = [0x4E,0x53,0x5D,0x57,0x40,0x4F,0x57,0x5E,0x51,0x52,0x5A,0x52,0x40,
              0x4C,0x5A,0x5C,0x4D,0x5A,0x4B,0x40,0x2D,0x2F,0x2D,0x2B,0x40,0x47,0x45,0x26];
const MASTER_SECRET = _raw.map(c => String.fromCharCode(c ^ 0x1F)).join('');

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

    const key = `${hmac.slice(0,5)}-${hmac.slice(5,10)}-${hmac.slice(10,15)}-${hmac.slice(15,20)}`;
    return { key, expiry };
}

module.exports = { generateKey };
