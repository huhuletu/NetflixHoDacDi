const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

// Cấu hình multer lưu file upload vào bộ nhớ RAM tạm thời
const upload = multer({ storage: multer.memoryStorage() });

// CƠ SỞ DỮ LIỆU TẠM THỜI (LƯU TRÊN RAM)
const db = {
  notification: { id: 1, message: "Hệ thống đã sẵn sàng!", display_seconds: 15 },
  config: {
    tgGateEnabled: false, // ĐÃ TẮT: Cho phép vào thẳng không cần Telegram
    tgChannels: [],
    tgBotUsername: ""
  },
  plansConfig: {
    premium: { limit: 2, windowMinutes: 720, url: "https://netflix.com/browse", cookie_value: "" },
    standard: { limit: 2, windowMinutes: 720, url: "https://netflix.com/browse", cookie_value: "" },
    duplicate: { limit: 2, windowMinutes: 720, url: "https://netflix.com/browse", cookie_value: "" },
    basic: { limit: 2, windowMinutes: 720, url: "https://netflix.com/browse", cookie_value: "" }
  },
  users: new Map() // Lưu lịch sử thiết bị
};

// Hàm lấy/tạo mới hồ sơ người dùng
function getUser(uuid) {
  if (!uuid) return null;
  if (!db.users.has(uuid)) {
    db.users.set(uuid, {
      tgVerified: true, // Auto verify
      history: { premium: [], standard: [], duplicate: [], basic: [] },
      bonus: { premium: 0, standard: 0, duplicate: 0, basic: 0 }
    });
  }
  return db.users.get(uuid);
}

// Tính số lượt đã dùng trong 12h
function calculateUsage(user) {
  const now = Date.now();
  const usageArray = [];
  
  for (const [planId, planObj] of Object.entries(db.plansConfig)) {
    const history = user.history[planId] || [];
    const windowMs = planObj.windowMinutes * 60 * 1000;
    const validHistory = history.filter(time => now - time < windowMs);
    user.history[planId] = validHistory; 
    
    const used = validHistory.length;
    const totalLimit = planObj.limit + (user.bonus[planId] || 0);
    
    let resetMinutes = 0;
    if (used > 0) {
      const oldestConnection = Math.min(...validHistory);
      const timePassed = now - oldestConnection;
      resetMinutes = Math.max(0, Math.ceil((windowMs - timePassed) / 60000));
    }

    usageArray.push({
      id: planId,
      name: planId.charAt(0).toUpperCase() + planId.slice(1),
      used: used,
      limit: planObj.limit,
      bonus: user.bonus[planId] || 0,
      windowMinutes: planObj.windowMinutes,
      resetMinutes: resetMinutes,
      unlimited: false
    });
  }
  return usageArray;
}

// ==========================================
// API DÀNH CHO EXTENSION NGƯỜI DÙNG
// ==========================================

app.get('/api/config', (req, res) => res.json({ ...db.config, tgVerified: true }));
app.get('/api/notification', (req, res) => res.json({ notification: db.notification }));
app.post('/api/tg-claim', (req, res) => res.json({ ok: true })); // Vô hiệu hoá Telegram

app.get('/api/usage', (req, res) => {
  const user = getUser(req.headers['x-client-uuid']);
  if (!user) return res.json([]);
  res.json(calculateUsage(user));
});

// Xử lý khi bấm nút "Kết Nối & Vào Xem"
app.post('/api/connect', (req, res) => {
  const uuid = req.headers['x-client-uuid'];
  const { plan } = req.body;
  const user = getUser(uuid);
  const planObj = db.plansConfig[plan];

  if (!user || !planObj) return res.status(400).json({ error: "Lỗi thiết bị hoặc gói không tồn tại!" });

  const usageData = calculateUsage(user);
  const planUsage = usageData.find(u => u.id === plan);
  const totalLimit = planUsage.limit + planUsage.bonus;

  if (planUsage.used >= totalLimit) {
    return res.status(403).json({ error: "Đã hết lượt kết nối trong 12h qua!" });
  }

  user.history[plan].push(Date.now());
  
  // Trả về Cookie cho Extension tự dán vào trình duyệt
  res.json({ 
    success: true,
    url: planObj.url, 
    cookie_value: planObj.cookie_value,
    remaining: totalLimit - planUsage.used - 1 
  });
});

// ==========================================
// API DÀNH CHO TRANG QUẢN TRỊ ADMIN
// ==========================================

app.post('/admin/push-notification', (req, res) => {
  if (req.body.message) {
    db.notification.id += 1;
    db.notification.message = req.body.message;
    res.json({ success: true, notification: db.notification });
  } else {
    res.status(400).json({ error: "Thiếu tin nhắn" });
  }
});

app.get('/admin/users', (req, res) => {
  const allUsers = {};
  for (const [uuid, data] of db.users.entries()) {
    allUsers[uuid] = {
      historyCount: Object.keys(data.history).map(k => `${k}: ${data.history[k].length}`).join(', ')
    };
  }
  res.json(allUsers);
});

// Chức năng mới: Nhận file Cookie từ Admin
app.post('/admin/upload-cookie', upload.single('cookieFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Chưa chọn file nào!" });
  
  const fileContent = req.file.buffer.toString('utf-8');
  const plan = req.body.plan || 'premium';

  if (db.plansConfig[plan]) {
    db.plansConfig[plan].cookie_value = fileContent;
    console.log(`[+] Đã cập nhật Cookie mới cho gói: ${plan}`);
    res.json({ success: true, message: `Đã cập nhật Cookie cho gói ${plan.toUpperCase()} thành công!` });
  } else {
    res.status(400).json({ error: "Gói không tồn tại!" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server đang chạy tại cổng ${PORT}`));
