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

// Enmascarar números: si encuentra una secuencia con >=10 dígitos totales,
// deja los primeros 6 dígitos visibles y el resto los reemplaza por '*'.
function maskPhones(texto) {
  if (!texto) return texto;

  const chars = texto.split('');
  const len = chars.length;
  const digitPositions = [];

  // Guardar posiciones de todos los dígitos
  for (let i = 0; i < len; i++) {
    if (/\d/.test(chars[i])) {
      digitPositions.push(i);
    }
  }

  // Si hay menos de 10 dígitos en todo el texto, no hacemos nada
  if (digitPositions.length < 10) return texto;

  // Mantenemos visibles solo los primeros 6 dígitos; el resto se enmascara
  const visibleCount = 6;
  for (let i = visibleCount; i < digitPositions.length; i++) {
    const idx = digitPositions[i];
    chars[idx] = '*';
  }

  return chars.join('');
}

// Función para recortar texto a 60 caracteres, aplicando primero el enmascarado
function truncar(texto, max = 60) {
  if (!texto) return '';
  const masked = maskPhones(texto);
  return masked.length > max ? masked.slice(0, max) + '…' : masked;
}

// Lista en memoria de los últimos posts válidos (media + texto)
// Cada item: { media_url, media_type, text, nombre, fecha, hora }
let items = [];

// Mapa en memoria: último timestamp (ms) en que se le mostró el aviso a cada usuario
// Clave: userId (from.id)
const avisosPorUsuario = {};
const SIETE_HORAS_MS = 7 * 60 * 60 * 1000; // 7 horas en milisegundos

// Añadir un nuevo item y mantener máximo 50
function agregarItem(media_url, media_type, text, nombre, fecha, hora) {
  items.unshift({ media_url, media_type, text, nombre, fecha, hora }); // más reciente primero
  if (items.length > 50) {
    items.pop(); // elimina el más viejo
  }
}

// Obtener URL pública de un archivo (foto o video) desde Telegram
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

// ¿Toca enviar aviso a este usuario ahora?
function debeEnviarAviso(userId) {
  const ahora = Date.now();
  const ultimo = avisosPorUsuario[userId];

  // Nunca se ha enviado → sí se envía y se registra ahora
  if (!ultimo) {
    avisosPorUsuario[userId] = ahora;
    return true;
  }

  const diff = ahora - ultimo; // ms desde el último aviso

  if (diff >= SIETE_HORAS_MS) {
    // Pasaron 7 horas o más → se permite de nuevo y actualizamos timestamp
    avisosPorUsuario[userId] = ahora;
    return true;
  }

  // Todavía no han pasado 7 horas → no enviar aviso
  return false;
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
      const from = update.message.from || {};
      const userId = from.id; // ID único del usuario

      const caption = update.message.caption || '';
      const tieneCaption = caption && caption.trim().length > 0;

      const tieneVideo = !!update.message.video;
      const tieneFoto =
        Array.isArray(update.message.photo) && update.message.photo.length > 0;

      // Prioridad: video + caption, luego foto + caption
      if (tieneCaption && (tieneVideo || tieneFoto)) {
        let mediaUrl = '';
        let mediaType = '';

        if (tieneVideo) {
          // Priorizar video
          const video = update.message.video;
          mediaUrl = await obtenerUrlArchivo(video.file_id);
          mediaType = 'video';
        } else if (tieneFoto) {
          // Si no hay video, usar foto (última, de mayor resolución)
          const fotos = update.message.photo;
          const lastPhoto = fotos[fotos.length - 1];
          mediaUrl = await obtenerUrlArchivo(lastPhoto.file_id);
          mediaType = 'photo';
        }

        if (!mediaUrl) {
          // Algo falló al obtener la URL, no guardamos ni respondemos
          return;
        }

        // Enmascarar y recortar texto a 60 caracteres
        const textoRecortado = truncar(caption, 60);

        // Nombre (solo las primeras 4 letras)
        let nombre = from.first_name || 'Prod';
        nombre = nombre.toString().slice(0, 4); // ej: "Camilo" -> "Cami"

        const timestampMs = update.message.date
          ? update.message.date * 1000
          : Date.now();

        // Ajustar a zona horaria Colombia (UTC-5)
        const offsetMs = -5 * 60 * 60 * 1000; // -5 horas
        const localMs = timestampMs + offsetMs;
        const d = new Date(localMs);

        const fecha = d.toISOString().slice(0, 10); // 2026-03-12
        const hora = d.toTimeString().slice(0, 5);  // 10:58

        // Guardar en la lista de items
        agregarItem(mediaUrl, mediaType, textoRecortado, nombre, fecha, hora);

        // Respuesta al usuario (publicación correcta)
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Producto publicado en CDCAM.CO correctamente ✅',
        });

        // IMPORTANTE: return aquí para que NO siga procesando nada más en este update
        return;
      }

      // Si llega aquí es porque NO cumplió las condiciones (mensaje inválido)
      if (userId && debeEnviarAviso(userId)) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Para publicar Producto en CDCAM envía una IMAGEN con el TEXTO en el mismo mensaje.',
        });
      }
      // Si NO toca avisar (menos de 7 horas), no respondemos nada

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
