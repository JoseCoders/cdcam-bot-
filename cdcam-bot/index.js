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
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;

app.use(bodyParser.json());

// Función para recortar texto a 60 caracteres
function truncar(texto, max = 60) {
  if (!texto) return '';
  return texto.length > max ? texto.slice(0, max) + '…' : texto;
}

// Aquí guardamos en memoria los últimos mensajes (imagen + texto)
let items = []; // cada item: { image_url, text }

// Añadir un nuevo item y mantener máximo 50
function agregarItem(image_url, text) {
  items.unshift({ image_url, text }); // agrega al inicio (más reciente primero)
  if (items.length > 50) {
    items.pop(); // elimina el más viejo
  }
}

// Función para obtener URL pública del archivo (foto) de Telegram
async function obtenerUrlFoto(photoArray) {
  if (!photoArray || !Array.isArray(photoArray) || photoArray.length === 0) {
    return '';
  }

  // Tomamos la última (normalmente la de mayor resolución)
  const fileId = photoArray[photoArray.length - 1].file_id;

  // 1) Pedir info del archivo
  const resp = await axios.get(`${TELEGRAM_API}/getFile`, {
    params: { file_id: fileId },
  });

  if (!resp.data.ok) {
    console.error('Error en getFile:', resp.data);
    return '';
  }

  const filePath = resp.data.result.file_path;
  // 2) Construir URL pública de descarga
  const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

  return fileUrl;
}

// Webhook de Telegram
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  // Responder inmediatamente a Telegram
  res.status(200).send('ok');

  const update = req.body;
  console.log('Update recibido:', JSON.stringify(update, null, 2));

  (async () => {
    try {
      if (update.message && update.message.chat) {
        const chatId = update.message.chat.id;

        // Caso 1: foto + caption
        if (update.message.photo) {
          const fotoUrl = await obtenerUrlFoto(update.message.photo);
          const caption = update.message.caption || '';
          const textoRecortado = truncar(caption, 60);

          agregarItem(fotoUrl, textoRecortado);

          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: 'Imagen y texto recibidos por el webhook ✅',
          });

        // Caso 2: solo texto
        } else if (update.message.text) {
          const texto = update.message.text;
          const textoRecortado = truncar(texto, 60);

          // Sin foto, usamos una imagen por defecto
          const imageUrlPorDefecto = 'https://cdcam.co/wp-content/uploads/default.jpg';

          agregarItem(imageUrlPorDefecto, textoRecortado);

          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: 'Mensaje recibido por el webhook ✅',
          });
        }
      }
    } catch (err) {
      console.error('Error al procesar update:', err.message);
    }
  })();
});

// Endpoint para WordPress: devuelve lista de items (máx 50)
app.get('/api/ultimos-items', (req, res) => {
  res.json(items);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
