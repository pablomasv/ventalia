/**
 * Vuelve al estado de la semilla: borra data/ventalia.db y la vuelve a
 * cargar desde data/crm.json.
 *
 * Los casos creados después de la semilla, su actividad y los análisis
 * de analisis_caso desaparecen. Si data/analisis-semilla.json existe,
 * esos análisis se vuelven a cargar.
 *
 * Uso: node limpiar-nuevos.js
 */

const { reiniciar } = require('./reiniciar-db');

reiniciar();
