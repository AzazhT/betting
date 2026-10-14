const TelegramBot = require('node-telegram-bot-api');

module.exports = function (token, pool) {
  const bot = new TelegramBot(token, { polling: true });

  // /start ትዕዛዝ ሲላክ
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);
    const firstName = msg.from.first_name || "ተጫዋች";
    const username = msg.from.username || "";

    try {
      // ተጠቃሚው በዳታቤዝ ውስጥ መኖሩን ማረጋገጥ እና ካለ መመዝገብ
      await pool.query(`
        INSERT INTO users (telegram_id, name, username, balance, is_active)
        VALUES ($1, $2, $3, 0.00, TRUE)
        ON CONFLICT (telegram_id) 
        DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username, updated_at = NOW()
      `, [telegramId, firstName, username]);
    } catch (err) {
      console.error('User registration on start error:', err.message);
    }

    const welcomeText = `ሰላም ${firstName}!እንኳን ወደ **Fast Keno** (እድል ኬኖ) በደህና መጡ። ከታች ያሉትን አማራጮች በመጠቀም ጨዋታውን መጀመር ወይም መረጃዎችን ማየት ይችላሉ።`;

    const options = {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🎮 Play (ጨዋታ ጀምር)", web_app: { url: "https://tiny-dasik-98c906.netlify.app" } },
            { text: "👤 መለያ (Profile)", callback_data: "register" }
          ],
          [
            { text: "💰 የሒሳብ መጠን (Balance)", callback_data: "balance" },
            { text: "💸 ገንዘብ ማስገባት (Deposit)", callback_data: "deposit" }
          ],
          [
            { text: "🚨 የዕርዳታ ማዕከል (Support)", url: "https://t.me/YOUR_ADMIN_USERNAME" },
            { text: "💬 የጨዋታ መመሪያ (Instruction)", callback_data: "instruction" }
          ]
        ]
      }
    };

    bot.sendMessage(chatId, welcomeText, options);
  });

  // የአዝራሮቹ ምላሽ (Callback Queries)
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const telegramId = String(query.from.id);
    const data = query.data;

    try {
      if (data === 'balance') {
        const userRes = await pool.query(`
          SELECT balance FROM users WHERE telegram_id = $1
        `, [telegramId]);

        const balance = userRes.rows.length ? Number(userRes.rows[0].balance).toFixed(2) : "0.00";
        bot.sendMessage(chatId, `💰 የሒሳብዎ መጠን: **${balance} ETB**`, { parse_mode: "Markdown" });

      } else if (data === 'deposit') {
        bot.sendMessage(chatId, "📥 ገንዘብ ለማስገባት የሚከተለውን የቴሌብር ቁጥር ይጠቀሙ:\n\n📱 ቁጥር: `0912345678`\n👤 ስም: `ማስተካከያ ስም`\n\nገንዘብ ካስተላለፉ በኋላ ደረሰኙን ለአድሚን በመላክ ባላንስዎን መሙላት ይችላሉ።", { parse_mode: "Markdown" });

      } else if (data === 'register') {
        const userRes = await pool.query(`
          SELECT name, balance, created_at FROM users WHERE telegram_id = $1
        `, [telegramId]);

        if (userRes.rows.length) {
          const u = userRes.rows[0];
          bot.sendMessage(chatId, `👤 **የተጠቃሚ መረጃዎ**\n\nስም: ${u.name}\nመለያ (ID): ${telegramId}\nቀሪ ሂሳብ: ${Number(u.balance).toFixed(2)} ETB`, { parse_mode: "Markdown" });
        } else {
          bot.sendMessage(chatId, "👤 እባክዎ መጀመሪያ /start በመጫን ይመዝገቡ።");
        }

      } else if (data === 'instruction') {
        bot.sendMessage(chatId, "💬 **የFast Keno ጨዋታ መመሪያ፦**\n\n1. ጨዋታውን ይክፈቱ (Play)\n2. ከ 1 እስከ 80 ካሉት ቁጥሮች እስከ 10 ቁጥሮች ይምረጡ\n3. የውርርድ መጠን (Stake) ወስነው BET ይጫኑ\n4. ሰርቨሩ በየ 60 ሰከንድ የሚያወጣቸውን 20 አሸናፊ ቁጥሮች ይጠብቁ\n5. ቁጥሮችዎ ሲገጥሙ በራስሰር አሸናፊ ይሆናሉ!", { parse_mode: "Markdown" });
      }
    } catch (err) {
      console.error('Callback query error:', err.message);
      bot.sendMessage(chatId, "ይቅርታ፣ ስህተት አጋጥሟል። እባክዎ እንደገና ይሞክሩ።");
    }

    // የአዝራሩን መጫን ማረጋገጫ (Loading እንዲቆም)
    bot.answerCallbackQuery(query.id);
  });

  return bot;
};
