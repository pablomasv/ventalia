const SCOPE_LABELS = {
  tecnico: 'Ámbito de conocimiento: técnico + transversal',
  postventa: 'Ámbito de conocimiento: postventa + transversal',
  responsable: 'Ámbito de conocimiento: todos los dominios',
};

const MOTIVO_LABELS = {
  sin_cobertura: 'Sin cobertura en la base de conocimiento',
  sin_cobertura_producto: 'Sin cobertura para el producto del caso',
  cubierto: 'Cubierto',
};

const RESPALDO_LABELS = { corpus: 'Corpus', historico: 'Histórico', modelo: 'Modelo' };
const VEREDICTO_LABELS = { procede: 'Procede', no_procede: 'No procede', pendiente_dato: 'Pendiente de un dato' };

// Mismo enum cerrado que valida el servidor en analizar.js
// (CATEGORIAS_VALIDAS): se usa para poblar el filtro de categoría.
const CATEGORIAS = ['Duda técnica', 'Incidencia', 'Garantía', 'Devolución', 'Repuesto', 'Documentación'];
const PRIORIDADES = ['Alta', 'Media', 'Baja'];

const estado = {
  rol: 'tecnico',
  vista: 'cola',
  casos: [],
  dashboard: null, // datos de /api/responsable, solo para el rol responsable
  casoSeleccionado: null, // fila de la cola (con equipo/origen/pendiente)
  analisis: null, // resultado completo de /api/analizar
  cargando: false,
  reasignando: false,
  resolviendo: false,
  error: null,
  // Filtros de la cola de agente (técnico/postventa): solo afectan a lo
  // que se ve, no a la petición al servidor (la lista completa ya está
  // en estado.casos).
  filtroCola: { prioridad: 'todas', categoria: 'todas', busqueda: '' },
  // Filtros de la cola combinada dentro de la vista de Responsable.
  filtroColaResponsable: { cliente: '', urgencia: 'todas' },
};

const appEl = document.getElementById('app');
const scopeEl = document.getElementById('scope-label');

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Encuentra el fragmento exacto que respalda una afirmación de origen
 * "corpus". Desde que el id de fragmento combina documento + encabezado
 * ("documento#seccion"), el id ya identifica una sección única: no hace
 * falta ningún criterio de desempate adicional.
 */
function fragmentoDeAfirmacion(analisis, afirmacion) {
  return (analisis.fragmentos || []).find((f) => f.id === afirmacion.fuente_id) || null;
}

/**
 * Construye la URL del visor de documentos (documento.html) para un
 * fuente_id de fragmento ("documento#seccion"): abre el documento
 * completo con el navegador situado en esa sección. Se abre en una
 * pestaña nueva (target="_blank") para no perder el caso que se está
 * viendo.
 */
function enlaceDocumento(fuenteId) {
  if (!fuenteId || !fuenteId.includes('#')) return null;
  const [documentoId, slug] = fuenteId.split('#');
  return `/documento.html?doc=${encodeURIComponent(documentoId)}#${encodeURIComponent(slug)}`;
}

/**
 * Muestra, si las hay, las afirmaciones de corpus que la validación del
 * servidor ha descartado (fuente_id inexistente o cifra no anclada en el
 * fragmento citado). Es una nota discreta, no un error: informa de que el
 * sistema ha filtrado una posible alucinación antes de mostrarla.
 */
function renderAfirmacionesDescartadas(analisis) {
  const descartadas = analisis.afirmaciones_descartadas || [];
  if (descartadas.length === 0) return '';

  const items = descartadas
    .map(
      (a) => `<li><span class="descarte__texto">"${escapeHtml(a.texto)}"</span><span class="descarte__motivo">${escapeHtml(a.motivo_descarte)}</span></li>`
    )
    .join('');

  return `<div class="descartes">
    <div class="descartes__header">${descartadas.length} afirmación(es) descartada(s) por la validación</div>
    <ul class="descartes__list">${items}</ul>
  </div>`;
}

/* ---------- Vista técnica: citas numeradas + acciones concretas ---------- */

/**
 * Construye la lista numerada de citas que alimenta el bloque "Respaldo"
 * y a la que apuntan los marcadores de las acciones. Primero Corpus,
 * después CRM. Las afirmaciones de origen "modelo" no se numeran: no
 * son citas, son razonamiento.
 *
 * Corpus se deduplica por `fuente_id`: el modelo a menudo genera varias
 * afirmaciones sobre la misma sección (p. ej. dos frases citando
 * `#3-3-distancias-minimas`). En Respaldo debe aparecer **un** card por
 * fragmento, no uno por frase. Las afirmaciones agrupadas se conservan
 * en `afirmaciones[]` para el emparejamiento léxico de marcadores.
 */
function construirCitasRespaldo(analisis) {
  const citas = [];
  let n = 1;
  const corpusPorFuente = new Map();

  for (const a of (analisis.afirmaciones || []).filter((x) => x.origen === 'corpus')) {
    const clave = a.fuente_id || `__sin_fuente_${n}`;
    const existente = corpusPorFuente.get(clave);
    if (existente) {
      existente.afirmaciones.push(a);
      continue;
    }
    const cita = {
      n: n++,
      tipo: 'corpus',
      afirmacion: a,
      afirmaciones: [a],
      fragmento: fragmentoDeAfirmacion(analisis, a),
    };
    corpusPorFuente.set(clave, cita);
    citas.push(cita);
  }

  // Casos similares del CRM: siempre llevan número de cita, aunque el
  // modelo no haya generado una afirmación sobre ellos. Así las
  // acciones con respaldo "historico" pueden apuntar a estos cards y
  // no caer en campos CRM ajenos (pedido.fecha_entrega, etc.).
  for (const s of analisis.contexto?.casos_similares || []) {
    citas.push({
      n: n++,
      tipo: 'crm',
      subtipo: 'similar',
      campo: 'casos_similares',
      casoId: s.id,
      similar: s,
      afirmacion: {
        texto: `${s.id}: ${s.causa_raiz || s.asunto || ''}`.trim(),
        origen: 'crm',
        campo: 'casos_similares',
      },
    });
  }

  // Resto de afirmaciones CRM (pedido, cuenta…), excluyendo las que
  // ya cubre la lista de casos similares para no numerar dos veces
  // el mismo hecho histórico.
  for (const a of (analisis.afirmaciones || []).filter((x) => x.origen === 'crm')) {
    if (/casos_similares|causa_raiz/i.test(a.campo || '')) continue;
    const casoIdMatch = (a.texto || '').match(/CASE-\d{4}-\d+/);
    citas.push({
      n: n++,
      tipo: 'crm',
      afirmacion: a,
      campo: a.campo || null,
      casoId: casoIdMatch ? casoIdMatch[0] : null,
    });
  }

  return citas;
}

function solapaTexto(a, b) {
  const tokens = String(a || '')
    .toLowerCase()
    .split(/[^a-záéíóúñ0-9]+/i)
    .filter((t) => t.length > 4);
  const haystack = String(b || '').toLowerCase();
  if (!tokens.length) return false;
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  return hits >= Math.min(2, tokens.length);
}

/**
 * Devuelve los números `[n]` de las citas cuyo texto solapa léxicamente
 * con `texto` (ver `solapaTexto`). Generaliza el emparejamiento usado
 * tanto para el dato que falta (vista técnica) como para los factores
 * de la decisión (vista postventa): un mismo criterio de "esta frase
 * parece hablar de lo mismo que esta cita" para todas las acciones.
 */
function textoCitaParaSolape(c) {
  if (c.subtipo === 'similar') {
    const s = c.similar || {};
    return `${s.id || ''} ${s.causa_raiz || ''} ${s.asunto || ''} ${s.resolucion || ''} ${c.afirmacion?.texto || ''}`;
  }
  if (c.tipo !== 'corpus') return c.afirmacion?.texto || '';
  const frases = (c.afirmaciones || [c.afirmacion]).map((a) => a.texto).join(' ');
  return `${frases} ${c.fragmento?.encabezado || ''} ${c.fragmento?.texto || ''}`;
}

function citasQueSolapan(texto, citas, { tipos = ['corpus', 'crm'], max = 2 } = {}) {
  return citas
    .filter((c) => tipos.includes(c.tipo))
    .filter((c) => solapaTexto(texto, textoCitaParaSolape(c)))
    .slice(0, max)
    .map((c) => c.n);
}

function esCitaHistorica(c) {
  return (
    c.tipo === 'crm' &&
    (c.subtipo === 'similar' || /casos_similares|causa_raiz/i.test(c.campo || ''))
  );
}

/**
 * Elige qué citas numeradas sostienen una causa candidata, según su
 * `respaldo`.
 * - historico: solo casos similares / causa_raiz. Nunca campos CRM
 *   ajenos (pedido.fecha_entrega, etc.), aunque no haya solape.
 * - corpus: prioriza solape léxico; si no hay, las citas de corpus.
 */
function citasParaCausa(causa, citas) {
  if (causa.respaldo === 'historico') {
    const historicas = citas.filter(esCitaHistorica);
    const relacionadas = historicas.filter((c) => solapaTexto(causa.causa, textoCitaParaSolape(c)));
    return (relacionadas.length ? relacionadas : historicas).slice(0, 2);
  }

  if (causa.respaldo === 'corpus') {
    const corpus = citas.filter((c) => c.tipo === 'corpus');
    const relacionadas = corpus.filter((c) => solapaTexto(causa.causa, textoCitaParaSolape(c)));
    return (relacionadas.length ? relacionadas : corpus).slice(0, 2);
  }

  return [];
}

/**
 * Dato que el agente debe pedir al cliente. Preferimos `falta_dato` del
 * modelo; si viene vacío pero el CRM dice que no hay informe de puesta
 * en marcha y el propio análisis (borrador, siguiente_accion o
 * afirmaciones) lo menciona, lo tratamos como dato pendiente implícito.
 * Sin eso, el borrador puede pedir el informe y la lista de acciones no
 * lo refleja (bug visto en CASE-2026-018374).
 */
function datoPendienteEfectivo(analisis) {
  if (analisis.falta_dato) return String(analisis.falta_dato).trim();

  const sinInforme =
    analisis.contexto?.pedido != null &&
    analisis.contexto.pedido.informe_puesta_en_marcha === false;
  if (!sinInforme) return null;

  const texto = [
    analisis.siguiente_accion,
    analisis.borrador,
    ...(analisis.afirmaciones || []).map((a) => a.texto),
  ]
    .filter(Boolean)
    .join(' ');

  if (!/informe\s+de\s+puesta\s+en\s+marcha|puesta\s+en\s+marcha/i.test(texto)) {
    return null;
  }

  return 'Informe de puesta en marcha firmado por el instalador';
}

/**
 * Convierte el diagnóstico + dato pendiente + siguiente_accion en una
 * lista ordenada de acciones ejecutables. No llama al modelo: reexpresa
 * lo que ya viene en el análisis como "qué hacer", no como "qué pienso".
 */
function construirAccionesTecnicas(analisis, citas) {
  const acciones = [];
  const diagnostico = analisis.diagnostico || {};
  const causas = diagnostico.causas_candidatas || [];
  const datoPendiente = datoPendienteEfectivo(analisis);
  const datoInferido = Boolean(datoPendiente && !analisis.falta_dato);

  if (datoPendiente) {
    acciones.push({
      destacada: true,
      verbo: 'Solicitar al cliente',
      objeto: datoPendiente,
      porque: datoInferido
        ? 'El CRM no registra informe de puesta en marcha y el análisis lo requiere para tramitar la reclamación.'
        : 'Sin este dato no se puede cerrar el diagnóstico con la información disponible.',
      citasNums: citasQueSolapan(datoPendiente, citas, { tipos: ['corpus'] }),
    });
  }

  causas.forEach((causa) => {
    const respaldo = RESPALDO_LABELS[causa.respaldo] || causa.respaldo;
    acciones.push({
      destacada: false,
      verbo: 'Verificar',
      objeto: causa.causa,
      porque: `Hipótesis: ${causa.causa}. La sostiene el ${String(respaldo).toLowerCase()}.`,
      citasNums: citasParaCausa(causa, citas).map((c) => c.n),
    });
  });

  if (analisis.siguiente_accion) {
    const siguiente = String(analisis.siguiente_accion);
    const yaCubiertaPorDatoPendiente =
      datoPendiente &&
      (siguiente.toLowerCase().includes(datoPendiente.toLowerCase().slice(0, 24)) ||
        (/puesta\s+en\s+marcha/i.test(siguiente) && /puesta\s+en\s+marcha/i.test(datoPendiente)));
    if (!yaCubiertaPorDatoPendiente) {
      acciones.push({
        destacada: false,
        verbo: 'Ejecutar',
        objeto: siguiente,
        porque: 'Acción concreta propuesta al cierre del diagnóstico.',
        citasNums: [],
      });
    }
  }

  if (acciones.length === 0) {
    acciones.push({
      destacada: false,
      verbo: 'Revisar',
      objeto: 'el caso con la información disponible',
      porque: 'No hay un diagnóstico estructurado ni un dato pendiente declarado.',
      citasNums: [],
    });
  }

  // El aviso de orden alterado no va mezclado en el "porqué" (ese es
  // el razonamiento de la hipótesis): es una decisión del sistema
  // sobre el orden de verificación, y se marca aparte en la primera
  // acción de la lista para que se vea al abrir el bloque.
  if (diagnostico.orden_alterado_por_historico && acciones.length) {
    acciones[0].avisoOrdenHistorico =
      diagnostico.motivo_orden ||
      'El histórico del CRM ha alterado el orden de verificación respecto al que sugiere la documentación.';
  }

  return acciones;
}

function renderMarcadoresCita(nums) {
  if (!nums?.length) return '';
  return nums
    .map(
      (n) =>
        `<a class="cita-marker" href="#cita-${n}" title="Ir a la cita ${n}">[${n}]</a>`
    )
    .join(' ');
}

/**
 * Renderiza una lista de "acciones propuestas" (bloque 2 en la vista
 * técnica, bloque 3 en la de postventa). Cada acción es {destacada,
 * verbo, objeto, porque, citasNums} y, opcionalmente en postventa,
 * `factores`: una lista de {descripcion, polaridad, citasNums} que se
 * muestra bajo el porqué cuando la acción es el veredicto de la
 * decisión (ver construirAccionesPostventa).
 */
function renderListaAcciones(acciones) {
  if (!acciones.length) return '<p class="empty">Sin acciones propuestas</p>';

  return `<ol class="acciones-list">${acciones
    .map((a) => {
      const factoresHtml = a.factores?.length
        ? `<ul class="factores-list factores-list--accion">${a.factores
            .map(
              (f) => `<li class="factor-item factor-item--${f.polaridad}">
            <span class="factor-item__tag">${f.polaridad === 'a_favor' ? 'A favor' : 'En contra'}</span>
            <span>${escapeHtml(f.descripcion)} ${renderMarcadoresCita(f.citasNums)}</span>
          </li>`
            )
            .join('')}</ul>`
        : '';

      // Marca de sistema: el histórico del CRM reordenó las causas
      // respecto a la documentación. No es el "porqué" de la acción
      // (ese sigue debajo): es una decisión de enrutado del diagnóstico.
      const avisoOrden = a.avisoOrdenHistorico
        ? `<div class="accion-item__aviso-orden">
            <span class="accion-item__aviso-orden-tag">Orden alterado por el histórico</span>
            <span class="accion-item__aviso-orden-texto">${escapeHtml(a.avisoOrdenHistorico)}</span>
          </div>`
        : '';

      return `<li class="accion-item${a.destacada ? ' accion-item--destacada' : ''}">
      <div class="accion-item__que"><span class="accion-item__verbo">${escapeHtml(a.verbo)}</span> ${escapeHtml(a.objeto)}</div>
      ${avisoOrden}
      ${a.porque ? `<p class="accion-item__porque">${escapeHtml(a.porque)} ${renderMarcadoresCita(a.citasNums)}</p>` : ''}
      ${factoresHtml}
    </li>`;
    })
    .join('')}</ol>`;
}

/**
 * Única acción cuando el caso no tiene cobertura de conocimiento:
 * escalar al equipo propuesto por el triaje. Común a la vista técnica
 * y a la de postventa, porque en ambas el modelo no ha sido consultado
 * y no hay diagnóstico ni decisión que traducir a acciones.
 */
function construirAccionEscalado(analisis) {
  const destinatario = analisis.triaje?.equipo || 'Responsable';
  return [
    {
      destacada: true,
      verbo: 'Escalar',
      objeto: `al equipo ${destinatario} para revisión manual`,
      porque:
        analisis.escalado?.descripcion ||
        'Sin cobertura de conocimiento: no se ha generado una propuesta citada.',
      citasNums: [],
    },
  ];
}

/* ---------- Cobertura calculada: dato del sistema, no de la IA ---------- */

/**
 * Resumen de los 4 valores de COBERTURA_CALCULADA que se muestran
 * dentro del bloque "Contexto de cliente y pedido" (vista postventa):
 * meses desde la entrega, si está dentro de plazo, el margen de
 * cortesía del segmento y si la cortesía es aplicable. El segmento
 * comercial NO se repite aquí: ya aparece una vez en
 * `renderClientContext`. Se marca con la etiqueta "Cálculo del
 * sistema" para no confundirse con datos crudos del CRM ni con
 * afirmaciones de la IA (son números que calcula `cobertura.js`, no
 * algo que el modelo haya redactado o deducido), y cada valor conserva
 * su enlace a la sección de corpus que lo respalda.
 */
function renderCoberturaCalculadaResumen(cobertura) {
  if (!cobertura) return '';

  if (!cobertura.aplicable) {
    return `<div class="cobertura-calculada cobertura-calculada--na cobertura-calculada--embed">
      <span class="cobertura-calculada__tag">Cálculo del sistema</span> ${escapeHtml(cobertura.motivo)}
    </div>`;
  }

  const filas = [
    { label: 'Meses desde la entrega', valor: cobertura.meses_desde_entrega.valor, fuente: cobertura.meses_desde_entrega.fuente_id },
    {
      label: `¿Dentro de plazo? (garantía ${cobertura.plazo_garantia_meses.valor} meses)`,
      valor: cobertura.dentro_de_plazo.valor ? 'Sí' : 'No',
      fuente: cobertura.dentro_de_plazo.fuente_id,
    },
    { label: 'Margen de cortesía del segmento', valor: `${cobertura.margen_cortesia_meses.valor} mes(es)`, fuente: cobertura.margen_cortesia_meses.fuente_id },
    { label: '¿Cortesía aplicable?', valor: cobertura.cortesia_aplicable.valor ? 'Sí' : 'No', fuente: cobertura.cortesia_aplicable.fuente_id },
  ];

  const filasHtml = filas
    .map((f) => {
      const href = f.fuente ? enlaceDocumento(f.fuente) : null;
      const cita = href
        ? ` <a href="${href}" target="_blank" rel="noopener noreferrer" class="cobertura-calculada__fuente" title="Abrir fragmento en una pestaña nueva">[${escapeHtml(f.fuente)}]</a>`
        : '';
      return `<div class="cobertura-calculada__row">
      <span class="cobertura-calculada__label">${escapeHtml(f.label)}</span>
      <span class="cobertura-calculada__value">${escapeHtml(String(f.valor))}${cita}</span>
    </div>`;
    })
    .join('');

  return `<div class="cobertura-calculada cobertura-calculada--embed">
    <div class="cobertura-calculada__header"><span class="cobertura-calculada__tag">Cálculo del sistema</span> No son datos del CRM ni redacción de la IA</div>
    ${filasHtml}
  </div>`;
}

/**
 * Aviso cuando decision_postventa.veredicto contradice los hechos de
 * COBERTURA_CALCULADA (ver detectarIncoherenciaCobertura en analizar.js).
 * No corrige nada: solo avisa al agente de que revise el veredicto.
 */
function renderIncoherenciaCobertura(incoherencias) {
  if (!incoherencias || incoherencias.length === 0) return '';
  return `<div class="incoherencia-alert">
    <div class="incoherencia-alert__header">Aviso: el veredicto de la IA no coincide con el cálculo del sistema</div>
    <ul>${incoherencias.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
  </div>`;
}

/* ---------- Contextos de la columna lateral / bloque de cliente ---------- */

/**
 * Contexto de cliente y pedido en primer plano para la vista de
 * postventa: no es una columna lateral, es un bloque dentro del
 * propio flujo de decisión (cuenta, país, segmento comercial —
 * aparece una única vez, aquí—, antigüedad como cliente, contrato de
 * mantenimiento, casos previos y datos crudos del pedido). Los meses
 * transcurridos desde la entrega NO se muestran en esta cuadrícula:
 * viven en `renderCoberturaCalculadaResumen`, marcados como cálculo
 * del sistema, para no mezclar dato crudo del CRM con dato derivado.
 */
function renderClientContext(ctx) {
  const cuenta = ctx?.cuenta;
  if (!cuenta) return '<p class="empty">Sin contexto de cliente</p>';
  const pedido = ctx?.pedido;

  return `<div class="client-context">
    <div class="ctx-block"><div class="ctx-block__label">Cuenta</div><div class="ctx-block__value">${escapeHtml(cuenta.nombre)}</div></div>
    <div class="ctx-block"><div class="ctx-block__label">País</div><div class="ctx-block__value">${escapeHtml(cuenta.pais)}</div></div>
    <div class="ctx-block"><div class="ctx-block__label">Segmento comercial</div><div class="ctx-block__value">${escapeHtml(cuenta.segmento_comercial || '—')}${cuenta.facturacion_ultimos_12m != null ? `<br><span style="font-size:0.75rem;color:var(--text-muted)">${cuenta.facturacion_ultimos_12m.toLocaleString('es-ES')} € últimos 12 meses</span>` : ''}</div></div>
    <div class="ctx-block"><div class="ctx-block__label">Cliente desde</div><div class="ctx-block__value">${cuenta.antiguedad_cliente_anios != null ? `${cuenta.antiguedad_cliente_anios} años` : '—'}</div></div>
    <div class="ctx-block"><div class="ctx-block__label">Contrato de mantenimiento</div><div class="ctx-block__value">${cuenta.contrato_mantenimiento ? 'Sí' : 'No'}</div></div>
    <div class="ctx-block"><div class="ctx-block__label">Casos previos</div><div class="ctx-block__value">${cuenta.numero_casos_previos ?? '—'}</div></div>
    <div class="ctx-block"><div class="ctx-block__label">Pedido</div><div class="ctx-block__value">${
      pedido
        ? `Entrega: ${escapeHtml(pedido.fecha_entrega)}<br>Puesta en marcha: ${pedido.informe_puesta_en_marcha ? 'sí' : 'no'}`
        : 'No asociado al caso'
    }</div></div>
  </div>`;
}

/**
 * Construye la lista de eventos de la cronología de un cliente a
 * partir de datos reales del CRM (nunca inventados ni calculados por
 * IA): alta como cliente, entregas de pedidos y casos (abiertos y
 * cerrados) de la cuenta. Ordenados de más antiguo a más reciente.
 */
function construirEventosCliente(ctx) {
  const eventos = [];

  if (ctx.cuenta?.cliente_desde) {
    eventos.push({
      fecha: ctx.cuenta.cliente_desde,
      tipo: 'alta',
      titulo: 'Alta como cliente',
      detalle: ctx.cuenta.nombre,
    });
  }

  (ctx.historial_cuenta?.pedidos || []).forEach((p) => {
    eventos.push({
      fecha: p.fecha_entrega,
      tipo: 'pedido',
      titulo: `Entrega ${p.id}`,
      detalle: p.producto_referencia || 'Producto no identificado',
    });
  });

  (ctx.historial_cuenta?.casos || []).forEach((c) => {
    eventos.push({
      id: c.id,
      fecha: c.creado,
      tipo: c.es_actual ? 'actual' : c.estado === 'Cerrado' ? 'cerrado' : 'abierto',
      titulo: c.id,
      detalle: c.asunto,
      causaRaiz: c.causa_raiz,
      resolucion: c.resolucion,
    });
  });

  return eventos
    .filter((e) => e.fecha)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
}

/**
 * Cronología del cliente: eje ordenado por fecha (de más antiguo a más
 * reciente), con los eventos por los que ha pasado la cuenta. El
 * espaciado entre puntos es uniforme por posición, no proporcional al
 * tiempo transcurrido: la mayoría de la actividad de un cliente se
 * concentra en los últimos meses, y una escala proporcional real
 * amontona ahí casi todos los eventos, haciéndolos ilegibles. La fecha
 * exacta se indica en la etiqueta de cada punto. Solo en la vista de
 * postventa, donde el contexto de cliente es el centro de la decisión.
 */
function renderTimelineCliente(ctx) {
  const eventos = construirEventosCliente(ctx);
  if (eventos.length === 0) return '';

  const anchoMinimo = Math.max(560, eventos.length * 95);

  const puntos = eventos
    .map((e, i) => {
      const pct = eventos.length > 1 ? (i / (eventos.length - 1)) * 100 : 50;
      const posicion = i % 2 === 0 ? 'arriba' : 'abajo';
      const fechaCorta = new Date(e.fecha).toLocaleDateString('es-ES', {
        day: '2-digit',
        month: 'short',
        year: '2-digit',
      });
      return `<div class="timeline__evento timeline__evento--${e.tipo} timeline__evento--${posicion}"
        style="left:${pct.toFixed(2)}%"
        data-id="${escapeHtml(e.id || '')}"
        data-tipo="${e.tipo}"
        data-detalle="${escapeHtml(e.detalle || '')}"
        data-causa="${escapeHtml(e.causaRaiz || '')}"
        data-resolucion="${escapeHtml(e.resolucion || '')}"
        title="${escapeHtml(e.detalle || '')}">
        <span class="timeline__dot"></span>
        <div class="timeline__label">
          <span class="timeline__label-fecha">${fechaCorta}</span>
          <span class="timeline__label-titulo">${escapeHtml(e.titulo)}</span>
        </div>
      </div>`;
    })
    .join('');

  return `<div class="timeline-wrap">
    <div class="timeline" style="min-width:${anchoMinimo}px">${puntos}</div>
  </div>
  <div class="timeline-legend">
    <span class="timeline-legend__item"><span class="timeline__dot timeline__dot--alta"></span> Alta como cliente</span>
    <span class="timeline-legend__item"><span class="timeline__dot timeline__dot--pedido"></span> Entrega de pedido</span>
    <span class="timeline-legend__item"><span class="timeline__dot timeline__dot--abierto"></span> Caso abierto</span>
    <span class="timeline-legend__item"><span class="timeline__dot timeline__dot--cerrado"></span> Caso cerrado</span>
    <span class="timeline-legend__item"><span class="timeline__dot timeline__dot--actual"></span> Este caso</span>
  </div>`;
}

/* ---------- Vista técnica rediseñada: 4 bloques ---------- */

function opcionesSelect(valores, seleccionado) {
  return valores
    .map(
      (v) =>
        `<option value="${escapeHtml(v)}"${v === seleccionado ? ' selected' : ''}>${escapeHtml(v)}</option>`
    )
    .join('');
}

/**
 * Datos recogidos en el formulario asistido (paso 2), con enlace a la
 * sección del corpus que motivó cada pregunta.
 */
function renderDatosRecogidos(analisis) {
  const items =
    analisis.contexto?.datos_recogidos ||
    analisis.contexto?.caso?.datos_recogidos ||
    [];
  if (!Array.isArray(items) || !items.length) return '';

  const filas = items
    .map((d) => {
      const href = d.fuente_id ? enlaceDocumento(d.fuente_id) : null;
      const fuente = href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.fuente_id)}</a>`
        : escapeHtml(d.fuente_id || '—');
      const respuesta =
        d.respuesta != null && String(d.respuesta).trim() !== ''
          ? escapeHtml(d.respuesta)
          : '<span class="muted">(sin respuesta)</span>';
      return `<div class="dato-recogido">
        <div class="dato-recogido__pregunta">${escapeHtml(d.pregunta || '—')}</div>
        <div class="dato-recogido__respuesta">${respuesta}</div>
        <div class="dato-recogido__fuente">Fuente: ${fuente}</div>
      </div>`;
    })
    .join('');

  return `<div class="datos-recogidos">
    <div class="ctx-block__label">Datos recogidos en el formulario asistido</div>
    ${filas}
  </div>`;
}

/**
 * Bloque 1 — Detalle del caso + etiquetas de triaje editables
 * (categoría, prioridad, equipo) arriba del todo. Idéntico en la
 * vista técnica y en la de postventa: mismo caso, mismos datos.
 */
function renderBloqueDetalleCaso(fila, analisis) {
  const ctx = analisis.contexto || {};
  const cuenta = ctx.cuenta || {};
  const contacto = ctx.contacto || {};
  const producto = ctx.producto || {};
  const pedido = ctx.pedido || {};
  const caso = ctx.caso || {};
  const canal = caso.canal || fila.canal || '';
  const triaje = {
    categoria: fila.categoria || analisis.triaje?.categoria || '',
    prioridad: fila.prioridad || analisis.triaje?.prioridad || '',
    equipo: fila.equipo || analisis.triaje?.equipo || '',
  };
  const origenTexto =
    fila.origen_triaje === 'agente'
      ? 'Corregido por agente'
      : fila.pendiente
        ? 'Pendiente de triaje'
        : 'Propuesto por IA';
  const marcaFormulario =
    canal === 'formulario'
      ? '<span class="canal-tag canal-tag--formulario">Entrada por formulario asistido</span>'
      : '';

  return `<section class="tech-block">
    <header class="tech-block__head">
      <h3 class="tech-block__title">1 · Detalle del caso</h3>
      <span class="tech-block__meta">${renderOrigenRespuesta(analisis)} · ${escapeHtml(origenTexto)}${marcaFormulario ? ` · ${marcaFormulario}` : ''}</span>
    </header>
    <div class="tech-block__body">
      <div class="triaje-tags">
        <label class="triaje-tag">
          <span>Categoría</span>
          <select id="triaje-categoria" ${fila.pendiente ? 'disabled' : ''}>${opcionesSelect(CATEGORIAS, triaje.categoria)}</select>
        </label>
        <label class="triaje-tag">
          <span>Prioridad</span>
          <select id="triaje-prioridad" ${fila.pendiente ? 'disabled' : ''}>${opcionesSelect(PRIORIDADES, triaje.prioridad)}</select>
        </label>
        <label class="triaje-tag">
          <span>Equipo</span>
          <select id="triaje-equipo" ${fila.pendiente ? 'disabled' : ''}>${opcionesSelect(['Técnico', 'Postventa'], triaje.equipo)}</select>
        </label>
      </div>
      <div class="caso-detalle-grid">
        <div class="ctx-block"><div class="ctx-block__label">Referencia</div><div class="ctx-block__value ref">${escapeHtml(fila.id)}</div></div>
        <div class="ctx-block"><div class="ctx-block__label">Asunto</div><div class="ctx-block__value">${escapeHtml(fila.asunto || caso.asunto || '—')}</div></div>
        <div class="ctx-block"><div class="ctx-block__label">Cuenta</div><div class="ctx-block__value">${escapeHtml(cuenta.nombre || fila.cuenta_nombre || '—')}${cuenta.segmento_comercial ? ` <span class="segmento-pill">${escapeHtml(cuenta.segmento_comercial)}</span>` : ''}</div></div>
        <div class="ctx-block"><div class="ctx-block__label">Contacto</div><div class="ctx-block__value">${escapeHtml(contacto.nombre || '—')}${contacto.cargo ? `<br><span class="muted">${escapeHtml(contacto.cargo)}</span>` : ''}</div></div>
        <div class="ctx-block"><div class="ctx-block__label">Producto</div><div class="ctx-block__value">${escapeHtml(producto.referencia || fila.producto_referencia || '—')}${producto.nombre ? `<br><span class="muted">${escapeHtml(producto.nombre)}</span>` : ''}</div></div>
        <div class="ctx-block"><div class="ctx-block__label">Nº de serie</div><div class="ctx-block__value">${escapeHtml(pedido.numero_serie || '—')}</div></div>
        <div class="ctx-block"><div class="ctx-block__label">Canal</div><div class="ctx-block__value">${escapeHtml(canal || '—')}${canal === 'formulario' ? ' <span class="canal-tag canal-tag--formulario">asistido</span>' : ''}</div></div>
        <div class="ctx-block"><div class="ctx-block__label">Antigüedad</div><div class="ctx-block__value">${escapeHtml(fila.antiguedad || '—')}</div></div>
      </div>
      <div class="caso-descripcion">
        <div class="ctx-block__label">Descripción del cliente</div>
        <p>${escapeHtml(caso.descripcion || fila.descripcion || '—')}</p>
      </div>
      ${renderDatosRecogidos(analisis)}
    </div>
  </section>`;
}

function renderRespaldoCorpus(citas) {
  const items = citas.filter((c) => c.tipo === 'corpus');
  if (!items.length) return '<p class="empty">Sin citas de corpus</p>';

  return items
    .map((c) => {
      const frag = c.fragmento;
      const fuenteId = c.afirmacion.fuente_id;
      const href = enlaceDocumento(fuenteId);
      const titulo = frag?.titulo || fuenteId;
      const seccion = frag?.encabezado || '';
      const score =
        frag?.puntuacion != null
          ? `<span class="cita-card__score">similitud ${frag.puntuacion.toFixed(2)}</span>`
          : '';
      const enlace = href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">Abrir sección</a>`
        : '';
      const texto = frag?.texto
        ? `<div class="cita-card__texto">${escapeHtml(frag.texto)}</div>`
        : `<div class="cita-card__texto muted">${escapeHtml(c.afirmacion.texto)}</div>`;

      // Si varias afirmaciones citaban la misma sección, las listamos
      // debajo del fragmento para no perder el matiz, sin repetir el texto
      // del documento.
      const otrasFrases = (c.afirmaciones || []).slice(1);
      const frasesHtml = otrasFrases.length
        ? `<ul class="cita-card__frases">${[c.afirmacion, ...otrasFrases]
            .map((a) => `<li>${escapeHtml(a.texto)}</li>`)
            .join('')}</ul>`
        : '';

      return `<article class="cita-card cita-card--corpus" id="cita-${c.n}">
        <div class="cita-card__num">[${c.n}]</div>
        <div class="cita-card__body">
          <div class="cita-card__titulo">${escapeHtml(titulo)}${seccion ? ` · ${escapeHtml(seccion)}` : ''} ${score}</div>
          ${texto}
          ${frasesHtml}
          <div class="cita-card__footer">${enlace}</div>
        </div>
      </article>`;
    })
    .join('');
}

/**
 * Casos históricos del CRM (mismo producto, cerrados, con causa_raiz).
 * Si vienen como citas numeradas (`subtipo: 'similar'`), cada card lleva
 * su `[n]` para que las acciones con respaldo "historico" enlacen aquí.
 * Si no hay citas (p. ej. vista sin cobertura sin construirCitasRespaldo),
 * se pinta igual desde `contexto.casos_similares`, sin número.
 */
function renderCasosSimilaresCrm(analisis, citas = []) {
  const desdeCitas = citas.filter((c) => c.subtipo === 'similar');
  const similares = desdeCitas.length
    ? desdeCitas.map((c) => ({ ...c.similar, _n: c.n }))
    : [...(analisis.contexto?.casos_similares || [])]
        .sort((a, b) => new Date(b.creado) - new Date(a.creado))
        .map((s) => ({ ...s, _n: null }));

  if (!similares.length) {
    return `<div class="casos-similares">
      <h5 class="casos-similares__title">Casos similares del CRM</h5>
      <p class="empty">Ningún caso cerrado del mismo producto con causa raíz registrada</p>
    </div>`;
  }

  const items = similares
    .map((s) => {
      const fecha = s.creado
        ? new Date(s.creado).toLocaleDateString('es-ES', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
        : '—';
      const numHtml =
        s._n != null ? `<span class="caso-similar-card__num">[${s._n}]</span>` : '';
      const idAttr = s._n != null ? ` id="cita-${s._n}"` : '';
      return `<article class="caso-similar-card"${idAttr}>
        <div class="caso-similar-card__head">
          ${numHtml}
          <button type="button" class="btn--link-active cita-caso-link"
            data-caso="${escapeHtml(s.id)}"
            data-asunto="${escapeHtml(s.asunto || '')}"
            data-causa="${escapeHtml(s.causa_raiz || '')}"
            data-resolucion="${escapeHtml(s.resolucion || '')}">${escapeHtml(s.id)}</button>
          <span class="caso-similar-card__fecha">${escapeHtml(fecha)}</span>
        </div>
        <div class="caso-similar-card__asunto">${escapeHtml(s.asunto || '—')}</div>
        <div class="caso-similar-card__campo"><span>Causa raíz</span> ${escapeHtml(s.causa_raiz || '—')}</div>
        <div class="caso-similar-card__campo"><span>Resolución</span> ${escapeHtml(s.resolucion || '—')}</div>
      </article>`;
    })
    .join('');

  return `<div class="casos-similares">
    <h5 class="casos-similares__title">Casos similares del CRM</h5>
    <p class="casos-similares__hint">Histórico del mismo producto · no es similitud semántica del corpus</p>
    ${items}
  </div>`;
}

function renderRespaldoCrm(citas, analisis) {
  // Siempre: los casos similares del CRM (con número de cita si aplica).
  let html = renderCasosSimilaresCrm(analisis, citas);

  // Otras afirmaciones CRM (pedido, cuenta…): no volver a pintar los
  // casos similares, que ya salen arriba con su [n].
  const items = citas.filter((c) => c.tipo === 'crm' && c.subtipo !== 'similar');
  if (!items.length) return html;

  html += items
    .map((c) => {
      return `<article class="cita-card cita-card--crm" id="cita-${c.n}">
        <div class="cita-card__num">[${c.n}]</div>
        <div class="cita-card__body">
          <div class="cita-card__titulo">Campo: ${escapeHtml(c.campo || 'crm')}</div>
          <div class="cita-card__texto">${escapeHtml(c.afirmacion.texto)}</div>
        </div>
      </article>`;
    })
    .join('');

  return html;
}

function renderBloqueRespaldo(analisis, citas, { numero = 3 } = {}) {
  return `<section class="tech-block">
    <header class="tech-block__head">
      <h3 class="tech-block__title">${numero} · Respaldo</h3>
    </header>
    <div class="tech-block__body">
      <div class="respaldo-grupo respaldo-grupo--corpus">
        <h4 class="respaldo-grupo__title">Conocimiento (Corpus)</h4>
        ${renderRespaldoCorpus(citas)}
      </div>
      <div class="respaldo-grupo respaldo-grupo--crm">
        <h4 class="respaldo-grupo__title">Contexto (CRM)</h4>
        ${renderRespaldoCrm(citas, analisis)}
      </div>
      ${renderAfirmacionesDescartadas(analisis)}
    </div>
  </section>`;
}

function renderBloqueRespaldoSinCobertura(analisis, { numero = 3 } = {}) {
  const d = analisis.descartado;
  const frag = d?.fragmento;
  return `<section class="tech-block">
    <header class="tech-block__head">
      <h3 class="tech-block__title">${numero} · Respaldo</h3>
    </header>
    <div class="tech-block__body">
      <div class="no-cover no-cover--inline">
        <p><strong>Motivo:</strong> <span class="motivo-tag">${escapeHtml(analisis.motivo)}</span> — ${escapeHtml(MOTIVO_LABELS[analisis.motivo] || analisis.motivo)}</p>
        <p><strong>Mejor puntuación:</strong> ${analisis.mejorPuntuacion?.toFixed(4) ?? '—'}</p>
        ${
          frag
            ? `<p><strong>Fragmento descartado:</strong> ${escapeHtml(frag.encabezado || frag.id)} — puntuación ${frag.puntuacion?.toFixed(4) ?? '—'}</p>
        <p><strong>Por qué:</strong> ${escapeHtml(d.motivo || 'No supera los filtros de producto/dominio o el umbral.')}</p>
        ${frag.texto ? `<div class="cita-card__texto">${escapeHtml(frag.texto)}</div>` : ''}`
            : '<p>No hay fragmento descartado que mostrar.</p>'
        }
        <p class="no-cover__note">No se ha consultado al modelo de lenguaje para redactar una respuesta técnica. No hay citas de respaldo.</p>
      </div>
      <div class="respaldo-grupo respaldo-grupo--crm">
        <h4 class="respaldo-grupo__title">Contexto (CRM)</h4>
        ${renderCasosSimilaresCrm(analisis)}
      </div>
    </div>
  </section>`;
}

/**
 * Asegura que el borrador menciona al contacto por su nombre. Si el
 * modelo ya lo puso, no se toca; si no, se antepone un saludo. Solo
 * tiene sentido cuando hay un borrador real (caso cubierto): si no hay
 * cobertura, el modelo nunca se ha llamado y no existe `analisis.borrador`
 * — anteponer un saludo a un texto vacío dejaría un "borrador" que solo
 * es un saludo suelto, más engañoso que no mostrar nada.
 */
function borradorConContacto(analisis) {
  const borrador = analisis.borrador || '';
  const nombre = analisis.contexto?.contacto?.nombre;
  if (!borrador.trim()) return '';
  if (!nombre || borrador.includes(nombre)) return borrador;
  return `Estimado/a ${nombre},\n\n${borrador}`;
}

function renderBloqueRespuesta(analisis, { conBotones = true, numero = 4 } = {}) {
  const borrador = borradorConContacto(analisis);
  const sinBorrador = !borrador.trim();
  return `<section class="tech-block">
    <header class="tech-block__head">
      <h3 class="tech-block__title">${numero} · Respuesta sugerida al cliente</h3>
    </header>
    <div class="tech-block__body">
      <textarea id="borrador" class="textarea-draft"${sinBorrador ? ' placeholder="Sin borrador: el caso no tiene cobertura de conocimiento, así que no se ha consultado al modelo. Redacta la respuesta a mano o espera a la revisión manual del escalado."' : ''}>${escapeHtml(borrador)}</textarea>
      ${
        conBotones
          ? `<div class="respuesta-acciones">
        <button type="button" class="btn" id="btn-copiar-borrador">Copiar</button>
        <button type="button" class="btn btn--primary" id="btn-respondido">Marcar como respondido</button>
      </div>`
          : ''
      }
    </div>
  </section>`;
}

function renderVistaTecnico(fila, analisis) {
  const forzarBtn = `<button type="button" class="btn" id="btn-forzar">Forzar reanálisis</button>`;
  const toolbar = `<div class="tech-toolbar">
    <button type="button" class="btn" id="btn-volver">← Volver a la cola</button>
    <div class="tech-toolbar__right">
      ${forzarBtn}
      <button type="button" class="btn btn--resolver" id="btn-resolver" ${estado.resolviendo ? 'disabled' : ''}>Resolver caso</button>
    </div>
  </div>`;

  if (analisis.cubierto === false) {
    const acciones = construirAccionEscalado(analisis);

    return `<div class="detail-tecnico-v2">
      ${toolbar}
      ${renderBloqueDetalleCaso(fila, analisis)}
      <section class="tech-block tech-block--principal">
        <header class="tech-block__head">
          <h3 class="tech-block__title">2 · Acciones propuestas</h3>
        </header>
        <div class="tech-block__body">${renderListaAcciones(acciones)}</div>
      </section>
      ${renderBloqueRespaldoSinCobertura(analisis)}
      ${renderBloqueRespuesta(analisis, { conBotones: true })}
    </div>`;
  }

  const citas = construirCitasRespaldo(analisis);
  const acciones = construirAccionesTecnicas(analisis, citas);

  return `<div class="detail-tecnico-v2">
    ${toolbar}
    ${renderBloqueDetalleCaso(fila, analisis)}
    <section class="tech-block tech-block--principal">
      <header class="tech-block__head">
        <h3 class="tech-block__title">2 · Acciones propuestas</h3>
        <span class="tech-block__meta">Qué hacer, no un análisis</span>
      </header>
      <div class="tech-block__body">${renderListaAcciones(acciones)}</div>
    </section>
    ${renderBloqueRespaldo(analisis, citas)}
    ${renderBloqueRespuesta(analisis)}
  </div>`;
}

/**
 * Bloque 2 (solo vista postventa) — Contexto de cliente y pedido.
 * Junta lo que antes eran dos bloques distintos: el contexto de
 * cliente (cuenta, segmento, antigüedad, contrato, casos previos, con
 * su cronología) y el antiguo bloque independiente "Cálculo del
 * sistema" (los 4 valores de cobertura calculados). El segmento
 * comercial solo aparece una vez, dentro de `renderClientContext`; los
 * meses transcurridos desde la entrega solo aparecen dentro de
 * `renderCoberturaCalculadaResumen`, marcados como cálculo del
 * sistema, no como dato crudo de `pedido`.
 */
function renderBloqueContextoClientePedido(analisis) {
  const ctx = analisis.contexto || {};
  return `<section class="tech-block">
    <header class="tech-block__head">
      <h3 class="tech-block__title">2 · Contexto de cliente y pedido</h3>
    </header>
    <div class="tech-block__body">
      ${renderClientContext(ctx)}
      ${renderCoberturaCalculadaResumen(analisis.cobertura_calculada)}
      ${renderTimelineCliente(ctx)}
    </div>
  </section>`;
}

/**
 * Acciones propuestas de la vista postventa. La decisión
 * (decision_postventa.veredicto) ya no es un bloque aparte: es la
 * primera acción, con su motivo como "porqué" y sus factores a
 * favor/en contra colgando de esa misma acción, cada uno con sus
 * propios marcadores de cita. Después, si hay una siguiente_accion
 * distinta, se añade como segunda acción (igual que en la vista
 * técnica).
 */
function construirAccionesPostventa(analisis, citas) {
  const decision = analisis.decision_postventa || {};
  const acciones = [];

  const factores = (decision.factores || []).map((f) => ({
    ...f,
    citasNums: citasQueSolapan(f.descripcion, citas),
  }));

  const VERBOS = {
    procede: 'Proceder con',
    no_procede: 'Denegar',
    pendiente_dato: 'Solicitar al cliente',
  };
  const OBJETOS = {
    procede: 'la solicitud del cliente',
    no_procede: 'la reclamación, según lo documentado',
    pendiente_dato: analisis.falta_dato || 'el dato que falta para decidir',
  };

  acciones.push({
    destacada: decision.veredicto === 'pendiente_dato',
    verbo: VERBOS[decision.veredicto] || 'Resolver',
    objeto: OBJETOS[decision.veredicto] || 'la solicitud del cliente',
    porque: decision.motivo || null,
    citasNums: [],
    factores,
  });

  if (analisis.siguiente_accion) {
    acciones.push({
      destacada: false,
      verbo: 'Ejecutar',
      objeto: analisis.siguiente_accion,
      porque: 'Acción concreta propuesta al cierre de la decisión.',
      citasNums: [],
    });
  }

  const diagnostico = analisis.diagnostico || {};
  if (diagnostico.orden_alterado_por_historico && acciones.length) {
    acciones[0].avisoOrdenHistorico =
      diagnostico.motivo_orden ||
      'El histórico del CRM ha alterado el orden de verificación respecto al que sugiere la documentación.';
  }

  return acciones;
}

function renderVistaPostventa(fila, analisis) {
  const forzarBtn = `<button type="button" class="btn" id="btn-forzar">Forzar reanálisis</button>`;
  const toolbar = `<div class="tech-toolbar">
    <button type="button" class="btn" id="btn-volver">← Volver a la cola</button>
    <div class="tech-toolbar__right">
      ${forzarBtn}
      <button type="button" class="btn btn--resolver" id="btn-resolver" ${estado.resolviendo ? 'disabled' : ''}>Resolver caso</button>
    </div>
  </div>`;

  const bloqueContexto = renderBloqueContextoClientePedido(analisis);

  if (analisis.cubierto === false) {
    const acciones = construirAccionEscalado(analisis);

    return `<div class="detail-tecnico-v2">
      ${toolbar}
      ${renderBloqueDetalleCaso(fila, analisis)}
      ${bloqueContexto}
      <section class="tech-block tech-block--principal">
        <header class="tech-block__head">
          <h3 class="tech-block__title">3 · Acciones propuestas</h3>
        </header>
        <div class="tech-block__body">${renderListaAcciones(acciones)}</div>
      </section>
      ${renderBloqueRespaldoSinCobertura(analisis, { numero: 4 })}
      ${renderBloqueRespuesta(analisis, { conBotones: true, numero: 5 })}
    </div>`;
  }

  const citas = construirCitasRespaldo(analisis);
  const acciones = construirAccionesPostventa(analisis, citas);

  return `<div class="detail-tecnico-v2">
    ${toolbar}
    ${renderBloqueDetalleCaso(fila, analisis)}
    ${bloqueContexto}
    <section class="tech-block tech-block--principal">
      <header class="tech-block__head">
        <h3 class="tech-block__title">3 · Acciones propuestas</h3>
        <span class="tech-block__meta">El veredicto, con su motivo y sus condicionantes</span>
      </header>
      <div class="tech-block__body">
        ${renderIncoherenciaCobertura(analisis.incoherencias_cobertura)}
        ${renderListaAcciones(acciones)}
      </div>
    </section>
    ${renderBloqueRespaldo(analisis, citas, { numero: 4 })}
    ${renderBloqueRespuesta(analisis, { numero: 5 })}
  </div>`;
}

/* ---------- Vista A: cola de casos (técnico / postventa) ---------- */

function formatearHorasCorta(horas) {
  if (horas < 24) return `${horas} h`;
  return `${Math.floor(horas / 24)} d`;
}

/**
 * Estadísticas de la cola mostradas en las tarjetas rápidas: solo
 * cuentas sobre datos ya presentes en las filas (prioridad, cobertura,
 * antigüedad calculadas por el servidor). Nada inventado.
 */
function statsCola(filas) {
  const total = filas.length;
  const alta = filas.filter((f) => f.prioridad === 'Alta').length;
  const sinCobertura = filas.filter((f) => f.cubierto === false).length;
  const horasMedias = total
    ? Math.round(filas.reduce((acc, f) => acc + (f.horas_abierto || 0), 0) / total)
    : 0;
  return { total, alta, sinCobertura, horasMedias };
}

function renderQuickStats(filas, filtro) {
  const s = statsCola(filas);
  const sinFiltroAlguno = filtro.prioridad === 'todas' && filtro.categoria === 'todas' && !filtro.busqueda;

  return `<div class="quick-stats">
    <button type="button" class="quick-stat ${sinFiltroAlguno ? 'quick-stat--activo' : ''}" data-accion="reset">
      <div class="quick-stat__value">${s.total}</div>
      <div class="quick-stat__label">Casos en la cola</div>
    </button>
    <button type="button" class="quick-stat ${filtro.prioridad === 'Alta' ? 'quick-stat--activo' : ''}" data-accion="prioridad-alta">
      <div class="quick-stat__value">${s.alta}</div>
      <div class="quick-stat__label">Prioridad alta</div>
    </button>
    <div class="quick-stat" style="cursor:default">
      <div class="quick-stat__value">${s.sinCobertura}</div>
      <div class="quick-stat__label">Sin cobertura de conocimiento</div>
    </div>
    <div class="quick-stat" style="cursor:default">
      <div class="quick-stat__value">${formatearHorasCorta(s.horasMedias)}</div>
      <div class="quick-stat__label">Antigüedad media</div>
    </div>
  </div>`;
}

function renderFilterBar(filtro, totalFiltrado, totalGeneral) {
  return `<div class="filter-bar">
    <div class="filter-bar__field">
      <label for="filtro-prioridad">Prioridad</label>
      <select id="filtro-prioridad">
        <option value="todas" ${filtro.prioridad === 'todas' ? 'selected' : ''}>Todas</option>
        ${PRIORIDADES.map((p) => `<option value="${escapeHtml(p)}" ${filtro.prioridad === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
      </select>
    </div>
    <div class="filter-bar__field">
      <label for="filtro-categoria">Categoría</label>
      <select id="filtro-categoria">
        <option value="todas" ${filtro.categoria === 'todas' ? 'selected' : ''}>Todas</option>
        ${CATEGORIAS.map((c) => `<option value="${escapeHtml(c)}" ${filtro.categoria === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
      </select>
    </div>
    <div class="filter-bar__field">
      <label for="filtro-busqueda">Buscar</label>
      <input type="search" id="filtro-busqueda" placeholder="Asunto, cuenta o referencia…" value="${escapeHtml(filtro.busqueda)}">
    </div>
    <button type="button" class="btn filter-bar__reset" id="filtro-reset">Quitar filtros</button>
    <span class="filter-bar__count">${totalFiltrado} de ${totalGeneral} caso(s)</span>
  </div>`;
}

function filtrarFilasCola(filas, filtro) {
  return filas.filter((c) => {
    if (filtro.prioridad !== 'todas' && c.prioridad !== filtro.prioridad) return false;
    if (filtro.categoria !== 'todas' && c.categoria !== filtro.categoria) return false;
    if (filtro.busqueda) {
      const q = filtro.busqueda.toLowerCase();
      const texto = `${c.asunto} ${c.cuenta_nombre || ''} ${c.id}`.toLowerCase();
      if (!texto.includes(q)) return false;
    }
    return true;
  });
}

function prioridadClase(prioridad) {
  if (prioridad === 'Alta') return 'alta';
  if (prioridad === 'Baja') return 'baja';
  if (prioridad === 'Media') return 'media';
  return 'sin';
}

function renderFilaCola(c, { mostrarEquipo }) {
  const origenTag = c.pendiente
    ? '<span class="triaje-origen-tag triaje-origen-tag--pendiente">Pendiente de triaje</span>'
    : c.origen_triaje === 'agente'
      ? '<span class="triaje-origen-tag triaje-origen-tag--agente">Corregido por agente</span>'
      : '<span class="triaje-origen-tag triaje-origen-tag--ia">Propuesto por IA</span>';

  const marcaCanal =
    c.canal === 'formulario'
      ? '<span class="canal-tag canal-tag--formulario" title="Entrada por formulario asistido">Formulario</span>'
      : '';

  return `<tr data-id="${escapeHtml(c.id)}">
    <td><span class="priority-dot priority-dot--${prioridadClase(c.prioridad)}">${escapeHtml(c.prioridad || 'Sin triaje')}</span></td>
    <td class="col-caso">
      <span class="queue-table__asunto">${escapeHtml(c.asunto)} ${marcaCanal}</span>
      <span class="queue-table__ref">${escapeHtml(c.id)}</span>
    </td>
    <td>${escapeHtml(c.cuenta_nombre || '—')}</td>
    <td>${escapeHtml(c.producto_referencia || '—')}</td>
    <td>${escapeHtml(c.categoria || '—')}</td>
    ${mostrarEquipo ? `<td>${escapeHtml(c.equipo || '—')}</td>` : ''}
    <td>${origenTag}</td>
    <td>${escapeHtml(c.antiguedad)}</td>
  </tr>`;
}

function renderQueueTable(filas, { mostrarEquipo = false } = {}) {
  if (!filas.length) {
    return `<div class="empty">Ningún caso coincide con los filtros aplicados</div>`;
  }

  return `<table class="queue-table">
    <thead><tr>
      <th>Prioridad</th><th>Caso</th><th>Cuenta</th><th>Producto</th><th>Categoría</th>
      ${mostrarEquipo ? '<th>Equipo</th>' : ''}
      <th>Triaje</th><th>Antigüedad</th>
    </tr></thead>
    <tbody>${filas.map((c) => renderFilaCola(c, { mostrarEquipo })).join('')}</tbody>
  </table>`;
}

function renderCola() {
  const todas = estado.casos;

  if (!todas.length) {
    return `<div class="panel"><div class="empty">No hay casos en esta cola</div></div>`;
  }

  const filtro = estado.filtroCola;
  const filas = filtrarFilasCola(todas, filtro);

  return `<div class="panel">
    <div class="panel__header">
      <div>
        <h2 class="panel__title">Cola de casos</h2>
        <p class="panel__subtitle">Filtra por prioridad, categoría o texto libre</p>
      </div>
    </div>
    <div class="panel__body" style="padding-bottom:0">
      ${renderQuickStats(todas, filtro)}
    </div>
    ${renderFilterBar(filtro, filas.length, todas.length)}
    <div class="panel__body" style="padding:0">
      ${renderQueueTable(filas, { mostrarEquipo: false })}
    </div>
  </div>`;
}

/* ---------- Vista B: detalle de caso ---------- */

function renderOrigenRespuesta(analisis) {
  if (analisis._origen_respuesta === 'cache') {
    const fecha = analisis._analizado_en ? new Date(analisis._analizado_en).toLocaleString('es-ES') : '';
    return `<span style="font-size:0.75rem;color:var(--text-muted);font-weight:400;text-transform:none;letter-spacing:0">· desde caché${fecha ? ` (analizado el ${escapeHtml(fecha)})` : ''}</span>`;
  }
  return `<span style="font-size:0.75rem;color:var(--corpus);font-weight:400;text-transform:none;letter-spacing:0">· análisis en vivo</span>`;
}

/**
 * Sugerencia de causa raíz para precargar en el diálogo de "Resolver
 * caso": la causa mejor situada del diagnóstico técnico, o si no hay
 * diagnóstico (vista postventa / sin cobertura), el motivo de la
 * decisión de postventa. Es solo una sugerencia de partida — el agente
 * puede cambiarla o dejarla en blanco — nunca se guarda sin que la
 * confirme.
 */
function sugerenciaCausaRaiz(analisis) {
  const primeraCausa = analisis?.diagnostico?.causas_candidatas?.[0]?.causa;
  if (primeraCausa) return primeraCausa;
  return analisis?.decision_postventa?.motivo || '';
}

function renderDetalle() {
  const fila = estado.casoSeleccionado;
  const analisis = estado.analisis;

  if (estado.cargando) {
    return `<div class="loading"><span class="spinner"></span> Analizando caso…</div>`;
  }

  if (estado.error) {
    return `<div class="error-box">${escapeHtml(estado.error)}</div>
      <button type="button" class="btn" id="btn-volver">← Volver a la cola</button>`;
  }

  if (!fila || !analisis) return '';

  // Vista de postventa: veredicto + factores como primera acción,
  // contexto de cliente y pedido en primer plano. Cualquier otro rol
  // (técnico, y el responsable al abrir cualquier caso) usa la vista
  // técnica de 4 bloques.
  if (estado.rol === 'postventa') {
    return renderVistaPostventa(fila, analisis);
  }

  return renderVistaTecnico(fila, analisis);
}

/* ---------- Vista C: responsable ---------- */

function renderCargaTrabajo(cargaTrabajo, horasSinActualizar) {
  const cards = cargaTrabajo.porEquipo
    .map(
      (e) => `<div class="workload-card">
      <div class="workload-card__team"><span>${escapeHtml(e.equipo)}</span><span class="workload-card__total">${e.total}</span></div>
      ${e.porPrioridad.map((p) => `<div class="workload-card__row"><span>Prioridad ${escapeHtml(p.prioridad)}</span><strong>${p.total}</strong></div>`).join('')}
      <div class="workload-card__row"><span>Antigüedad media</span><strong>${e.antiguedadMediaHoras} h</strong></div>
      <div class="workload-card__row"><span>Sin actualizar &gt; ${horasSinActualizar} h</span><strong>${e.sinActualizar}</strong></div>
    </div>`
    )
    .join('');

  return `
    <div class="workload-grid">${cards}</div>
    <div class="workload-mini-grid">
      <div class="stat-card">
        <div class="stat-card__label">Total casos abiertos</div>
        <div class="stat-card__value">${cargaTrabajo.totalAbiertos}</div>
        <div class="stat-card__sub">Técnico + Postventa + pendientes de triaje</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">Pendientes de triaje</div>
        <div class="stat-card__value">${cargaTrabajo.pendientesTriaje.total}</div>
        <div class="stat-card__sub">Sin equipo asignado todavía</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">Correcciones manuales</div>
        <div class="stat-card__value">${cargaTrabajo.correccionesManuales.total}</div>
        <div class="stat-card__sub">Señal de acierto del enrutado de la IA</div>
      </div>
    </div>`;
}

function renderPatternChip(c) {
  const abierto = estado.casos.some((f) => f.id === c.id);
  return `<button type="button" class="pattern-case-chip"
    data-id="${escapeHtml(c.id)}"
    data-abierto="${abierto}"
    data-asunto="${escapeHtml(c.asunto || '')}"
    data-causa="${escapeHtml(c.causa_raiz || '')}"
    data-resolucion="${escapeHtml(c.resolucion || '')}"
    title="${escapeHtml(c.asunto || '')}">${escapeHtml(c.id)}</button>`;
}

function renderPatrones(patrones, umbral) {
  const intro = `<p class="patterns-intro">Se muestra un patrón cuando el mismo hecho se repite <strong>${umbral} veces o más</strong>. Se calcula sobre los casos abiertos y cerrados del CRM; no hay ningún patrón escrito a mano.</p>`;

  if (!patrones.length) {
    return `${intro}<div class="empty">Ningún hecho supera el umbral de repetición ahora mismo</div>`;
  }

  const cards = patrones
    .map(
      (p) => `<div class="pattern-card">
      <div class="pattern-card__header">
        <div>
          <h3 class="pattern-card__title">${escapeHtml(p.titulo)}</h3>
          <p class="pattern-card__detail">${escapeHtml(p.detalle)}</p>
        </div>
        <span class="pattern-card__badge">${p.repeticiones}× repetido</span>
      </div>
      <div class="pattern-card__cases">${p.casos.map(renderPatternChip).join('')}</div>
      <div class="pattern-card__footer">
        <span class="pattern-card__destinatario">Destinatario sugerido: <strong>${escapeHtml(p.destinatario)}</strong></span>
        <button type="button" class="btn btn--derivar" data-destinatario="${escapeHtml(p.destinatario)}" data-titulo="${escapeHtml(p.titulo)}">Derivar</button>
      </div>
    </div>`
    )
    .join('');

  return intro + cards;
}

/**
 * Cola combinada de Técnico + Postventa dentro de la vista de
 * Responsable: reutiliza estado.casos, que para el rol "responsable"
 * ya trae TODOS los casos abiertos (incluidos los pendientes de
 * triaje), sin volver a llamar al servidor.
 */
function filtrarColaResponsable(filas, filtro) {
  return filas.filter((c) => {
    if (filtro.urgencia !== 'todas' && c.prioridad !== filtro.urgencia) return false;
    if (filtro.cliente) {
      const q = filtro.cliente.toLowerCase();
      if (!(c.cuenta_nombre || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function renderColaResponsable() {
  const todas = estado.casos;
  const filtro = estado.filtroColaResponsable;
  const filas = filtrarColaResponsable(todas, filtro);

  return `<div class="panel responsable-queue">
    <div class="panel__header">
      <div>
        <h2 class="panel__title">Cola combinada — Técnico y Postventa</h2>
        <p class="panel__subtitle">Todos los casos abiertos, incluidos los pendientes de triaje. Filtra por cliente o urgencia.</p>
      </div>
    </div>
    <div class="filter-bar">
      <div class="filter-bar__field">
        <label for="resp-filtro-cliente">Cliente</label>
        <input type="search" id="resp-filtro-cliente" placeholder="Nombre de cuenta…" value="${escapeHtml(filtro.cliente)}">
      </div>
      <div class="filter-bar__field">
        <label for="resp-filtro-urgencia">Urgencia</label>
        <select id="resp-filtro-urgencia">
          <option value="todas" ${filtro.urgencia === 'todas' ? 'selected' : ''}>Todas</option>
          ${PRIORIDADES.map((p) => `<option value="${escapeHtml(p)}" ${filtro.urgencia === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        </select>
      </div>
      <button type="button" class="btn filter-bar__reset" id="resp-filtro-reset">Quitar filtros</button>
      <span class="filter-bar__count">${filas.length} de ${todas.length} caso(s)</span>
    </div>
    <div class="panel__body" style="padding:0">
      ${renderQueueTable(filas, { mostrarEquipo: true })}
    </div>
  </div>`;
}

function renderResponsable() {
  const d = estado.dashboard;
  if (!d) return '<div class="empty">Cargando panel del responsable…</div>';

  return `
    <div class="panel" style="margin-bottom:1.5rem">
      <div class="panel__header">
        <div>
          <h2 class="panel__title">Carga de trabajo</h2>
          <p class="panel__subtitle">Casos abiertos por equipo, calculados sobre la cola actual</p>
        </div>
      </div>
      <div class="panel__body">${renderCargaTrabajo(d.cargaTrabajo, d.horasSinActualizar)}</div>
    </div>

    <div class="panel" style="margin-bottom:1.5rem">
      <div class="panel__header">
        <div>
          <h2 class="panel__title">Patrones que requieren acción fuera del equipo</h2>
          <p class="panel__subtitle">Causa raíz por producto, categorías de garantía, huecos de conocimiento e instalación fuera de especificación</p>
        </div>
      </div>
      <div class="panel__body">${renderPatrones(d.patrones, d.umbralRepeticiones)}</div>
    </div>

    ${renderColaResponsable()}`;
}

/* ---------- Render principal y enlazado de eventos ---------- */

function render() {
  scopeEl.textContent = SCOPE_LABELS[estado.rol] || '';

  document.querySelectorAll('.role-btn').forEach((btn) => {
    btn.classList.toggle('role-btn--active', btn.dataset.rol === estado.rol);
  });

  if (estado.cargando && estado.vista === 'cola') {
    appEl.innerHTML = `<div class="loading"><span class="spinner"></span> Cargando…</div>`;
    return;
  }

  if (estado.vista === 'detalle') {
    appEl.innerHTML = renderDetalle();
    bindDetalle();
    return;
  }

  if (estado.rol === 'responsable') {
    appEl.innerHTML = renderResponsable();
    bindResponsable();
    return;
  }

  appEl.innerHTML = renderCola();
  bindCola();
}

function bindCola() {
  appEl.querySelectorAll('.queue-table tbody tr').forEach((row) => {
    row.addEventListener('click', () => abrirCaso(row.dataset.id));
  });

  const selPrioridad = document.getElementById('filtro-prioridad');
  if (selPrioridad) {
    selPrioridad.addEventListener('change', () => {
      estado.filtroCola.prioridad = selPrioridad.value;
      render();
    });
  }

  const selCategoria = document.getElementById('filtro-categoria');
  if (selCategoria) {
    selCategoria.addEventListener('change', () => {
      estado.filtroCola.categoria = selCategoria.value;
      render();
    });
  }

  const inputBusqueda = document.getElementById('filtro-busqueda');
  if (inputBusqueda) {
    inputBusqueda.addEventListener('input', () => {
      estado.filtroCola.busqueda = inputBusqueda.value;
      const cursor = inputBusqueda.selectionStart;
      render();
      const nuevo = document.getElementById('filtro-busqueda');
      if (nuevo) {
        nuevo.focus();
        nuevo.setSelectionRange(cursor, cursor);
      }
    });
  }

  const btnReset = document.getElementById('filtro-reset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      estado.filtroCola = { prioridad: 'todas', categoria: 'todas', busqueda: '' };
      render();
    });
  }

  appEl.querySelectorAll('.quick-stat[data-accion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.accion === 'reset') {
        estado.filtroCola.prioridad = 'todas';
      } else if (btn.dataset.accion === 'prioridad-alta') {
        estado.filtroCola.prioridad = estado.filtroCola.prioridad === 'Alta' ? 'todas' : 'Alta';
      }
      render();
    });
  });
}

function bindResponsable() {
  appEl.querySelectorAll('.pattern-case-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (chip.dataset.abierto === 'true') {
        abrirCaso(chip.dataset.id);
        return;
      }
      const partes = [chip.dataset.asunto];
      if (chip.dataset.causa) partes.push(`Causa raíz: ${chip.dataset.causa}`);
      if (chip.dataset.resolucion) partes.push(`Resolución: ${chip.dataset.resolucion}`);
      alert(`${chip.dataset.id} (caso cerrado)\n\n${partes.join('\n\n')}`);
    });
  });

  appEl.querySelectorAll('.btn--derivar').forEach((btn) => {
    btn.addEventListener('click', () => {
      alert(`Patrón derivado a ${btn.dataset.destinatario}:\n"${btn.dataset.titulo}"\n\n(Simulado: no se ha enviado nada todavía.)`);
    });
  });

  appEl.querySelectorAll('.responsable-queue .queue-table tbody tr').forEach((row) => {
    row.addEventListener('click', () => abrirCaso(row.dataset.id));
  });

  const inputCliente = document.getElementById('resp-filtro-cliente');
  if (inputCliente) {
    inputCliente.addEventListener('input', () => {
      estado.filtroColaResponsable.cliente = inputCliente.value;
      const cursor = inputCliente.selectionStart;
      render();
      const nuevo = document.getElementById('resp-filtro-cliente');
      if (nuevo) {
        nuevo.focus();
        nuevo.setSelectionRange(cursor, cursor);
      }
    });
  }

  const selUrgencia = document.getElementById('resp-filtro-urgencia');
  if (selUrgencia) {
    selUrgencia.addEventListener('change', () => {
      estado.filtroColaResponsable.urgencia = selUrgencia.value;
      render();
    });
  }

  const btnResetResp = document.getElementById('resp-filtro-reset');
  if (btnResetResp) {
    btnResetResp.addEventListener('click', () => {
      estado.filtroColaResponsable = { cliente: '', urgencia: 'todas' };
      render();
    });
  }
}

function bindDetalle() {
  const btnVolver = document.getElementById('btn-volver');
  if (btnVolver) {
    btnVolver.addEventListener('click', () => {
      estado.vista = 'cola';
      estado.casoSeleccionado = null;
      estado.analisis = null;
      estado.error = null;
      cargarCasos();
    });
  }

  const btnForzar = document.getElementById('btn-forzar');
  if (btnForzar) {
    btnForzar.addEventListener('click', () => abrirCaso(estado.casoSeleccionado.id, { forzar: true }));
  }

  const btnResolver = document.getElementById('btn-resolver');
  if (btnResolver) {
    btnResolver.addEventListener('click', resolverCasoActual);
  }

  const btnCopiar = document.getElementById('btn-copiar-borrador');
  if (btnCopiar) {
    btnCopiar.addEventListener('click', async () => {
      const texto = document.getElementById('borrador')?.value || '';
      try {
        await navigator.clipboard.writeText(texto);
        btnCopiar.textContent = 'Copiado';
        setTimeout(() => {
          btnCopiar.textContent = 'Copiar';
        }, 1500);
      } catch {
        alert('No se pudo copiar al portapapeles');
      }
    });
  }

  const btnRespondido = document.getElementById('btn-respondido');
  if (btnRespondido) {
    btnRespondido.addEventListener('click', marcarRespondidoActual);
  }

  ['triaje-categoria', 'triaje-prioridad', 'triaje-equipo'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const campo = id.replace('triaje-', '');
      corregirTriajeActual({ [campo]: el.value });
    });
  });

  appEl.querySelectorAll('.cita-caso-link').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.caso;
      if (!id) return;
      if (estado.casos.some((c) => c.id === id)) {
        abrirCaso(id);
        return;
      }
      const partes = [el.dataset.asunto || id];
      if (el.dataset.causa) partes.push(`Causa raíz: ${el.dataset.causa}`);
      if (el.dataset.resolucion) partes.push(`Resolución: ${el.dataset.resolucion}`);
      alert(`${id}\n\n${partes.join('\n\n')}`);
    });
  });

  bindTimelineCliente();
}

/**
 * Eventos "abierto"/"cerrado" de la cronología de cliente son casos
 * clicables: un caso cerrado muestra su causa raíz y resolución (igual
 * que los chips de patrones del panel de Responsable); un caso abierto
 * lo abre si está en la cola visible del rol actual.
 */
function bindTimelineCliente() {
  appEl.querySelectorAll('.timeline__evento[data-tipo="abierto"], .timeline__evento[data-tipo="cerrado"]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (!id || id === estado.casoSeleccionado?.id) return;

      if (el.dataset.tipo === 'abierto') {
        if (estado.casos.some((c) => c.id === id)) {
          abrirCaso(id);
        } else {
          alert(`${id} (caso abierto)\n\n${el.dataset.detalle}\n\nAsignado a otra cola: no está cargado en esta vista.`);
        }
        return;
      }

      const partes = [el.dataset.detalle];
      if (el.dataset.causa) partes.push(`Causa raíz: ${el.dataset.causa}`);
      if (el.dataset.resolucion) partes.push(`Resolución: ${el.dataset.resolucion}`);
      alert(`${id} (caso cerrado)\n\n${partes.join('\n\n')}`);
    });
  });
}

async function abrirCaso(caseId, { forzar = false } = {}) {
  const fila = estado.casos.find((c) => c.id === caseId) || estado.casoSeleccionado;
  if (!fila) return;

  estado.vista = 'detalle';
  estado.casoSeleccionado = fila;
  estado.cargando = true;
  estado.error = null;
  if (!forzar) estado.analisis = null;
  render();

  try {
    const analisis = await analizarCaso(caseId, estado.rol, forzar);
    estado.analisis = analisis;
  } catch (err) {
    estado.error = err.message;
  } finally {
    estado.cargando = false;
    render();
  }
}

/**
 * Aplica una corrección de triaje (categoría, prioridad y/o equipo)
 * desde las etiquetas editables del detalle del caso (bloque 1, común
 * a técnico y postventa). Si el equipo deja de coincidir con el rol
 * activo, el caso sale de esta cola.
 */
async function corregirTriajeActual(cambios) {
  const fila = estado.casoSeleccionado;
  if (!fila) return;

  estado.reasignando = true;
  render();

  try {
    const respuesta = cambios.equipo && Object.keys(cambios).length === 1
      ? await reasignarCaso(fila.id, cambios.equipo)
      : await corregirTriajeCaso(fila.id, cambios);

    Object.assign(fila, {
      ...respuesta.triaje,
      origen_triaje: respuesta.triaje.origen,
      categoria: respuesta.triaje.categoria,
      prioridad: respuesta.triaje.prioridad,
      equipo: respuesta.triaje.equipo,
    });

    const perteneceARolActual =
      estado.rol === 'responsable' ||
      fila.equipo === (estado.rol === 'tecnico' ? 'Técnico' : 'Postventa');

    if (!perteneceARolActual) {
      estado.vista = 'cola';
      estado.casoSeleccionado = null;
      estado.analisis = null;
      estado.reasignando = false;
      await cargarCasos();
      return;
    }
  } catch (err) {
    estado.error = err.message;
  } finally {
    estado.reasignando = false;
    render();
  }
}

async function marcarRespondidoActual() {
  const fila = estado.casoSeleccionado;
  if (!fila) return;

  if (
    !confirm(
      `¿Marcar ${fila.id} como respondido?\n\nEl caso pasará a "Esperando cliente" y volverás a la cola.`
    )
  ) {
    return;
  }

  try {
    await marcarCasoRespondido(fila.id);
    estado.vista = 'cola';
    estado.casoSeleccionado = null;
    estado.analisis = null;
    await cargarCasos();
  } catch (err) {
    estado.error = err.message;
    render();
  }
}

/**
 * Cierra el caso abierto en el detalle. Pide confirmación y una causa
 * raíz opcional (precargada con la sugerencia del análisis, ver
 * `sugerenciaCausaRaiz`); la resolución se toma del propio borrador de
 * respuesta, que el agente puede haber editado. Tras cerrarlo, el caso
 * ya no pertenece a ninguna cola de agente, así que siempre se vuelve a
 * la cola y se recarga.
 */
async function resolverCasoActual() {
  const fila = estado.casoSeleccionado;
  if (!fila || !estado.analisis) return;

  if (!confirm(`¿Marcar ${fila.id} como resuelto?\n\nEl caso pasará a "Cerrado" y desaparecerá de la cola.`)) {
    return;
  }

  const causaRaiz = prompt(
    'Causa raíz confirmada (opcional). Se usa para detectar patrones en el panel de Responsable:',
    sugerenciaCausaRaiz(estado.analisis)
  );
  if (causaRaiz === null) return; // el agente ha cancelado el diálogo

  const resolucion = document.getElementById('borrador')?.value || '';

  estado.resolviendo = true;
  render();

  try {
    await resolverCaso(fila.id, { causaRaiz: causaRaiz.trim(), resolucion: resolucion.trim() });
    estado.vista = 'cola';
    estado.casoSeleccionado = null;
    estado.analisis = null;
    estado.resolviendo = false;
    await cargarCasos();
  } catch (err) {
    estado.error = err.message;
    estado.resolviendo = false;
    render();
  }
}

async function cargarCasos() {
  estado.cargando = true;
  estado.error = null;
  render();

  try {
    const data = await fetchCasos(estado.rol);
    estado.casos = data.casos;

    if (estado.rol === 'responsable') {
      estado.dashboard = await fetchResponsable();
    }
  } catch (err) {
    appEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    estado.cargando = false;
    return;
  }

  estado.cargando = false;
  render();
}

function cambiarRol(rol) {
  estado.rol = rol;
  estado.vista = 'cola';
  estado.casoSeleccionado = null;
  estado.analisis = null;
  estado.dashboard = null;
  estado.error = null;
  estado.filtroCola = { prioridad: 'todas', categoria: 'todas', busqueda: '' };
  estado.filtroColaResponsable = { cliente: '', urgencia: 'todas' };
  cargarCasos();
}

document.querySelectorAll('.role-btn').forEach((btn) => {
  btn.addEventListener('click', () => cambiarRol(btn.dataset.rol));
});

cargarCasos();
