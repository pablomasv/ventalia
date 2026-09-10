/**
 * Construye los datos de la vista de Responsable: carga de trabajo del
 * equipo (bloque A) y patrones detectados sobre los datos que apuntan
 * a un problema fuera del equipo de soporte (bloque B).
 *
 * Este módulo NO decide nada por su cuenta ni inventa números: todo
 * sale de contar y agrupar filas.js (cola ya calculada) y crm.json
 * (casos cerrados). Si quieres ver de dónde sale cada cifra, sigue las
 * funciones de este fichero: cada una hace una sola cuenta.
 */

// Un patrón solo se muestra si el mismo hecho se repite este número de
// veces o más. Se expone también en la respuesta de la API para que la
// interfaz pueda decir "se han detectado repitiendo 2 o más veces" en
// vez de dejarlo implícito.
const UMBRAL_REPETICIONES = 2;

// A partir de cuántas horas sin actualizarse consideramos un caso
// "estancado". Usamos la fecha de creación como referencia porque el
// CRM simulado no guarda una fecha de última actividad aparte.
const HORAS_SIN_ACTUALIZAR = 48;

function promedio(numeros) {
  if (!numeros.length) return 0;
  return Math.round((numeros.reduce((a, b) => a + b, 0) / numeros.length) * 10) / 10;
}

/**
 * Bloque A — Carga de trabajo.
 * Toda la información sale de `filas` (la cola ya construida por
 * cola.js: casos abiertos + su triaje) y de `correcciones` (triaje.js).
 */
function construirCargaTrabajo(filas, correcciones) {
  const equipos = ['Técnico', 'Postventa'];
  const prioridades = ['Alta', 'Media', 'Baja'];

  const porEquipo = equipos.map((equipo) => {
    const casosEquipo = filas.filter((f) => f.equipo === equipo);
    return {
      equipo,
      total: casosEquipo.length,
      porPrioridad: prioridades.map((prioridad) => ({
        prioridad,
        total: casosEquipo.filter((f) => f.prioridad === prioridad).length,
      })),
      sinActualizar: casosEquipo.filter((f) => f.horas_abierto >= HORAS_SIN_ACTUALIZAR).length,
      antiguedadMediaHoras: promedio(casosEquipo.map((f) => f.horas_abierto)),
    };
  });

  const pendientesTriaje = filas.filter((f) => f.pendiente);

  return {
    totalAbiertos: filas.length,
    porEquipo,
    pendientesTriaje: {
      total: pendientesTriaje.length,
      casos: pendientesTriaje.map((f) => ({ id: f.id, asunto: f.asunto })),
    },
    correccionesManuales: {
      total: correcciones.length,
      detalle: correcciones,
    },
  };
}

function agruparPorClave(items, claveFn) {
  const grupos = new Map();
  for (const item of items) {
    const clave = claveFn(item);
    if (clave == null) continue;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(item);
  }
  return grupos;
}

/**
 * Patrón 1 — misma causa_raiz repetida en el mismo producto, entre los
 * casos YA CERRADOS (causa_raiz es un dato confirmado al resolver, no
 * una propuesta de la IA). Señal para Ingeniería de Producto: si un
 * mismo fallo se repite en un producto, puede ser un defecto de diseño
 * y no una serie de incidencias aisladas.
 */
function patronesCausaRaizPorProducto(casosCerrados, productos) {
  const mapaProductos = new Map(productos.map((p) => [p.id, p]));
  const conCausa = casosCerrados.filter((c) => c.causa_raiz);
  const grupos = agruparPorClave(conCausa, (c) => `${c.producto_id}::${c.causa_raiz}`);

  const patrones = [];
  for (const casos of grupos.values()) {
    if (casos.length < UMBRAL_REPETICIONES) continue;
    const producto = mapaProductos.get(casos[0].producto_id);
    patrones.push({
      tipo: 'causa_raiz_producto',
      titulo: `"${casos[0].causa_raiz}" se repite en ${producto?.referencia || casos[0].producto_id}`,
      detalle: `${casos.length} casos cerrados con la misma causa raíz confirmada en el mismo producto.`,
      repeticiones: casos.length,
      destinatario: 'Ingeniería de Producto',
      casos: casos.map((c) => ({
        id: c.id,
        asunto: c.asunto,
        causa_raiz: c.causa_raiz,
        resolucion: c.resolucion,
      })),
    });
  }
  return patrones;
}

/**
 * Patrón 2 — concentración de categorías relacionadas con garantía,
 * contando tanto casos abiertos (categoría propuesta por la IA) como
 * cerrados (categoría confirmada en el CRM). Señal para Comercial /
 * Canal: si muchas consultas acaban siendo dudas o reclamaciones de
 * garantía, las condiciones no están claras en el punto de venta.
 */
function patronCategoriaGarantia(filasAbiertas, casosCerrados) {
  const REGEX_GARANTIA = /garant/i;

  const candidatos = [
    ...filasAbiertas
      .filter((f) => f.categoria)
      .map((f) => ({ id: f.id, asunto: f.asunto, categoria: f.categoria })),
    ...casosCerrados
      .filter((c) => c.categoria)
      .map((c) => ({
        id: c.id,
        asunto: c.asunto,
        categoria: c.categoria,
        causa_raiz: c.causa_raiz,
        resolucion: c.resolucion,
      })),
  ];

  const relacionados = candidatos.filter((c) => REGEX_GARANTIA.test(c.categoria));
  if (relacionados.length < UMBRAL_REPETICIONES) return [];

  return [
    {
      tipo: 'categoria_garantia',
      titulo: 'Concentración de consultas relacionadas con garantía',
      detalle: `${relacionados.length} casos (abiertos + cerrados) con una categoría relacionada con garantía.`,
      repeticiones: relacionados.length,
      destinatario: 'Comercial / Canal',
      casos: relacionados.map((c) => ({ id: c.id, asunto: c.asunto })),
    },
  ];
}

/**
 * Patrón 3 — casos abiertos sin cobertura de conocimiento, agrupados
 * por producto + categoría propuesta. Señal para el equipo que
 * mantiene Corpus: son huecos de documentación reales, no supuestos.
 */
function patronesSinCobertura(filasAbiertas) {
  const sinCobertura = filasAbiertas.filter((f) => f.cubierto === false);
  const grupos = agruparPorClave(
    sinCobertura,
    (f) => `${f.producto_referencia || 'Producto desconocido'}::${f.categoria || 'Sin categoría'}`
  );

  const patrones = [];
  for (const [clave, casos] of grupos) {
    if (casos.length < UMBRAL_REPETICIONES) continue;
    const [producto, tema] = clave.split('::');
    patrones.push({
      tipo: 'sin_cobertura',
      titulo: `Hueco de conocimiento: ${producto} — ${tema}`,
      detalle: `${casos.length} casos abiertos sin fragmentos de corpus por encima del umbral para este producto y tema.`,
      repeticiones: casos.length,
      destinatario: 'Documentación técnica (Corpus)',
      casos: casos.map((c) => ({ id: c.id, asunto: c.asunto })),
    });
  }

  return {
    patrones,
    totalSinCobertura: sinCobertura.length,
    casosSinCobertura: sinCobertura.map((f) => ({
      id: f.id,
      asunto: f.asunto,
      producto: f.producto_referencia,
    })),
  };
}

/**
 * Patrón 4 — causas raíz de instalación/montaje repetidas entre los
 * casos cerrados. Señal para Formación de instaladores o para revisar
 * la documentación de montaje.
 */
function patronesInstalacion(casosCerrados) {
  const REGEX_INSTALACION = /instalaci[oó]n|distancia|montaje/i;
  const relacionados = casosCerrados.filter(
    (c) => c.causa_raiz && REGEX_INSTALACION.test(c.causa_raiz)
  );
  if (relacionados.length < UMBRAL_REPETICIONES) return [];

  return [
    {
      tipo: 'instalacion_fuera_especificacion',
      titulo: 'Causas raíz de instalación/montaje fuera de especificación',
      detalle: `${relacionados.length} casos cerrados cuya causa raíz confirmada es un problema de instalación o distancias de montaje.`,
      repeticiones: relacionados.length,
      destinatario: 'Formación de instaladores',
      casos: relacionados.map((c) => ({
        id: c.id,
        asunto: c.asunto,
        causa_raiz: c.causa_raiz,
        resolucion: c.resolucion,
      })),
    },
  ];
}

/**
 * Construye el objeto completo que consume la vista de Responsable.
 *
 * @param {Array} filas - cola completa (cola.listarCola(), sin filtrar por rol)
 * @param {Array} casosCerrados - crm.getCasosCerrados()
 * @param {Array} productos - crm.getProductos()
 * @param {Array} correcciones - triaje.listarCorrecciones()
 */
function construirDashboard(filas, casosCerrados, productos, correcciones) {
  const { patrones: patronesCobertura, totalSinCobertura, casosSinCobertura } =
    patronesSinCobertura(filas);

  const patrones = [
    ...patronesCausaRaizPorProducto(casosCerrados, productos),
    ...patronCategoriaGarantia(filas, casosCerrados),
    ...patronesCobertura,
    ...patronesInstalacion(casosCerrados),
  ].sort((a, b) => b.repeticiones - a.repeticiones);

  return {
    umbralRepeticiones: UMBRAL_REPETICIONES,
    horasSinActualizar: HORAS_SIN_ACTUALIZAR,
    cargaTrabajo: construirCargaTrabajo(filas, correcciones),
    patrones,
    sinCobertura: {
      total: totalSinCobertura,
      casos: casosSinCobertura,
    },
  };
}

module.exports = {
  UMBRAL_REPETICIONES,
  HORAS_SIN_ACTUALIZAR,
  construirDashboard,
};
