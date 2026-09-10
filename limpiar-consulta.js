/**
 * Limpieza determinista de consultas de búsqueda.
 *
 * Elimina cortesías y fórmulas vacías que no aportan señal semántica
 * al embedding, sin llamar a ningún modelo ni reformular el texto.
 *
 * Regla clave: todos los patrones están anclados al inicio (^) o al final ($)
 * del texto restante. Nunca se toca una coincidencia en medio de una frase.
 */

const PATRONES_INICIO = [
  { patron: /^Muy señores míos[,.]?\s*/i, etiqueta: 'Muy señores míos' },
  { patron: /^Buenos días[,.]?\s*/i, etiqueta: 'Buenos días' },
  { patron: /^Buenas tardes[,.]?\s*/i, etiqueta: 'Buenas tardes' },
  { patron: /^Buenas noches[,.]?\s*/i, etiqueta: 'Buenas noches' },
  { patron: /^Estimados[,.]?\s*/i, etiqueta: 'Estimados' },
  { patron: /^Estimada[,.]?\s*/i, etiqueta: 'Estimada' },
  { patron: /^Estimado[,.]?\s*/i, etiqueta: 'Estimado' },
  { patron: /^Hola[,.]?\s*/i, etiqueta: 'Hola' },
];

const PATRONES_FINAL = [
  { patron: /\s*Quedamos a la espera[,.]?\s*$/i, etiqueta: 'Quedamos a la espera' },
  { patron: /\s*Quedo a la espera[,.]?\s*$/i, etiqueta: 'Quedo a la espera' },
  { patron: /\s*Saludos cordiales[,.]?\s*$/i, etiqueta: 'Saludos cordiales' },
  { patron: /\s*Muchas gracias[,.]?\s*$/i, etiqueta: 'Muchas gracias' },
  { patron: /\s*Atentamente[,.]?\s*$/i, etiqueta: 'Atentamente' },
  { patron: /\s*Un saludo[,.]?\s*$/i, etiqueta: 'Un saludo' },
  { patron: /\s*Saludos[,.]?\s*$/i, etiqueta: 'Saludos' },
  { patron: /\s*Gracias[,.]?\s*$/i, etiqueta: 'Gracias' },
];

const PATRONES_PETICION = [
  { patron: /^¿nos podéis orientar\?[,.]?\s*/i, etiqueta: '¿nos podéis orientar?' },
  { patron: /^¿nos pueden ayudar\?[,.]?\s*/i, etiqueta: '¿nos pueden ayudar?' },
  { patron: /^agradeceríamos su ayuda[,.]?\s*/i, etiqueta: 'agradeceríamos su ayuda' },
  { patron: /\s*¿nos podéis orientar\?[,.]?\s*$/i, etiqueta: '¿nos podéis orientar?' },
  { patron: /\s*¿nos pueden ayudar\?[,.]?\s*$/i, etiqueta: '¿nos pueden ayudar?' },
  { patron: /\s*agradeceríamos su ayuda[,.]?\s*$/i, etiqueta: 'agradeceríamos su ayuda' },
];

function aplicarPatronesAnclados(texto, patrones) {
  let limpio = texto;
  const eliminados = [];
  let huboCambio = true;

  while (huboCambio) {
    huboCambio = false;

    for (const { patron, etiqueta } of patrones) {
      const coincidencia = limpio.match(patron);
      if (!coincidencia) continue;

      eliminados.push(coincidencia[0].trim() || etiqueta);
      limpio = limpio.replace(patron, '').trim();
      huboCambio = true;
      break;
    }
  }

  return { texto: limpio, eliminados };
}

function limpiarConsulta(texto) {
  if (!texto || typeof texto !== 'string') {
    return { texto: '', eliminados: [] };
  }

  let limpio = texto.trim();
  const eliminados = [];

  for (const patrones of [PATRONES_INICIO, PATRONES_FINAL, PATRONES_PETICION]) {
    const resultado = aplicarPatronesAnclados(limpio, patrones);
    limpio = resultado.texto;
    eliminados.push(...resultado.eliminados);
  }

  limpio = limpio.replace(/\s{2,}/g, ' ').trim();

  return { texto: limpio, eliminados };
}

module.exports = { limpiarConsulta };
