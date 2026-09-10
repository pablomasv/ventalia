/**
 * Portal público de alta de casos (/nuevo-caso).
 * Pasos: 1) datos básicos → 2) preguntas opcionales → 3) resumen/creación.
 */

const estado = {
  catalogo: null,
  paso: 1,
  cuentaId: '',
  contactoId: '',
  productoId: '',
  descripcion: '',
  analisis: null,
  respuestas: {}, // índice de pregunta → texto
  cargando: false,
  error: null,
  resultadoCreacion: null,
};

const appEl = document.getElementById('alta-app');

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function enlaceDocumento(fuenteId) {
  if (!fuenteId || !fuenteId.includes('#')) return null;
  const [documentoId, slug] = fuenteId.split('#');
  return `/documento.html?doc=${encodeURIComponent(documentoId)}#${encodeURIComponent(slug)}`;
}

function contactosDeCuenta(cuentaId) {
  return (estado.catalogo?.contactos || []).filter((c) => c.cuenta_id === cuentaId);
}

function nombreCuenta(id) {
  return estado.catalogo?.cuentas.find((c) => c.id === id)?.nombre || id;
}

function nombreContacto(id) {
  return estado.catalogo?.contactos.find((c) => c.id === id)?.nombre || id;
}

function nombreProducto(id) {
  const p = estado.catalogo?.productos.find((x) => x.id === id);
  return p ? `${p.referencia} — ${p.nombre}` : id;
}

function renderSteps() {
  const labels = ['1 · Datos del caso', '2 · Datos adicionales', '3 · Confirmación'];
  return `<div class="alta-steps">${labels
    .map((label, i) => {
      const n = i + 1;
      let cls = 'alta-step-pill';
      if (n === estado.paso) cls += ' alta-step-pill--activo';
      else if (n < estado.paso) cls += ' alta-step-pill--hecho';
      return `<span class="${cls}">${label}</span>`;
    })
    .join('')}</div>`;
}

function renderPaso1() {
  const contactos = contactosDeCuenta(estado.cuentaId);
  const opcionesCuenta = (estado.catalogo.cuentas || [])
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}"${c.id === estado.cuentaId ? ' selected' : ''}>${escapeHtml(c.nombre)} (${escapeHtml(c.pais)})</option>`
    )
    .join('');

  const opcionesContacto = contactos.length
    ? contactos
        .map(
          (c) =>
            `<option value="${escapeHtml(c.id)}"${c.id === estado.contactoId ? ' selected' : ''}>${escapeHtml(c.nombre)} — ${escapeHtml(c.cargo || '')}</option>`
        )
        .join('')
    : '<option value="">Selecciona primero una cuenta</option>';

  const opcionesProducto = (estado.catalogo.productos || [])
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}"${p.id === estado.productoId ? ' selected' : ''}>${escapeHtml(p.referencia)} — ${escapeHtml(p.nombre)} (${escapeHtml(p.gama)})</option>`
    )
    .join('');

  return `<section class="alta-card">
    <h2>Describe tu consulta</h2>
    <p class="alta-card__sub">Indica la cuenta (ya identificada en el portal), el contacto, el producto afectado y una descripción libre del problema.</p>
    <div class="alta-field">
      <label for="alta-cuenta">Cuenta</label>
      <select id="alta-cuenta"><option value="">Seleccionar…</option>${opcionesCuenta}</select>
    </div>
    <div class="alta-field">
      <label for="alta-contacto">Contacto</label>
      <select id="alta-contacto" ${!estado.cuentaId ? 'disabled' : ''}><option value="">Seleccionar…</option>${opcionesContacto}</select>
    </div>
    <div class="alta-field">
      <label for="alta-producto">Producto afectado</label>
      <select id="alta-producto"><option value="">Seleccionar…</option>${opcionesProducto}</select>
    </div>
    <div class="alta-field">
      <label for="alta-descripcion">Descripción del problema</label>
      <textarea id="alta-descripcion" placeholder="Explica qué ocurre, desde cuándo y en qué condiciones…">${escapeHtml(estado.descripcion)}</textarea>
    </div>
    <div class="alta-actions">
      <button type="button" class="btn btn--primary" id="alta-siguiente-1" ${estado.cargando ? 'disabled' : ''}>Continuar</button>
    </div>
  </section>`;
}

function renderPaso2() {
  const preguntas = estado.analisis?.preguntas || [];
  if (!preguntas.length) {
    return `<section class="alta-card">
      <h2>Datos adicionales</h2>
      <p class="alta-card__sub">No se han identificado datos adicionales exigidos por la documentación a partir de tu descripción. Puedes continuar a la confirmación.</p>
      <div class="alta-actions">
        <button type="button" class="btn" id="alta-atras-2">Atrás</button>
        <button type="button" class="btn btn--primary" id="alta-siguiente-2">Continuar</button>
      </div>
    </section>`;
  }

  const items = preguntas
    .map((p, i) => {
      const href = enlaceDocumento(p.fuente_id);
      const fuente = href
        ? `<a class="alta-pregunta__fuente" href="${href}" target="_blank" rel="noopener noreferrer">Ver sección en la documentación (${escapeHtml(p.fuente_id)})</a>`
        : `<span class="alta-muted">${escapeHtml(p.fuente_id || '')}</span>`;
      return `<div class="alta-pregunta">
        <strong>${escapeHtml(p.pregunta)}</strong>
        <p class="alta-pregunta__porque">${escapeHtml(p.porque || 'Dato exigido por la documentación recuperada.')}</p>
        ${fuente}
        <div class="alta-field" style="margin-bottom:0">
          <label for="alta-r-${i}">Tu respuesta (opcional)</label>
          <textarea id="alta-r-${i}" rows="2">${escapeHtml(estado.respuestas[i] || '')}</textarea>
        </div>
      </div>`;
    })
    .join('');

  return `<section class="alta-card">
    <h2>Algunos datos ayudarían al diagnóstico</h2>
    <p class="alta-card__sub">La documentación sugiere estas preguntas. Todas son opcionales: puedes saltarlas y crear el caso igual.</p>
    ${items}
    <div class="alta-actions">
      <button type="button" class="btn" id="alta-atras-2">Atrás</button>
      <button type="button" class="btn" id="alta-saltar-2">Saltar y continuar</button>
      <button type="button" class="btn btn--primary" id="alta-siguiente-2">Continuar</button>
    </div>
  </section>`;
}

function datosRecogidosParaEnvio() {
  const preguntas = estado.analisis?.preguntas || [];
  return preguntas.map((p, i) => ({
    pregunta: p.pregunta,
    porque: p.porque || null,
    fuente_id: p.fuente_id || null,
    respuesta: (estado.respuestas[i] || '').trim(),
  }));
}

function renderPaso3() {
  const recogidos = datosRecogidosParaEnvio().filter((d) => d.respuesta);
  const listaRecogidos = recogidos.length
    ? `<ul>${recogidos
        .map(
          (d) =>
            `<li><strong>${escapeHtml(d.pregunta)}</strong><br>${escapeHtml(d.respuesta)}</li>`
        )
        .join('')}</ul>`
    : '<p class="alta-muted">Sin respuestas adicionales (o se han omitido).</p>';

  return `<section class="alta-card">
    <h2>Resumen antes de crear el caso</h2>
    <p class="alta-card__sub">Revisa lo que se va a registrar. El caso solo se crea al confirmar.</p>
    <dl class="alta-resumen-dl">
      <dt>Cuenta</dt><dd>${escapeHtml(nombreCuenta(estado.cuentaId))}</dd>
      <dt>Contacto</dt><dd>${escapeHtml(nombreContacto(estado.contactoId))}</dd>
      <dt>Producto</dt><dd>${escapeHtml(nombreProducto(estado.productoId))}</dd>
      <dt>Canal</dt><dd>formulario</dd>
      <dt>Descripción</dt><dd>${escapeHtml(estado.descripcion)}</dd>
    </dl>
    <h3 style="font-size:0.9rem;margin:0 0 0.4rem">Datos recogidos en el asistente</h3>
    ${listaRecogidos}
    <p class="alta-muted">Categoría, prioridad y equipo los propondrá el triaje automático tras la creación.</p>
    <div class="alta-actions">
      <button type="button" class="btn" id="alta-atras-3" ${estado.cargando ? 'disabled' : ''}>Atrás</button>
      <button type="button" class="btn btn--primary" id="alta-crear" ${estado.cargando ? 'disabled' : ''}>${estado.cargando ? 'Creando y triando…' : 'Confirmar y crear caso'}</button>
    </div>
  </section>`;
}

function renderExito() {
  const r = estado.resultadoCreacion;
  const equipo = r.triaje?.equipo || 'pendiente de asignación';
  return `<section class="alta-card alta-ok">
    <h2>Caso registrado</h2>
    <p><strong>Referencia:</strong> ${escapeHtml(r.caso.id)}</p>
    <p><strong>Estado:</strong> ${escapeHtml(r.caso.estado)}</p>
    <p><strong>Equipo enrutado:</strong> ${escapeHtml(equipo)}</p>
    ${
      r.triaje?.categoria
        ? `<p><strong>Categoría / prioridad:</strong> ${escapeHtml(r.triaje.categoria)} · ${escapeHtml(r.triaje.prioridad || '—')}</p>`
        : ''
    }
    <p class="alta-muted">El triaje se ha ejecutado automáticamente. Un agente del equipo correspondiente verá el caso en su cola.</p>
    <div class="alta-actions">
      <a class="btn btn--primary" href="/nuevo-caso">Abrir otro caso</a>
      <a class="btn" href="/">Ir a la gestión de casos</a>
    </div>
  </section>`;
}

function render() {
  if (!estado.catalogo && !estado.error) {
    appEl.innerHTML = `<div class="loading"><span class="spinner"></span> Cargando…</div>`;
    return;
  }

  if (estado.resultadoCreacion) {
    appEl.innerHTML = `${renderSteps()}${renderExito()}`;
    return;
  }

  let cuerpo = '';
  if (estado.paso === 1) cuerpo = renderPaso1();
  else if (estado.paso === 2) cuerpo = renderPaso2();
  else cuerpo = renderPaso3();

  const errorHtml = estado.error
    ? `<div class="alta-error">${escapeHtml(estado.error)}</div>`
    : '';
  const loadingHtml = estado.cargando
    ? `<div class="loading" style="margin-bottom:1rem"><span class="spinner"></span> Analizando documentación…</div>`
    : '';

  appEl.innerHTML = `${renderSteps()}${errorHtml}${loadingHtml}${cuerpo}`;
  bind();
}

function leerPaso1DelDom() {
  estado.cuentaId = document.getElementById('alta-cuenta')?.value || '';
  estado.contactoId = document.getElementById('alta-contacto')?.value || '';
  estado.productoId = document.getElementById('alta-producto')?.value || '';
  estado.descripcion = document.getElementById('alta-descripcion')?.value || '';
}

function leerRespuestasDelDom() {
  const preguntas = estado.analisis?.preguntas || [];
  preguntas.forEach((_, i) => {
    const el = document.getElementById(`alta-r-${i}`);
    if (el) estado.respuestas[i] = el.value;
  });
}

function bind() {
  const cuenta = document.getElementById('alta-cuenta');
  if (cuenta) {
    cuenta.addEventListener('change', () => {
      estado.cuentaId = cuenta.value;
      estado.contactoId = '';
      const contactos = contactosDeCuenta(estado.cuentaId);
      if (contactos.length === 1) estado.contactoId = contactos[0].id;
      render();
    });
  }

  document.getElementById('alta-siguiente-1')?.addEventListener('click', async () => {
    leerPaso1DelDom();
    estado.error = null;
    if (!estado.cuentaId || !estado.contactoId || !estado.productoId || !estado.descripcion.trim()) {
      estado.error = 'Completa cuenta, contacto, producto y descripción.';
      render();
      return;
    }

    estado.cargando = true;
    render();
    try {
      const res = await fetch('/api/alta/analizar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          descripcion: estado.descripcion.trim(),
          productoId: estado.productoId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      estado.analisis = data;
      estado.respuestas = {};
      estado.paso = 2;
    } catch (err) {
      estado.error = err.message;
    } finally {
      estado.cargando = false;
      render();
    }
  });

  document.getElementById('alta-atras-2')?.addEventListener('click', () => {
    leerRespuestasDelDom();
    estado.paso = 1;
    estado.error = null;
    render();
  });

  const irAPaso3 = () => {
    leerRespuestasDelDom();
    estado.paso = 3;
    estado.error = null;
    render();
  };

  document.getElementById('alta-siguiente-2')?.addEventListener('click', irAPaso3);
  document.getElementById('alta-saltar-2')?.addEventListener('click', () => {
    estado.respuestas = {};
    irAPaso3();
  });

  document.getElementById('alta-atras-3')?.addEventListener('click', () => {
    estado.paso = 2;
    estado.error = null;
    render();
  });

  document.getElementById('alta-crear')?.addEventListener('click', async () => {
    estado.cargando = true;
    estado.error = null;
    render();
    try {
      const res = await fetch('/api/alta/crear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cuentaId: estado.cuentaId,
          contactoId: estado.contactoId,
          productoId: estado.productoId,
          descripcion: estado.descripcion.trim(),
          datos_recogidos: datosRecogidosParaEnvio(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      estado.resultadoCreacion = data;
      estado.paso = 3;
    } catch (err) {
      estado.error = err.message;
    } finally {
      estado.cargando = false;
      render();
    }
  });
}

async function init() {
  try {
    const res = await fetch('/api/alta/catalogo');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    estado.catalogo = data;
  } catch (err) {
    estado.error = err.message;
  }
  render();
}

init();
