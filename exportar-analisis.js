/**
 * Vuelca la tabla analisis_caso a data/analisis-semilla.json.
 *
 * El formato es el del antiguo triaje-cache.json: un objeto indexado
 * por id de caso, y cada valor es { analizado_en, resultado }.
 *
 * semilla.js carga ese fichero si existe, así que el despliegue
 * arranca con el triaje ya hecho. Para actualizarlo: node pretriaje.js
 * en local, luego node exportar-analisis.js, y push.
 *
 * Uso: node exportar-analisis.js
 */

const fs = require('fs');
const path = require('path');
const { DB_PATH, abrir } = require('./db');

const DESTINO = path.join(__dirname, 'data', 'analisis-semilla.json');

function exportarAnalisis() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`No hay base de datos en ${DB_PATH}.`);
  }

  const filas = abrir()
    .prepare(
      `SELECT caso_id, analizado_en, resultado
       FROM analisis_caso
       ORDER BY caso_id`
    )
    .all();

  if (filas.length === 0) {
    throw new Error('analisis_caso está vacía. No se ha escrito el fichero.');
  }

  const cache = {};
  for (const fila of filas) {
    cache[fila.caso_id] = {
      analizado_en: fila.analizado_en,
      resultado: JSON.parse(fila.resultado),
    };
  }

  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, `${JSON.stringify(cache, null, 2)}\n`);
  return filas.length;
}

if (require.main === module) {
  try {
    const n = exportarAnalisis();
    console.log(`Exportados ${n} análisis a ${DESTINO}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { exportarAnalisis, DESTINO };
