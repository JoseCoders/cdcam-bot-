const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!TELEGRAM_TOKEN) {
  console.error('ERROR: TELEGRAM_TOKEN no está definido');
}
if (!WEBHOOK_SECRET) {
  console.error('ERROR: WEBHOOK_SECRET no está definido');
}
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL no está definido');
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;

// Pool de conexión a Supabase (PostgreSQL, session pooler IPv4)
const pool = new Pool({
  connectionString: DATABASE_URL, // ej: postgresql://postgres.ecqamfssdmqzljemakcp:TUPASS@aws-0-us-west-2.pooler.supabase.com:5432/postgres
  ssl: { rejectUnauthorized: false },
});

app.use(bodyParser.json());

// Enmascarar números
function maskPhones(texto) {
  if (!texto) return texto;

  const chars = texto.split('');
  const len = chars.length;
  const digitPositions = [];

  for (let i = 0; i < len; i++) {
    if (/\d/.test(chars[i])) {
      digitPositions.push(i);
    }
  }

  if (digitPositions.length < 10) return texto;

  const visibleCount = 6;
  for (let i = visibleCount; i < digitPositions.length; i++) {
    const idx = digitPositions[i];
    chars[idx] = '*';
  }

  return chars.join('');
}

// Recortar texto a 60 caracteres
function truncar(texto, max = 60) {
  if (!texto) return '';
  const masked = maskPhones(texto);
  return masked.length > max ? masked.slice(0, max) + '…' : masked;
}

// Mapa de avisos
const avisosPorUsuario = {};
const SIETE_HORAS_MS = 7 * 60 * 60 * 1000;

// Guardar publicación en Supabase
async function agregarItem(media_url, media_type, text, nombre, fecha, hora) {
  try {
    await pool.query(
      `INSERT INTO publicaciones (media_url, media_type, text, nombre, fecha, hora)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [media_url, media_type, text, nombre, fecha, hora]
    );
  } catch (err) {
    console.error('Error insertando publicación en BD:', err.message);
  }
}

// Obtener URL pública de un archivo Telegram
async function obtenerUrlArchivo(fileId) {
  if (!fileId) return '';

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

// ¿Toca enviar aviso?
function debeEnviarAviso(userId) {
  const ahora = Date.now();
  const ultimo = avisosPorUsuario[userId];

  if (!ultimo) {
    avisosPorUsuario[userId] = ahora;
    return true;
  }

  const diff = ahora - ultimo;

  if (diff >= SIETE_HORAS_MS) {
    avisosPorUsuario[userId] = ahora;
    return true;
  }

  return false;
}

// Webhook de Telegram
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  res.status(200).send('ok');

  const update = req.body;
  console.log('Update recibido:', JSON.stringify(update, null, 2));

  (async () => {
    try {
      if (!update.message || !update.message.chat) return;

      const chatId = update.message.chat.id;
      const from = update.message.from || {};
      const userId = from.id;

      const caption = update.message.caption || '';
      const tieneCaption = caption && caption.trim().length > 0;

      const tieneVideo = !!update.message.video;
      const tieneFoto =
        Array.isArray(update.message.photo) && update.message.photo.length > 0;

      if (tieneCaption && (tieneVideo || tieneFoto)) {
        let mediaUrl = '';
        let mediaType = '';

        if (tieneVideo) {
          const video = update.message.video;
          mediaUrl = await obtenerUrlArchivo(video.file_id);
          mediaType = 'video';
        } else if (tieneFoto) {
          const fotos = update.message.photo;
          const lastPhoto = fotos[fotos.length - 1];
          mediaUrl = await obtenerUrlArchivo(lastPhoto.file_id);
          mediaType = 'photo';
        }

        if (!mediaUrl) {
          return;
        }

        const textoRecortado = truncar(caption, 60);

        let nombre = from.first_name || 'Prod';
        nombre = nombre.toString().slice(0, 4);

        const timestampMs = update.message.date
          ? update.message.date * 1000
          : Date.now();

        const offsetMs = -5 * 60 * 60 * 1000;
        const localMs = timestampMs + offsetMs;
        const d = new Date(localMs);

        const fecha = d.toISOString().slice(0, 10);
        const hora = d.toTimeString().slice(0, 5);

        await agregarItem(
          mediaUrl,
          mediaType,
          textoRecortado,
          nombre,
          fecha,
          hora
        );

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Producto publicado en CDCAM.CO correctamente ✅',
        });

        return;
      }

      if (userId && debeEnviarAviso(userId)) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Para publicar Producto en CDCAM envía una IMAGEN con el TEXTO en el mismo mensaje.',
        });
      }
    } catch (err) {
      console.error('Error al procesar update:', err.message);
    }
  })();
});

// Endpoint para WordPress: últimos 50 items desde Supabase
app.get('/api/ultimos-items', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT media_url, media_type, text, nombre, fecha, hora
       FROM publicaciones
       ORDER BY created_at DESC
       LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error consultando publicaciones en BD:', err.message);
    res.json([]);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
