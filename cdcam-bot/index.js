const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

//Notificacion de OneSignal

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// Grupo interno de notificaciones (Telegram) para compartir manualmente por WhatsApp

const GRUPO_NOTIFICACIONES_ID = process.env.GRUPO_NOTIFICACIONES_ID;

const NUMERO_WHATSAPP = process.env.NUMERO_WHATSAPP; // Número de WhatsApp para contacto en notificaciones

// --- WhatsApp Cloud API (notificaciones a compradores) ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED;
const WHATSAPP_TEMPLATE_OPTIN = process.env.WHATSAPP_TEMPLATE_OPTIN;
const WHATSAPP_TEMPLATE_RESUMEN = process.env.WHATSAPP_TEMPLATE_RESUMEN;

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

// Enviar notificación push cuando se publica algo nuevo
async function enviarNotificacionOneSignal(nombre, texto) {
  try {
    const response = await axios.post(
      'https://onesignal.com/api/v1/notifications',
      {
        app_id: ONESIGNAL_APP_ID,
        headings: { en: 'Nueva publicación en CDCAM' },
        contents: { en: `${nombre} publicó: ${texto}` },
        url: 'https://cdcam.co/publicaciones-campesinas-tiempo-real/#publicaciones-campesinas',
        included_segments: ['Total Subscriptions'],
        chrome_web_icon: 'https://cdcam.co/wp-content/uploads/2026/04/cropped-Logo-Cdcam1-1.png',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${ONESIGNAL_API_KEY}`,
        },
      }
    );
    console.log('Notificación OneSignal enviada. Respuesta:', JSON.stringify(response.data));
  } catch (err) {
    console.error('Error enviando notificación OneSignal:', err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

async function enviarNotificacionGrupoInterno(nombre, textoCompleto) {
  try {
    const textoConNumerosOcultos = maskPhones(textoCompleto);
    const nombreMostrar = nombre;

    const mensaje =
      `🌾 *NUEVO PRODUCTO DISPONIBLE - CDCAM*\n` +
      `_(Este WhatsApp es solo de notificaciones)_\n\n` +
      `👤 *Vendedor verificado:* ${nombreMostrar}\n` +
      `📋 *Detalle:* ${textoConNumerosOcultos}\n\n` +
      `📞 ¿Quieres más detalles o contactar al vendedor?\n` +
      `Escríbenos por WhatsApp al ${NUMERO_WHATSAPP} y con gusto te ayudamos.\n\n` +
      `🔗 *Ver publicación completa:*\n` +
      `https://cdcam.co/publicaciones-campesinas-tiempo-real/#publicaciones-campesinas`;

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: GRUPO_NOTIFICACIONES_ID,
      text: mensaje,
      // Sin parse_mode: se envía como texto plano
      // para que los * y _ sobrevivan al copiar/pegar en WhatsApp
    });

    console.log('Notificación enviada al grupo interno de Telegram.');
  } catch (err) {
    console.error('Error enviando al grupo interno:', err.response ? JSON.stringify(err.response.data) : err.message);
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

// ============================================================
// FUNCIONES DE WHATSAPP (invitación de opt-in y resumen diario)
// ============================================================

// Enviar plantilla de invitación (una sola vez, a un comprador que aún no ha aceptado)
async function enviarInvitacionOptIn(telefono, nombre) {
  if (WHATSAPP_ENABLED !== 'true') {
    console.log('WhatsApp desactivado (WHATSAPP_ENABLED != true). No se envía invitación.');
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'template',
        template: {
          name: WHATSAPP_TEMPLATE_OPTIN,
          language: { code: 'es' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: nombre || 'comprador' }] }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`Invitación de WhatsApp enviada a ${nombre} (${telefono})`);
  } catch (err) {
    console.error(`Error invitando a ${telefono}:`, err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

// Enviar resumen diario a todos los compradores que ya aceptaron (opted_in = true)
async function enviarResumenDiarioWhatsApp() {
  if (WHATSAPP_ENABLED !== 'true') {
    console.log('WhatsApp desactivado (WHATSAPP_ENABLED != true). No se envía resumen.');
    return;
  }

  try {
    // Fecha de "hoy" usando el mismo offset horario que ya usas para guardar publicaciones
    const ahora = new Date();
    const offsetMs = -5 * 60 * 60 * 1000;
    const fechaHoy = new Date(ahora.getTime() + offsetMs).toISOString().slice(0, 10);

    const resultPublicaciones = await pool.query(
      `SELECT nombre, text FROM publicaciones WHERE fecha = $1 ORDER BY created_at ASC`,
      [fechaHoy]
    );
    const publicaciones = resultPublicaciones.rows;

    if (publicaciones.length === 0) {
      console.log('No hubo publicaciones hoy, no se envía resumen de WhatsApp.');
      return;
    }

    const resultCompradores = await pool.query(
      `SELECT telefono, nombre FROM "compradores_CDCAM" WHERE opted_in = true`
    );
    const compradores = resultCompradores.rows;
    const cantidad = publicaciones.length;

    for (const c of compradores) {
      try {
        await axios.post(
          `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: c.telefono,
            type: 'template',
            template: {
              name: WHATSAPP_TEMPLATE_RESUMEN,
              language: { code: 'es' },
              components: [
                {
                  type: 'body',
                  parameters: [
                    { type: 'text', text: c.nombre || 'comprador' },
                    { type: 'text', text: String(cantidad) }
                  ]
                }
              ]
            }
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
      } catch (err) {
        console.error(`Error enviando resumen a ${c.telefono}:`, err.response ? JSON.stringify(err.response.data) : err.message);
      }
    }

    console.log(`Resumen diario de WhatsApp enviado a ${compradores.length} compradores (${cantidad} publicaciones hoy).`);
  } catch (err) {
    console.error('Error generando resumen diario de WhatsApp:', err.message);
  }
}

// ============================================================
// WEBHOOK DE TELEGRAM (ya existente)
// ============================================================

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

        await enviarNotificacionOneSignal(nombre, textoRecortado); // Notificacion de OneSignal

        await enviarNotificacionGrupoInterno(nombre, caption); // Notificacion al grupo interno para WhatsApp

        // Nota: ya NO se envía WhatsApp aquí por cada publicación individual.
        // El aviso a compradores se manda una vez al día como resumen (ver cron al final del archivo).

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

// ============================================================
// WEBHOOK DE WHATSAPP (verificación + respuestas de botones)
// ============================================================

// Verificación del webhook (Meta la llama una sola vez al configurar)
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recibir respuestas de botones (Sí/No) y textos (BAJA)
app.post('/webhook/whatsapp', async (req, res) => {
  res.status(200).send('ok');

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const mensaje = change?.value?.messages?.[0];
    if (!mensaje) return;

    const telefono = mensaje.from;
    const botonTexto = mensaje.button?.text || mensaje.interactive?.button_reply?.title || '';

    if (botonTexto) {
      if (botonTexto.toLowerCase().includes('sí') || botonTexto.toLowerCase().includes('si')) {
        await pool.query(`UPDATE "compradores_CDCAM" SET opted_in = true WHERE telefono = $1`, [telefono]);
        console.log(`Comprador ${telefono} aceptó (botón).`);
      } else if (botonTexto.toLowerCase().includes('no')) {
        await pool.query(`UPDATE "compradores_CDCAM" SET opted_in = false WHERE telefono = $1`, [telefono]);
        console.log(`Comprador ${telefono} rechazó (botón).`);
      }
      return;
    }

    const texto = mensaje.text?.body?.toLowerCase() || '';
    if (texto.includes('baja')) {
      await pool.query(`UPDATE "compradores_CDCAM" SET opted_in = false WHERE telefono = $1`, [telefono]);
      console.log(`Comprador ${telefono} se dio de baja (texto).`);
    }
  } catch (err) {
    console.error('Error procesando webhook de WhatsApp:', err.message);
  }
});

// Endpoint manual: enviar invitaciones a todos los que aún no han aceptado (usar una sola vez o cuando agregues compradores nuevos)
app.get('/enviar-invitaciones', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT telefono, nombre FROM "compradores_CDCAM" WHERE opted_in = false`
    );
    for (const c of result.rows) {
      await enviarInvitacionOptIn(c.telefono, c.nombre);
    }
    res.send(`Invitaciones enviadas a ${result.rows.length} compradores.`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Endpoint manual para forzar el envío del resumen ahora mismo (útil para pruebas)
app.get('/enviar-resumen-ahora', async (req, res) => {
  try {
    await enviarResumenDiarioWhatsApp();
    res.send('Resumen ejecutado. Revisa los logs para ver el detalle.');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Programar el resumen diario a las 5:00 PM hora Colombia
cron.schedule('0 17 * * *', () => {
  console.log('Ejecutando resumen diario de WhatsApp (5:00 PM)...');
  enviarResumenDiarioWhatsApp();
}, { timezone: 'America/Bogota' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});