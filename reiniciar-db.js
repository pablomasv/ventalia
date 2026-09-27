/**
 * Borra data/ventalia.db y vuelve a sembrarla desde data/crm.json.
 * Es el estado de partida: los casos creados después, su actividad y
 * los análisis guardados desaparecen.
 *
 * Si data/analisis-semilla.json existe, la semilla vuelve a copiar
 * esos análisis. Si no, y queda data/triaje-cache.json, usa ese.
 *
 * Uso: node reiniciar-db.js
 */

const fs = require('fs');
const { DB_PATH, cerrar } = require('./db');
const { sembrar } = require('./semilla');

function borrarBase() {
  cerrar();
  for (const sufijo of ['', '-wal', '-shm', '-journal']) {
    const archivo = DB_PATH + sufijo;
    if (fs.existsSync(archivo)) fs.unlinkSync(archivo);
  }
}

function reiniciar() {
  borrarBase();
  sembrar();
  console.log('Base reiniciada al estado de la semilla.');
}

if (require.main === module) {
  try {
    reiniciar();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { reiniciar, borrarBase };
