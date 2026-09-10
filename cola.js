/**
 * Construye las filas de la cola de casos combinando datos del CRM con
 * el triaje ya calculado (pre-triaje en disco + correcciones en
 * memoria). No decide nada por su cuenta: si un caso no tiene triaje,
 * se marca como pendiente y no se asigna a ningún equipo.
 */

const {
  getCasosAbiertos,
  getContextoCuenta,
  horasDesde,
  formatearAntiguedad,
} = require('./crm');
const { resumenTriaje } = require('./triaje');

const ORDEN_PRIORIDAD = { Alta: 0, Media: 1, Baja: 2 };

async function listarCola() {
  const casos = await getCasosAbiertos();

  const filas = await Promise.all(
    casos.map(async (caso) => {
      const { cuenta, producto } = await getContextoCuenta(caso.cuenta_id, {
        productoId: caso.producto_id,
      });
      const triaje = resumenTriaje(caso.id);

      return {
        id: caso.id,
        asunto: caso.asunto,
        descripcion: caso.descripcion,
        estado: caso.estado,
        canal: caso.canal,
        creado: caso.creado,
        antiguedad: formatearAntiguedad(caso.creado),
        horas_abierto: horasDesde(caso.creado),
        cuenta_id: caso.cuenta_id,
        cuenta_nombre: cuenta?.nombre ?? null,
        producto_id: caso.producto_id,
        producto_referencia: producto?.referencia ?? null,
        producto_nombre: producto?.nombre ?? null,
        categoria: triaje.categoria,
        prioridad: triaje.prioridad,
        equipo: triaje.equipo,
        pendiente: triaje.pendiente,
        cubierto: triaje.cubierto,
        motivo_cobertura: triaje.motivo_cobertura,
        origen_triaje: triaje.origen,
        analizado_en: triaje.analizado_en ?? null,
        corregido_en: triaje.corregido_en ?? null,
      };
    })
  );

  filas.sort((a, b) => {
    const pa = ORDEN_PRIORIDAD[a.prioridad] ?? 99;
    const pb = ORDEN_PRIORIDAD[b.prioridad] ?? 99;
    if (pa !== pb) return pa - pb;
    return new Date(a.creado) - new Date(b.creado);
  });

  return filas;
}

function filtrarPorRol(filas, rol) {
  if (rol === 'tecnico') return filas.filter((f) => f.equipo === 'Técnico');
  if (rol === 'postventa') return filas.filter((f) => f.equipo === 'Postventa');
  return filas;
}

module.exports = { listarCola, filtrarPorRol };
