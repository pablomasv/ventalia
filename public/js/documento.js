/**
 * Visor de un documento del corpus. Se abre en pestaña nueva desde los
 * enlaces "fuente_id" de las afirmaciones citadas
 * (?doc=<documento_id>#<slug-de-seccion>). Pide el documento reconstruido
 * a /api/documentos/:id (documentos.js, que lee corpus-index.json) y lo
 * convierte a HTML con un conversor de markdown mínimo, suficiente para
 * el estilo de los documentos de /data/corpus (párrafos, listas, negrita).
 */

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(texto) {
  return escapeHtml(texto).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * Conversor de markdown a HTML muy básico: no es un parser genérico,
 * cubre exactamente lo que aparece en /data/corpus (párrafos separados
 * por líneas en blanco, listas con "- "/"1. " y negrita **texto**).
 */
function markdownABasicoHtml(texto) {
  const lineas = (texto || '').split('\n');
  let html = '';
  let listaAbierta = null;
  let parrafoActual = [];

  function cerrarParrafo() {
    if (parrafoActual.length) {
      html += `<p>${inline(parrafoActual.join(' '))}</p>`;
      parrafoActual = [];
    }
  }

  function cerrarLista() {
    if (listaAbierta) {
      html += `</${listaAbierta}>`;
      listaAbierta = null;
    }
  }

  for (const linea of lineas) {
    const l = linea.trim();

    if (!l) {
      cerrarParrafo();
      cerrarLista();
      continue;
    }

    const bullet = l.match(/^[-*]\s+(.*)/);
    const numerada = l.match(/^\d+[.)]\s+(.*)/);

    if (bullet) {
      cerrarParrafo();
      if (listaAbierta !== 'ul') {
        cerrarLista();
        html += '<ul>';
        listaAbierta = 'ul';
      }
      html += `<li>${inline(bullet[1])}</li>`;
    } else if (numerada) {
      cerrarParrafo();
      if (listaAbierta !== 'ol') {
        cerrarLista();
        html += '<ol>';
        listaAbierta = 'ol';
      }
      html += `<li>${inline(numerada[1])}</li>`;
    } else {
      cerrarLista();
      parrafoActual.push(l);
    }
  }

  cerrarParrafo();
  cerrarLista();
  return html;
}

function renderFragmento(f) {
  const nivelTag = f.encabezado_padre ? 'h3' : 'h2';
  const padre = f.encabezado_padre
    ? `<p class="doc-fragmento__padre">${escapeHtml(f.encabezado_padre)}</p>`
    : '';
  return `<section class="doc-fragmento" id="${escapeHtml(f.slug)}">
    ${padre}
    <${nivelTag} class="doc-fragmento__titulo">${escapeHtml(f.encabezado)}</${nivelTag}>
    ${markdownABasicoHtml(f.texto)}
  </section>`;
}

async function cargarDocumento() {
  const params = new URLSearchParams(window.location.search);
  const documentoId = params.get('doc');
  const contenedor = document.getElementById('contenido');
  const tituloEl = document.getElementById('doc-titulo');

  if (!documentoId) {
    contenedor.innerHTML = '<p class="empty">Falta el parámetro ?doc= en la URL.</p>';
    return;
  }

  try {
    const res = await fetch(`/api/documentos/${encodeURIComponent(documentoId)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `No se pudo cargar el documento (HTTP ${res.status})`);
    }
    const doc = await res.json();

    document.title = `${doc.titulo} — Ventalia`;
    tituloEl.textContent = doc.titulo;
    contenedor.innerHTML = doc.fragmentos.map(renderFragmento).join('');

    if (window.location.hash) {
      const slug = decodeURIComponent(window.location.hash.slice(1));
      const objetivo = document.getElementById(slug);
      if (objetivo) {
        objetivo.scrollIntoView({ block: 'start', behavior: 'instant' });
        objetivo.classList.add('doc-fragmento--resaltado');
      }
    }
  } catch (err) {
    contenedor.innerHTML = `<p class="empty">No se pudo cargar el documento: ${escapeHtml(err.message)}</p>`;
  }
}

cargarDocumento();
