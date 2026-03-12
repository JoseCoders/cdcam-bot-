const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

app.use(bodyParser.json());

// Endpoint del webhook (seguro por secreto en la URL)
app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  // Responder rápido a Telegram
  res.send('ok');

  const update = req.body;
  console.log('Update recibido:', JSON.stringify(update, null, 2));

  try {
    if (update.message && update.message.chat && update.message.text) {
      const chatId = update.message.chat.id;
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: 'Mensaje recibido por el webhook ✅',
      });
    }
  } catch (err) {
    console.error('Error al procesar update:', err.message);
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
