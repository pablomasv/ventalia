/**
 * Cálculo determinista de cobertura de garantía y margen de cortesía
 * comercial. NADA de este fichero llama a un modelo de IA: son fechas,
 * comparaciones numéricas y una tabla fija por segmento. El objetivo es
 * que el plazo y la cortesía nunca dependan de que el modelo "sepa
 * contar los meses bien" — se le pasan ya calculados como hechos, y él
 * solo redacta a partir de ellos.
 *
 * Referencias de corpus que respaldan cada constante (para poder
 * enlazarlas en la interfaz y en el prompt):
 * - Plazo de garantía: faq-garantia#cual-es-el-plazo-de-cobertura (24 meses)
 * - Márgenes de cortesía por segmento: politica-segmentacion#cliente-oro /
 *   #cliente-plata / #cliente-estandar
 */

const PLAZO_GARANTIA_MESES = 24;
const FUENTE_PLAZO_GARANTIA = 'faq-garantia#cual-es-el-plazo-de-cobertura';
const FUENTE_SEGMENTACION = 'politica-segmentacion#segmentacion-de-clientes';

const MARGEN_CORTESIA_POR_SEGMENTO = {
  Oro: { meses: 3, fuente_id: 'politica-segmentacion#cliente-oro' },
  Plata: { meses: 1, fuente_id: 'politica-segmentacion#cliente-plata' },
  Estándar: { meses: 0, fuente_id: 'politica-segmentacion#cliente-estandar' },
};

function mesesDesdeEntrega(fechaEntrega, fechaReferencia) {
  const entrega = new Date(fechaEntrega);
  const referencia = new Date(fechaReferencia);
  const diffMs = referencia - entrega;
  return Math.round((diffMs / (1000 * 60 * 60 * 24 * 30.44)) * 10) / 10;
}

/**
 * Segmento comercial calculado SIEMPRE a partir de la facturación de los
 * últimos doce meses, según los rangos de la política comercial. Nunca
 * se lee el campo segmento_comercial del JSON del CRM tal cual.
 */
function calcularSegmentoComercial(facturacionUltimos12m) {
  if (facturacionUltimos12m == null) return null;
  if (facturacionUltimos12m > 100000) return 'Oro';
  if (facturacionUltimos12m >= 50000) return 'Plata';
  return 'Estándar';
}

/**
 * Evalúa de forma determinista si un caso está dentro del plazo de
 * garantía y si, en caso de estar fuera, le aplica el margen de
 * cortesía de su segmento comercial. Cada valor devuelto lleva su
 * propio `fuente_id` (referencia al fragmento de corpus que lo
 * respalda, o `null` si el dato sale directamente del CRM) para poder
 * enlazarlo en la interfaz y para que el modelo sepa de dónde sale sin
 * tener que fiarse a ciegas.
 *
 * Si el caso no tiene pedido con fecha de entrega, no hay nada que
 * calcular y se devuelve `{ aplicable: false, motivo }`.
 */
function evaluarCobertura(caso, pedido, cuenta) {
  if (!pedido || !pedido.fecha_entrega) {
    return {
      aplicable: false,
      motivo: 'El caso no tiene un pedido con fecha de entrega asociado: no se puede calcular la cobertura.',
    };
  }

  const mesesTranscurridos = mesesDesdeEntrega(pedido.fecha_entrega, caso.creado);
  const dentroDePlazo = mesesTranscurridos <= PLAZO_GARANTIA_MESES;
  const mesesFueraDePlazo = dentroDePlazo
    ? 0
    : Math.round((mesesTranscurridos - PLAZO_GARANTIA_MESES) * 10) / 10;

  const segmentoComercial = calcularSegmentoComercial(cuenta?.facturacion_ultimos_12m);
  const margen = MARGEN_CORTESIA_POR_SEGMENTO[segmentoComercial] || { meses: 0, fuente_id: null };

  const cortesiaAplicable =
    !dentroDePlazo && margen.meses > 0 && mesesFueraDePlazo <= margen.meses;

  return {
    aplicable: true,
    meses_desde_entrega: { valor: mesesTranscurridos, fuente_id: null },
    plazo_garantia_meses: { valor: PLAZO_GARANTIA_MESES, fuente_id: FUENTE_PLAZO_GARANTIA },
    dentro_de_plazo: { valor: dentroDePlazo, fuente_id: FUENTE_PLAZO_GARANTIA },
    meses_fuera_de_plazo: { valor: mesesFueraDePlazo, fuente_id: FUENTE_PLAZO_GARANTIA },
    segmento_comercial: { valor: segmentoComercial, fuente_id: FUENTE_SEGMENTACION },
    margen_cortesia_meses: { valor: margen.meses, fuente_id: margen.fuente_id },
    cortesia_aplicable: { valor: cortesiaAplicable, fuente_id: margen.fuente_id },
  };
}

module.exports = {
  evaluarCobertura,
  calcularSegmentoComercial,
  mesesDesdeEntrega,
  PLAZO_GARANTIA_MESES,
  MARGEN_CORTESIA_POR_SEGMENTO,
};
