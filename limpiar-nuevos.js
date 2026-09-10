/**
 * Vuelve al estado semilla: vacía data/casos-nuevos.json y elimina de
 * data/triaje-cache.json las entradas de esos casos.
 *
 * Uso: node limpiar-nuevos.js
 */

const fs = require('fs');
const {
  CASOS_NUEVOS_PATH,
  vaciarCasosNuevos,
  recargarCasosNuevosDeDisco,
} = require('./crm');
const {
  cargarCacheDeDisco,
  guardarCacheEnDisco,
  recargarCacheDeDisco,
} = require('./triaje');

function main() {
  let ids = [];
  if (fs.existsSync(CASOS_NUEVOS_PATH)) {
    try {
      const arr = JSON.parse(fs.readFileSync(CASOS_NUEVOS_PATH, 'utf8'));
      if (Array.isArray(arr)) ids = arr.map((c) => c.id).filter(Boolean);
    } catch (err) {
      console.warn('No se pudo leer casos-nuevos.json:', err.message);
    }
  }

  vaciarCasosNuevos();
  recargarCasosNuevosDeDisco();

  const cache = cargarCacheDeDisco();
  let eliminadas = 0;
  for (const id of ids) {
    if (cache[id]) {
      delete cache[id];
      eliminadas += 1;
    }
  }
  guardarCacheEnDisco(cache);
  recargarCacheDeDisco();

  console.log(`casos-nuevos.json vaciado (${ids.length} caso(s) eliminado(s) del fichero).`);
  console.log(`triaje-cache.json: ${eliminadas} entrada(s) de triaje eliminada(s).`);
  console.log('Estado semilla restaurado. Reinicia el servidor si estaba en marcha.');
}

main();
