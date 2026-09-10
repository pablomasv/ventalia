/**
 * Script de pre-triaje. Se ejecuta a mano:
 *
 *   node pretriaje.js
 *
 * Analiza TODOS los casos abiertos (estado distinto de "Cerrado") con la
 * misma función que usa /api/analizar (analizarCaso), uno detrás de otro
 * (no en paralelo, para no saturar la API de OpenAI ni mezclar logs), y
 * guarda el resultado en /data/triaje-cache.json indexado por id de caso.
 *
 * El resultado de cada caso es la fuente única de verdad para el equipo
 * (Técnico/Postventa), la categoría y la prioridad: la cola de cada
 * agente y el panel de responsable leen de aquí, no de heurísticas por
 * palabras clave.
 *
 * Se analiza con rol "responsable" para no restringir el conocimiento
 * consultado por dominio: en este momento aún no sabemos a qué equipo
 * se va a enrutar el caso, así que el pre-triaje debe poder ver todo
 * el corpus antes de decidir el equipo.
 */

const { analizarCaso } = require('./analizar');
const { getCasosAbiertos } = require('./crm');
const { guardarCacheEnDisco, CACHE_PATH } = require('./triaje');

async function ejecutarPretriaje() {
  const casos = await getCasosAbiertos();
  console.log(`Casos abiertos encontrados: ${casos.length}\n`);

  const cache = {};
  const porEquipo = {};
  const porPrioridad = {};
  const sinCobertura = [];
  let errores = 0;

  for (const caso of casos) {
    process.stdout.write(`Analizando ${caso.id} — ${caso.asunto} ... `);

    try {
      const resultado = await analizarCaso(caso.id, 'responsable');

      cache[caso.id] = {
        analizado_en: new Date().toISOString(),
        resultado,
      };

      const equipo = resultado.triaje?.equipo || 'Sin equipo';
      const prioridad = resultado.triaje?.prioridad || 'Sin prioridad';

      porEquipo[equipo] = (porEquipo[equipo] || 0) + 1;
      porPrioridad[prioridad] = (porPrioridad[prioridad] || 0) + 1;

      if (!resultado.cubierto) {
        sinCobertura.push({
          id: caso.id,
          asunto: caso.asunto,
          motivo: resultado.motivo,
        });
      }

      console.log(`OK (equipo: ${equipo}, prioridad: ${prioridad}, cubierto: ${resultado.cubierto})`);
    } catch (error) {
      errores += 1;
      console.log(`ERROR: ${error.message}`);
    }
  }

  guardarCacheEnDisco(cache);

  console.log('\n=== Resumen del pre-triaje ===');
  console.log(`Total de casos abiertos: ${casos.length}`);
  console.log(`Analizados correctamente: ${Object.keys(cache).length}`);
  if (errores > 0) console.log(`Con error (no guardados en caché): ${errores}`);

  console.log('\nReparto por equipo propuesto:');
  for (const [equipo, n] of Object.entries(porEquipo)) {
    console.log(`  ${equipo}: ${n}`);
  }

  console.log('\nReparto por prioridad:');
  for (const [prioridad, n] of Object.entries(porPrioridad)) {
    console.log(`  ${prioridad}: ${n}`);
  }

  console.log(`\nCasos sin cobertura de conocimiento (${sinCobertura.length}):`);
  if (sinCobertura.length === 0) {
    console.log('  (ninguno)');
  } else {
    for (const c of sinCobertura) {
      console.log(`  - ${c.id} (${c.asunto}) → ${c.motivo}`);
    }
  }

  console.log(`\nCaché guardada en ${CACHE_PATH}`);
}

ejecutarPretriaje().catch((error) => {
  console.error('Error en el pre-triaje:', error.message);
  process.exit(1);
});
