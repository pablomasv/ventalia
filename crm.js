const fs = require('fs');
const path = require('path');

const CRM_PATH = path.join(__dirname, 'data', 'crm.json');
const CASOS_NUEVOS_PATH = path.join(__dirname, 'data', 'casos-nuevos.json');

let datos = null;
let casosNuevosEnMemoria = null;

async function cargarCRM() {
  if (!datos) {
    const raw = fs.readFileSync(CRM_PATH, 'utf8');
    datos = JSON.parse(raw);
  }
  return datos;
}

/**
 * Casos creados por el formulario asistido. Persistidos en disco
 * (`casos-nuevos.json`); `crm.json` es semilla inmutable.
 */
function cargarCasosNuevos() {
  if (casosNuevosEnMemoria) return casosNuevosEnMemoria;

  if (!fs.existsSync(CASOS_NUEVOS_PATH)) {
    fs.writeFileSync(CASOS_NUEVOS_PATH, '[]', 'utf8');
    casosNuevosEnMemoria = [];
    return casosNuevosEnMemoria;
  }

  try {
    casosNuevosEnMemoria = JSON.parse(fs.readFileSync(CASOS_NUEVOS_PATH, 'utf8'));
    if (!Array.isArray(casosNuevosEnMemoria)) casosNuevosEnMemoria = [];
  } catch {
    casosNuevosEnMemoria = [];
  }
  return casosNuevosEnMemoria;
}

function guardarCasosNuevos(casos) {
  casosNuevosEnMemoria = casos;
  fs.writeFileSync(CASOS_NUEVOS_PATH, JSON.stringify(casos, null, 2), 'utf8');
}

function recargarCasosNuevosDeDisco() {
  casosNuevosEnMemoria = null;
  return cargarCasosNuevos();
}

/**
 * Unión de casos semilla + casos del formulario. Si hubiera el mismo id
 * en ambos (no debería), gana el de casos-nuevos.
 */
async function listarTodosLosCasos() {
  const crm = await cargarCRM();
  const nuevos = cargarCasosNuevos();
  const porId = new Map();
  for (const caso of crm.casos) porId.set(caso.id, caso);
  for (const caso of nuevos) porId.set(caso.id, caso);
  return [...porId.values()];
}

function esCasoNuevo(id) {
  return cargarCasosNuevos().some((c) => c.id === id);
}

async function getCaso(id) {
  const nuevos = cargarCasosNuevos();
  const desdeNuevos = nuevos.find((caso) => caso.id === id);
  if (desdeNuevos) return desdeNuevos;

  const crm = await cargarCRM();
  return crm.casos.find((caso) => caso.id === id) ?? null;
}

/**
 * Casos que aún no están cerrados. Semilla + formulario.
 */
async function getCasosAbiertos() {
  const todos = await listarTodosLosCasos();
  return todos.filter((caso) => caso.estado !== 'Cerrado');
}

/**
 * Casos cerrados. Es la fuente de causa_raiz y categoria "reales"
 * (confirmadas al resolver el caso, no propuestas por la IA) que usa
 * el panel de responsable para detectar patrones repetidos.
 */
async function getCasosCerrados() {
  const todos = await listarTodosLosCasos();
  return todos.filter((caso) => caso.estado === 'Cerrado');
}

async function getProductos() {
  const crm = await cargarCRM();
  return crm.productos;
}

async function getCuentas() {
  const crm = await cargarCRM();
  return crm.cuentas;
}

async function getContactos(cuentaId = null) {
  const crm = await cargarCRM();
  if (!cuentaId) return crm.contactos;
  return crm.contactos.filter((c) => c.cuenta_id === cuentaId);
}

async function getProducto(productoId) {
  const crm = await cargarCRM();
  return crm.productos.find((p) => p.id === productoId) ?? null;
}

/**
 * Cuenta cuántos casos previos (de cualquier estado) tiene una cuenta,
 * sin contar el caso actual. Se usa para mostrar "número de casos
 * previos" en el contexto de cliente de la vista de postventa.
 */
async function contarCasosCuenta(cuentaId, casoActualId) {
  const todos = await listarTodosLosCasos();
  return todos.filter(
    (caso) => caso.cuenta_id === cuentaId && caso.id !== casoActualId
  ).length;
}

async function getContextoCuenta(cuentaId, { contactoId, productoId, pedidoId } = {}) {
  const crm = await cargarCRM();

  const cuenta = crm.cuentas.find((c) => c.id === cuentaId) ?? null;
  const contacto = contactoId
    ? crm.contactos.find((c) => c.id === contactoId) ?? null
    : crm.contactos.find((c) => c.cuenta_id === cuentaId) ?? null;
  const producto = productoId
    ? crm.productos.find((p) => p.id === productoId) ?? null
    : null;
  const pedido = pedidoId ? crm.pedidos.find((p) => p.id === pedidoId) ?? null : null;

  return { cuenta, contacto, producto, pedido };
}

/**
 * Pedido más reciente de una cuenta para un producto (si existe).
 * Sirve para asociar cobertura de garantía a un alta por formulario.
 */
async function getPedidoReciente(cuentaId, productoId) {
  const crm = await cargarCRM();
  const candidatos = crm.pedidos
    .filter((p) => p.cuenta_id === cuentaId && p.producto_id === productoId)
    .sort((a, b) => new Date(b.fecha_entrega) - new Date(a.fecha_entrega));
  return candidatos[0] || null;
}

async function getCasosSimilares(productoId, casoActualId) {
  const todos = await listarTodosLosCasos();

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

/**
 * Historial completo de una cuenta (todos sus pedidos y todos sus
 * casos, abiertos y cerrados), ordenado cronológicamente. Es la fuente
 * de datos para la cronología del cliente en la vista de postventa:
 * solo hechos que ya existen en el CRM, nada calculado por IA.
 */
async function getHistorialCuenta(cuentaId, casoActualId) {
  const crm = await cargarCRM();
  const productosPorId = new Map(crm.productos.map((p) => [p.id, p]));
  const todos = await listarTodosLosCasos();

  const casos = todos
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

  const pedidos = crm.pedidos
    .filter((pedido) => pedido.cuenta_id === cuentaId)
    .map((pedido) => ({
      id: pedido.id,
      fecha_entrega: pedido.fecha_entrega,
      producto_referencia: productosPorId.get(pedido.producto_id)?.referencia ?? null,
    }))
    .sort((a, b) => new Date(a.fecha_entrega) - new Date(b.fecha_entrega));

  return { casos, pedidos };
}

/**
 * Actualiza un caso. Si está en casos-nuevos.json, persiste en disco.
 * Si viene de la semilla crm.json, solo muta la copia en memoria
 * (crm.json nunca se escribe).
 */
async function actualizarCaso(id, cambios) {
  const nuevos = cargarCasosNuevos();
  const indiceNuevo = nuevos.findIndex((caso) => caso.id === id);

  if (indiceNuevo !== -1) {
    nuevos[indiceNuevo] = { ...nuevos[indiceNuevo], ...cambios };
    guardarCasosNuevos(nuevos);
    return nuevos[indiceNuevo];
  }

  const crm = await cargarCRM();
  const indice = crm.casos.findIndex((caso) => caso.id === id);

  if (indice === -1) return null;

  crm.casos[indice] = { ...crm.casos[indice], ...cambios };
  return crm.casos[indice];
}

/**
 * Genera CASE-2026-0NNNNN (6 dígitos) sin colisionar con semilla ni
 * con altas ya persistidas.
 */
async function generarIdCaso() {
  const todos = await listarTodosLosCasos();
  let max = 0;
  for (const caso of todos) {
    const m = String(caso.id).match(/^CASE-(\d{4})-(\d+)$/);
    if (!m) continue;
    const n = parseInt(m[2], 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  const siguiente = max + 1;
  const year = new Date().getFullYear();
  return `CASE-${year}-${String(siguiente).padStart(6, '0')}`;
}

function asuntoDesdeDescripcion(descripcion) {
  const limpia = String(descripcion || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpia) return 'Consulta desde formulario';
  return limpia.length > 80 ? `${limpia.slice(0, 77)}…` : limpia;
}

/**
 * Alta persistente en casos-nuevos.json. No toca crm.json.
 * `datos` esperado: cuenta_id, contacto_id, producto_id, descripcion,
 * y opcionalmente asunto, pedido_id, datos_recogidos.
 */
async function crearCaso(datos) {
  const id = await generarIdCaso();
  const pedidoAsociado =
    datos.pedido_id ||
    (await getPedidoReciente(datos.cuenta_id, datos.producto_id))?.id ||
    null;

  const caso = {
    id,
    cuenta_id: datos.cuenta_id,
    contacto_id: datos.contacto_id,
    producto_id: datos.producto_id,
    pedido_id: pedidoAsociado,
    canal: 'formulario',
    estado: 'Abierto',
    categoria: null,
    prioridad: null,
    equipo: null,
    creado: new Date().toISOString(),
    asunto: datos.asunto || asuntoDesdeDescripcion(datos.descripcion),
    descripcion: datos.descripcion,
    datos_recogidos: datos.datos_recogidos || [],
    resolucion: null,
  };

  const nuevos = cargarCasosNuevos();
  nuevos.push(caso);
  guardarCasosNuevos(nuevos);
  return caso;
}

/**
 * Vacía casos-nuevos.json (usado por limpiar-nuevos.js).
 */
function vaciarCasosNuevos() {
  guardarCasosNuevos([]);
  return [];
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
  CASOS_NUEVOS_PATH,
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
  esCasoNuevo,
  vaciarCasosNuevos,
  recargarCasosNuevosDeDisco,
  listarTodosLosCasos,
  horasDesde,
  formatearAntiguedad,
};
