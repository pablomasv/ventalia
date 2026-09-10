async function fetchCasos(rol) {
  const res = await fetch(`/api/casos?rol=${encodeURIComponent(rol)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Error ${res.status} al cargar casos`);
  }
  return res.json();
}

async function fetchResponsable() {
  const res = await fetch('/api/responsable');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Error ${res.status} al cargar el panel de responsable`);
  }
  return res.json();
}

async function analizarCaso(caseId, rol, forzar) {
  const res = await fetch('/api/analizar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId, rol, forzar: Boolean(forzar) }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status} al analizar`);
  }
  return data;
}

async function reasignarCaso(caseId, equipo) {
  const res = await fetch(`/api/casos/${encodeURIComponent(caseId)}/equipo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ equipo }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status} al reasignar`);
  }
  return data;
}

async function resolverCaso(caseId, { causaRaiz, resolucion } = {}) {
  const res = await fetch(`/api/casos/${encodeURIComponent(caseId)}/resolver`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ causa_raiz: causaRaiz || null, resolucion: resolucion || null }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status} al resolver el caso`);
  }
  return data;
}

async function corregirTriajeCaso(caseId, cambios) {
  const res = await fetch(`/api/casos/${encodeURIComponent(caseId)}/triaje`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cambios),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status} al corregir el triaje`);
  }
  return data;
}

async function marcarCasoRespondido(caseId) {
  const res = await fetch(`/api/casos/${encodeURIComponent(caseId)}/respondido`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status} al marcar el caso como respondido`);
  }
  return data;
}
