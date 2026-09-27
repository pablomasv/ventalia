/**
 * Vuelve al estado de la semilla: borra data/ventalia.db y la vuelve a
 * cargar desde data/crm.json.
 *
 * Los casos creados después de la semilla, su actividad y los análisis
 * de analisis_caso desaparecen. Si ya no está data/triaje-cache.json,
 * hay que repetir el pre-triaje (`node pretriaje.js`).
 *
 * Uso: node limpiar-nuevos.js
 */

const { reiniciar } = require('./reiniciar-db');

reiniciar();
