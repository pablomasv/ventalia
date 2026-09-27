/**
 * Acceso al CRM. Los datos viven en data/ventalia.db (ver semilla.js).
 * crm.json no se lee en caliente y no se escribe nunca.
 *
 * Las funciones de consulta mantienen la firma de cuando el CRM era un
 * JSON. El estado de un caso solo cambia con cambiarEstado(): una
 * transición que no esté en la máquina de estados lanza un error y no
 * toca la fila.
 */

const path = require('path');
const { abrir } = require('./db');

const CRM_PATH = path.join(__dirname, 'data', 'crm.json');

const ESTADOS = [
  'Nuevo',
  'En triaje',
  'En curso',
  'Esperando cliente',
  'Escalado',
  'Resuelto',
  'Cerrado',
];

const TRANSICIONES = {
  Nuevo: ['En triaje', 'Escalado'],
  'En triaje': ['En curso', 'Escalado'],
  'En curso': ['Esperando cliente', 'Escalado', 'Resuelto'],
  'Esperando cliente': ['En curso', 'Resuelto', 'Cerrado'],
  Escalado: ['En curso', 'Resuelto'],
  Resuelto: ['Cerrado', 'En curso'],
  Cerrado: ['En curso'],
};

const CAMPOS_CASO = [
  'cuenta_id',
  'contacto_id',
  'producto_id',
  'pedido_id',
  'canal',
  'categoria',
  'prioridad',
  'equipo',
  'asunto',
  'descripcion',
  'datos_recogidos',
  'causa_raiz',
  'resolucion',
  'creado',
];

function errorConStatus(mensaje, status) {
  const error = new Error(mensaje);
  error.status = status;
  return error;
}

function filaACuenta(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    nombre: fila.nombre,
    pais: fila.pais,
    filial: fila.filial,
    idioma: fila.idioma,
    segmento: fila.segmento,
    cliente_desde: fila.cliente_desde,
    contrato_mantenimiento: fila.contrato_mantenimiento === 1,
    facturacion_ultimos_12m: fila.facturacion_ultimos_12m,
    segmento_comercial: fila.segmento_comercial,
  };
}

function filaAContacto(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    cuenta_id: fila.cuenta_id,
    nombre: fila.nombre,
    cargo: fila.cargo,
    email: fila.email,
  };
}

function filaAProducto(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    referencia: fila.referencia,
    nombre: fila.nombre,
    gama: fila.gama,
    dominio: fila.dominio,
  };
}

function filaAPedido(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    cuenta_id: fila.cuenta_id,
    producto_id: fila.producto_id,
    numero_serie: fila.numero_serie,
    cantidad: fila.cantidad,
    fecha_entrega: fila.fecha_entrega,
    instalador: fila.instalador,
    informe_puesta_en_marcha: fila.informe_puesta_en_marcha === 1,
  };
}

function filaACaso(fila) {
  if (!fila) return null;
  const caso = {
    id: fila.id,
    cuenta_id: fila.cuenta_id,
    contacto_id: fila.contacto_id,
    producto_id: fila.producto_id,
    pedido_id: fila.pedido_id,
    canal: fila.canal,
    estado: fila.estado,
    categoria: fila.categoria,
    prioridad: fila.prioridad,
    equipo: fila.equipo,
    creado: fila.creado,
    actualizado: fila.actualizado,
    asunto: fila.asunto,
    descripcion: fila.descripcion,
    resolucion: fila.resolucion,
    causa_raiz: fila.causa_raiz,
    _escenario: fila.escenario,
  };
  if (fila.nota_demo != null) caso._nota_demo = fila.nota_demo;
  if (fila.datos_recogidos) caso.datos_recogidos = JSON.parse(fila.datos_recogidos);
  return caso;
}

function filaAActividad(fila) {
  return {
    id: fila.id,
    caso_id: fila.caso_id,
    momento: fila.momento,
    tipo: fila.tipo,
    actor: fila.actor,
    detalle: fila.detalle,
  };
}

function obtenerCasoSync(id) {
  const fila = abrir().prepare('SELECT * FROM casos WHERE id = ?').get(id);
  return filaACaso(fila);
}

function listarCasosSync() {
  return abrir()
    .prepare('SELECT * FROM casos ORDER BY rowid')
    .all()
    .map(filaACaso);
}

async function listarTodosLosCasos() {
  return listarCasosSync();
}

async function getCaso(id) {
  return obtenerCasoSync(id);
}

async function getCasosAbiertos() {
  return abrir()
    .prepare(`SELECT * FROM casos WHERE estado != 'Cerrado' ORDER BY rowid`)
    .all()
    .map(filaACaso);
}

async function getCasosCerrados() {
  return abrir()
    .prepare(`SELECT * FROM casos WHERE estado = 'Cerrado' ORDER BY rowid`)
    .all()
    .map(filaACaso);
}

async function getProductos() {
  return abrir().prepare('SELECT * FROM productos ORDER BY rowid').all().map(filaAProducto);
}

async function getCuentas() {
  return abrir().prepare('SELECT * FROM cuentas ORDER BY rowid').all().map(filaACuenta);
}

async function getContactos(cuentaId = null) {
  const db = abrir();
  const filas = cuentaId
    ? db.prepare('SELECT * FROM contactos WHERE cuenta_id = ? ORDER BY rowid').all(cuentaId)
    : db.prepare('SELECT * FROM contactos ORDER BY rowid').all();
  return filas.map(filaAContacto);
}

async function getProducto(productoId) {
  const fila = abrir().prepare('SELECT * FROM productos WHERE id = ?').get(productoId);
  return filaAProducto(fila);
}

async function contarCasosCuenta(cuentaId, casoActualId) {
  const fila = abrir()
    .prepare('SELECT COUNT(*) AS n FROM casos WHERE cuenta_id = ? AND id != ?')
    .get(cuentaId, casoActualId);
  return fila.n;
}

async function getContextoCuenta(cuentaId, { contactoId, productoId, pedidoId } = {}) {
  const db = abrir();
  const cuenta = filaACuenta(db.prepare('SELECT * FROM cuentas WHERE id = ?').get(cuentaId));

  let contacto = null;
  if (contactoId) {
    contacto = filaAContacto(db.prepare('SELECT * FROM contactos WHERE id = ?').get(contactoId));
  } else {
    contacto = filaAContacto(
      db.prepare('SELECT * FROM contactos WHERE cuenta_id = ? ORDER BY rowid LIMIT 1').get(cuentaId)
    );
  }

  const producto = productoId
    ? filaAProducto(db.prepare('SELECT * FROM productos WHERE id = ?').get(productoId))
    : null;
  const pedido = pedidoId
    ? filaAPedido(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId))
    : null;

  return { cuenta, contacto, producto, pedido };
}

async function getPedidoReciente(cuentaId, productoId) {
  const candidatos = abrir()
    .prepare('SELECT * FROM pedidos WHERE cuenta_id = ? AND producto_id = ?')
    .all(cuentaId, productoId)
    .map(filaAPedido)
    .sort((a, b) => new Date(b.fecha_entrega) - new Date(a.fecha_entrega));
  return candidatos[0] || null;
}

async function getCasosSimilares(productoId, casoActualId) {
  const todos = listarCasosSync();
  return todos
    .filter(
      (caso) =>
        caso.producto_id === productoId &&
        caso.id !== casoActualId &&
        caso.estado === 'Cerrado' &&
        caso.causa_raiz
    )
    .sort((a, b) => new Date(b.creado) - new Date(a.creado));
}

async function getHistorialCuenta(cuentaId, casoActualId) {
  const db = abrir();
  const productosPorId = new Map(
    db.prepare('SELECT * FROM productos').all().map(filaAProducto).map((p) => [p.id, p])
  );

  const casos = listarCasosSync()
    .filter((caso) => caso.cuenta_id === cuentaId)
    .map((caso) => ({
      id: caso.id,
      asunto: caso.asunto,
      estado: caso.estado,
      creado: caso.creado,
      causa_raiz: caso.causa_raiz || null,
      resolucion: caso.resolucion || null,
      es_actual: caso.id === casoActualId,
    }))
    .sort((a, b) => new Date(a.creado) - new Date(b.creado));

  const pedidos = db
    .prepare('SELECT * FROM pedidos WHERE cuenta_id = ?')
    .all(cuentaId)
    .map(filaAPedido)
    .map((pedido) => ({
      id: pedido.id,
      fecha_entrega: pedido.fecha_entrega,
      producto_referencia: productosPorId.get(pedido.producto_id)?.referencia ?? null,
    }))
    .sort((a, b) => new Date(a.fecha_entrega) - new Date(b.fecha_entrega));

  return { casos, pedidos };
}

/**
 * Actualiza campos del caso y devuelve la fila nueva. `estado` no es
 * uno de esos campos: si viene en `cambios`, se lanza un error para
 * que el cambio pase por cambiarEstado().
 */
async function actualizarCaso(id, cambios) {
  if (cambios && Object.prototype.hasOwnProperty.call(cambios, 'estado')) {
    throw errorConStatus(
      'El estado no se modifica con actualizarCaso(). Usa cambiarEstado().',
      400
    );
  }

  const actual = obtenerCasoSync(id);
  if (!actual) return null;

  const asignaciones = [];
  const valores = [];
  for (const campo of CAMPOS_CASO) {
    if (!cambios || !Object.prototype.hasOwnProperty.call(cambios, campo)) continue;
    asignaciones.push(`${campo} = ?`);
    let valor = cambios[campo];
    if (campo === 'datos_recogidos') {
      valor = valor == null ? null : JSON.stringify(valor);
    }
    valores.push(valor ?? null);
  }

  if (asignaciones.length === 0) return actual;

  const ahora = new Date().toISOString();
  asignaciones.push('actualizado = ?');
  valores.push(ahora);
  valores.push(id);

  abrir()
    .prepare(`UPDATE casos SET ${asignaciones.join(', ')} WHERE id = ?`)
    .run(...valores);

  return obtenerCasoSync(id);
}

function generarIdCasoSync() {
  const ids = abrir().prepare('SELECT id FROM casos').all();
  let max = 0;
  for (const { id } of ids) {
    const coincidencia = String(id).match(/^CASE-(\d{4})-(\d+)$/);
    if (!coincidencia) continue;
    const n = parseInt(coincidencia[2], 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  const year = new Date().getFullYear();
  return `CASE-${year}-${String(max + 1).padStart(6, '0')}`;
}

function asuntoDesdeDescripcion(descripcion) {
  const limpia = String(descripcion || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpia) return 'Consulta desde formulario';
  return limpia.length > 80 ? `${limpia.slice(0, 77)}…` : limpia;
}

function insertarActividadSync(casoId, tipo, actor, detalle, momento) {
  if (!casoId || !tipo || !actor) {
    throw errorConStatus('registrarActividad requiere casoId, tipo y actor.', 400);
  }

  const db = abrir();
  const existe = db.prepare('SELECT 1 FROM casos WHERE id = ?').get(casoId);
  if (!existe) {
    throw errorConStatus(`Caso no encontrado: ${casoId}`, 404);
  }

  const cuando = momento || new Date().toISOString();
  const texto =
    detalle == null ? null : typeof detalle === 'string' ? detalle : JSON.stringify(detalle);

  const info = db
    .prepare(
      `INSERT INTO actividad_caso (caso_id, momento, tipo, actor, detalle)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(casoId, cuando, tipo, actor, texto);

  return filaAActividad(
    db.prepare('SELECT * FROM actividad_caso WHERE id = ?').get(Number(info.lastInsertRowid))
  );
}

/**
 * Alta de un caso. La referencia es CASE-AAAA-NNNNNN, sin colisionar
 * con las que ya existen. El estado inicial es siempre "Nuevo" y queda
 * una actividad de creación.
 *
 * `datos`: cuenta_id, contacto_id, producto_id, descripcion, y de forma
 * opcional asunto, pedido_id, datos_recogidos, canal y actor.
 */
async function crearCaso(datos) {
  const db = abrir();
  const crear = db.transaction(() => {
    const id = generarIdCasoSync();
    const ahora = new Date().toISOString();
    const pedidoAsociado =
      datos.pedido_id ||
      db
        .prepare(
          `SELECT id FROM pedidos
           WHERE cuenta_id = ? AND producto_id = ?
           ORDER BY fecha_entrega DESC
           LIMIT 1`
        )
        .get(datos.cuenta_id, datos.producto_id)?.id ||
      null;

    const recogidos = Array.isArray(datos.datos_recogidos) ? datos.datos_recogidos : [];

    db.prepare(
      `INSERT INTO casos (
         id, cuenta_id, contacto_id, producto_id, pedido_id, canal, estado,
         categoria, prioridad, equipo, asunto, descripcion, datos_recogidos,
         causa_raiz, resolucion, creado, actualizado
       ) VALUES (
         ?, ?, ?, ?, ?, ?, 'Nuevo',
         NULL, NULL, NULL, ?, ?, ?,
         NULL, NULL, ?, ?
       )`
    ).run(
      id,
      datos.cuenta_id ?? null,
      datos.contacto_id ?? null,
      datos.producto_id ?? null,
      pedidoAsociado,
      datos.canal || 'formulario',
      datos.asunto || asuntoDesdeDescripcion(datos.descripcion),
      datos.descripcion ?? null,
      JSON.stringify(recogidos),
      ahora,
      ahora
    );

    insertarActividadSync(id, 'creacion', datos.actor || 'sistema', 'Caso creado', ahora);
    return id;
  });

  return obtenerCasoSync(crear());
}

/**
 * Cambia el estado si la transición es válida y registra la actividad.
 * Si no lo es, lanza un error y el caso se queda como estaba.
 */
async function cambiarEstado(casoId, nuevoEstado, actor, motivo) {
  const db = abrir();
  const aplicar = db.transaction(() => {
    const caso = obtenerCasoSync(casoId);
    if (!caso) {
      throw errorConStatus(`Caso no encontrado: ${casoId}`, 404);
    }
    if (!actor) {
      throw errorConStatus('cambiarEstado requiere un actor.', 400);
    }
    if (!ESTADOS.includes(nuevoEstado)) {
      throw errorConStatus(
        `Estado no reconocido: "${nuevoEstado}". Estados válidos: ${ESTADOS.join(', ')}.`,
        400
      );
    }

    const permitidas = TRANSICIONES[caso.estado] || [];
    if (!permitidas.includes(nuevoEstado)) {
      throw errorConStatus(
        `Transición no válida: "${caso.estado}" → "${nuevoEstado}". Desde "${caso.estado}" solo se puede pasar a: ${permitidas.join(', ')}.`,
        400
      );
    }

    const ahora = new Date().toISOString();
    db.prepare('UPDATE casos SET estado = ?, actualizado = ? WHERE id = ?').run(
      nuevoEstado,
      ahora,
      casoId
    );

    const detalle = motivo
      ? `${caso.estado} → ${nuevoEstado}. ${motivo}`
      : `${caso.estado} → ${nuevoEstado}`;
    insertarActividadSync(casoId, 'cambio_estado', actor, detalle, ahora);
    return obtenerCasoSync(casoId);
  });

  return aplicar();
}

async function registrarActividad(casoId, tipo, actor, detalle) {
  return insertarActividadSync(casoId, tipo, actor, detalle);
}

async function getActividad(casoId) {
  return abrir()
    .prepare(
      `SELECT id, caso_id, momento, tipo, actor, detalle
       FROM actividad_caso
       WHERE caso_id = ?
       ORDER BY momento ASC, id ASC`
    )
    .all(casoId)
    .map(filaAActividad);
}

function horasDesde(fechaIso) {
  const diffMs = Date.now() - new Date(fechaIso).getTime();
  return Math.floor(diffMs / (1000 * 60 * 60));
}

function formatearAntiguedad(fechaIso) {
  const horas = horasDesde(fechaIso);
  if (horas < 24) return `${horas} h`;
  const dias = Math.floor(horas / 24);
  return `${dias} d`;
}

module.exports = {
  CRM_PATH,
  ESTADOS,
  TRANSICIONES,
  getCaso,
  getCasosAbiertos,
  getCasosCerrados,
  getProductos,
  getProducto,
  getCuentas,
  getContactos,
  contarCasosCuenta,
  getContextoCuenta,
  getPedidoReciente,
  getCasosSimilares,
  getHistorialCuenta,
  actualizarCaso,
  crearCaso,
  cambiarEstado,
  registrarActividad,
  getActividad,
  listarTodosLosCasos,
  horasDesde,
  formatearAntiguedad,
};
