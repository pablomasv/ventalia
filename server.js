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
 * Crea el caso en casos-nuevos.json, dispara el triaje completo
 * (analizar.js) y persiste el resultado en triaje-cache.json.
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
 * Marca el caso como respondido: pasa a "Esperando cliente". Sigue
 * abierto (aparece en cola), pero deja constancia de que el agente ya
 * envió una respuesta. Solo en memoria, como el resto de mutaciones.
 */
app.post('/api/casos/:caseId/respondido', async (req, res) => {
  const { caseId } = req.params;
  const caso = await getCaso(caseId);
  if (!caso) {
    return res.status(404).json({ error: `Caso no encontrado: ${caseId}` });
  }
  if (caso.estado === 'Cerrado') {
    return res.status(400).json({ error: 'El caso ya está cerrado' });
  }

  const actualizado = await actualizarCaso(caseId, {
    estado: 'Esperando cliente',
    respondido_en: new Date().toISOString(),
  });

  res.json({ caso: actualizado });
});

/**
 * Marca un caso como resuelto: pasa a "Cerrado" y por tanto deja de
 * aparecer en cualquier cola (`getCasosAbiertos()` lo excluye). Al
 * cerrarlo, se "confirman" en el propio caso del CRM el equipo, la
 * prioridad y la categoría que tenía en ese momento el triaje (IA o
 * corregido por agente): así un caso cerrado por esta vía queda con el
 * mismo aspecto que los casos cerrados de ejemplo del CRM, y puede
 * alimentar los patrones de la vista de Responsable
 * (`patronesCausaRaizPorProducto`, `patronCategoriaGarantia`,
 * `patronesInstalacion`) igual que ellos. `causa_raiz`/`resolucion` son
 * opcionales: si el agente no los rellena, el caso igualmente se cierra.
 * Como `crm.js` mantiene los datos en memoria (no reescribe crm.json),
 * esto se pierde al reiniciar el servidor — mismo criterio que las
 * correcciones de equipo.
 */
app.post('/api/casos/:caseId/resolver', async (req, res) => {
  const { caseId } = req.params;
  const { causa_raiz: causaRaiz, resolucion } = req.body;

  const caso = await getCaso(caseId);
  if (!caso) {
    return res.status(404).json({ error: `Caso no encontrado: ${caseId}` });
  }
  if (caso.estado === 'Cerrado') {
    return res.status(400).json({ error: 'El caso ya está cerrado' });
  }

  const triaje = resumenTriaje(caseId);

  const actualizado = await actualizarCaso(caseId, {
    estado: 'Cerrado',
    categoria: triaje.categoria || caso.categoria || null,
    prioridad: triaje.prioridad || caso.prioridad || null,
    equipo: triaje.equipo || caso.equipo || null,
    causa_raiz: causaRaiz || null,
    resolucion: resolucion || null,
    resuelto_en: new Date().toISOString(),
  });

  res.json({ caso: actualizado });
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
