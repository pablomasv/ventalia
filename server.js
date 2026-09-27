require('dotenv').config();

const express = require('express');
const path = require('path');
const { listarCola, filtrarPorRol } = require('./cola');
const {
  analizarConCache,
  analizarYPersistir,
  corregirEquipo,
  corregirTriaje,
  resumenTriaje,
  listarCorrecciones,
} = require('./triaje');
const {
  getCaso,
  getCasosCerrados,
  getProductos,
  getCuentas,
  getContactos,
  actualizarCaso,
  crearCaso,
  cambiarEstado,
  registrarActividad,
  TRANSICIONES,
} = require('./crm');
const { construirDashboard } = require('./dashboard');
const { obtenerDocumento } = require('./documentos');
const { analizarAlta } = require('./alta-asistida');

const app = express();
const PORT = process.env.PORT || 3000;

const ROLES_VALIDOS = ['tecnico', 'postventa', 'responsable'];
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/nuevo-caso', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'nuevo-caso.html'));
});

function validarRol(rol) {
  return ROLES_VALIDOS.includes(rol) ? rol : 'tecnico';
}

/**
 * Camino más corto entre dos estados, sin incluir el de origen.
 * Devuelve null si no hay una secuencia de transiciones válidas.
 */
function caminoDeEstados(desde, hasta) {
  if (desde === hasta) return [];

  const cola = [[desde]];
  const vistos = new Set([desde]);

  while (cola.length) {
    const camino = cola.shift();
    const actual = camino[camino.length - 1];
    for (const siguiente of TRANSICIONES[actual] || []) {
      if (vistos.has(siguiente)) continue;
      const extendido = camino.concat(siguiente);
      if (siguiente === hasta) return extendido.slice(1);
      vistos.add(siguiente);
      cola.push(extendido);
    }
  }

  return null;
}

/**
 * Lleva un caso hasta `destino` dando solo pasos que la máquina de
 * estados permite. Cada paso queda en actividad_caso. Los botones de
 * la interfaz prometen "Esperando cliente" o "Cerrado" de un golpe, y
 * desde "Nuevo" eso no es una transición directa: se recorre el camino
 * más corto y el caso termina en el estado que la interfaz ya anuncia.
 */
async function llevarAlEstado(casoId, destino, actor, motivo) {
  const caso = await getCaso(casoId);
  if (!caso) return null;
  if (caso.estado === destino) return caso;

  const pasos = caminoDeEstados(caso.estado, destino);
  if (!pasos) {
    const error = new Error(
      `No hay una secuencia de transiciones válidas desde "${caso.estado}" hasta "${destino}".`
    );
    error.status = 400;
    throw error;
  }

  let actual = caso;
  for (let i = 0; i < pasos.length; i += 1) {
    const esUltimo = i === pasos.length - 1;
    const motivoPaso = esUltimo ? motivo : `Paso intermedio hacia «${destino}»`;
    actual = await cambiarEstado(casoId, pasos[i], actor, motivoPaso);
  }
  return actual;
}

/**
 * Catálogo para el formulario público de alta: cuentas, contactos y
 * productos del CRM semilla (el cliente "ya está identificado").
 */
app.get('/api/alta/catalogo', async (req, res) => {
  try {
    const [cuentas, contactos, productos] = await Promise.all([
      getCuentas(),
      getContactos(),
      getProductos(),
    ]);
    res.json({
      cuentas: cuentas.map((c) => ({
        id: c.id,
        nombre: c.nombre,
        pais: c.pais,
      })),
      contactos: contactos.map((c) => ({
        id: c.id,
        cuenta_id: c.cuenta_id,
        nombre: c.nombre,
        cargo: c.cargo,
        email: c.email,
      })),
      productos: productos.map((p) => ({
        id: p.id,
        referencia: p.referencia,
        nombre: p.nombre,
        gama: p.gama,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Paso 1→2 del formulario: analiza la descripción + producto y, si hay
 * cobertura, propone hasta 3 preguntas opcionales ancladas al corpus.
 */
app.post('/api/alta/analizar', async (req, res) => {
  const { descripcion, productoId } = req.body || {};
  if (!descripcion || !productoId) {
    return res.status(400).json({ error: 'Faltan descripcion y productoId' });
  }
  try {
    const resultado = await analizarAlta(descripcion, productoId);
    res.json(resultado);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * Crea el caso en la base, dispara el triaje completo (analizar.js)
 * y persiste el resultado en analisis_caso.
 */
app.post('/api/alta/crear', async (req, res) => {
  const {
    cuentaId,
    contactoId,
    productoId,
    descripcion,
    datos_recogidos: datosRecogidos,
  } = req.body || {};

  if (!cuentaId || !contactoId || !productoId || !descripcion) {
    return res.status(400).json({
      error: 'Faltan cuentaId, contactoId, productoId o descripcion',
    });
  }

  try {
    const recogidos = Array.isArray(datosRecogidos)
      ? datosRecogidos
          .filter((d) => d && d.pregunta)
          .map((d) => ({
            pregunta: String(d.pregunta),
            respuesta: d.respuesta != null ? String(d.respuesta) : '',
            fuente_id: d.fuente_id || null,
            porque: d.porque || null,
          }))
      : [];

    const caso = await crearCaso({
      cuenta_id: cuentaId,
      contacto_id: contactoId,
      producto_id: productoId,
      descripcion: String(descripcion).trim(),
      datos_recogidos: recogidos,
    });

    console.log(`[alta] Caso creado ${caso.id} — lanzando triaje…`);
    const analisis = await analizarYPersistir(caso.id, 'responsable');
    const triaje = resumenTriaje(caso.id);

    res.status(201).json({
      caso: {
        id: caso.id,
        estado: caso.estado,
        canal: caso.canal,
        asunto: caso.asunto,
        creado: caso.creado,
      },
      triaje: {
        equipo: triaje.equipo,
        categoria: triaje.categoria,
        prioridad: triaje.prioridad,
        pendiente: triaje.pendiente,
      },
      cubierto: analisis.cubierto,
      motivo: analisis.motivo,
    });
  } catch (error) {
    console.error('[alta] Error al crear/triajar:', error);
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

app.get('/api/casos', async (req, res) => {
  try {
    const rol = validarRol(req.query.rol);
    const filas = await listarCola();
    const casos = filtrarPorRol(filas, rol);

    res.json({ rol, casos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Datos exclusivos de la vista de Responsable: carga de trabajo por
 * equipo y patrones detectados sobre casos cerrados + abiertos. No
 * depende del rol de la petición porque solo la usa esa vista, pero
 * no hay nada sensible que restringir por dominio aquí.
 */
app.get('/api/responsable', async (req, res) => {
  try {
    const [filas, casosCerrados, productos] = await Promise.all([
      listarCola(),
      getCasosCerrados(),
      getProductos(),
    ]);
    const correcciones = listarCorrecciones();
    const dashboard = construirDashboard(filas, casosCerrados, productos, correcciones);

    res.json(dashboard);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analizar', async (req, res) => {
  const { caseId, rol: rolBody, forzar } = req.body;

  if (!caseId) {
    return res.status(400).json({ error: 'Falta caseId en el cuerpo de la petición' });
  }

  const rol = validarRol(rolBody);

  try {
    const resultado = await analizarConCache(caseId, rol, { forzar: Boolean(forzar) });
    res.json({ ...resultado, rol });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * Visor de un documento del corpus, para los enlaces "ver fuente" de
 * las afirmaciones citadas. Devuelve el documento reconstruido a
 * partir de corpus-index.json (ver documentos.js): mismo id de sección
 * que puede aparecer como fuente_id en una afirmación.
 */
app.get('/api/documentos/:documentoId', (req, res) => {
  const documento = obtenerDocumento(req.params.documentoId);
  if (!documento) {
    return res.status(404).json({ error: `Documento no encontrado: ${req.params.documentoId}` });
  }
  res.json(documento);
});

app.post('/api/casos/:caseId/equipo', (req, res) => {
  const { caseId } = req.params;
  const { equipo } = req.body;

  if (!EQUIPOS_VALIDOS.includes(equipo)) {
    return res.status(400).json({ error: `Equipo inválido. Debe ser: ${EQUIPOS_VALIDOS.join(' o ')}` });
  }

  corregirEquipo(caseId, equipo);
  res.json({ caseId, triaje: resumenTriaje(caseId) });
});

/**
 * Corrección parcial del triaje (categoría, prioridad y/o equipo) desde
 * las etiquetas editables del detalle técnico. Solo los campos enviados
 * se actualizan; el resto se conserva. Misma persistencia en memoria
 * que la reasignación de equipo.
 */
app.post('/api/casos/:caseId/triaje', (req, res) => {
  const { caseId } = req.params;
  const { equipo, categoria, prioridad } = req.body || {};
  const cambios = {};

  if (equipo !== undefined) {
    if (!EQUIPOS_VALIDOS.includes(equipo)) {
      return res.status(400).json({ error: `Equipo inválido. Debe ser: ${EQUIPOS_VALIDOS.join(' o ')}` });
    }
    cambios.equipo = equipo;
  }
  if (categoria !== undefined) {
    if (!CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({
        error: `Categoría inválida. Debe ser una de: ${CATEGORIAS_VALIDAS.join(', ')}`,
      });
    }
    cambios.categoria = categoria;
  }
  if (prioridad !== undefined) {
    if (!PRIORIDADES_VALIDAS.includes(prioridad)) {
      return res.status(400).json({
        error: `Prioridad inválida. Debe ser: ${PRIORIDADES_VALIDAS.join(', ')}`,
      });
    }
    cambios.prioridad = prioridad;
  }

  if (Object.keys(cambios).length === 0) {
    return res.status(400).json({ error: 'No se ha enviado ningún campo de triaje para corregir' });
  }

  corregirTriaje(caseId, cambios);
  res.json({ caseId, triaje: resumenTriaje(caseId) });
});

/**
 * Marca el caso como respondido: termina en "Esperando cliente" por
 * transiciones válidas, y deja actividad de ese mensaje al cliente.
 * El caso sigue en cola.
 */
app.post('/api/casos/:caseId/respondido', async (req, res) => {
  const { caseId } = req.params;

  try {
    const caso = await getCaso(caseId);
    if (!caso) {
      return res.status(404).json({ error: `Caso no encontrado: ${caseId}` });
    }
    if (caso.estado === 'Cerrado') {
      return res.status(400).json({ error: 'El caso ya está cerrado' });
    }

    const actualizado = await llevarAlEstado(
      caseId,
      'Esperando cliente',
      'agente',
      'Respuesta enviada al cliente'
    );
    await registrarActividad(caseId, 'mensaje_cliente', 'agente', 'Respuesta enviada al cliente');

    res.json({ caso: actualizado });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

/**
 * Cierra el caso: confirma en el CRM categoría, prioridad y equipo del
 * triaje (IA o corregido) y lo lleva a "Cerrado" por transiciones
 * válidas. A partir de ahí `getCasosAbiertos()` lo excluye y puede
 * alimentar los patrones de la vista de Responsable. `causa_raiz` y
 * `resolucion` son opcionales. Queda persistido en la base.
 */
app.post('/api/casos/:caseId/resolver', async (req, res) => {
  const { caseId } = req.params;
  const { causa_raiz: causaRaiz, resolucion } = req.body;

  try {
    const caso = await getCaso(caseId);
    if (!caso) {
      return res.status(404).json({ error: `Caso no encontrado: ${caseId}` });
    }
    if (caso.estado === 'Cerrado') {
      return res.status(400).json({ error: 'El caso ya está cerrado' });
    }

    const triaje = resumenTriaje(caseId);

    await actualizarCaso(caseId, {
      categoria: triaje.categoria || caso.categoria || null,
      prioridad: triaje.prioridad || caso.prioridad || null,
      equipo: triaje.equipo || caso.equipo || null,
      causa_raiz: causaRaiz || null,
      resolucion: resolucion || null,
    });

    const motivo = causaRaiz
      ? `Cerrado por el agente. Causa raíz: ${causaRaiz}`
      : 'Cerrado por el agente';
    const actualizado = await llevarAlEstado(caseId, 'Cerrado', 'agente', motivo);

    res.json({ caso: actualizado });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
