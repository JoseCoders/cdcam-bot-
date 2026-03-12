const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!TELEGRAM_TOKEN) {
  console.error('ERROR: TELEGRAM_TOKEN no está definido');
}
if (!WEBHOOK_SECRET) {
  console.error('ERROR: WEBHOOK_SECRET no está definido');
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

app.use(bodyParser.json());

// Función para recortar texto a 60 caracteres
function truncar(texto, max = 60) {
  if (!texto) return '';
  return texto.length > max ? texto.slice(0, max) + '…' : texto;
}

// Aquí guardamos en memoria el último mensaje
let ultimoItem = {
  image_url: 'https://tusitio.com/wp-content/uploads/default.jpg', // cámbiala por la que quieras
  text: ''
};

// Webhook de Telegram
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  // Responder inmediatamente a Telegram
  res.status(200).send('ok');

  const update = req.body;
  console.log('Update recibido:', JSON.stringify(update, null, 2));

  (async () => {
    try {
      if (update.message && update.message.chat && update.message.text) {
        const chatId = update.message.chat.id;
        const texto = update.message.text;

        // Guardar versión recortada para la web (máx 60 caracteres)
        ultimoItem.text = truncar(texto, 60);

        // (Opcional) si en algún momento quieres que la imagen dependa del mensaje,
        // aquí podrías cambiar ultimoItem.image_url.

        // Respuesta al usuario en Telegram
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Mensaje recibido por el webhook ✅',
        });
      }
    } catch (err) {
      console.error('Error al procesar update:', err.message);
    }
  })();
});

// Endpoint para WordPress: devuelve solo imagen + texto (máx 60 chars)
app.get('/api/ultimo-item', (req, res) => {
  res.json(ultimoItem);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
