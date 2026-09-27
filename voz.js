/**
 * Endpoints para el agente de voz (ElevenLabs).
 *
 * No reutiliza /api/analizar: esa respuesta (fragmentos, puntuaciones,
 * afirmaciones, borrador) no se puede leer por teléfono y tarda
 * demasiado. Aquí cada respuesta lleva un campo `hablado` de como
 * mucho dos frases. Fuentes, puntuaciones e ids viajan aparte, para
 * registro, no para leerse.
 *
 * La consulta de /api/voz/consultar llega ya destilada por el modelo
 * de la conversación, no como transcripción literal. limpiarConsulta()
 * se aplica igual, como red de seguridad, sin asumir saludos ni
 * muletillas.
 *
 * Segunda recuperación: NO. A diferencia de analizar.js, este módulo
 * no lanza la búsqueda extra de política comercial (márgenes,
 * segmentos, gestos). Es una decisión de permisos: quien llama es un
 * instalador, cliente externo, y no puede ver esa información. Si
 * pregunta por una excepción comercial, no hay nada que recuperar.
 * Los fragmentos de `politica-segmentacion` que pudieran colarse en
 * la búsqueda única también se descartan por el mismo motivo.
 */

require('dotenv').config();

const crypto = require('crypto');
const { abrir } = require('./db');
const { limpiarConsulta } = require('./limpiar-consulta');
const { buscar, fragmentosDelDocumento } = require('./buscar');
const { mesesDesdeEntrega } = require('./cobertura');
const { crearCaso, getProducto } = require('./crm');
const { analizarYPersistir } = require('./triaje');

const MODELO_CHAT = 'gpt-4o';
const OBJETIVO_MS = 1500;
const DOCUMENTO_COMERCIAL = 'politica-segmentacion';
const MIN_PALABRAS_SIGNIFICATIVAS = 3;
const PREGUNTA_SINTOMA = '¿Puede describir el síntoma con más detalle?';

// Artículos, preposiciones, conjunciones y pronombres. No cuentan como
// señal para decidir si la consulta es demasiado corta.
const PALABRAS_VACIAS = new Set([
  'a', 'al', 'ante', 'aquel', 'aquella', 'aquellas', 'aquello', 'aquellos',
  'bajo', 'con', 'contra', 'de', 'del', 'desde', 'durante',
  'e', 'el', 'ella', 'ellas', 'ello', 'ellos', 'en', 'entre', 'esa', 'esas',
  'ese', 'eso', 'esos', 'esta', 'estas', 'este', 'esto', 'estos',
  'hacia', 'hasta', 'la', 'las', 'le', 'les', 'lo', 'los',
  'me', 'mediante', 'mi', 'mis', 'nos', 'nuestra', 'nuestras', 'nuestro', 'nuestros',
  'ni', 'o', 'os', 'para', 'por', 'que', 'se', 'segun', 'si', 'sin', 'sobre',
  'su', 'sus', 'te', 'tras', 'tu', 'tus', 'un', 'una', 'unas', 'uno', 'unos', 'y',
]);

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const DIGITOS = {
  0: 'cero',
  1: 'uno',
  2: 'dos',
  3: 'tres',
  4: 'cuatro',
  5: 'cinco',
  6: 'seis',
  7: 'siete',
  8: 'ocho',
  9: 'nueve',
};

const PROMPT_VOZ = `Eres el soporte técnico de Ventalia, hablando por teléfono con un instalador.
Responde ÚNICAMENTE con un JSON válido:
{
  "hablado": string,
  "falta_dato": string | null
}

"hablado": una o dos frases, español oral, sin listas, sin markdown y sin leer nombres de documento ni identificadores.
"falta_dato": o null, o la misma pregunta que "hablado". Nunca una etiqueta, nunca un diagnóstico, nunca una categoría técnica ("aerodinámico", "desequilibrio" y similares).

Procedimiento, en este orden:
1. Anota lo que la consulta ya dice, aunque use otras palabras. "Al arrancar", "cuando arranca" o "al ponerse en marcha" ya responden si el problema se concentra en el arranque. "Por las mañanas" ya dice el momento del día.
2. En los fragmentos, localiza las condiciones que distinguen una causa de otra y la lista de datos que exigen para cerrar el diagnóstico. Tacha todo lo que el paso 1 ya cubre.
3. Si tras tachar queda algún dato exigido, "falta_dato" es la pregunta por el primero que falte, en el orden de los fragmentos. No te saltes a uno posterior. No preguntes una condición ya tachada, ni la confirmes, ni la ofrezcas como opción ("¿solo al arrancar o también en continuo?" está prohibido si la consulta ya dice "al arrancar").
4. Si no queda ningún dato exigido, "falta_dato" es null y "hablado" es la orientación, sin pregunta. No pidas que el cliente confirme la descripción del manual. No vale repetir la consulta ("eso ya lo tenemos claro") sin orientar.
5. Si la consulta no trae la condición que distingue varias causas, no elijas. La pregunta es esa condición, en términos observables (qué se oye, qué marca un indicador, cuántas horas lleva).

No inventes procedimientos, plazos ni cifras que no estén en los fragmentos. No menciones márgenes, segmentos ni gestos comerciales.

Ejemplo de la regla, no lo copies si los fragmentos piden otra cosa:
- Consulta "vibra al arrancar" y los fragmentos piden horas de funcionamiento después de saber si ocurre al arranque: "falta_dato" pregunta las horas, no vuelve a preguntar el arranque.
- Consulta que ya trae todos los datos que los fragmentos exigen: "falta_dato" es null y "hablado" responde.`;

function tokensIguales(recibido, esperado) {
  if (!recibido || !esperado) return false;
  const a = Buffer.from(String(recibido));
  const b = Buffer.from(String(esperado));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function tokenDeLaPeticion(req) {
  const autorizacion = req.get('authorization') || '';
  if (autorizacion.toLowerCase().startsWith('bearer ')) {
    return autorizacion.slice(7).trim();
  }
  return '';
}

function medir(nombre, handler, objetivoMs = OBJETIVO_MS) {
  return async (req, res) => {
    const inicio = process.hrtime.bigint();
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status || 500;
      if (!res.headersSent) {
        res.status(status).json({ error: error.message });
      }
    } finally {
      const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
      const lento = ms > objetivoMs ? ` — por encima de ${objetivoEnLog(objetivoMs)}` : '';
      console.log(`[voz] ${nombre} ${Math.round(ms)} ms${lento}`);
    }
  };
}

function objetivoEnLog(ms) {
  const segundos = ms / 1000;
  return `${String(segundos).replace('.', ',')} s`;
}

function aLoSumoDosFrases(texto) {
  const limpio = String(texto || '')
    .replace(/[*_`#]/g, '')
    .replace(/S\.\s*L\./gi, 'SL')
    .replace(/S\.\s*A\./gi, 'SA')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio) return '';
  const partes = limpio.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [limpio];
  let unido = partes
    .map((parte) => parte.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  if (unido && !/[.!?]$/.test(unido)) unido += '.';
  return unido;
}

function nombreParaVoz(nombre) {
  return String(nombre || '')
    .replace(/\s+S\.\s*L\.?/gi, '')
    .replace(/\s+S\.\s*A\.?/gi, '')
    .trim();
}

function normalizarReferencia(valor) {
  return String(valor || '')
    .toUpperCase()
    .replace(/[\s._]/g, '')
    .replace(/[-–—−]/g, '');
}

function mesYAnio(fechaIso) {
  const [anio, mes] = String(fechaIso || '').split('-');
  const nombre = MESES[Number(mes) - 1];
  if (!anio || !nombre) return null;
  return `${nombre} de ${anio}`;
}

function tipoProductoHablado(nombre) {
  const primera = String(nombre || '')
    .trim()
    .split(/\s+/)[0];
  return primera ? primera.toLocaleLowerCase('es') : 'equipo';
}

function dictarReferencia(id) {
  const coincidencia = String(id).match(/^CASE-\d{4}-(\d+)$/);
  if (!coincidencia) {
    return 'Queda abierto el caso.';
  }
  // El año y los ceros de delante no se dictan: solo los cuatro últimos.
  const cola = coincidencia[1].slice(-4);
  const dichos = cola
    .split('')
    .map((digito) => DIGITOS[digito] || digito)
    .join(' ');
  return `Queda abierto el caso. Termina en ${dichos}.`;
}

function listarPedidos() {
  return abrir()
    .prepare(
      `SELECT
         p.id AS pedido_id,
         p.numero_serie,
         p.fecha_entrega,
         p.cuenta_id,
         c.nombre AS cuenta_nombre,
         pr.id AS producto_id,
         pr.referencia AS producto_referencia,
         pr.nombre AS producto_nombre,
         pr.gama AS producto_gama
       FROM pedidos p
       JOIN cuentas c ON c.id = p.cuenta_id
       JOIN productos pr ON pr.id = p.producto_id`
    )
    .all();
}

function buscarPedido(referenciaNormalizada) {
  const pedidos = listarPedidos();
  const exacto = pedidos.find(
    (pedido) =>
      normalizarReferencia(pedido.pedido_id) === referenciaNormalizada ||
      normalizarReferencia(pedido.numero_serie) === referenciaNormalizada
  );
  return exacto || null;
}

async function identificar(req, res) {
  const referencia = normalizarReferencia(req.body?.referencia);
  if (!referencia) {
    return res.status(400).json({ error: 'Falta referencia' });
  }

  const pedido = buscarPedido(referencia);
  if (!pedido) {
    return res.json({
      encontrado: false,
      hablado: aLoSumoDosFrases(
        'No encuentro esa referencia. Dígame el número de pedido o el de serie, tal como figura en la etiqueta.'
      ),
      contexto: null,
    });
  }

  const previos = abrir()
    .prepare('SELECT COUNT(*) AS n FROM casos WHERE cuenta_id = ?')
    .get(pedido.cuenta_id);
  const cuando = mesYAnio(pedido.fecha_entrega);
  const tipo = tipoProductoHablado(pedido.producto_nombre);
  const entrega = cuando ? `, entregado en ${cuando}` : '';

  return res.json({
    encontrado: true,
    hablado: aLoSumoDosFrases(
      `${nombreParaVoz(pedido.cuenta_nombre)}, ${tipo} ${pedido.producto_referencia}${entrega}.`
    ),
    contexto: {
      cuenta_id: pedido.cuenta_id,
      cuenta_nombre: pedido.cuenta_nombre,
      producto_referencia: pedido.producto_referencia,
      producto_gama: pedido.producto_gama,
      pedido_id: pedido.pedido_id,
      meses_desde_entrega: mesesDesdeEntrega(pedido.fecha_entrega, new Date().toISOString()),
      casos_previos_count: previos.n,
    },
  });
}

const VERBOS_LIGEROS = new Set([
  'hace', 'hacer', 'hay', 'tiene', 'tengo', 'da', 'dar', 'produce', 'producir',
]);

function textoPlano(texto) {
  return String(texto || '')
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function palabrasSignificativas(texto) {
  return textoPlano(texto)
    .split(/\s+/)
    .filter((palabra) => palabra && !PALABRAS_VACIAS.has(palabra));
}

// Un síntoma es un verbo o un sustantivo de comportamiento. "Hace ruido"
// no cuenta: el verbo es vacío y "ruido" va solo, sin decir cómo ni cuándo.
function describeSintoma(texto) {
  const plano = textoPlano(texto);
  if (!plano) return false;
  if (/\bvibr/.test(plano)) return true;
  if (/\bgote/.test(plano)) return true;
  if (/\bno\s+arranc/.test(plano)) return true;
  if (/\bno\s+enfri/.test(plano)) return true;
  if (/\bse\s+par(a|o|ado|ada|ando|aron)\b/.test(plano)) return true;
  if (/\berror(es)?\b/.test(plano)) return true;
  if (/\bruido\b/.test(plano)) {
    const resto = palabrasSignificativas(texto).filter(
      (palabra) => palabra !== 'ruido' && !VERBOS_LIGEROS.has(palabra)
    );
    return resto.length > 0;
  }
  return false;
}

function consultaSinDetalle(consulta) {
  if (palabrasSignificativas(consulta).length >= MIN_PALABRAS_SIGNIFICATIVAS) return false;
  return !describeSintoma(consulta);
}

function fragmentosPermitidos(fragmentos) {
  return (fragmentos || []).filter((fragmento) => fragmento.documento_id !== DOCUMENTO_COMERCIAL);
}

// La sección padre a veces supera el umbral y las hijas no. Sin ellas el
// modelo no ve qué condición discrimina ni qué dato pide el manual después.
function conSeccionesHijas(fragmentos) {
  const salida = [];
  const vistos = new Set();
  const porDocumento = new Map();

  for (const fragmento of fragmentos) {
    if (!vistos.has(fragmento.id)) {
      vistos.add(fragmento.id);
      salida.push(fragmento);
    }
    if (!porDocumento.has(fragmento.documento_id)) {
      porDocumento.set(fragmento.documento_id, fragmentosDelDocumento(fragmento.documento_id));
    }
    for (const hijo of porDocumento.get(fragmento.documento_id)) {
      if (hijo.encabezado_padre !== fragmento.encabezado || vistos.has(hijo.id)) continue;
      vistos.add(hijo.id);
      salida.push({ ...hijo, puntuacion: fragmento.puntuacion });
    }
  }

  return salida;
}

function formatearFragmentos(fragmentos) {
  return fragmentos
    .map((fragmento) => `fuente_id: ${fragmento.id}\n${fragmento.texto}`)
    .join('\n\n');
}

async function redactarRespuestaVoz(consulta, productoReferencia, fragmentos) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODELO_CHAT,
      temperature: 0.1,
      max_tokens: 180,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT_VOZ },
        {
          role: 'user',
          content: [
            `Producto: ${productoReferencia}`,
            '',
            'Consulta del instalador (ya destilada, puede estar incompleta):',
            consulta,
            'Tacha de los datos exigidos por los fragmentos todo lo que esta consulta ya dice. falta_dato es solo el siguiente que quede, o null si no queda ninguno.',
            '',
            'Fragmentos recuperados:',
            formatearFragmentos(fragmentos),
          ].join('\n'),
        },
      ],
    }),
  });

  if (!response.ok) {
    const detalle = await response.text();
    const error = new Error(`OpenAI error ${response.status}: ${detalle}`);
    error.status = 502;
    throw error;
  }

  const data = await response.json();
  const texto = data.choices?.[0]?.message?.content;
  if (!texto) {
    const error = new Error('OpenAI no devolvió contenido');
    error.status = 502;
    throw error;
  }
  return JSON.parse(texto);
}

async function consultar(req, res) {
  const consultaOriginal = String(req.body?.consulta || '').trim();
  const productoReferencia = String(req.body?.producto_referencia || '').trim();
  if (!consultaOriginal || !productoReferencia) {
    return res.status(400).json({ error: 'Faltan consulta y producto_referencia' });
  }

  const { texto } = limpiarConsulta(consultaOriginal);
  const consulta = texto || consultaOriginal;

  // Lo que corta la consulta no es que sea corta, es que no describa un
  // síntoma. Con tres palabras significativas se intenta la recuperación.
  // Por debajo, solo pasa si nombra un comportamiento (vibra, no arranca,
  // gotea, se para, error, ruido con algún matiz). "Hace ruido" se queda
  // fuera: no se llama al embedding ni al modelo.
  if (consultaSinDetalle(consulta)) {
    return res.json({
      cubierto: true,
      hablado: PREGUNTA_SINTOMA,
      falta_dato: PREGUNTA_SINTOMA,
      fuentes: [],
      puntuacion: null,
    });
  }

  // La referencia entra en la búsqueda para anclar el embedding al equipo.
  // El modelo solo ve la consulta destilada, sin síntomas añadidos.
  const busqueda = await buscar(`${consulta} ${productoReferencia}`, productoReferencia, {
    dominioRol: null,
  });
  const permitidos = conSeccionesHijas(fragmentosPermitidos(busqueda.fragmentos));
  const cubierto = busqueda.cubierto && permitidos.length > 0;

  if (!cubierto) {
    return res.json({
      cubierto: false,
      hablado: aLoSumoDosFrases(
        'Eso no lo cubre la documentación que tengo. Si quiere, abrimos un caso para que lo revise un técnico.'
      ),
      falta_dato: null,
      fuentes: [],
      puntuacion: busqueda.mejorPuntuacion ?? 0,
    });
  }

  const redaccion = await redactarRespuestaVoz(consulta, productoReferencia, permitidos);
  const faltaCruda = redaccion.falta_dato ? aLoSumoDosFrases(redaccion.falta_dato) : null;
  // Una etiqueta o un diagnóstico no se lee. falta_dato solo viaja si es pregunta.
  const faltaDato = faltaCruda && /[?¿]/.test(faltaCruda) ? faltaCruda : null;
  // Si falta un dato, lo que se lee es la pregunta, no un aviso de que falta.
  const hablado = faltaDato
    ? faltaDato
    : aLoSumoDosFrases(redaccion.hablado) || 'No puedo concretarlo con lo que me ha dicho.';

  return res.json({
    cubierto: true,
    hablado,
    falta_dato: faltaDato,
    fuentes: permitidos.map((fragmento) => fragmento.id),
    puntuacion: busqueda.mejorPuntuacion ?? permitidos[0].puntuacion,
  });
}

async function crearCasoVoz(req, res) {
  const cuentaId = req.body?.cuenta_id;
  const productoId = req.body?.producto_id;
  const descripcion = String(req.body?.descripcion || '').trim();
  const datosRecogidos = req.body?.datos_recogidos;

  if (!cuentaId || !productoId || !descripcion) {
    return res.status(400).json({ error: 'Faltan cuenta_id, producto_id o descripcion' });
  }

  const producto = await getProducto(productoId);
  if (!producto) {
    return res.status(404).json({ error: `Producto no encontrado: ${productoId}` });
  }
  const cuenta = abrir().prepare('SELECT id FROM cuentas WHERE id = ?').get(cuentaId);
  if (!cuenta) {
    return res.status(404).json({ error: `Cuenta no encontrada: ${cuentaId}` });
  }

  const caso = await crearCaso({
    cuenta_id: cuentaId,
    producto_id: productoId,
    descripcion,
    datos_recogidos: Array.isArray(datosRecogidos) ? datosRecogidos : [],
    canal: 'voz',
    actor: 'agente-voz',
  });

  // No se espera al análisis: la llamada tiene que volver en menos de
  // medio segundo. El caso nace en "Nuevo" y, hasta que el triaje se
  // persista, la cola lo trata como pendiente. Si el análisis falla,
  // se queda así; ese estado ya lo resuelve la cola.
  lanzarAnalisisEnSegundoPlano(caso.id);

  return res.status(201).json({
    referencia: caso.id,
    hablado: dictarReferencia(caso.id),
  });
}

function lanzarAnalisisEnSegundoPlano(casoId) {
  analizarYPersistir(casoId, 'responsable').catch((error) => {
    console.error(
      `[voz] El caso ${casoId} quedó creado, pero el análisis no se pudo guardar: ${error.message}`
    );
  });
}

function conAuth(handler) {
  return async (req, res) => {
    if (!tokensIguales(tokenDeLaPeticion(req), process.env.VOZ_API_TOKEN)) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
    await handler(req, res);
  };
}

function montarVoz(app) {
  app.post('/api/voz/identificar', medir('identificar', conAuth(identificar)));
  app.post('/api/voz/consultar', medir('consultar', conAuth(consultar)));
  app.post('/api/voz/crear-caso', medir('crear-caso', conAuth(crearCasoVoz), 500));
}

module.exports = {
  montarVoz,
  normalizarReferencia,
  aLoSumoDosFrases,
  dictarReferencia,
  consultaSinDetalle,
};
