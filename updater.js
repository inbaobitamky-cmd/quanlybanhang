const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ⚠️ Thay bằng GitHub username/repo của bạn
// Ví dụ: 'nguyenvana/quanlybanhang'
const GITHUB_REPO = 'inbaobitamky-cmd/quanlybanhang';

// ── Đọc version hiện tại ──
// Đọc từ config.js — được pkg bundle thẳng vào exe, luôn đúng, không cần đọc file
function getCurrentVersion() {
    try {
        const cfg = require('./config');
        if (cfg.VERSION) return cfg.VERSION;
    } catch {}
    // Fallback: đọc version.json cạnh exe (dành cho dev mode)
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version || '1.0.0';
    } catch {}
    return '1.0.0';
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return 1;
        if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
}

// ── Kiểm tra bản cập nhật từ GitHub Releases ──
function checkForUpdate() {
    return new Promise(resolve => {
        if (!GITHUB_REPO || GITHUB_REPO.includes('YOUR_GITHUB')) {
            return resolve(null);
        }
        const opts = {
            hostname: 'api.github.com',
            path:     `/repos/${GITHUB_REPO}/releases/latest`,
            method:   'GET',
            headers:  { 'User-Agent': 'QLBH-App/1.0' }
        };
        const req = https.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const release = JSON.parse(data);
                    if (!release.tag_name) return resolve(null);

                    const latest  = release.tag_name.replace(/^v/, '');
                    const current = getCurrentVersion();
                    if (compareVersions(latest, current) <= 0) return resolve(null);

                    // Tìm file .exe và .vbs trong assets
                    const asset    = (release.assets || []).find(a => a.name.toLowerCase().endsWith('.exe'));
                    const vbsAsset = (release.assets || []).find(a => a.name.toLowerCase().endsWith('.vbs'));
                    resolve({
                        version:        latest,
                        currentVersion: current,
                        downloadUrl:    asset    ? asset.browser_download_url    : null,
                        vbsDownloadUrl: vbsAsset ? vbsAsset.browser_download_url : null,
                        releaseUrl:     release.html_url,
                        releaseNotes:   (release.body || '').substring(0, 300),
                        publishedAt:    release.published_at,
                        fileSize:       asset ? asset.size : 0
                    });
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// ── Tải file về — tự động theo redirect (GitHub dùng 302 → CDN) ──
function downloadUpdate(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        let redirectCount = 0;

        function makeRequest(currentUrl) {
            if (redirectCount > 10) return reject(new Error('Quá nhiều redirect'));
            const lib = currentUrl.startsWith('https') ? https : http;

            lib.get(currentUrl, { headers: { 'User-Agent': 'QLBH-Updater/1.0' } }, res => {
                // Xử lý redirect
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    redirectCount++;
                    res.resume(); // drain response
                    return makeRequest(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Lỗi HTTP ${res.statusCode}`));
                }

                const total      = parseInt(res.headers['content-length'] || '0');
                let   downloaded = 0;
                const file       = fs.createWriteStream(destPath);

                res.on('data', chunk => {
                    downloaded += chunk.length;
                    if (onProgress && total > 0) {
                        onProgress(Math.round(downloaded / total * 100), downloaded, total);
                    }
                });

                res.pipe(file);
                file.on('finish', () => { file.close(() => resolve(destPath)); });
                file.on('error', err => {
                    fs.unlink(destPath, () => {});
                    reject(err);
                });
            }).on('error', err => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        }

        makeRequest(url);
    });
}

// ── Lấy đường dẫn .exe hiện tại (khi chạy qua pkg) ──
function getExePath() {
    if (typeof process.pkg !== 'undefined') {
        return process.execPath; // đường dẫn file .exe thật
    }
    return null; // đang chạy bằng node (dev mode)
}

module.exports = { checkForUpdate, getCurrentVersion, downloadUpdate, getExePath };
