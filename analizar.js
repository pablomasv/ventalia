const { buscar } = require('./buscar');
const { limpiarConsulta } = require('./limpiar-consulta');
const {
  getCaso,
  getContextoCuenta,
  getCasosSimilares,
  getHistorialCuenta,
  contarCasosCuenta,
} = require('./crm');
const {
  evaluarCobertura,
  calcularSegmentoComercial,
  mesesDesdeEntrega,
} = require('./cobertura');

const MODELO_CHAT = 'gpt-4o';

/**
 * Años completos que una cuenta lleva como cliente, a partir de su
 * fecha de alta (cliente_desde). Se usa en el contexto de cliente de
 * la vista de postventa ("antigüedad como cliente").
 */
function antiguedadClienteAnios(clienteDesde, fechaReferencia) {
  if (!clienteDesde) return null;
  const alta = new Date(clienteDesde);
  const referencia = new Date(fechaReferencia);
  const diffMs = referencia - alta;
  return Math.round((diffMs / (1000 * 60 * 60 * 24 * 365.25)) * 10) / 10;
}

/**
 * Detección determinista (por palabras clave, sin IA) de si el caso tiene
 * pinta de reclamación o gestión postventa, y de qué tipo. Se usa
 * ÚNICAMENTE para decidir si merece la pena lanzar una segunda búsqueda
 * sobre la política de segmentación comercial: no decide el equipo ni la
 * prioridad del caso, eso sigue siendo tarea exclusiva de la IA.
 */
const SENALES_RECLAMACION = [
  { patron: /garant[ií]a/i, tipo: 'garantía' },
  { patron: /devoluci[oó]n|abono/i, tipo: 'devolución y abono' },
  { patron: /visita t[eé]cnica|desplazamiento/i, tipo: 'visita técnica sin coste' },
  { patron: /reclamaci[oó]n/i, tipo: 'reclamación' },
  { patron: /cortes[ií]a|fuera de plazo|cobertura/i, tipo: 'extensión de cobertura' },
];

function detectarTipoReclamacion(texto) {
  for (const { patron, tipo } of SENALES_RECLAMACION) {
    if (patron.test(texto)) return tipo;
  }
  return null;
}

/**
 * Quita fragmentos repetidos (mismo id) si una misma sección apareciera
 * en las dos búsquedas (problema + marco de decisión comercial).
 */
function deduplicarFragmentos(fragmentos) {
  const vistos = new Set();
  const resultado = [];
  for (const fragmento of fragmentos) {
    if (vistos.has(fragmento.id)) continue;
    vistos.add(fragmento.id);
    resultado.push(fragmento);
  }
  return resultado;
}

function construirConsultaBusqueda(caso, producto) {
  const { texto: descripcionLimpia, eliminados } = limpiarConsulta(caso.descripcion);

  return {
    consulta: [caso.asunto, descripcionLimpia, producto.referencia, producto.gama]
      .filter(Boolean)
      .join(' '),
    original: caso.descripcion,
    limpia: descripcionLimpia,
    eliminados,
  };
}

function construirContextoCRM(caso, contexto, casosSimilares, numeroCasosPrevios, historialCuenta) {
  const pedido = contexto.pedido;
  const mesesTranscurridos = pedido
    ? mesesDesdeEntrega(pedido.fecha_entrega, caso.creado)
    : null;

  const cuenta = contexto.cuenta
    ? {
        ...contexto.cuenta,
        // Sobrescribe el campo crudo del JSON: el segmento se calcula aquí a
        // partir de facturacion_ultimos_12m, nunca se toma del dato tal cual.
        segmento_comercial: calcularSegmentoComercial(contexto.cuenta.facturacion_ultimos_12m),
        antiguedad_cliente_anios: antiguedadClienteAnios(
          contexto.cuenta.cliente_desde,
          caso.creado
        ),
        numero_casos_previos: numeroCasosPrevios,
      }
    : null;

  const datosRecogidos = Array.isArray(caso.datos_recogidos) ? caso.datos_recogidos : [];

  return {
    caso: {
      id: caso.id,
      asunto: caso.asunto,
      descripcion: caso.descripcion,
      canal: caso.canal,
      creado: caso.creado,
      datos_recogidos: datosRecogidos,
    },
    cuenta,
    contacto: contexto.contacto,
    producto: contexto.producto,
    pedido: pedido
      ? {
          id: pedido.id,
          numero_serie: pedido.numero_serie,
          fecha_entrega: pedido.fecha_entrega,
          meses_desde_entrega: mesesTranscurridos,
          informe_puesta_en_marcha: pedido.informe_puesta_en_marcha,
          instalador: pedido.instalador,
        }
      : null,
    casos_similares: casosSimilares.map((c) => ({
      id: c.id,
      asunto: c.asunto,
      creado: c.creado,
      causa_raiz: c.causa_raiz,
      resolucion: c.resolucion,
    })),
    // Historial completo de la cuenta (pedidos + casos, no solo los del
    // mismo producto): alimenta la cronología de cliente en la vista de
    // postventa. Es solo para mostrar en la interfaz, no se pasa al
    // modelo (no cambia el prompt ni el JSON que le pedimos).
    historial_cuenta: historialCuenta || { casos: [], pedidos: [] },
    // Respuestas del formulario asistido (canal "formulario").
    datos_recogidos: datosRecogidos,
  };
}

function formatearBloqueCRM(contextoCRM) {
  const lineas = ['=== CONTEXTO_CRM ==='];

  if (contextoCRM.cuenta) {
    lineas.push(
      `Cuenta: ${contextoCRM.cuenta.nombre} (${contextoCRM.cuenta.pais}) — ${contextoCRM.cuenta.filial}`
    );
    lineas.push(
      `Cliente desde: ${contextoCRM.cuenta.cliente_desde} (${contextoCRM.cuenta.antiguedad_cliente_anios} años) · Contrato de mantenimiento: ${contextoCRM.cuenta.contrato_mantenimiento ? 'sí' : 'no'} · Casos previos: ${contextoCRM.cuenta.numero_casos_previos}`
    );
    lineas.push(
      `Segmento comercial: ${contextoCRM.cuenta.segmento_comercial} (facturación últimos 12 meses: ${contextoCRM.cuenta.facturacion_ultimos_12m ?? 'no disponible'} €) — calculado por la aplicación según la política de segmentación`
    );
  }

  if (contextoCRM.contacto) {
    lineas.push(
      `Contacto: ${contextoCRM.contacto.nombre} — ${contextoCRM.contacto.cargo}`
    );
  }

  if (contextoCRM.producto) {
    lineas.push(
      `Producto: ${contextoCRM.producto.referencia} — ${contextoCRM.producto.nombre} (gama ${contextoCRM.producto.gama})`
    );
  }

  if (contextoCRM.pedido) {
    lineas.push(`Fecha de entrega: ${contextoCRM.pedido.fecha_entrega}`);
    lineas.push(
      `Meses transcurridos desde la entrega: ${contextoCRM.pedido.meses_desde_entrega}`
    );
    lineas.push(
      `Informe de puesta en marcha: ${contextoCRM.pedido.informe_puesta_en_marcha ? 'sí' : 'no'}`
    );
  } else {
    lineas.push('Pedido: no asociado al caso');
  }

  lineas.push('', 'Casos similares cerrados (más recientes primero):');
  if (contextoCRM.casos_similares.length === 0) {
    lineas.push('- Ninguno con causa raíz registrada');
  } else {
    for (const c of contextoCRM.casos_similares) {
      lineas.push(
        `- ${c.id} (${c.creado}): causa "${c.causa_raiz}" → ${c.resolucion}`
      );
    }
  }

  lineas.push('', `Canal: ${contextoCRM.caso.canal || '—'}`);
  lineas.push(`Asunto del caso: ${contextoCRM.caso.asunto}`);
  lineas.push(`Descripción: ${contextoCRM.caso.descripcion}`);

  const recogidos = contextoCRM.datos_recogidos || contextoCRM.caso.datos_recogidos || [];
  if (recogidos.length > 0) {
    lineas.push(
      '',
      'Datos ya recogidos en el formulario asistido (NO vuelvas a pedirlos en falta_dato ni en el borrador; úsalos como hechos disponibles):'
    );
    for (const d of recogidos) {
      const respuesta =
        d.respuesta != null && String(d.respuesta).trim() !== ''
          ? d.respuesta
          : '(el cliente no aportó respuesta)';
      lineas.push(
        `- Pregunta: ${d.pregunta || '—'} → Respuesta: ${respuesta}${
          d.fuente_id ? ` [fuente_id: ${d.fuente_id}]` : ''
        }`
      );
    }
  }

  return lineas.join('\n');
}

const EQUIPOS_VALIDOS = ['Técnico', 'Postventa'];
const PRIORIDADES_VALIDAS = ['Alta', 'Media', 'Baja'];
const CATEGORIAS_VALIDAS = [
  'Duda técnica',
  'Incidencia',
  'Garantía',
  'Devolución',
  'Repuesto',
  'Documentación',
];

/**
 * Red de seguridad para "categoria": el prompt pide un enum cerrado, pero
 * el modelo puede desviarse (p. ej. "Fallo de rotor" o "Solicitud de
 * visita técnica" en vez de "Incidencia" o "Duda técnica"). Se reconduce
 * por palabras clave a la categoría más cercana del enum.
 */
function normalizarCategoria(categoria, caseId) {
  if (CATEGORIAS_VALIDAS.includes(categoria)) return categoria;

  const texto = String(categoria || '').toLowerCase();
  let normalizada;
  if (/garant[ií]a/.test(texto)) normalizada = 'Garantía';
  else if (/devoluci|abono/.test(texto)) normalizada = 'Devolución';
  else if (/repuesto|recambio|filtro/.test(texto)) normalizada = 'Repuesto';
  else if (/document|certificado|declaraci|ficha/.test(texto)) normalizada = 'Documentación';
  else if (/duda|consulta|pregunta|informaci[oó]n|compatibilidad|dimensiona|selecci[oó]n|visita/.test(texto))
    normalizada = 'Duda técnica';
  else normalizada = 'Incidencia';

  console.warn(
    `[triaje] ${caseId}: categoria fuera de enum ("${categoria}") normalizada a "${normalizada}"`
  );
  return normalizada;
}

/**
 * Red de seguridad: aunque el prompt pida un enum cerrado, un modelo de
 * lenguaje puede desviarse (p. ej. devolver "Soporte Técnico" en vez de
 * "Técnico"). Como la cola filtra por igualdad estricta de cadena, un
 * valor fuera de enum dejaría el caso sin cola asignada. Esta función
 * fuerza categoria/equipo/prioridad a valores válidos y registra el ajuste.
 */
function normalizarTriaje(triaje, caseId) {
  const normalizado = { ...triaje };
  normalizado.categoria = normalizarCategoria(normalizado.categoria, caseId);

  if (!EQUIPOS_VALIDOS.includes(normalizado.equipo)) {
    const original = normalizado.equipo;
    const texto = String(original || '').toLowerCase();
    normalizado.equipo = /postventa|garant|reclamaci|documental|log[ií]stica|devoluci|comercial/.test(texto)
      ? 'Postventa'
      : 'Técnico';
    console.warn(
      `[triaje] ${caseId}: equipo fuera de enum ("${original}") normalizado a "${normalizado.equipo}"`
    );
  }

  if (!PRIORIDADES_VALIDAS.includes(normalizado.prioridad)) {
    const original = normalizado.prioridad;
    normalizado.prioridad = 'Media';
    console.warn(
      `[triaje] ${caseId}: prioridad fuera de enum ("${original}") normalizada a "${normalizado.prioridad}"`
    );
  }

  return normalizado;
}

const VEREDICTOS_VALIDOS = ['procede', 'no_procede', 'pendiente_dato'];
const RESPALDOS_VALIDOS = ['corpus', 'historico', 'modelo'];
const POLARIDADES_VALIDAS = ['a_favor', 'en_contra'];

/**
 * Red de seguridad para los bloques nuevos "diagnostico" y
 * "decision_postventa": si el modelo omite el campo o devuelve un
 * valor fuera de enum, se sustituye por un valor por defecto seguro
 * en vez de dejar la interfaz sin nada que mostrar.
 */
function normalizarDiagnostico(diagnostico, triaje, caseId) {
  const causas = Array.isArray(diagnostico?.causas_candidatas)
    ? diagnostico.causas_candidatas.filter((c) => c && c.causa)
    : [];

  if (causas.length === 0) {
    console.warn(`[diagnostico] ${caseId}: sin causas_candidatas, se usa triaje.categoria como respaldo`);
    causas.push({ causa: triaje?.categoria || 'Sin categoría', respaldo: 'modelo' });
  }

  const causasNormalizadas = causas.map((c) => ({
    causa: c.causa,
    respaldo: RESPALDOS_VALIDOS.includes(c.respaldo) ? c.respaldo : 'modelo',
  }));

  return {
    causas_candidatas: causasNormalizadas,
    orden_alterado_por_historico: Boolean(diagnostico?.orden_alterado_por_historico),
    motivo_orden: diagnostico?.orden_alterado_por_historico ? (diagnostico.motivo_orden || null) : null,
  };
}

function normalizarDecisionPostventa(decision, caseId) {
  const veredicto = VEREDICTOS_VALIDOS.includes(decision?.veredicto)
    ? decision.veredicto
    : 'pendiente_dato';

  if (!VEREDICTOS_VALIDOS.includes(decision?.veredicto)) {
    console.warn(
      `[decision_postventa] ${caseId}: veredicto fuera de enum ("${decision?.veredicto}") normalizado a "pendiente_dato"`
    );
  }

  const factores = Array.isArray(decision?.factores)
    ? decision.factores
        .filter((f) => f && f.descripcion)
        .map((f) => ({
          descripcion: f.descripcion,
          polaridad: POLARIDADES_VALIDAS.includes(f.polaridad) ? f.polaridad : 'a_favor',
        }))
    : [];

  return {
    veredicto,
    motivo: decision?.motivo || '',
    factores,
  };
}

/**
 * Exclusiones y requisitos documentales de garantía (FAQ de garantía,
 * manuales de puesta en marcha) que sí pueden justificar un "no_procede"
 * o un "pendiente_dato" aunque el caso esté dentro de plazo o le aplique
 * cortesía comercial. Sirven para no marcar como "incoherente" una
 * denegación legítima por otro motivo distinto del plazo (instalación
 * fuera de especificación, recambios no originales, falta de
 * mantenimiento, daños de transporte, manipulación, o falta del informe
 * de puesta en marcha).
 */
const EXCLUSIONES_VALIDAS = /recambio|consumible no original|no original|instalaci[oó]n fuera de especificaci[oó]n|falta de mantenimiento|manipulaci[oó]n|da[ñn]os? de transporte|puesta en marcha|informe.*requerid|documentaci[oó]n.*falta|falta.*documentaci[oó]n/i;

function tieneExclusionDocumentada(decisionPostventa) {
  const texto = `${decisionPostventa?.motivo || ''} ${(decisionPostventa?.factores || [])
    .map((f) => f.descripcion)
    .join(' ')}`;
  return EXCLUSIONES_VALIDAS.test(texto);
}

/**
 * Comprobación final determinista: ¿el veredicto de decision_postventa
 * contradice los hechos de COBERTURA_CALCULADA? No corrige nada — el
 * veredicto lo sigue proponiendo el modelo — solo lo señala, para que
 * quede visible en consola y en la interfaz cuando el modelo ignora un
 * dato que se le pasó ya calculado (el fallo real que motivó este
 * cambio: negar una garantía dentro de plazo razonando "fuera de
 * plazo" en texto libre, sin ninguna cifra falsa que la validación de
 * citas pudiera cazar).
 */
function detectarIncoherenciaCobertura(decisionPostventa, coberturaCalculada, caseId) {
  if (!coberturaCalculada?.aplicable || !decisionPostventa) return [];

  const veredicto = decisionPostventa.veredicto;
  const dentroDePlazo = coberturaCalculada.dentro_de_plazo.valor;
  const cortesiaAplicable = coberturaCalculada.cortesia_aplicable.valor;
  const tieneExclusion = tieneExclusionDocumentada(decisionPostventa);

  const incoherencias = [];

  if (dentroDePlazo && veredicto === 'no_procede' && !tieneExclusion) {
    incoherencias.push(
      `El veredicto es "no_procede" pero el caso está DENTRO de plazo (${coberturaCalculada.meses_desde_entrega.valor} de ${coberturaCalculada.plazo_garantia_meses.valor} meses) y no se cita ninguna exclusión documentada.`
    );
  }

  if (!dentroDePlazo && cortesiaAplicable && veredicto === 'no_procede' && !tieneExclusion) {
    incoherencias.push(
      `El veredicto es "no_procede" pero cortesia_aplicable=true: el margen de ${coberturaCalculada.margen_cortesia_meses.valor} mes(es) del segmento ${coberturaCalculada.segmento_comercial.valor} cubre los ${coberturaCalculada.meses_fuera_de_plazo.valor} mes(es) fuera de plazo, y no se cita ninguna exclusión documentada.`
    );
  }

  if (!dentroDePlazo && !cortesiaAplicable && veredicto === 'procede') {
    incoherencias.push(
      `El veredicto es "procede" pero el caso está fuera de plazo (${coberturaCalculada.meses_fuera_de_plazo.valor} mes(es)) y no aplica cortesía para el segmento ${coberturaCalculada.segmento_comercial.valor}.`
    );
  }

  if (incoherencias.length > 0) {
    console.warn(`[cobertura] ${caseId}: incoherencia entre decision_postventa y COBERTURA_CALCULADA —`, incoherencias.join(' | '));
  }

  return incoherencias;
}

/**
 * Formatea el bloque COBERTURA_CALCULADA: hechos ya calculados de forma
 * determinista (cobertura.js), no por el modelo. Se presenta con una
 * instrucción explícita de que son datos verificados que no debe
 * recalcular ni contradecir.
 */
function formatearBloqueCobertura(cobertura) {
  if (!cobertura || !cobertura.aplicable) {
    return '=== COBERTURA_CALCULADA ===\nNo aplica: el caso no tiene un pedido con fecha de entrega asociado.';
  }

  const lineas = [
    '=== COBERTURA_CALCULADA ===',
    'Estos datos ya están calculados por la aplicación (no por ti) a partir del CRM y de la política comercial. Son hechos verificados: NO los recalcules ni los contradigas, úsalos tal cual para razonar y redactar decision_postventa.',
    `Meses transcurridos desde la entrega: ${cobertura.meses_desde_entrega.valor}`,
    `Plazo de garantía: ${cobertura.plazo_garantia_meses.valor} meses (fuente: ${cobertura.plazo_garantia_meses.fuente_id})`,
    `¿Dentro de plazo?: ${cobertura.dentro_de_plazo.valor ? 'SÍ' : 'NO'}`,
  ];

  if (!cobertura.dentro_de_plazo.valor) {
    lineas.push(`Meses fuera de plazo: ${cobertura.meses_fuera_de_plazo.valor}`);
  }

  lineas.push(
    `Segmento comercial: ${cobertura.segmento_comercial.valor} (fuente: ${cobertura.segmento_comercial.fuente_id})`,
    `Margen de cortesía del segmento: ${cobertura.margen_cortesia_meses.valor} mes(es)${cobertura.margen_cortesia_meses.fuente_id ? ` (fuente: ${cobertura.margen_cortesia_meses.fuente_id})` : ''}`,
    `¿Aplica cortesía a este caso?: ${cobertura.cortesia_aplicable.valor ? 'SÍ' : 'NO'}`
  );

  return lineas.join('\n');
}

function formatearBloqueCorpus(fragmentos) {
  const lineas = ['=== CONOCIMIENTO_CORPUS ==='];

  fragmentos.forEach((fragmento, i) => {
    const origen =
      fragmento._origen_recuperacion === 'marco_decision'
        ? 'marco de decisión / política comercial'
        : 'problema del cliente';
    lineas.push(
      `[Fragmento ${i + 1}] fuente_id: ${fragmento.id} | documento: ${fragmento.titulo} | sección: ${fragmento.encabezado} | recuperado por: ${origen}`
    );
    lineas.push(fragmento.texto);
    lineas.push('');
  });

  return lineas.join('\n');
}

/**
 * Prompt de triaje "sin corpus": se usa cuando la búsqueda no encuentra
 * conocimiento aplicable. No pide contenido técnico ni citas — solo una
 * clasificación (categoría, prioridad, equipo) a partir del contexto del
 * CRM, para que el enrutado del caso salga siempre de un juicio de la IA
 * y nunca de reglas de palabras clave.
 */
const PROMPT_TRIAJE_SIN_CORPUS = `Eres un clasificador de casos de soporte para el fabricante Ventalia.

No dispones de documentación técnica citable para este caso. NO redactes procedimientos,
NO cites fuentes, NO inventes contenido técnico. Tu única tarea es proponer una
clasificación de triaje a partir del CONTEXTO_CRM que recibirás.

Responde ÚNICAMENTE con un JSON con esta forma exacta:
{ "categoria": "Duda técnica"|"Incidencia"|"Garantía"|"Devolución"|"Repuesto"|"Documentación", "prioridad": "Alta"|"Media"|"Baja", "equipo": "Técnico"|"Postventa", "porque": string }

"categoria" debe ser EXACTAMENTE uno de los seis valores del enum (nunca una descripción libre
como "Fallo de rotor" o "Solicitud de visita técnica").
"equipo" debe ser "Técnico" para incidencias, dudas de instalación o de producto, y
"Postventa" para garantías, reclamaciones, documentación comercial o repuestos.
"porque" debe explicar brevemente el criterio de clasificación usado.`;

async function llamarTriajeIA(contextoCRM) {
  const bloqueCRM = formatearBloqueCRM(contextoCRM);

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
        { role: 'system', content: PROMPT_TRIAJE_SIN_CORPUS },
        { role: 'user', content: bloqueCRM },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Error de OpenAI (${response.status}): ${error}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

function propuestaEscalado(caso, triaje, resultadoBusqueda) {
  const mensajesMotivo = {
    sin_cobertura:
      'Ningún fragmento del corpus supera el umbral de similitud para esta consulta.',
    sin_cobertura_producto:
      'Hay fragmentos relevantes en el corpus, pero ninguno corresponde al producto del caso.',
  };

  return {
    motivo_busqueda: resultadoBusqueda.motivo,
    descripcion: mensajesMotivo[resultadoBusqueda.motivo] || 'Sin cobertura en la base de conocimiento.',
    mejor_puntuacion: resultadoBusqueda.mejorPuntuacion,
    descartado: resultadoBusqueda.descartado,
    accion_recomendada: `Escalar el caso ${caso.id} al equipo ${triaje.equipo} para revisión manual.`,
    notas:
      'No se ha citado conocimiento del corpus. El equipo y la prioridad los propone la IA a partir del contexto del CRM únicamente.',
  };
}

const PROMPT_SISTEMA = `Eres un asistente de triaje y redacción para el equipo de soporte técnico y postventa de Ventalia.

Recibirás hasta tres bloques de información claramente etiquetados:
- CONTEXTO_CRM: datos del caso, cuenta, producto, pedido e histórico de casos similares.
- COBERTURA_CALCULADA: cuando el caso tiene pedido, hechos YA CALCULADOS por la aplicación
  (no por ti) sobre plazo de garantía y margen de cortesía comercial. Son datos verificados.
- CONOCIMIENTO_CORPUS: fragmentos recuperados de la base de conocimiento.

Debes responder ÚNICAMENTE con un JSON válido con esta forma exacta:
{
  "triaje": { "categoria": "Duda técnica"|"Incidencia"|"Garantía"|"Devolución"|"Repuesto"|"Documentación", "prioridad": "Alta"|"Media"|"Baja", "equipo": "Técnico"|"Postventa", "porque": string },
  "diagnostico": {
    "causas_candidatas": [ { "causa": string, "respaldo": "corpus"|"historico"|"modelo" } ],
    "orden_alterado_por_historico": boolean,
    "motivo_orden": string|null
  },
  "decision_postventa": {
    "veredicto": "procede"|"no_procede"|"pendiente_dato",
    "motivo": string,
    "factores": [ { "descripcion": string, "polaridad": "a_favor"|"en_contra" } ]
  },
  "afirmaciones": [
    { "texto": string, "origen": "crm"|"corpus"|"modelo", "fuente_id": string|null, "campo": string|null }
  ],
  "falta_dato": string|null,
  "borrador": string,
  "siguiente_accion": string
}

Reglas obligatorias:
- "equipo" debe ser EXACTAMENTE "Técnico" o "Postventa" (sin variantes como "Soporte Técnico", "Logística" o "Documental"). "prioridad" debe ser EXACTAMENTE "Alta", "Media" o "Baja". "categoria" debe ser EXACTAMENTE uno de "Duda técnica", "Incidencia", "Garantía", "Devolución", "Repuesto" o "Documentación".
- Toda afirmación técnica, de procedimiento o de política comercial DEBE ir respaldada por un fragmento de CONOCIMIENTO_CORPUS con origen "corpus". "fuente_id" debe ser EXACTAMENTE el valor "fuente_id" mostrado junto al fragmento (formato "documento#seccion"), nunca solo el nombre del documento. Si no recuerdas el fuente_id exacto de un fragmento, no cites ese dato: decláralo en falta_dato o formúlalo como razonamiento con origen "modelo".
- Cada fragmento de CONOCIMIENTO_CORPUS indica si procede de la búsqueda del problema o del marco de decisión / política comercial. Usa los del marco de decisión para las condiciones comerciales (plazos de cortesía, visitas sin coste, márgenes) y los del problema para el diagnóstico técnico.
- Las afirmaciones basadas en CONTEXTO_CRM llevan origen "crm" y el campo correspondiente (ej. "pedido.fecha_entrega", "casos_similares").
- Solo usa origen "modelo" para razonamiento de encaje entre fuentes, nunca para inventar hechos técnicos.
- Si el histórico de casos similares contradice el orden de causas del conocimiento, PRIORIZA la evidencia del histórico y explícalo en triaje.porque o en afirmaciones de origen "modelo".
- Si falta un dato necesario para cerrar el diagnóstico, NO lo inventes: decláralo en falta_dato y pídelo en el borrador.
- Si CONTEXTO_CRM incluye "Datos ya recogidos en el formulario asistido", esos datos YA están disponibles: NO los declares en falta_dato, NO los vuelvas a pedir en el borrador y úsalos al razonar (afirmaciones de origen "crm" con campo "datos_recogidos" cuando cites una de esas respuestas).
- NO inventes referencias de producto, plazos, procedimientos ni datos que no aparezcan en los bloques proporcionados.
- Si recibes COBERTURA_CALCULADA aplicable, sus valores (meses transcurridos, dentro/fuera de plazo, segmento, margen y aplicabilidad de la cortesía) son hechos ya verificados por la aplicación: NO los recalcules, NO los contradigas y NO declares "fuera de plazo" si dice que está dentro de plazo, ni al revés. Si "¿Aplica cortesía a este caso?" es SÍ, el veredicto no puede ser "no_procede" únicamente por plazo (usa "procede", explicando que se aplica el margen de cortesía, salvo que exista otra causa de exclusión documentada en CONOCIMIENTO_CORPUS, que entonces debes citar explícitamente).
- El borrador debe ser un mensaje profesional en español para el cliente.
- siguiente_accion debe ser una acción concreta y ejecutable para el agente de soporte.

Reglas para "diagnostico" (diagnóstico técnico, ordenado por probabilidad):
- "causas_candidatas" es la lista de posibles causas del problema, ORDENADA de la más a la menos probable. Si solo hay una causa plausible, incluye solo un elemento.
- "respaldo" indica de dónde sale la probabilidad de esa causa: "corpus" si el orden lo marca la documentación, "historico" si sale de los casos similares del CRM, "modelo" si es una inferencia de encaje entre ambas fuentes.
- "orden_alterado_por_historico" es true SOLO si el orden de causas que sugeriría el conocimiento del corpus por sí solo ha sido invertido o corregido por la evidencia del histórico de casos similares. Si es true, "motivo_orden" explica el porqué en una frase. Si es false, "motivo_orden" es null.
- Si el caso no es un diagnóstico técnico (p. ej. una petición de documentación o de repuestos), usa una única causa_candidata que describa la naturaleza de la solicitud, con respaldo "modelo".

Reglas para "decision_postventa" (evalúa la solicitud desde el punto de vista de postventa, incluso si el equipo asignado es Técnico):
- "veredicto": "procede" si la solicitud puede resolverse favorablemente con la información disponible; "no_procede" si algo la excluye (fuera de plazo, exclusión de garantía, instalación fuera de especificación, etc.); "pendiente_dato" si no se puede decidir sin el dato de falta_dato.
- "motivo" resume el veredicto en una frase.
- "factores" es la lista de elementos que pesan en la decisión (plazo desde la entrega, exclusiones de la documentación, antecedentes del histórico, documentación que falta, contrato de mantenimiento, etc.), cada uno etiquetado "a_favor" o "en_contra". Incluye al menos un factor siempre que sea posible.
- Si la solicitud no es una reclamación (p. ej. una consulta técnica o un pedido de repuestos), interpreta "procede" como "puede atenderse con la información disponible" y describe los factores relevantes de esa gestión.`;

async function llamarOpenAI(contextoCRM, fragmentos, coberturaCalculada) {
  const bloqueCRM = formatearBloqueCRM(contextoCRM);
  const bloqueCobertura = formatearBloqueCobertura(coberturaCalculada);
  const bloqueCorpus = formatearBloqueCorpus(fragmentos);

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
        { role: 'system', content: PROMPT_SISTEMA },
        {
          role: 'user',
          content: `${bloqueCRM}\n\n${bloqueCobertura}\n\n${bloqueCorpus}`,
        },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Error de OpenAI (${response.status}): ${error}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

/**
 * Extrae del texto las cifras que van pegadas a una unidad relevante para
 * garantías/plazos/costes (meses, días, horas, €, %, Pa, años). Solo estas
 * cifras "con unidad" se verifican, para no rechazar afirmaciones por
 * números incidentales (referencias de producto, números de pedido...).
 */
function extraerCifrasConUnidad(texto) {
  if (!texto) return [];
  const regex = /(\d[\d.,]*)\s*(meses?|d[ií]as?|horas?|€|eur\b|euros?|%|pa\b|años?)/gi;
  const resultados = [];
  let match;
  while ((match = regex.exec(texto)) !== null) {
    resultados.push({
      original: match[0].trim(),
      cifra: match[1].replace(/[.,]/g, ''),
      unidad: match[2].toLowerCase(),
    });
  }
  return resultados;
}

/**
 * Anclaje numérico: si la afirmación cita una cifra con unidad (p. ej.
 * "24 meses"), esa cifra debe aparecer LITERALMENTE en el texto del
 * fragmento citado. Si el fragmento dice "24 meses" y la afirmación dice
 * "12 meses", la cifra no aparece y la afirmación se descarta, aunque el
 * fuente_id sea correcto.
 */
function verificarAnclajeNumerico(textoAfirmacion, textoFragmento) {
  const cifrasAfirmacion = extraerCifrasConUnidad(textoAfirmacion);
  if (cifrasAfirmacion.length === 0) return null;

  const cifrasFragmento = new Set(extraerCifrasConUnidad(textoFragmento).map((c) => c.cifra));
  const faltantes = cifrasAfirmacion.filter((c) => !cifrasFragmento.has(c.cifra));

  if (faltantes.length === 0) return null;

  return `la(s) cifra(s) "${faltantes.map((f) => f.original).join(', ')}" no aparece(n) literalmente en el fragmento citado`;
}

/**
 * Comprueba que las afirmaciones citadas del corpus correspondan a
 * fragmentos EXACTOS (documento + sección) realmente recuperados por la
 * búsqueda, y que cualquier cifra que citen aparezca de verdad en el texto
 * de ese fragmento.
 *
 * El modelo puede alucinar un fuente_id que no existe, citar el documento
 * correcto pero la sección equivocada, o inventar una cifra que no está en
 * el texto recuperado (p. ej. "12 meses" cuando el fragmento dice "24
 * meses"). Las tres situaciones se descartan para no mostrar citas falsas
 * al agente de soporte, y se devuelven junto con el motivo del descarte
 * para poder mostrarlo en la interfaz.
 */
function validarAfirmacionesCorpus(afirmaciones, fragmentosRecuperados) {
  const fragmentosPorId = new Map(fragmentosRecuperados.map((f) => [f.id, f]));
  const validas = [];
  const descartadas = [];

  for (const afirmacion of afirmaciones) {
    if (afirmacion.origen !== 'corpus') {
      validas.push(afirmacion);
      continue;
    }

    const fragmento = afirmacion.fuente_id ? fragmentosPorId.get(afirmacion.fuente_id) : null;

    if (!fragmento) {
      const motivo = `fuente_id "${afirmacion.fuente_id}" no corresponde a ningún fragmento recuperado (documento y/o sección incorrectos)`;
      descartadas.push({ ...afirmacion, motivo_descarte: motivo });
      console.warn('[validación] Afirmación de corpus descartada —', motivo, ':', JSON.stringify(afirmacion));
      continue;
    }

    const motivoCifra = verificarAnclajeNumerico(afirmacion.texto, fragmento.texto);
    if (motivoCifra) {
      descartadas.push({ ...afirmacion, motivo_descarte: motivoCifra });
      console.warn(`[validación] Afirmación de corpus descartada — ${motivoCifra}:`, JSON.stringify(afirmacion));
      continue;
    }

    validas.push(afirmacion);
  }

  if (descartadas.length > 0) {
    console.warn(
      `[validación] ${descartadas.length} afirmación(es) de corpus descartada(s) de ${afirmaciones.length} total`
    );
  }

  return { afirmaciones: validas, descartadas };
}

async function analizarCaso(caseId, rol = 'tecnico') {
  const caso = await getCaso(caseId);
  if (!caso) {
    const error = new Error(`Caso no encontrado: ${caseId}`);
    error.status = 404;
    throw error;
  }

  const contexto = await getContextoCuenta(caso.cuenta_id, {
    contactoId: caso.contacto_id,
    productoId: caso.producto_id,
    pedidoId: caso.pedido_id,
  });

  if (!contexto.producto) {
    const error = new Error(`Producto no encontrado para el caso ${caseId}`);
    error.status = 404;
    throw error;
  }

  const casosSimilares = await getCasosSimilares(caso.producto_id, caso.id);
  const numeroCasosPrevios = await contarCasosCuenta(caso.cuenta_id, caso.id);
  const historialCuenta = await getHistorialCuenta(caso.cuenta_id, caso.id);
  const contextoCRM = construirContextoCRM(
    caso,
    contexto,
    casosSimilares,
    numeroCasosPrevios,
    historialCuenta
  );

  // Cálculo determinista de cobertura (plazo de garantía + cortesía por
  // segmento): no depende de la IA ni de la búsqueda semántica, así que
  // se calcula siempre que el caso tenga pedido, independientemente de
  // si hay o no cobertura de conocimiento.
  const coberturaCalculada = evaluarCobertura(caso, contexto.pedido, contexto.cuenta);

  const { consulta, original, limpia, eliminados } = construirConsultaBusqueda(
    caso,
    contexto.producto
  );
  console.log('[analizar] Consulta original:', original);
  console.log('[analizar] Consulta limpia:', limpia);
  console.log(
    '[analizar] Eliminado:',
    eliminados.length > 0 ? eliminados.join(' | ') : '(nada)'
  );
  console.log('[analizar] Consulta de búsqueda:', consulta);

  const dominioRol = rol === 'responsable' ? null : rol;
  const resultadoBusqueda = await buscar(consulta, contexto.producto.referencia, {
    dominioRol,
  });

  if (resultadoBusqueda.motivo !== 'cubierto') {
    const triaje = normalizarTriaje(await llamarTriajeIA(contextoCRM), caso.id);

    return {
      caseId: caso.id,
      cubierto: false,
      motivo: resultadoBusqueda.motivo,
      mejorPuntuacion: resultadoBusqueda.mejorPuntuacion,
      consulta,
      descartado: resultadoBusqueda.descartado,
      contexto: contextoCRM,
      cobertura_calculada: coberturaCalculada,
      triaje,
      escalado: propuestaEscalado(caso, triaje, resultadoBusqueda),
    };
  }

  // Segunda recuperación: la consulta principal describe el problema
  // técnico y casi nunca recupera la política comercial de segmentación
  // (dominio "postventa", sin vocabulario técnico). Si el caso tiene pinta
  // de reclamación/gestión postventa, se lanza una búsqueda adicional
  // centrada en el segmento comercial del cliente y el tipo de gestión.
  const tipoReclamacion = detectarTipoReclamacion(`${caso.asunto} ${caso.descripcion}`);
  let fragmentosPolitica = [];
  if (tipoReclamacion && contextoCRM.cuenta?.segmento_comercial) {
    const consultaPolitica = `cliente ${contextoCRM.cuenta.segmento_comercial} ${tipoReclamacion} margen comercial gestos comerciales`;
    console.log('[analizar] Segunda consulta (marco de decisión comercial):', consultaPolitica);
    const resultadoPolitica = await buscar(consultaPolitica, null, { dominioRol });
    fragmentosPolitica = resultadoPolitica.fragmentos;
    console.log(
      `[analizar] Fragmentos de política recuperados: ${fragmentosPolitica.length}`
    );
  }

  const fragmentosProblema = resultadoBusqueda.fragmentos.map((f) => ({
    ...f,
    _origen_recuperacion: 'problema',
  }));
  const fragmentosPoliticaEtiquetados = fragmentosPolitica.map((f) => ({
    ...f,
    _origen_recuperacion: 'marco_decision',
  }));
  const fragmentosParaModelo = deduplicarFragmentos([
    ...fragmentosProblema,
    ...fragmentosPoliticaEtiquetados,
  ]);

  const propuesta = await llamarOpenAI(contextoCRM, fragmentosParaModelo, coberturaCalculada);

  propuesta.triaje = normalizarTriaje(propuesta.triaje || {}, caso.id);
  propuesta.diagnostico = normalizarDiagnostico(propuesta.diagnostico, propuesta.triaje, caso.id);
  propuesta.decision_postventa = normalizarDecisionPostventa(propuesta.decision_postventa, caso.id);

  const validacion = validarAfirmacionesCorpus(propuesta.afirmaciones || [], fragmentosParaModelo);
  propuesta.afirmaciones = validacion.afirmaciones;
  propuesta.afirmaciones_descartadas = validacion.descartadas;

  propuesta.incoherencias_cobertura = detectarIncoherenciaCobertura(
    propuesta.decision_postventa,
    coberturaCalculada,
    caso.id
  );

  return {
    caseId: caso.id,
    cubierto: true,
    motivo: 'cubierto',
    mejorPuntuacion: resultadoBusqueda.mejorPuntuacion,
    consulta,
    contexto: contextoCRM,
    cobertura_calculada: coberturaCalculada,
    fragmentos: fragmentosParaModelo.map((f) => ({
      id: f.id,
      titulo: f.titulo,
      encabezado: f.encabezado,
      encabezado_padre: f.encabezado_padre || null,
      texto: f.texto,
      puntuacion: f.puntuacion,
      origen_recuperacion: f._origen_recuperacion,
    })),
    ...propuesta,
  };
}

module.exports = { analizarCaso, validarAfirmacionesCorpus };
