// Genera el QR de invitacion en local (issue #4): se acabó la API externa
// (api.qrserver.com) que mandaba la URL de la sala fuera del servidor, a un
// tercero. El QR sale de 'qrcode' (npm) dentro del propio contenedor.
// Cae bajo el rate-limit generico de '/api/*' (server.js, issue #3): es un
// generador de URLs que cualquiera podria usar de servicio de spam si no.
const QRCode = require('qrcode');

// La URL de join no pasa de ~60 caracteres; cualquier cosa mas larga no es
// una invitacion. Limite generoso pero corto, para no invitar a abusar.
const QR_MAX_DATA_LENGTH = 200;

function registerQrRoutes(app) {
    app.get('/api/qr', async (req, res) => {
        const data = typeof req.query.data === 'string' ? req.query.data : '';
        if (!data || data.length > QR_MAX_DATA_LENGTH) {
            return res.status(400).json({ error: 'Parámetro data requerido (la URL de la sala a codificar).' });
        }

        try {
            const buffer = await QRCode.toBuffer(data, { width: 300, margin: 2, errorCorrectionLevel: 'M' });
            res.type('image/png').send(buffer);
        } catch (error) {
            console.error('Error generando QR:', error);
            res.status(500).json({ error: 'No se pudo generar el QR.' });
        }
    });
}

module.exports = { registerQrRoutes, QR_MAX_DATA_LENGTH };