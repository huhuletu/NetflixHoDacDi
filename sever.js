const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// CƠ SỞ DỮ LIỆU TẠM THỜI (LƯU TRÊN RAM)
// ==========================================
const db = {
  notification: { 
    id: 1, 
    message: "Hệ thống Premium đã kích hoạt thành công!", 
    display_seconds: 15 
  },
  config: {
    tgGateEnabled: false, // Bật tính năng bắt buộc tham gia Telegram
    tgChannels: [
      { label: "Kênh Chính Thức", url: "https://t.me/your_channel" },
      { label: "Nhóm Chat", url: "https://t.me/your_group" }
    ],
    tgBotUsername: "@your_verify_bot"
  },
  plansConfig: {
    premium: { limit: 2, windowMinutes: 720, url: "https://netflix.com/browse?profile=premium" },
    standard: { limit: 2, windowMinutes: 720, url: "https://netflix.com/browse?profile=standard" },
    duplicate: { limit: 2, windowMinutes: 720, url: "https://netflix.com/browse?profile=duplicate" },
    basic: { limit: 2, windowMinutes: 720, url: "https://netflix.com/browse?profile=basic" }
  },
  users: new Map() // Lưu hồ sơ của từng người dùng theo mã UUID
};

// Hàm lấy/tạo mới hồ sơ người dùng khi họ mở extension
function getUser(uuid) {
  if (!uuid) return null;
  if (!db.users.has(uuid)) {
    db.users.set(uuid, {
      tgVerified: false, // Mặc định chưa qua cổng Telegram
      history: { premium: [], standard: [], duplicate: [], basic: [] }, // Mảng lưu [thời gian] kết nối
      bonus: { premium: 0, standard: 0, duplicate: 0, basic: 0 } // Số lượt admin tặng thêm
    });
  }
  return db.users.get(uuid);
}

// Hàm tính toán số lượt sử dụng trong 12h qua
function calculateUsage(user) {
  const now = Date.now();
  const usageArray = [];
  
  for (const [planId, planObj] of Object.entries(db.plansConfig)) {
    const history = user.history[planId] || [];
    const windowMs = planObj.windowMinutes * 60 * 1000;
    
    // Thuật toán cốt lõi: Chỉ giữ lại những lần kết nối trong vòng 12h (720 phút)
    const validHistory = history.filter(time => now - time < windowMs);
    user.history[planId] = validHistory; 
    
    const used = validHistory.length;
    const totalLimit = planObj.limit + (user.bonus[planId] || 0);
    
    // Tính số phút đếm ngược để hiển thị chữ "Reset sau X giờ Y phút"
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
// CÁC API DÀNH CHO EXTENSION NGHIEN FLIX
// ==========================================

// 1. Trả về cấu hình & kiểm tra xem máy này đã verify Telegram chưa
app.get('/api/config', (req, res) => {
  const uuid = req.headers['x-client-uuid'];
  const user = getUser(uuid);
  res.json({
    ...db.config,
    tgVerified: user ? user.tgVerified : false
  });
});

// 2. Trả về danh sách thống kê lượt dùng (0/2, 1/2...)
app.get('/api/usage', (req, res) => {
  const uuid = req.headers['x-client-uuid'];
  const user = getUser(uuid);
  if (!user) return res.json([]);
  res.json(calculateUsage(user));
});

// 3. Trả về thông báo mới nhất cho chuông báo
app.get('/api/notification', (req, res) => {
  res.json({ notification: db.notification });
});

// 4. Khi người dùng nhập @username và bấm "VERIFY & UNLOCK" trên popup
app.post('/api/tg-claim', (req, res) => {
  const uuid = req.headers['x-client-uuid'];
  const user = getUser(uuid);
  if (user) {
    user.tgVerified = true; // Mở khóa!
    console.log(`[+] Thiết bị ${uuid.substring(0,8)}... đã xác minh Telegram`);
  }
  res.json({ ok: true });
});

// 5. NÚT "KẾT NỐI & VÀO XEM" - Quan trọng nhất!
app.post('/api/connect', (req, res) => {
  const uuid = req.headers['x-client-uuid'];
  const { plan } = req.body;
  
  const user = getUser(uuid);
  const planObj = db.plansConfig[plan];

  if (!user || !planObj) {
    return res.status(400).json({ error: "Gói không hợp lệ hoặc lỗi thiết bị" });
  }

  // Nếu Admin đang bật cổng Telegram mà người này chưa verify -> Chặn
  if (db.config.tgGateEnabled && !user.tgVerified) {
    return res.status(403).json({ error: "Vui lòng xác minh Telegram trước!" });
  }

  // Tính toán số lượt dùng
  const usageData = calculateUsage(user);
  const planUsage = usageData.find(u => u.id === plan);
  const totalLimit = planUsage.limit + planUsage.bonus;

  // Thuật toán chặn nếu đã dùng hết 2/2 lượt
  if (planUsage.used >= totalLimit) {
    return res.status(403).json({ error: "Đã hết lượt kết nối trong 12h qua!" });
  }

  // Ghi nhận thời gian kết nối thành công vào lịch sử
  user.history[plan].push(Date.now());
  
  // Thành công: Trả về URL để extension mở tab mới và số lượt còn lại
  res.json({ 
    success: true,
    url: planObj.url, 
    remaining: totalLimit - planUsage.used - 1 
  });
});

// ==========================================
// CÁC API DÀNH CHO ADMIN (Trang quản trị)
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

// Xem danh sách toàn bộ mã UID đang hoạt động
app.get('/admin/users', (req, res) => {
  const allUsers = {};
  for (const [uuid, data] of db.users.entries()) {
    allUsers[uuid] = {
      verified: data.tgVerified,
      historyCount: Object.keys(data.history).map(k => `${k}: ${data.history[k].length}`).join(', ')
    };
  }
  res.json(allUsers);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Premium Backend Server chạy tại cổng ${PORT}`));
