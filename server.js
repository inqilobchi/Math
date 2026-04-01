require('dotenv').config();
const fs = require('fs'); 
const express = require('express');
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const base64Img = require('base64-img');
const crypto = require('crypto');
const cors = require('cors');
const User = require('./models/User');
const Payment = require('./models/Payment');
const app = express();
const port = process.env.PORT || 3000;
const bot = new TelegramBot(process.env.BOT_TOKEN);

const WEBHOOK_URL = `${process.env.RENDER_URL}/bot${process.env.BOT_TOKEN}`;

bot.setWebHook(WEBHOOK_URL);
// Middleware'larni webhook route'dan OLDIN joylashtiring
app.use(express.json({ limit: '10mb' }));  // Limitni 10MB ga oshirish
app.use(cors({
  origin: '*',  // Barcha origin'larni ruxsat berish (test uchun)
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options('*', cors());  // Saqlang
// Webhook callback route (middleware'lardan keyin)
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
    try {
        // Test uchun: req.body ni tekshiring (production'da olib tashlang)
        if (!req.body) {
            console.error('req.body is undefined');
            res.sendStatus(200);
            return;
        }
        bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.sendStatus(200); // Telegram'ga muvaffaqiyatli qabul qilindi deb bildirish
    }
});
const connectDB = async () => {
  try {
    console.log('🔄 MongoDB ga ulanish...');
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      bufferMaxEntries: 0,
      maxPoolSize: 10,
    });
    
    console.log('✅ MongoDB ga muvaffaqiyatli ulandi!');
    await loadData();
    
  } catch (error) {
    console.error('❌ MongoDB ulanish xatosi:', error.message);
    setTimeout(connectDB, 5000); // 5s dan keyin qayta urinish
  }
};

// Server middleware'lardan OLDIN ishga tushiring
connectDB();

const RANKS = {
  bronze: { name: 'Bronze', icon: '🥉', min: 0, max: 90000, mult: 1, refBonus: 3000, price: 0, priceText: 'Bepul' },
  pro: { name: 'Pro', icon: '💎', min: 90000, max: 999999, mult: 1, refBonus: 3000, price: 15000, priceText: "15,000 so'm" }
};
const RANK_ORDER = ['bronze', 'pro'];
app.get('/api/user-data', async (req, res) => {
  try {
    const uid = req.query.uid; // 'default' olib tashlandi, majburiy
    if (!uid) return res.status(400).json({ error: 'UID required' });
    const user = await User.findOne({ id: uid });
    if (user) {
      res.json(user.toObject());
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/leaderboard', async (req, res) => {
  try {
    const users = await User.find().sort({ totalScore: -1 }).limit(50);
    res.json(users.map(u => ({ id: u.id, name: u.name, avatar: u.avatar, rank: u.rank, score: u.totalScore, isPremium: u.isPremium })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/update-stats', async (req, res) => {
  try {
    const { userId, totalScore, gamesPlayed, correct, wrong, rank, name, avatar } = req.body;
    let user = await User.findOne({ id: userId });
    if (!user) {
      user = new User({ id: userId, name, avatar });
    }
    user.totalScore = totalScore;
    user.gamesPlayed = gamesPlayed;
    user.correct = correct;
    user.wrong = wrong;
    user.rank = rank;
    user.name = name || user.name;
    user.avatar = avatar || user.avatar;
    await user.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/submit-instagram', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
  try {
    const { userId, screenshot } = req.body;
    const user = await User.findOne({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.instagramBonus) return res.status(400).json({ error: 'Already claimed' });
    const existingPending = await Payment.findOne({ userId, type: 'instagram', status: 'pending' });
    if (existingPending) return res.status(400).json({ error: 'Already submitted, waiting for approval' });
    const payment = new Payment({
      id: 'ig_' + Date.now(),
      userId,
      userName: user.name,
      userAvatar: user.avatar,
      userRank: user.rank,
      type: 'instagram',
      amount: '20,000 ball',
      product: 'Instagram Story',
      screenshot,
      status: 'pending',
      date: new Date().toISOString()
    });
    await payment.save();
    
    // Admin ga yuborish
    const mk = {
      inline_keyboard: [
        [{ text: "✅ Tasdiqlash", callback_data: `ap_${payment.id}` }],
        [{ text: "❌ Rad etish", callback_data: `rj_${payment.id}` }]
      ]
    };
    await bot.sendMessage(process.env.ADMIN_ID, `📸 Instagram Story so'rovi\n\n👤 ${user.name}\n🆔 ${userId}`);
    if (screenshot) {
      const tempPath = base64Img.imgSync(`data:image/png;base64,${screenshot.split(',')[1]}`, 'uploads', `temp_${Date.now()}`);
      await bot.sendPhoto(process.env.ADMIN_ID, tempPath, { caption: `📸 Instagram - ${user.name}`, reply_markup: mk });
      require('fs').unlinkSync(tempPath);
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
function getRank(score) {
  if (score >= 90000) return 'pro';
  return 'bronze';
}

let awaitingPhoto = {};

app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });


async function checkSub(uid) {
  try {
    const m = await bot.getChatMember(process.env.CHANNEL_ID, uid);
    return ['member', 'administrator', 'creator'].includes(m.status);
  } catch {
    return true;
  }
}

async function ensureUser(uid, name) {
  try {
    let user = await User.findOneAndUpdate(
      { id: uid },
      { $setOnInsert: { name, joinDate: new Date() } },  // Faqat yangi bo'lsa qo'sh
      { upsert: true, new: true }  // Agar mavjud bo'lmasa, yarat; mavjud bo'lsa, qaytar
    );
    return user;
  } catch (e) {
    console.log('Ensure user error:', e.message);
    return null;
  }
}

function mainMenu(subscribed = true, userStats = null) {
  if (!subscribed) {
    const m = {
      inline_keyboard: [
        [{ text: "📢 Kanalga obuna", url: `https://t.me/${process.env.CHANNEL.replace('@', '')}` }],
        [{ text: "✅ Tekshirish", callback_data: "check_sub" }]
      ]
    };
    return m;
  }

let url = process.env.MINI_APP_URL;
  if (userStats) {
    const encodedStats = encodeURIComponent(JSON.stringify(userStats));
    url += `?stats=${encodedStats}`;
  }
  const menu = {
    keyboard: [
      [{ text: "🎮 O'ynash", web_app: { url } }],
      ["🎁 Referral", "📊 Statistika"],
      ["🏆 Top 10", "ℹ️ Yordam"]
    ],
    resize_keyboard: true
  };
  return menu;
}

// ===== START =====
bot.onText(/\/start/, async (msg) => {
  const uid = msg.from.id.toString();
  const name = msg.from.first_name;

  let refUid = null;
  const args = msg.text.split(' ');
  if (args.length > 1 && args[1].startsWith('ref')) {
    refUid = args[1].replace('ref', '');
  }

  const isNew = !(await User.findOne({ id: uid }));
  const u = await ensureUser(uid, name);

  if (isNew && refUid && refUid !== uid.toString() && await User.findOne({ id: refUid })) {
    u.referredBy = refUid;
    const refUser = await User.findOne({ id: refUid });
    if (!refUser.referrals.includes(uid.toString())) {
      refUser.referrals.push(uid.toString());
      const today = new Date().toISOString().split('T')[0];
      if (refUser.lastRefDate !== today) {
        refUser.todayRefs = 0;
        refUser.lastRefDate = today;
      }
      refUser.todayRefs += 1;
      // Referral bonus berishda (start komandasi)
      const bonus = RANKS[refUser.rank || 'bronze'].refBonus;  // Bu endi 700 ball beradi
      refUser.totalScore += bonus;
      refUser.refEarnings += bonus;
      await refUser.save();

      try {
        await bot.sendMessage(refUid, `🎉 Yangi referral: ${name}!\n💰 +${bonus} ball darhol berildi!\n📈 24 soatdan keyin uning balidan 5% olasiz!`);
      } catch (e) {
        console.log('Referral message error:', e.message);
      }
    }
    await u.save();
  }

  const subscribed = await checkSub(uid);
  if (!subscribed) {
    try {
      await bot.sendMessage(uid, "❌ Avval kanalga obuna bo'ling!\n\n📢 Kanal: " + process.env.CHANNEL, { reply_markup: mainMenu(false) });
    } catch (e) {
      console.log('Subscription message error:', e.message);
    }
    return;
  }

  const userStats = u.toObject();
  const r = RANKS[u.rank || 'bronze'];
  try {
    await bot.sendMessage(uid, `👋 Salom, ${name}!\n\n🧮 TezHisob matematik o'yiniga xush kelibsiz!\n\n${r.icon} Daraja: ${r.name}\n⭐ Ball: ${u.totalScore}\n🎮 O'yinlar: ${u.gamesPlayed}\n\n🎮 O'ynash uchun pastdagi tugmani bosing!`, { reply_markup: mainMenu(true, userStats) });
  } catch (e) {
    console.log('Start message error:', e.message);
  }
});

// ===== CHECK SUB =====
bot.on('callback_query', async (query) => {
  if (query.data === 'check_sub') {
    const uid = query.from.id.toString();  // String ga aylantirish
    const subscribed = await checkSub(uid);
    if (subscribed) {
      await bot.answerCallbackQuery(query.id, { text: "✅ Obuna tasdiqlandi!" });
      await ensureUser(uid, query.from.first_name);
      await bot.sendMessage(uid, "✅ Obuna tasdiqlandi!\n\nEndi o'ynashingiz mumkin!", { reply_markup: mainMenu() });
    } else {
      await bot.answerCallbackQuery(query.id, { text: "❌ Obuna topilmadi!", show_alert: true });
    }
  }
});

// ===== REFERRAL =====
bot.onText(/^🎁 Referral$/, async (msg) => {
  const uid = msg.from.id.toString();
  const u = await ensureUser(uid, msg.from.first_name);

  const bonus = RANKS[u.rank || 'bronze'].refBonus;
  const link = `https://t.me/TezHisob_bot?start=ref${uid}`;

  const today = new Date().toISOString().split('T')[0];
  const todayRefs = u.lastRefDate === today ? u.todayRefs : 0;

  await bot.sendMessage(msg.chat.id, `🎁 REFERRAL TIZIMI\n\n🔗 Sizning havolangiz:\n${link}\n\n💰 Bonuslar:\n├ Har bir do'st: +3000 ball (darhol)\n└ 24 soatdan keyin: 5% ularning balidan\n\n📊 Statistika:\n├ Jami taklif qilganlar: ${u.referrals.length}\n├ Bugungi referrallar: ${todayRefs}\n└ Jami ishlab olgan: ${u.refEarnings} ball`);
});

// ===== STATS =====
bot.onText(/^📊 Statistika$/, async (msg) => {
  const uid = msg.from.id.toString();
  const u = await ensureUser(uid, msg.from.first_name);

  const r = RANKS[u.rank || 'bronze'];
  const total = u.correct + u.wrong;
  const acc = total > 0 ? Math.round(u.correct / total * 100) : 0;

const ri = RANK_ORDER.indexOf(u.rank || 'bronze');
let progress = '';
if (ri < RANK_ORDER.length - 1) {  
  const nextRank = RANK_ORDER[ri + 1];
  const nextR = RANKS[nextRank];
  progress = `\n📈 ${nextR.name} gacha: ${nextR.min - u.totalScore} ball`;
} else {
  progress = '\n👑 Siz eng yuqori darajada!';
}
  const premText = u.isPremium ? 'Ha' : 'Yoq';

  await bot.sendMessage(msg.chat.id, `📊 SIZNING STATISTIKANGIZ\n\n👤 Ism: ${u.name}\n${r.icon} Daraja: ${r.name}\n⭐ Jami ball: ${u.totalScore}\n⭐ Premium: ${premText}${progress}\n\n🎮 O'yin statistikasi:\n├ O'yinlar: ${u.gamesPlayed}\n├ To'g'ri: ${u.correct}\n├ Xato: ${u.wrong}\n└ Aniqlik: ${acc}%\n\n👥 Referral:\n├ Taklif qilganlar: ${u.referrals.length}\n└ Ref daromad: ${u.refEarnings} ball`);
});

// ===== TOP 10 =====
bot.onText(/^🏆 Top 10$/, async (msg) => {
  const users = await User.find().sort({ totalScore: -1 }).limit(10);
  if (users.length === 0) {
    await bot.sendMessage(msg.chat.id, "📊 Hali o'yinchilar yo'q.");
    return;
  }

  let txt = "🏆 TOP 10 O'YINCHILAR\n\n";
  const medals = ['🥇', '🥈', '🥉'];
  users.forEach((u, i) => {
    const medal = i < 3 ? medals[i] : `${i + 1}.`;
    const r = RANKS[u.rank || 'bronze'];
    const premium = u.isPremium ? ' ⭐' : '';
    const isMe = u.id === msg.from.id.toString() ? ' 👈' : '';
    txt += `${medal} ${u.name}${premium}${isMe}\n    ${r.icon} ${u.totalScore} ball\n\n`;
  });

  await bot.sendMessage(msg.chat.id, txt);
});

// ===== HELP =====
bot.onText(/^ℹ️ Yordam$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `ℹ️ YORDAM\n\n🎮 O'yin qoidalari:\n├ Matematik misollarni yeching\n├ Har bir to'g'ri javob +10 ball\n├ Combo: 3+ ketma-ket +5, 5+ +10\n├ 3 ta xato = o'yin tugadi\n└ 60 soniya vaqt\n\n🏆 Darajalar:\n├ 🥉 Bronze: 0 - 90,000\n└ 💎 Pro: 90,000+\n\n🎁 Referral:\n├ Har bir do'st +3000 ball\n└ 24 soatdan keyin 5% bonus`);
});

// ===== WEB APP DATA =====
bot.on('web_app_data', async (msg) => {
  const uid = msg.from.id.toString();
  let u = await ensureUser(uid, msg.from.first_name);

  try {
    const data = JSON.parse(msg.web_app_data.data);
    const action = data.action;

    if (action === 'game_end') {
      u.totalScore += data.lastGameScore || 0;
      u.gamesPlayed += 1;
      u.correct += data.correct || 0;
      u.wrong += data.wrong || 0;
      u.streak = data.streak || 0;
      u.tasks = data.tasks || u.tasks;

      const oldRank = u.rank;
      const newRank = getRank(u.totalScore);
      if (RANK_ORDER.indexOf(newRank) > RANK_ORDER.indexOf(oldRank)) {
        u.rank = newRank;
        const r = RANKS[newRank];
        await bot.sendMessage(uid, `🎉 TABRIKLAYMIZ!\n\n${r.icon} ${r.name} darajasiga chiqdingiz!\n✨ Endi ${r.mult}x ball olasiz!`);
      }

      if (u.referredBy) {
        const refUser = await User.findOne({ id: u.referredBy });
        if (refUser) {
          const bonus = Math.floor((data.lastGameScore || 0) * 0.05);
          if (bonus > 0) {
            refUser.totalScore += bonus;
            refUser.refEarnings += bonus;
            await refUser.save();
          }
        }
      }

      await u.save();
      const total = u.correct + u.wrong;
      const acc = total > 0 ? Math.round(u.correct / total * 100) : 0;

      try {
        await bot.sendMessage(uid, `🎮 O'YIN TUGADI!\n\n⭐ Ball: +${data.lastGameScore || 0}\n✅ To'g'ri: ${data.correct || 0}\n❌ Xato: ${data.wrong || 0}\n🎯 Aniqlik: ${acc}%\n\n🏆 Jami ball: ${u.totalScore}`);
      } catch (e) {
        console.log('Game end message error:', e.message);
      }
    } else if (action === 'update_stats') {
      u.totalScore = data.totalScore;
      u.gamesPlayed = data.gamesPlayed;
      u.correct = data.correct;
      u.wrong = data.wrong;
      u.rank = data.rank;
      u.name = data.name || u.name;
      u.avatar = data.avatar || u.avatar;
      await u.save();
    } else if (action === 'buy_rank') {
      const rank = data.rank;
      const price = data.price;
      awaitingPhoto[uid] = { type: 'rank', rank, price, product: `${RANKS[rank].name} daraja` };
      await bot.sendMessage(uid, `💳 ${RANKS[rank].name.toUpperCase()} DARAJA\n\n💰 Narxi: ${price} so'm\n\n💳 Karta raqami:\n9860 0801 5954 3810\n\n📸 To'lov qilib, chek rasmini yuboring:`);
} else if (action === 'submit_payment') {
  const paymentData = data.payment;
  const payId = paymentData.id;
  const payment = new Payment(paymentData);
  await payment.save();

  const mk = {
    inline_keyboard: [
      [{ text: "✅ Tasdiqlash", callback_data: `ap_${payId}` }],
      [{ text: "❌ Rad etish", callback_data: `rj_${payId}` }]
    ]
  };

  const text = `💳 YANGI TO'LOV SO'ROVI (Mini App dan)\n\n👤 Foydalanuvchi: ${paymentData.userName}\n🆔 ID: ${paymentData.userId}\n📦 Mahsulot: ${paymentData.product}\n💰 Summa: ${paymentData.amount}\n📅 Sana: ${paymentData.date}`;

  if (paymentData.screenshot) {
    try {
      const screenshot = paymentData.screenshot;
      const header = screenshot.split(',')[0];
      const mimeType = header.split(':')[1].split(';')[0];  // Masalan, 'image/png'
      const imageData = screenshot.split(',')[1];  // Base64 qism
      const imageBuffer = Buffer.from(imageData, 'base64');  // Base64'dan Buffer ga aylantirish
      
      // Temp fayl yaratish (extension mimeType ga qarab)
      const ext = mimeType.split('/')[1] || 'png';  // Agar aniqlanmasa, png
      const tempPath = `uploads/temp_${Date.now()}.${ext}`;
      fs.writeFileSync(tempPath, imageBuffer);  // Faylga yozish
      
      await bot.sendPhoto(process.env.ADMIN_ID, tempPath, { caption: text, reply_markup: mk });
      
      fs.unlinkSync(tempPath);  // Temp faylni o'chirish
    } catch (e) {
      console.log('Screenshot error:', e.message);
      await bot.sendMessage(process.env.ADMIN_ID, `${text}\n\n❌ Chekni yuklashda xatolik: ${e.message}`, { reply_markup: mk });
    }
  } else {
    await bot.sendMessage(process.env.ADMIN_ID, `${text}\n\n📸 Chek yo'q`, { reply_markup: mk });
  }

  await bot.sendMessage(uid, "✅ So'rov yuborildi! Admin tekshirmoqda...");  // Agar kerak bo'lmasa, olib tashlang
}


  } catch (e) {
    console.log('WebApp error:', e.message);
  }
});

// ===== PHOTO HANDLER =====
bot.on('photo', async (msg) => {
  const uid = msg.from.id.toString();
  if (!(uid in awaitingPhoto)) return;

  const info = awaitingPhoto[uid];
  delete awaitingPhoto[uid];

  const u = await ensureUser(uid, msg.from.first_name);
  const payId = `p${Date.now()}`;
  const payment = new Payment({
    id: payId,
    userId: uid,
    userName: u.name,
    type: info.type,
    targetRank: info.rank,
    amount: `${info.price} so'm`,
    product: info.product,
    screenshot: msg.photo[msg.photo.length - 1].file_id,
    status: 'pending',
    date: new Date().toISOString().split('T')[0] + ' ' + new Date().toTimeString().split(' ')[0]
  });
  await payment.save();

  const mk = {
    inline_keyboard: [
      [{ text: "✅ Tasdiqlash", callback_data: `ap_${payId}` }],
      [{ text: "❌ Rad etish", callback_data: `rj_${payId}` }]
    ]
  };
  await bot.sendMessage(process.env.ADMIN_ID, `💳 Yangi to'lov so'rovi!\n\n👤 ${u.name}\n📦 ${info.product}\n💰 ${info.price} so'm`);
  await bot.sendPhoto(process.env.ADMIN_ID, payment.screenshot, { reply_markup: mk });

});  //
app.post('/api/submit-payment', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');  
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    try {
        const { payment } = req.body;
        const pay = new Payment(payment);
        await pay.save();
        // Admin ga xabar yuborish (bot orqali)
        const mk = {
            inline_keyboard: [
                [{ text: "✅ Tasdiqlash", callback_data: `ap_${pay.id}` }],
                [{ text: "❌ Rad etish", callback_data: `rj_${pay.id}` }]
            ]
        };
        await bot.sendMessage(process.env.ADMIN_ID, `💳 YANGI TO'LOV SO'ROVI\n\n👤 ${pay.userName}\n📦 ${pay.product}\n💰 ${pay.amount}`);
        if (pay.screenshot) {
            // Screenshot yuborish (base64 dan)
            const tempPath = base64Img.imgSync(`data:image/png;base64,${pay.screenshot.split(',')[1]}`, 'uploads', `temp_${Date.now()}`);
            await bot.sendPhoto(process.env.ADMIN_ID, tempPath, { caption: `📸 Chek - ${pay.userName}`, reply_markup: mk });
            require('fs').unlinkSync(tempPath);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== ADMIN PAYMENT =====

bot.on('callback_query', async (query) => {
  if (query.data.startsWith('ap_') || query.data.startsWith('rj_')) {
    if (query.from.id.toString() !== process.env.ADMIN_ID) {
      await bot.answerCallbackQuery(query.id, { text: "❌ Sizda ruxsat yo'q!" });
      return;
    }
    const action = query.data.slice(0, 2);
    const payId = query.data.slice(3);
    const payment = await Payment.findOne({ id: payId });
    if (!payment) {
      await bot.answerCallbackQuery(query.id, { text: "❌ To'lov topilmadi!" });
      return;
    }
    if (payment.status !== 'pending') {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Bu to'lov allaqachon ko'rib chiqilgan!" });
      return;
    }
    const uid = payment.userId;
    const u = await User.findOne({ id: uid });
    if (action === 'ap') {
      payment.status = 'approved';
      if (payment.type === 'instagram') {
        const user = await User.findOne({ id: payment.userId });
        user.totalScore += 20000;
        user.instagramBonus = true;
        await user.save();
        await bot.sendMessage(payment.userId, "🎉 Instagram Story tasdiqlandi!\n\n💰 +20,000 ball berildi!");
      }
      if (payment.type === 'premium') {
        u.isPremium = true;
        await bot.sendMessage(uid, "🎉 PREMIUM TASDIQLANDI!\n\n✨ Endi sizda:\n├ 2x ball\n├ 5 ta jon\n└ Maxsus avatarlar\n\n🎮 O'yinni qayta boshlang!");
      } else if (payment.type === 'rank') {
        u.rank = payment.targetRank;
        const r = RANKS[payment.targetRank];
          if (u.totalScore < r.min) {
            u.totalScore = r.min;  
          }
        await bot.sendMessage(uid, `🎉 ${r.name.toUpperCase()} TASDIQLANDI!\n\n${r.icon} Endi sizda:\n├ ${r.mult}x ball multiplikator\n└ ${r.name} darajasi\n\n🎮 O'yinni qayta boshlang!`);
      }
            await u.save();
      await payment.save();
      await bot.answerCallbackQuery(query.id, { text: "✅ Tasdiqlandi!" });
      // Xabar turini tekshirib, mos funksiyani ishlat
      const newText = `✅ TASDIQLANDI\n\n👤 ${payment.userName}\n📦 ${payment.product}\n💰 ${payment.amount}`;
      if (query.message.photo) {
        // Rasm xabari – caption'ni edit qil
        await bot.editMessageCaption(newText, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        });
      } else {
        // Text xabari – text'ni edit qil
        await bot.editMessageText(newText, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        });
      }
    } else {
      payment.status = 'rejected';
      await payment.save();
      await bot.sendMessage(uid, "❌ To'lov rad etildi\n\nSabab: Chek tasdiqlanmadi.\nIltimos qayta urinib ko'ring.");
      await bot.answerCallbackQuery(query.id, { text: "❌ Rad etildi!" });
            // Xabar turini tekshirib, mos funksiyani ishlat
      const newText = `❌ RAD ETILDI\n\n👤 ${payment.userName}\n📦 ${payment.product}\n💰 ${payment.amount}`;
      if (query.message.photo) {
        // Rasm xabari – caption'ni edit qil
        await bot.editMessageCaption(newText, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        });
      } else {
        // Text xabari – text'ni edit qil
        await bot.editMessageText(newText, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        });
      }
    }
  }
});

// ===== ADMIN COMMANDS =====
bot.onText(/\/panel|\/admin/, async (msg) => {
  const uid = msg.from.id.toString();
  const u = await User.findOne({ id: uid });
  if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

  const totalUsers = await User.countDocuments();
  const premiumUsers = await User.countDocuments({ isPremium: true });
  const totalScore = await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalScore' } } }]);
  const totalGames = await User.aggregate([{ $group: { _id: null, total: { $sum: '$gamesPlayed' } } }]);
  const pending = await Payment.countDocuments({ status: 'pending' });

  await bot.sendMessage(msg.chat.id, `👑 ADMIN PANEL\n\n📊 Statistika:\n├ Foydalanuvchilar: ${totalUsers}\n├ Premium: ${premiumUsers}\n├ Jami o'yinlar: ${totalGames[0]?.total || 0}\n├ Jami ball: ${totalScore[0]?.total || 0}\n└ Kutilayotgan to'lovlar: ${pending}\n\n📝 Buyruqlar:\n/users - Foydalanuvchilar\n/pending - Kutilayotgan to'lovlar\n/broadcast - Xabar yuborish\n/bonus [id] [ball] - Ball berish\n/setrank [id] [rank] - Daraja\n/setpremium [id] - Premium\n/search [ism] - Qidirish\n/user [id] - Ma'lumot\n/setadmin [id] - Admin qo'shish\n/disadmin [id] - Adminlikdan olish\n/reset - Haftalik tozalash\n/user_res [id] - Foydalanuvchini 0 qilish`);
});

bot.onText(/\/users/, async (msg) => {
  const uid = msg.from.id.toString();
  const u = await User.findOne({ id: uid });
  if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

  const users = await User.find().sort({ totalScore: -1 }).limit(30);
  if (users.length === 0) {
    await bot.sendMessage(msg.chat.id, "👥 Hali foydalanuvchilar yo'q.");
    return;
  }

  let txt = "👥 TOP 30 FOYDALANUVCHILAR\n\n";
  users.forEach((u, i) => {
    const r = RANKS[u.rank || 'bronze'];
    const premium = u.isPremium ? ' ⭐' : '';
    txt += `${i + 1}. ${u.name}${premium} ${r.icon}\n    ${u.id} — ${u.totalScore} ball\n`;
  });

  await bot.sendMessage(msg.chat.id, txt);
});

bot.onText(/\/pending/, async (msg) => {
  const uid = msg.from.id.toString();
  const u = await User.findOne({ id: uid });
  if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

  const pending = await Payment.find({ status: 'pending' });
  if (pending.length === 0) {
    await bot.sendMessage(msg.chat.id, "✅ Kutilayotgan to'lovlar yo'q!");
    return;
  }

  for (const p of pending) {
    const mk = {
      inline_keyboard: [
        [{ text: "✅ Tasdiqlash", callback_data: `ap_${p.id}` }],
        [{ text: "❌ Rad etish", callback_data: `rj_${p.id}` }]
      ]
    };

    await bot.sendMessage(msg.chat.id, `⏳ Kutilayotgan to'lov\n\n👤 ${p.userName}\n🆔 ${p.userId}\n📦 ${p.product}\n💰 ${p.amount}\n📅 ${p.date}`);
    await bot.sendPhoto(msg.chat.id, p.screenshot, { reply_markup: mk });
  }
});

bot.onText(/\/user_res (.+)/, async (msg, match) => {
  const uid = msg.from.id.toString();
  const u = await User.findOne({ id: uid });
  if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

  const targetUid = match[1].trim();
  const targetUser = await User.findOne({ id: targetUid });
  if (!targetUser) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  targetUser.rank = 'bronze';
  targetUser.totalScore = 0;
  targetUser.gamesPlayed = 0;
  targetUser.correct = 0;
  targetUser.wrong = 0;
  targetUser.streak = 0;
  targetUser.refEarnings = 0;
  targetUser.todayRefs = 0;
  targetUser.referrals = [];
  await targetUser.save();

  await bot.sendMessage(msg.chat.id, `✅ ${targetUser.name} reset qilindi!\n\n🥉 Daraja: Bronze\n⭐ Ball: 0`);

  try {
    await bot.sendMessage(targetUid, "⚠️ Admin sizning hisobingizni reset qildi!\n\n🥉 Daraja: Bronze\n⭐ Ball: 0");
  } catch (e) {
    console.log('User reset message error:', e.message);
  }
});

bot.onText(/\/bonus (.+)/, async (msg, match) => {
  const uid = msg.from.id.toString();
  const u = await User.findOne({ id: uid });
  if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

  const parts = match[1].split(' ');
  if (parts.length !== 2) {
    await bot.sendMessage(msg.chat.id, "❗ Format: /bonus [user_id] [ball]");
    return;
  }

  const targetUid = parts[0];
  const amount = parseInt(parts[1]);
  if (isNaN(amount)) {
    await bot.sendMessage(msg.chat.id, "❗ Ball son bo'lishi kerak!");
    return;
  }

  const targetUser = await User.findOne({ id: targetUid });
  if (!targetUser) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  targetUser.totalScore += amount;
  await targetUser.save();

  await bot.sendMessage(msg.chat.id, `✅ ${targetUser.name} ga +${amount} ball berildi!\n🏆 Yangi ball: ${targetUser.totalScore}`);

  try {
    await bot.sendMessage(uid, `🎁 Admin sizga +${amount} ball berdi!\n\n🏆 Yangi ball: ${targetUser.totalScore}`);
  } catch (e) {
    console.log('Bonus message error:', e.message);
  }
});

bot.onText(/\/setrank (.+)/, async (msg, match) => {
  const uid = msg.from.id.toString();
  const u = await User.findOne({ id: uid });
  if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

  const parts = match[1].split(' ');
  if (parts.length !== 2) {
    await bot.sendMessage(msg.chat.id, "❗ Format: /setrank [user_id] [bronze/silver/gold/pro]");
    return;
  }

  const targetUid = parts[0];
  const rank = parts[1].toLowerCase();
  if (!RANKS[rank]) {
    await bot.sendMessage(msg.chat.id, "❌ Noto'g'ri daraja!");
    return;
  }

  const targetUser = await User.findOne({ id: targetUid });
  if (!targetUser) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  targetUser.rank = rank;
  await targetUser.save();

  const r = RANKS[rank];
  await bot.sendMessage(msg.chat.id, `✅ ${targetUser.name} ga ${r.icon} ${r.name} berildi!`);

  try {
    await bot.sendMessage(targetUid, `🎉 Admin sizga ${r.icon} ${r.name} darajasi berdi!`);
  } catch (e) {
    console.log('Setrank message error:', e.message);
  }
});

bot.onText(/\/setpremium (.+)/, async (msg, match) => {
  const uid = msg.from.id.toString();
  const u = await User.findOne({ id: uid });
  if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

  const targetUid = match[1].trim();  
  const targetUser = await User.findOne({ id: targetUid });
  if (!targetUser) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  targetUser.isPremium = true;
  await targetUser.save();

  await bot.sendMessage(msg.chat.id, `✅ ${targetUser.name} ga Premium berildi!`);

  try {
    await bot.sendMessage(targetUid, "🎉 Admin sizga Premium obuna berdi!\n\n✨ Endi sizda 2x ball va 5 ta jon!");
  } catch (e) {
    console.log('Setpremium message error:', e.message);
  }
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  const uid = msg.from.id.toString();
  const u = await User.findOne({ id: uid });
  if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

  const query = match[1].toLowerCase();
  const results = await User.find({ name: { $regex: query, $options: 'i' } }).limit(10);

  if (results.length === 0) {
    await bot.sendMessage(msg.chat.id, "❌ Hech kim topilmadi!");
    return;
  }

  let txt = "🔍 Natijalar:\n\n";
  results.forEach(u => {
    const r = RANKS[u.rank || 'bronze'];
    const premium = u.isPremium ? ' ⭐' : '';
    txt += `• ${u.name}${premium} ${r.icon}\n  ID: ${u.id}\n  Ball: ${u.totalScore}\n\n`;
  });

  await bot.sendMessage(msg.chat.id, txt);
});

bot.onText(/\/user (.+)/, async (msg, match) => {
  const uid = msg.from.id.toString();
  const u = await User.findOne({ id: uid });
  if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

  const targetUid = match[1].trim(); 
  const targetUser = await User.findOne({ id: targetUid });
  if (!targetUser) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  const r = RANKS[u.rank || 'bronze'];
  const total = targetUser.correct + targetUser.wrong;
  const acc = total > 0 ? Math.round(targetUser.correct / total * 100) : 0;
  const prem = targetUser.isPremium ? 'Ha' : 'Yoq';

  const mk = {
    inline_keyboard: [
      [{ text: "➕ +1000", callback_data: `adm_bonus_${targetUid}` }],
      [{ text: "👑 Premium", callback_data: `adm_prem_${targetUid}` }]
    ]
  };

  await bot.sendMessage(msg.chat.id, `👤 FOYDALANUVCHI\n\n📛 Ism: ${targetUser.name}\n🆔 ID: ${targetUid}\n${r.icon} Daraja: ${r.name}\n⭐ Ball: ${targetUser.totalScore}\n⭐ Premium: ${prem}\n\n🎮 O'yinlar: ${targetUser.gamesPlayed}\n✅ To'g'ri: ${targetUser.correct}\n❌ Xato: ${targetUser.wrong}\n🎯 Aniqlik: ${acc}%\n\n👥 Referrallar: ${targetUser.referrals.length}\n💰 Ref daromad: ${targetUser.refEarnings}\n📅 Qo'shilgan: ${targetUser.joinDate}`, { reply_markup: mk });
});
bot.onText(/\/setadmin (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  const uid = match[1].trim();
  const u = await User.findOne({ id: uid });
  if (!u) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  u.isAdmin = true;
  await u.save();

  await bot.sendMessage(msg.chat.id, `✅ ${u.name} ga Admin berildi!`);

  try {
    await bot.sendMessage(uid, "🎉 Admin sizga Admin huquqlari berdi!");
  } catch (e) {
    console.log('Setadmin message error:', e.message);
  }
});
bot.onText(/\/disadmin (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  const uid = match[1].trim();
  const u = await User.findOne({ id: uid });
  if (!u) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  u.isAdmin = false;
  await u.save();

  await bot.sendMessage(msg.chat.id, `✅ ${u.name} adminlikdan olindi!`);

  try {
    await bot.sendMessage(uid, "❌ Siz adminlikdan olindingiz !");
  } catch (e) {
    console.log('Setadmin message error:', e.message);
  }
});
// ===== RESET ALL USERS =====
bot.onText(/^\/reset$/, async (msg) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  await bot.sendMessage(
    msg.chat.id,
    "⚠️ DIQQAT!\n\nBarcha foydalanuvchilarning:\n" +
    "• Ballari 0 bo‘ladi\n" +
    "• Darajasi 🥉 Bronze bo‘ladi\n" +
    "• Premium bekor qilinadi\n\n" +
    "Tasdiqlaysizmi?",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ HA, RESET", callback_data: "confirm_reset" }],
          [{ text: "❌ BEKOR", callback_data: "cancel_reset" }]
        ]
      }
    }
  );
});

bot.on('callback_query', async (query) => {
  if (query.data.startsWith('adm_')) {
      const uid = query.from.id.toString();
      const u = await User.findOne({ id: uid });
      if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

    const parts = query.data.split('_');
    const action = parts[1];
    const targetUid = parts[2];

    const targetUser = await User.findOne({ id: targetUid });
    if (!targetUser) {
      await bot.answerCallbackQuery(query.id, { text: "❌ Topilmadi!" });
      return;
    }

    if (action === 'bonus') {
      u.totalScore += 1000;
      await targetUser.save();
      await bot.answerCallbackQuery(query.id, { text: "✅ +1000 ball berildi!" });
      try {
        await bot.sendMessage(targetUid, "🎁 Admin sizga +1,000 ball berdi!");
      } catch (e) {
        console.log('Quick bonus message error:', e.message);
      }
    } else if (action === 'prem') {
      targetUser.isPremium = true;
      await targetUser.save();
      await bot.answerCallbackQuery(query.id, { text: "✅ Premium berildi!" });
      try {
        await bot.sendMessage(targetUid, "🎉 Admin sizga Premium berdi!");
      } catch (e) {
        console.log('Quick prem message error:', e.message);
      }
    }
  }
  if (query.data === 'confirm_reset') {
      const uid = query.from.id.toString();
      const u = await User.findOne({ id: uid });
      if (uid !== process.env.ADMIN_ID && (!u || !u.isAdmin)) return;

    await User.updateMany(
      {},
      {
        $set: {
          rank: 'bronze',
          totalScore: 0,
          isPremium: false,
          gamesPlayed: 0,
          correct: 0,
          wrong: 0,
          streak: 0,
          refEarnings: 0,
          todayRefs: 0,
          referrals: [],  
          instagramBonus: false 
        }
      }
    );

    await bot.answerCallbackQuery(query.id, { text: "✅ Reset bajarildi!" });
    await bot.sendMessage(
      query.message.chat.id,
      "♻️ BARCHA FOYDALANUVCHILAR RESET QILINDI!\n\n" +
      "🥉 Daraja: Bronze\n" +
      "⭐ Ball: 0\n" +
      "🚫 Premium: O‘chirildi"
    );
  }

  if (query.data === 'cancel_reset') {
    await bot.answerCallbackQuery(query.id, { text: "❌ Bekor qilindi" });
    await bot.sendMessage(query.message.chat.id, "🚫 Reset bekor qilindi.");
  }
});

bot.onText(/\/broadcast/, async (msg) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  await bot.sendMessage(msg.chat.id, "📢 BROADCAST\n\nXabaringizni yozing.\nBekor qilish: /cancel");

  const doBroadcast = async (response) => {
    if (response.from.id.toString() !== process.env.ADMIN_ID) return;

    if (response.text === '/cancel') {
      await bot.sendMessage(response.chat.id, "❌ Bekor qilindi.");
      return;
    }

    const users = await User.find();
    let sent = 0;
    let failed = 0;

    await bot.sendMessage(response.chat.id, "📤 Yuborilmoqda...");

    for (const u of users) {
      try {
        await bot.sendMessage(u.id, response.text);
        sent++;
      } catch (e) {
        failed++;
      }
    }

    await bot.sendMessage(response.chat.id, `📨 Broadcast yakunlandi!\n\n✅ Yuborildi: ${sent}\n❌ Xato: ${failed}`);
  };

  bot.once('message', doBroadcast);
});
app.post('/api/approve-payment', async (req, res) => {
    try {
        const { paymentId, adminId } = req.body;
        const adminUser = await User.findOne({ id: adminId });
        if (adminId !== process.env.ADMIN_ID && (!adminUser || !adminUser.isAdmin)) return res.status(403).json({ error: 'Not admin' });
        const payment = await Payment.findOne({ id: paymentId });
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        payment.status = 'approved';
        const user = await User.findOne({ id: payment.userId });
        if (payment.type === 'premium') user.isPremium = true;
        else if (payment.type === 'rank') user.rank = payment.targetRank;
        user.pendingRequest = null;  // Qo'shildi
        await user.save();
        await payment.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/reject-payment', async (req, res) => {
    try {
        const { paymentId, adminId } = req.body;
        const adminUser = await User.findOne({ id: adminId });
        if (adminId !== process.env.ADMIN_ID && (!adminUser || !adminUser.isAdmin)) return res.status(403).json({ error: 'Not admin' });
        const payment = await Payment.findOne({ id: paymentId });
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        payment.status = 'rejected';
        const user = await User.findOne({ id: payment.userId });
        user.pendingRequest = null;  // Qo'shildi
        await user.save();
        await payment.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin-payments', async (req, res) => {
    try {
        const pending = await Payment.find({ status: 'pending' });
        // Screenshot'ni base64 ga aylantirish (agar file_id bo'lsa, uni olish kerak, lekin kodda base64 saqlanadi)
        const result = pending.map(p => ({
            ...p.toObject(),
            screenshot: p.screenshot // Agar base64 bo'lsa, shunday qoldir; agar file_id bo'lsa, uni base64 ga aylantir
        }));
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ===== LOAD AND RUN =====
const loadData = async () => {
  const userCount = await User.countDocuments();
  const paymentCount = await Payment.countDocuments();
  console.log('='.repeat(50));
  console.log('✅ Tez Hisob Bot ishga tushdi!');
  console.log(`👥 Foydalanuvchilar: ${userCount}`);
  console.log(`💳 To'lovlar: ${paymentCount}`);
  console.log('='.repeat(50));
};

loadData();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
