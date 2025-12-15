require('dotenv').config();
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
const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: { port: process.env.PORT || 3000 } });

// Render URL
const WEBHOOK_URL = `${process.env.RENDER_URL}/bot${process.env.BOT_TOKEN}`;

// Webhook o‘rnatish
bot.setWebHook(WEBHOOK_URL);

// Telegram webhook callback route
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.use(cors({
  origin: '*',  // Barcha origin'larni ruxsat berish (test uchun)
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options('*', cors());  // Saqlang
   
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const RANKS = {
  bronze: { name: 'Bronze', icon: '🥉', min: 0, max: 5000, mult: 1, ref: 50 },
  silver: { name: 'Silver', icon: '🥈', min: 5000, max: 10000, mult: 1.2, ref: 75 },
  gold: { name: 'Gold', icon: '🥇', min: 10000, max: 15000, mult: 1.5, ref: 100 },
  pro: { name: 'Pro', icon: '💎', min: 15000, max: 999999, mult: 2, ref: 150 }
};
const RANK_ORDER = ['bronze', 'silver', 'gold', 'pro'];
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
function getRank(score) {
  if (score >= 15000) return 'pro';
  if (score >= 10000) return 'gold';
  if (score >= 5000) return 'silver';
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
  let user = await User.findOne({ id: uid });
  if (!user) {
    user = new User({ id: uid, name });
    await user.save();
  }
  return user;
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
  const uid = msg.from.id;
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
      const bonus = RANKS[refUser.rank || 'bronze'].ref;
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
    await bot.sendMessage(uid, `👋 Salom, ${name}!\n\n🧮 VibeX Matematik o'yiniga xush kelibsiz!\n\n${r.icon} Daraja: ${r.name}\n⭐ Ball: ${u.totalScore}\n🎮 O'yinlar: ${u.gamesPlayed}\n\n🎮 O'ynash uchun pastdagi tugmani bosing!`, { reply_markup: mainMenu(true, userStats) });
  } catch (e) {
    console.log('Start message error:', e.message);
  }
});

// ===== CHECK SUB =====
bot.on('callback_query', async (query) => {
  if (query.data === 'check_sub') {
    const subscribed = await checkSub(query.from_user.id);
    if (subscribed) {
      await bot.answerCallbackQuery(query.id, { text: "✅ Obuna tasdiqlandi!" });
      await ensureUser(query.from_user.id, query.from_user.first_name);
      await bot.sendMessage(query.from_user.id, "✅ Obuna tasdiqlandi!\n\nEndi o'ynashingiz mumkin!", { reply_markup: mainMenu() });
    } else {
      await bot.answerCallbackQuery(query.id, { text: "❌ Obuna topilmadi!", show_alert: true });
    }
  }
});

// ===== REFERRAL =====
bot.onText(/^🎁 Referral$/, async (msg) => {
  const uid = msg.from.id.toString();
  const u = await ensureUser(uid, msg.from.first_name);

  const bonus = RANKS[u.rank || 'bronze'].ref;
  const link = `https://t.me/${bot.options.username}?start=ref${uid}`;

  const today = new Date().toISOString().split('T')[0];
  const todayRefs = u.lastRefDate === today ? u.todayRefs : 0;

  await bot.sendMessage(msg.chat.id, `🎁 REFERRAL TIZIMI\n\n🔗 Sizning havolangiz:\n${link}\n\n💰 Bonuslar:\n├ Har bir do'st: +${bonus} ball (darhol)\n└ 24 soatdan keyin: 5% ularning balidan\n\n📊 Statistika:\n├ Jami taklif qilganlar: ${u.referrals.length}\n├ Bugungi referrallar: ${todayRefs}\n└ Jami ishlab olgan: ${u.refEarnings} ball`);
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
  if (ri < 3) {
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
  await bot.sendMessage(msg.chat.id, `ℹ️ YORDAM\n\n🎮 O'yin qoidalari:\n├ Matematik misollarni yeching\n├ Har bir to'g'ri javob +10 ball\n├ Combo: 3+ ketma-ket +5, 5+ +10\n├ 3 ta xato = o'yin tugadi\n└ 60 soniya vaqt\n\n🏆 Darajalar:\n├ 🥉 Bronze: 0 - 10,000\n├ 🥈 Silver: 10,000 - 20,000 (1.2x)\n├ 🥇 Gold: 20,000 - 30,000 (1.5x)\n└ 💎 Pro: 30,000+ (2x)\n\n🎁 Referral:\n├ Har bir do'st +50 ball\n└ 24 soatdan keyin 5% bonus`);
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
    } else if (action === 'buy_premium') {
      awaitingPhoto[uid] = { type: 'premium', price: 5000, product: 'Premium obuna' };
      await bot.sendMessage(uid, `💳 PREMIUM OBUNA\n\n💰 Narxi: 5,000 so'm\n\n✨ Premium imkoniyatlar:\n├ 2x ball\n├ 5 ta jon\n└ Maxsus avatarlar\n\n💳 Karta raqami:\n9860 0801 5954 3810\n\n📸 To'lov qilib, chek rasmini yuboring:`);
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

      await bot.sendMessage(process.env.ADMIN_ID, `💳 YANGI TO'LOV SO'ROVI (Mini App dan)\n\n👤 Foydalanuvchi: ${paymentData.userName}\n🆔 ID: ${paymentData.userId}\n📦 Mahsulot: ${paymentData.product}\n💰 Summa: ${paymentData.amount}\n📅 Sana: ${paymentData.date}`);

      if (paymentData.screenshot) {
        try {
          const screenshot = paymentData.screenshot;
          const header = screenshot.split(',')[0];
          const mimeType = header.split(':')[1].split(';')[0];
          const ext = mimeType.split('/')[1];
          const imageData = screenshot.split(',')[1];
          const tempPath = base64Img.imgSync(`data:${mimeType};base64,${imageData}`, 'uploads', `temp_${Date.now()}`);
          await bot.sendPhoto(process.env.ADMIN_ID, tempPath, { caption: `📸 Chek - ${paymentData.userName}`, reply_markup: mk });
          require('fs').unlinkSync(tempPath);
        } catch (e) {
          console.log('Screenshot error:', e.message);
          await bot.sendMessage(process.env.ADMIN_ID, `❌ Chekni yuklashda xatolik: ${e.message}`, { reply_markup: mk });
        }
      } else {
        await bot.sendMessage(process.env.ADMIN_ID, "📸 Chek yo'q", { reply_markup: mk });
      }

      await bot.sendMessage(uid, "✅ So'rov yuborildi! Admin tekshirmoqda...");
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

      if (payment.type === 'premium') {
        u.isPremium = true;
        await bot.sendMessage(uid, "🎉 PREMIUM TASDIQLANDI!\n\n✨ Endi sizda:\n├ 2x ball\n├ 5 ta jon\n└ Maxsus avatarlar\n\n🎮 O'yinni qayta boshlang!");
      } else if (payment.type === 'rank') {
        u.rank = payment.targetRank;
        const r = RANKS[payment.targetRank];
        await bot.sendMessage(uid, `🎉 ${r.name.toUpperCase()} TASDIQLANDI!\n\n${r.icon} Endi sizda:\n├ ${r.mult}x ball multiplikator\n└ ${r.name} darajasi\n\n🎮 O'yinni qayta boshlang!`);
      }

      await u.save();
      await payment.save();

      await bot.answerCallbackQuery(query.id, { text: "✅ Tasdiqlandi!" });
      await bot.editMessageCaption(`✅ TASDIQLANDI\n\n👤 ${payment.userName}\n📦 ${payment.product}\n💰 ${payment.amount}`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    } else {
      payment.status = 'rejected';
      await payment.save();

      await bot.sendMessage(uid, "❌ To'lov rad etildi\n\nSabab: Chek tasdiqlanmadi.\nIltimos qayta urinib ko'ring.");

      await bot.answerCallbackQuery(query.id, { text: "❌ Rad etildi!" });
      await bot.editMessageCaption(`❌ RAD ETILDI\n\n👤 ${payment.userName}\n📦 ${payment.product}\n💰 ${payment.amount}`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    }
  }
});

// ===== ADMIN COMMANDS =====
bot.onText(/\/panel|\/admin/, async (msg) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  const totalUsers = await User.countDocuments();
  const premiumUsers = await User.countDocuments({ isPremium: true });
  const totalScore = await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalScore' } } }]);
  const totalGames = await User.aggregate([{ $group: { _id: null, total: { $sum: '$gamesPlayed' } } }]);
  const pending = await Payment.countDocuments({ status: 'pending' });

  await bot.sendMessage(msg.chat.id, `👑 ADMIN PANEL\n\n📊 Statistika:\n├ Foydalanuvchilar: ${totalUsers}\n├ Premium: ${premiumUsers}\n├ Jami o'yinlar: ${totalGames[0]?.total || 0}\n├ Jami ball: ${totalScore[0]?.total || 0}\n└ Kutilayotgan to'lovlar: ${pending}\n\n📝 Buyruqlar:\n/users - Foydalanuvchilar\n/pending - Kutilayotgan to'lovlar\n/broadcast - Xabar yuborish\n/bonus [id] [ball] - Ball berish\n/setrank [id] [rank] - Daraja\n/setpremium [id] - Premium\n/search [ism] - Qidirish\n/user [id] - Ma'lumot`);
});

bot.onText(/\/users/, async (msg) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

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
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

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

bot.onText(/\/bonus (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  const parts = match[1].split(' ');
  if (parts.length !== 2) {
    await bot.sendMessage(msg.chat.id, "❗ Format: /bonus [user_id] [ball]");
    return;
  }

  const uid = parts[0];
  const amount = parseInt(parts[1]);
  if (isNaN(amount)) {
    await bot.sendMessage(msg.chat.id, "❗ Ball son bo'lishi kerak!");
    return;
  }

  const u = await User.findOne({ id: uid });
  if (!u) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  u.totalScore += amount;
  await u.save();

  await bot.sendMessage(msg.chat.id, `✅ ${u.name} ga +${amount} ball berildi!\n🏆 Yangi ball: ${u.totalScore}`);

  try {
    await bot.sendMessage(uid, `🎁 Admin sizga +${amount} ball berdi!\n\n🏆 Yangi ball: ${u.totalScore}`);
  } catch (e) {
    console.log('Bonus message error:', e.message);
  }
});

bot.onText(/\/setrank (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  const parts = match[1].split(' ');
  if (parts.length !== 2) {
    await bot.sendMessage(msg.chat.id, "❗ Format: /setrank [user_id] [bronze/silver/gold/pro]");
    return;
  }

  const uid = parts[0];
  const rank = parts[1].toLowerCase();
  if (!RANKS[rank]) {
    await bot.sendMessage(msg.chat.id, "❌ Noto'g'ri daraja!");
    return;
  }

  const u = await User.findOne({ id: uid });
  if (!u) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  u.rank = rank;
  await u.save();

  const r = RANKS[rank];
  await bot.sendMessage(msg.chat.id, `✅ ${u.name} ga ${r.icon} ${r.name} berildi!`);

  try {
    await bot.sendMessage(uid, `🎉 Admin sizga ${r.icon} ${r.name} darajasi berdi!`);
  } catch (e) {
    console.log('Setrank message error:', e.message);
  }
});

bot.onText(/\/setpremium (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  const uid = match[1].trim();
  const u = await User.findOne({ id: uid });
  if (!u) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  u.isPremium = true;
  await u.save();

  await bot.sendMessage(msg.chat.id, `✅ ${u.name} ga Premium berildi!`);

  try {
    await bot.sendMessage(uid, "🎉 Admin sizga Premium obuna berdi!\n\n✨ Endi sizda 2x ball va 5 ta jon!");
  } catch (e) {
    console.log('Setpremium message error:', e.message);
  }
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

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
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  const uid = match[1].trim();
  const u = await User.findOne({ id: uid });
  if (!u) {
    await bot.sendMessage(msg.chat.id, "❌ Foydalanuvchi topilmadi!");
    return;
  }

  const r = RANKS[u.rank || 'bronze'];
  const total = u.correct + u.wrong;
  const acc = total > 0 ? Math.round(u.correct / total * 100) : 0;
  const prem = u.isPremium ? 'Ha' : 'Yoq';

  const mk = {
    inline_keyboard: [
      [{ text: "➕ +1000", callback_data: `adm_bonus_${uid}` }],
      [{ text: "👑 Premium", callback_data: `adm_prem_${uid}` }]
    ]
  };

  await bot.sendMessage(msg.chat.id, `👤 FOYDALANUVCHI\n\n📛 Ism: ${u.name}\n🆔 ID: ${uid}\n${r.icon} Daraja: ${r.name}\n⭐ Ball: ${u.totalScore}\n⭐ Premium: ${prem}\n\n🎮 O'yinlar: ${u.gamesPlayed}\n✅ To'g'ri: ${u.correct}\n❌ Xato: ${u.wrong}\n🎯 Aniqlik: ${acc}%\n\n👥 Referrallar: ${u.referrals.length}\n💰 Ref daromad: ${u.refEarnings}\n📅 Qo'shilgan: ${u.joinDate}`, { reply_markup: mk });
});

bot.on('callback_query', async (query) => {
  if (query.data.startsWith('adm_')) {
    if (query.from.id.toString() !== process.env.ADMIN_ID) return;

    const parts = query.data.split('_');
    const action = parts[1];
    const uid = parts[2];

    const u = await User.findOne({ id: uid });
    if (!u) {
      await bot.answerCallbackQuery(query.id, { text: "❌ Topilmadi!" });
      return;
    }

    if (action === 'bonus') {
      u.totalScore += 1000;
      await u.save();
      await bot.answerCallbackQuery(query.id, { text: "✅ +1000 ball berildi!" });
      try {
        await bot.sendMessage(uid, "🎁 Admin sizga +1,000 ball berdi!");
      } catch (e) {
        console.log('Quick bonus message error:', e.message);
      }
    } else if (action === 'prem') {
      u.isPremium = true;
      await u.save();
      await bot.answerCallbackQuery(query.id, { text: "✅ Premium berildi!" });
      try {
        await bot.sendMessage(uid, "🎉 Admin sizga Premium berdi!");
      } catch (e) {
        console.log('Quick prem message error:', e.message);
      }
    }
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
        if (adminId !== process.env.ADMIN_ID) return res.status(403).json({ error: 'Not admin' });
        const payment = await Payment.findOne({ id: paymentId });
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        payment.status = 'approved';
        const user = await User.findOne({ id: payment.userId });
        if (payment.type === 'premium') user.isPremium = true;
        else if (payment.type === 'rank') user.rank = payment.targetRank;
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
        if (adminId !== process.env.ADMIN_ID) return res.status(403).json({ error: 'Not admin' });
        const payment = await Payment.findOne({ id: paymentId });
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        payment.status = 'rejected';
        await payment.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/admin-payments', async (req, res) => {
    try {
        const pending = await Payment.find({ status: 'pending' });
        res.json(pending);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ===== LOAD AND RUN =====
const loadData = async () => {
  const userCount = await User.countDocuments();
  const paymentCount = await Payment.countDocuments();
  console.log('='.repeat(50));
  console.log('✅ VibeX Bot ishga tushdi!');
  console.log(`👥 Foydalanuvchilar: ${userCount}`);
  console.log(`💳 To'lovlar: ${paymentCount}`);
  console.log('='.repeat(50));
};

loadData();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
