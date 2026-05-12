const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const sourceDir = path.join(__dirname, '..');
const buildDir = path.join(__dirname, '..', 'release', 'QuanLyBanHang');

console.log('========================================');
console.log('  BUILD PHẦN MỀM QUẢN LÝ BÁN HÀNG');
console.log('========================================\n');

// Xóa thư mục build cũ nếu tồn tại
if (fs.existsSync(buildDir)) {
    console.log('🗑️  Xóa build cũ...');
    try {
        fs.rmSync(buildDir, { recursive: true, force: true });
    } catch (err) {
        console.log('⚠️  Không thể xóa build cũ (có thể đang chạy). Sẽ ghi đè...');
    }
}

// Tạo thư mục build
console.log('📁 Tạo thư mục build...');
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(path.join(buildDir, 'views'), { recursive: true });
fs.mkdirSync(path.join(buildDir, 'public'), { recursive: true });
fs.mkdirSync(path.join(buildDir, 'data'), { recursive: true });

// Danh sách file cần copy trực tiếp (không mã hóa)
const filesToCopy = [
    'start.bat',
    'stop.bat',
    'version.json'
];

// Danh sách file JavaScript cần mã hóa
const filesToObfuscate = [
    'server.js',
    'database.js',
    'telegram.js',
    'license.js',
    'updater.js',
    'heartbeat.js',
    'tray.js',
    'config.js'
];

// File copy không mã hóa (config.js để dễ chỉnh sửa nếu cần)
// config.js được copy thẳng vì đã bỏ bot token khỏi đây rồi

// Danh sách thư mục cần copy toàn bộ
const dirsToCopy = [
    { src: 'config', dest: 'config' },
    { src: 'views', dest: 'views' },
    { src: 'public', dest: 'public' }
];

// Cấu hình obfuscator
const obfuscatorOptions = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 0.75,
    transformObjectKeys: true,
    unicodeEscapeSequence: false
};

// Copy và mã hóa file JavaScript
console.log('\n🔒 Mã hóa file JavaScript...');
filesToObfuscate.forEach(file => {
    const sourcePath = path.join(sourceDir, file);
    const destPath = path.join(buildDir, file);

    if (fs.existsSync(sourcePath)) {
        const code = fs.readFileSync(sourcePath, 'utf8');
        const obfuscated = JavaScriptObfuscator.obfuscate(code, obfuscatorOptions);

        fs.writeFileSync(destPath, obfuscated.getObfuscatedCode());
        console.log(`✅ Mã hóa: ${file}`);
    }
});

// Copy file không mã hóa
console.log('\n📋 Copy file cấu hình...');
filesToCopy.forEach(file => {
    const sourcePath = path.join(sourceDir, file);
    const destPath = path.join(buildDir, file);

    if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        console.log(`✅ Copy: ${file}`);
    }
});

// Tạo package.json mới cho bản build
console.log('✅ Tạo package.json...');
const buildPackageJson = {
    name: 'quan-ly-ban-hang',
    version: '1.0.0',
    description: 'Phần mềm quản lý bán hàng linh kiện máy tính',
    main: 'server.js',
    scripts: {
        start: 'node server.js',
        'seed-categories': 'node scripts/seed-categories.js'
    },
    author: '',
    license: 'ISC',
    dependencies: {
        'bcryptjs': '^3.0.3',
        'body-parser': '^1.20.2',
        'ejs': '^3.1.9',
        'express': '^4.18.2',
        'express-session': '^1.19.0',
        'sqlite3': '^5.1.7'
    }
};
fs.writeFileSync(
    path.join(buildDir, 'package.json'),
    JSON.stringify(buildPackageJson, null, 2)
);

// Copy script seed-categories
console.log('✅ Copy seed script...');
fs.mkdirSync(path.join(buildDir, 'scripts'), { recursive: true });
fs.copyFileSync(
    path.join(sourceDir, 'scripts', 'seed-categories.js'),
    path.join(buildDir, 'scripts', 'seed-categories.js')
);

// Copy thư mục
console.log('\n📂 Copy thư mục...');
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (let entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

dirsToCopy.forEach(({ src, dest }) => {
    const srcPath = path.join(sourceDir, src);
    const destPath = path.join(buildDir, dest);

    if (fs.existsSync(srcPath)) {
        copyDir(srcPath, destPath);
        console.log(`✅ Copy thư mục: ${src}`);
    }
});

// Tạo database trống với schema
console.log('\n💾 Tạo database...');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(buildDir, 'data', 'database.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Tạo các bảng
    db.run(`CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#3498db',
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS subcategories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#3498db',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT,
        subcategory TEXT,
        cost_price REAL DEFAULT 0,
        retail_price REAL DEFAULT 0,
        wholesale_price REAL DEFAULT 0,
        price REAL DEFAULT 0,
        import_date TEXT DEFAULT (datetime('now', 'localtime')),
        warranty_months INTEGER DEFAULT 12,
        stock INTEGER DEFAULT 0,
        colors TEXT,
        has_serial INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS serials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        serial TEXT NOT NULL UNIQUE,
        color TEXT,
        status TEXT DEFAULT 'Tồn kho',
        sold_date TEXT,
        sale_id INTEGER,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        address TEXT,
        type TEXT DEFAULT 'Khách lẻ',
        level TEXT DEFAULT 'Thường',
        total_spent REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        customer_id INTEGER,
        customer_name TEXT,
        customer_phone TEXT,
        items TEXT NOT NULL,
        subtotal REAL DEFAULT 0,
        discount REAL DEFAULT 0,
        total REAL DEFAULT 0,
        date TEXT DEFAULT (datetime('now', 'localtime')),
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS warranties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        product_name TEXT,
        serial TEXT,
        color TEXT,
        customer_id INTEGER,
        customer_name TEXT,
        customer_phone TEXT,
        sale_date TEXT,
        warranty_months INTEGER DEFAULT 12,
        expiry_date TEXT,
        status TEXT DEFAULT 'Còn bảo hành',
        note TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS expense_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        color TEXT DEFAULT '#3498db',
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT DEFAULT (datetime('now', 'localtime')),
        type TEXT NOT NULL,
        category_id INTEGER,
        category_name TEXT,
        amount REAL DEFAULT 0,
        customer_id INTEGER,
        customer_name TEXT,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`);

    // Thêm settings mặc định
    const settingsStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    settingsStmt.run('storeName', 'CỬA HÀNG LINH KIỆN MÁY TÍNH');
    settingsStmt.run('storeAddress', '');
    settingsStmt.run('storePhone', '');
    settingsStmt.run('taxCode', '');
    settingsStmt.finalize();

    // Thêm danh mục thu/chi mặc định
    const expenseCatStmt = db.prepare('INSERT OR IGNORE INTO expense_categories (id, name, type, color) VALUES (?, ?, ?, ?)');

    // Danh mục THU
    expenseCatStmt.run(1, 'Doanh thu bán hàng', 'income', '#4CAF50');
    expenseCatStmt.run(2, 'Thu nợ khách hàng', 'income', '#8BC34A');
    expenseCatStmt.run(3, 'Thu khác', 'income', '#00BCD4');

    // Danh mục CHI
    expenseCatStmt.run(4, 'Nhập hàng', 'expense', '#f44336');
    expenseCatStmt.run(5, 'Tiền lương', 'expense', '#E91E63');
    expenseCatStmt.run(6, 'Tiền thuê mặt bằng', 'expense', '#9C27B0');
    expenseCatStmt.run(7, 'Tiền điện nước', 'expense', '#673AB7');
    expenseCatStmt.run(8, 'Chi phí vận chuyển', 'expense', '#3F51B5');
    expenseCatStmt.run(9, 'Chi phí marketing', 'expense', '#2196F3');
    expenseCatStmt.run(10, 'Trả nợ nhà cung cấp', 'expense', '#FF5722');
    expenseCatStmt.run(11, 'Chi khác', 'expense', '#795548');

    expenseCatStmt.finalize();

    console.log('✅ Tạo database thành công');

    db.close(() => {
        console.log('\n========================================');
        console.log('  ✅ BUILD HOÀN THÀNH!');
        console.log('========================================');
        console.log(`\n📦 Thư mục build: ${buildDir}`);
        console.log('\n📌 HƯỚNG DẪN CÀI ĐẶT:');
        console.log('1. Vào thư mục build: cd release/QuanLyBanHang');
        console.log('2. Cài đặt dependencies: npm install --production');
        console.log('3. Thêm danh mục mẫu: npm run seed-categories');
        console.log('4. Khởi động: npm start hoặc start.bat');
        console.log('5. Truy cập: http://localhost:3000\n');
    });
});
