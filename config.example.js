// Copia este fichero a config.js y ajusta los valores.
// config.js esta en .gitignore: nunca subas credenciales al repositorio.
module.exports = {
  host: 'db',
  user: 'palabrejo_user',
  password: 'cambia-esta-password',
  database: 'palabrejo_db',
  // Opcional: ID de cliente OAuth de Google (consola de Google Cloud, tipo
  // "aplicacion web", con este dominio en los origenes autorizados). Si se
  // deja vacio, el boton de "Continuar con Google" no se muestra.
  // Tambien se puede dar por la variable de entorno GOOGLE_CLIENT_ID.
  googleClientId: '',

  // Opcional: aplicacion registrada en Microsoft Entra ID (portal de Azure >
  // "Registros de aplicaciones"), con la URL de vuelta
  // https://TU-DOMINIO/api/auth/microsoft/callback como plataforma "Web".
  // Variables de entorno equivalentes: MICROSOFT_CLIENT_ID,
  // MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT.
  microsoftClientId: '',
  microsoftClientSecret: '',
  // 'common' admite cuentas personales (Outlook/Hotmail) y de organizacion
  microsoftTenant: 'common',

  // Solo si el servidor esta detras de un proxy que cambia el host y la URL de
  // vuelta no coincide con la registrada. Entorno: APP_BASE_URL.
  baseUrl: ''
};
