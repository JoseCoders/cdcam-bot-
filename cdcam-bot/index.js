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

// Lista en memoria de los últimos posts válidos (foto + texto)
let items = []; // { image_url, text }

// Añadir un nuevo item y mantener máximo 50
function agregarItem(image_url, text) {
  items.unshift({ image_url, text }); // más reciente primero
  if (items.length > 50) {
    items.pop(); // elimina el más viejo
  }
}

// Obtener URL pública de la foto desde Telegram
async function obtenerUrlFoto(photoArray) {
  if (!photoArray || !Array.isArray(photoArray) || photoArray.length === 0) {
    return '';
  }

  const fileId = photoArray[photoArray.length - 1].file_id;

  const resp = await axios.get(`${TELEGRAM_API}/getFile`, {
    params: { file_id: fileId },
  });

  if (!resp.data.ok) {
    console.error('Error en getFile:', resp.data);
    return '';
  }

  const filePath = resp.data.result.file_path;
  const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
  return fileUrl;
}

// Webhook de Telegram
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  // Responder rápido a Telegram
  res.status(200).send('ok');

  const update = req.body;
  console.log('Update recibido:', JSON.stringify(update, null, 2));

  (async () => {
    try {
      if (!update.message || !update.message.chat) return;

      const chatId = update.message.chat.id;

      // Solo aceptamos: foto + caption (texto en el mismo mensaje)
      if (update.message.photo && update.message.caption) {
        const fotoUrl = await obtenerUrlFoto(update.message.photo);
        const caption = update.message.caption;
        const textoRecortado = truncar(caption, 60);

        // Guardar en la lista de items
        agregarItem(fotoUrl, textoRecortado);

        // Respuesta al usuario
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Producto publicado en CDCAM correctamente ✅',
        });
      } else {
        // Opcional: responder que el formato no es válido
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Para publicar en CDCAM envía una FOTO con el texto en el mismo mensaje.',
        });
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
