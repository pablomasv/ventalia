/**
 * Flujo de alta asistida (portal público), distinto de analizar.js:
 * trabaja sobre texto suelto + producto, sin caso CRM todavía.
 * Recupera Corpus y, si hay cobertura, pide al modelo solo las
 * preguntas de datos que exige la documentación y que faltan en la
 * descripción del cliente (máx. 3).
 */

require('dotenv').config();

const { buscar } = require('./buscar');
const { getProducto } = require('./crm');

const MODELO_CHAT = 'gpt-4o';
const MAX_PREGUNTAS = 3;

const PROMPT_ALTA = `Eres un asistente del portal de soporte de Ventalia. Un cliente ha
escrito la descripción libre de un problema y se han recuperado fragmentos
de la base de conocimiento (CONOCIMIENTO_CORPUS).

Tu ÚNICA tarea: identificar qué datos exige esa documentación para poder
diagnosticar o tramitar el caso, cuáles de esos datos NO están presentes
en la descripción del cliente, y redactar una pregunta clara para cada
uno, con el fuente_id del fragmento que lo exige.

Responde ÚNICAMENTE con un JSON válido:
{
  "preguntas": [
    {
      "pregunta": string,
      "porque": string,
      "fuente_id": string
    }
  ]
}

Reglas:
- Como máximo ${MAX_PREGUNTAS} preguntas. Si faltan más datos, prioriza los
  más críticos para el diagnóstico o la tramitación.
- "fuente_id" debe ser EXACTAMENTE el fuente_id de un fragmento de
  CONOCIMIENTO_CORPUS (formato "documento#seccion"). Si no puedes anclar
  una pregunta a un fragmento recuperado, no la incluyas.
- No pidas datos que ya estén claramente en la descripción del cliente.
- No inventes procedimientos ni plazos que no aparezcan en los fragmentos.
- Si la documentación recuperada no exige ningún dato adicional ausente
  en la descripción, devuelve "preguntas": [].
- Redacta las preguntas en español, dirigidas al cliente, en tono
  profesional y breve.`;

function formatearCorpusAlta(fragmentos) {
  const lineas = ['=== CONOCIMIENTO_CORPUS ==='];
  for (const f of fragmentos) {
    lineas.push('');
    lineas.push(`fuente_id: ${f.id}`);
    lineas.push(`Título: ${f.titulo}`);
    lineas.push(`Sección: ${f.encabezado}`);
    lineas.push(f.texto);
  }
  return lineas.join('\n');
}

function validarPreguntas(preguntas, fragmentos) {
  const ids = new Set(fragmentos.map((f) => f.id));
  const validas = [];

  for (const p of preguntas || []) {
    if (!p || !p.pregunta || !p.fuente_id) continue;
    if (!ids.has(p.fuente_id)) {
      console.warn(
        `[alta-asistida] Pregunta descartada: fuente_id no recuperado ("${p.fuente_id}")`
      );
      continue;
    }
    validas.push({
      pregunta: String(p.pregunta).trim(),
      porque: p.porque ? String(p.porque).trim() : '',
      fuente_id: p.fuente_id,
    });
    if (validas.length >= MAX_PREGUNTAS) break;
  }

  return validas;
}

async function llamarModeloPreguntas(descripcion, producto, fragmentos) {
  const bloqueCorpus = formatearCorpusAlta(fragmentos);
  const userContent = [
    `Producto: ${producto.referencia} — ${producto.nombre} (gama ${producto.gama})`,
    '',
    'Descripción del cliente:',
    descripcion,
    '',
    bloqueCorpus,
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODELO_CHAT,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT_ALTA },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const detalle = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${detalle}`);
  }

  const data = await response.json();
  const texto = data.choices?.[0]?.message?.content;
  if (!texto) throw new Error('OpenAI no devolvió contenido');
  return JSON.parse(texto);
}

/**
 * Análisis previo a la creación del caso.
 * @returns {{ cubierto, motivo, mejorPuntuacion, consulta, preguntas, fragmentos }}
 */
async function analizarAlta(descripcion, productoId) {
  const producto = await getProducto(productoId);
  if (!producto) {
    const error = new Error(`Producto no encontrado: ${productoId}`);
    error.status = 404;
    throw error;
  }

  const texto = String(descripcion || '').trim();
  if (!texto) {
    const error = new Error('Falta la descripción del problema');
    error.status = 400;
    throw error;
  }

  const consulta = `${texto} ${producto.referencia} ${producto.gama}`;
  console.log('[alta-asistida] Consulta de búsqueda:', consulta);

  // Rol null: el cliente del portal no tiene dominio técnico/postventa.
  const resultadoBusqueda = await buscar(consulta, producto.referencia, {
    dominioRol: null,
  });

  const base = {
    cubierto: resultadoBusqueda.motivo === 'cubierto',
    motivo: resultadoBusqueda.motivo,
    mejorPuntuacion: resultadoBusqueda.mejorPuntuacion,
    consulta,
    producto: {
      id: producto.id,
      referencia: producto.referencia,
      nombre: producto.nombre,
      gama: producto.gama,
    },
    fragmentos: (resultadoBusqueda.fragmentos || []).map((f) => ({
      id: f.id,
      titulo: f.titulo,
      encabezado: f.encabezado,
      puntuacion: f.puntuacion,
    })),
    preguntas: [],
  };

  if (resultadoBusqueda.motivo !== 'cubierto') {
    console.log('[alta-asistida] Sin cobertura — no se piden datos adicionales');
    return base;
  }

  const propuesta = await llamarModeloPreguntas(
    texto,
    producto,
    resultadoBusqueda.fragmentos
  );
  const preguntas = validarPreguntas(propuesta.preguntas, resultadoBusqueda.fragmentos);

  console.log(`[alta-asistida] Preguntas a mostrar: ${preguntas.length}`);
  return { ...base, preguntas };
}

module.exports = {
  analizarAlta,
  MAX_PREGUNTAS,
};
