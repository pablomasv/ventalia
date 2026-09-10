# Cómo funciona el análisis asistido por IA  
## Marca de demo: Ventalia Ventilation Group

Documento técnico de proceso: describe **qué ocurre desde que un caso entra en el sistema hasta justo antes de renderizarlo en la UI**, indicando en cada paso **qué script lo realiza**. Stack: Node.js + Express, OpenAI (`text-embedding-3-small` + `gpt-4o`), frontend vanilla en `/public`.

---

## 1. Idea general

El sistema no sustituye al agente: **propone** triaje, diagnóstico o decisión de postventa, borrador y fuentes. Combina tres tipos de información:

| Fuente | Qué aporta | Quién lo calcula | Script / artefacto |
|--------|------------|------------------|--------------------|
| **CRM** | Cuenta, producto, pedido, historial, casos similares | Lectura de datos (simulados) | `crm.js` ← `data/crm.json` |
| **Corpus** | Manuales, FAQs, política comercial | Indexación + recuperación semántica | `indexar.js` → `data/corpus-index.json`; búsqueda en `buscar.js` |
| **Reglas de cobertura** | Plazo, segmento, cortesía | Cálculo determinista (sin IA) | `cobertura.js` |

El orquestador de todo el análisis de un caso es **`analizar.js`** (`analizarCaso`). La IA (**GPT-4o**) razona y redacta a partir de bloques que le pasa la aplicación; no inventa el plazo ni el segmento: esos hechos se fijan antes de la llamada al modelo.

---

## 2. Mapa de scripts del pipeline

| Script | Rol |
|--------|-----|
| **`indexar.js`** | Script manual. Trocea `/data/corpus/*.md`, pide embeddings y escribe `data/corpus-index.json`. |
| **`limpiar-consulta.js`** | Limpieza determinista (regex) de la descripción del cliente antes de buscar. |
| **`buscar.js`** | Embedding de la consulta + similitud coseno + filtros dominio/producto + umbral. |
| **`crm.js`** | Acceso al CRM simulado (casos, contexto, similares, historial, actualización en memoria). |
| **`cobertura.js`** | `evaluarCobertura`, segmento comercial, meses desde entrega. Sin IA. |
| **`analizar.js`** | Orquestador: CRM + cobertura + búsqueda(s) + GPT-4o + validaciones post-modelo. |
| **`triaje.js`** | Caché (`triaje-cache.json` / memoria), correcciones de agente, `analizarConCache`. |
| **`pretriaje.js`** | Script manual. Recorre casos abiertos y persiste el lote en `data/triaje-cache.json`. |
| **`cola.js`** | Filas de cola = CRM + `triaje.resumenTriaje()`, filtradas por rol. |
| **`dashboard.js`** | Métricas y patrones de la vista Responsable. |
| **`documentos.js`** | Reconstruye un documento del corpus para el visor de fuentes. |
| **`server.js`** | Express: estáticos + APIs (`/api/casos`, `/api/analizar`, etc.). |
| **`public/js/api.js`** | Cliente HTTP de la SPA. |
| **`public/js/app.js`** | Render de colas y detalle (técnico / postventa / responsable). |
| **`probar-busqueda.js`** | Utilidad de terminal para calibrar `buscar()` sin montar el servidor. |

---

## 3. Preparación previa: indexación del corpus

**Script:** `indexar.js` (`node indexar.js`)  
**Entrada:** `/data/corpus/*.md`  
**Salida:** `data/corpus-index.json`

1. Separa cabecera YAML y cuerpo Markdown.  
2. Trocea por encabezados `##` y `###` (cada `###` conserva su `##` padre).  
3. Genera un `id` de fragmento único: `documento#encabezado-normalizado`.  
4. Llama a la API de embeddings (`text-embedding-3-small`) **por fragmento**.  
5. Persiste texto + metadatos + vector.

Ese índice **no se regenera en cada análisis**. Solo cuando cambia la documentación o el troceado. **`buscar.js`** lo lee después; no vuelve a embeddear los documentos en cada caso.

```text
data/corpus/*.md
        │
        ▼
   indexar.js  ──embeddings──►  OpenAI (text-embedding-3-small)
        │
        ▼
 data/corpus-index.json
        │
        ▼
   buscar.js  (en cada análisis de caso)
```

---

## 4. Quién dispara el análisis de un caso

| Disparador | Script / ruta | Comportamiento |
|------------|---------------|----------------|
| Lote previo | `pretriaje.js` | Llama `analizarCaso(id, 'responsable')` en serie y escribe `triaje-cache.json`. |
| Abrir caso / API | `server.js` → `POST /api/analizar` → `triaje.analizarConCache` | Si hay caché y no `forzar`: devuelve caché. Si no hay o `forzar`: ejecuta `analizarCaso` y guarda en **memoria** (no pisa el JSON de disco). |
| UI | `public/js/app.js` → `public/js/api.js` | Envía `{ caseId, rol, forzar }`. |

Lo que sigue es el interior de **`analizarCaso()`** en **`analizar.js`** (camino completo).

---

## 5. Flujo de `analizarCaso` (paso a paso)

### Paso 1 — Contexto CRM

**Scripts:** `analizar.js` orquesta; datos vía **`crm.js`**.

| Función | Uso |
|---------|-----|
| `getCaso` | Caso actual |
| `getContextoCuenta` | Cuenta, contacto, producto, pedido |
| `getCasosSimilares` | Cerrados del mismo producto con `causa_raiz` |
| `contarCasosCuenta` | Nº de casos previos de la cuenta |
| `getHistorialCuenta` | Pedidos + casos de la cuenta (solo UI / cronología; **no** entra en el prompt) |

El **segmento comercial** (Oro / Plata / Estándar) se recalcula con **`cobertura.calcularSegmentoComercial(facturacion_ultimos_12m)`**, no se confía a ciegas en el campo del JSON.

---

### Paso 2 — Cobertura de garantía (determinista, sin IA)

**Script:** `cobertura.js` → `evaluarCobertura(caso, pedido, cuenta)`  
Invocado desde **`analizar.js`** siempre que haya pedido con fecha de entrega.

Calcula: meses desde entrega, dentro/fuera de plazo (24 meses), segmento, margen de cortesía, cortesía aplicable. Cada valor puede llevar `fuente_id` de referencia al corpus. Viaja en la respuesta como `cobertura_calculada` (también en rama sin cobertura de conocimiento).

---

### Paso 3 — Construir la consulta de búsqueda

**Scripts:** `limpiar-consulta.js` (`limpiarConsulta`) + armado en **`analizar.js`**.

1. Limpia la descripción (saludos, despedidas, fórmulas vacías; regex ancladas, sin IA).  
2. Consulta final:
   ```text
   asunto + descripción_limpia + referencia_producto + gama
   ```

El CRM **no** se embeddea: entra después como texto estructurado en el prompt.

---

### Paso 4 — Primera recuperación RAG

**Script:** `buscar.js` → `buscar(consulta, referenciaProducto, { dominioRol })`  
Llamado desde **`analizar.js`**. Modelo de embedding: `text-embedding-3-small`.

1. Filtra el índice por **dominio del rol** (`tecnico` / `postventa` / sin filtro si responsable).  
2. Embedding de la consulta.  
3. Similitud coseno vs fragmentos permitidos.  
4. Filtro por **producto** (referencia o `"todos"`).  
5. Umbral (~0.50) → `motivo`: `cubierto` | `sin_cobertura_producto` | `sin_cobertura`.  
6. Devuelve top N fragmentos + mejor descartado.

---

### Paso 5A — Sin cobertura (`motivo !== 'cubierto'`)

**Script:** `analizar.js`

- **No** se hace la llamada grande de RAG a GPT.  
- Sí: llamada breve a **GPT-4o** con `PROMPT_TRIAJE_SIN_CORPUS` + solo `CONTEXTO_CRM`.  
- Respuesta: `{ categoria, prioridad, equipo, porque }`.  
- `normalizarTriaje()` + propuesta de `escalado`.  
- Devuelve `cubierto: false` (sin borrador citado ni afirmaciones de corpus).  
- `cobertura_calculada` sigue presente.

---

### Paso 5B — Con cobertura

#### 5B.1 Segunda búsqueda (misma ejecución de `analizarCaso`)

**Scripts:** detección en **`analizar.js`** (`detectarTipoReclamacion`); otra llamada a **`buscar.js`**.

Si el caso parece reclamación/gestión postventa y hay segmento comercial, se lanza una segunda query del tipo:

```text
cliente <segmento> <tipo> margen comercial gestos comerciales
```

Fragmentos etiquetados (`problema` / `marco_decision`), deduplicados por `id`, unidos en `CONOCIMIENTO_CORPUS`.

#### 5B.2 Llamada a GPT-4o

**Script:** `analizar.js` → `llamarOpenAI(...)`.

Tres bloques en el prompt:

1. **`CONTEXTO_CRM`** — formateado en `analizar.js`  
2. **`COBERTURA_CALCULADA`** — desde `cobertura.js` (hechos: no recalcular ni contradecir)  
3. **`CONOCIMIENTO_CORPUS`** — fragmentos de `buscar.js` con `fuente_id` = `documento#sección`

JSON esperado del modelo (resumen):

| Campo | Contenido |
|-------|-----------|
| `triaje` | categoría, prioridad, equipo, porque |
| `diagnostico` | causas candidatas, `orden_alterado_por_historico`, `motivo_orden` |
| `decision_postventa` | veredicto, motivo, factores a favor/en contra |
| `afirmaciones[]` | origen `crm` \| `corpus` \| `modelo` (+ `fuente_id` / `campo`) |
| `falta_dato` | dato pendiente o null |
| `borrador` | mensaje al cliente |
| `siguiente_accion` | acción concreta para el agente |

---

### Paso 6 — Validaciones deterministas (post-modelo)

**Script:** todo en **`analizar.js`** (sin nueva llamada a OpenAI).

| Función | Qué hace |
|---------|----------|
| `normalizarTriaje` / `normalizarDiagnostico` / `normalizarDecisionPostventa` | Fuerza enums cerrados (categoría, equipo, veredicto…) |
| `validarAfirmacionesCorpus` | `fuente_id` debe ser un fragmento **recuperado**; cifras de la afirmación deben aparecer **literalmente** en el fragmento; si no → `afirmaciones_descartadas` |
| `detectarIncoherenciaCobertura` | Compara `decision_postventa` con `cobertura_calculada`; **no corrige** el veredicto, solo rellena `incoherencias_cobertura` |

---

### Paso 7 — Empaquetado y entrega a la API (aún sin UI)

**Scripts:** `analizar.js` (objeto resultado) → **`triaje.js`** (`analizarConCache` / `guardarEnMemoria` / origen `cache`|`vivo`) → **`server.js`** responde JSON.

La UI (`public/js/app.js`) solo interpreta ese JSON: acciones, respaldo, cobertura, borrador, avisos. Acciones del agente (corregir triaje, resolver, respondido) van por otros endpoints de `server.js` y, en el prototipo, persisten en **memoria** vía `triaje.js` / `crm.actualizarCaso`.

---

## 6. Diagrama del flujo (con scripts)

```text
 data/corpus/*.md
        │
        ▼
   indexar.js ──────────────────► data/corpus-index.json
                                        │
 pretriaje.js ──┐                       │
 POST /api/analizar                     │
 (server.js)    │                       │
        │       │                       │
        ▼       ▼                       │
   triaje.analizarConCache              │
   (triaje.js)                          │
        │                               │
        │  miss / forzar                │
        ▼                               │
   analizar.analizarCaso                │
   (analizar.js)                        │
        │                               │
        ├─ crm.js                       │
        ├─ cobertura.js                 │
        ├─ limpiar-consulta.js          │
        ├─ buscar.js ◄──────────────────┘  (embedding + coseno)
        │     └─ (opcional 2ª buscar.js)
        ├─ GPT-4o (OpenAI)
        ├─ validaciones en analizar.js
        │
        ▼
   JSON resultado ──► server.js ──► public/js/api.js + app.js
```

Cadena conceptual del núcleo:

```text
analizar.js (arma query)
    → buscar.js (embedding + similitud)
    → analizar.js (GPT-4o: triaje + propuesta)
    → analizar.js (validaciones)
    → triaje.js / server.js
```

---

## 7. Pre-triaje frente a abrir un caso

| Concepto | Script | Detalle |
|----------|--------|---------|
| Pre-triaje | `pretriaje.js` | Usa `analizarCaso` con rol `'responsable'` (sin filtrar dominio de conocimiento). Persiste en `data/triaje-cache.json`. |
| Cola de agentes | `cola.js` + `triaje.resumenTriaje` | Filtra por `equipo` propuesto (Técnico / Postventa). Sin caché → `pendiente`, solo visible al Responsable. |
| Abrir caso | `triaje.analizarConCache` | Caché por defecto; `forzar: true` repite embeddings + GPT y guarda en memoria. |
| Panel Responsable | `dashboard.js` | Carga y patrones sobre cola + casos cerrados del CRM. |

---

## 8. Vistas de la UI (post-pipeline)

**Script:** `public/js/app.js` (datos vía `public/js/api.js` y `server.js`).

| Rol | Objetivo |
|-----|----------|
| Agente técnico | Acciones de verificación + respaldo corpus/CRM + borrador |
| Agente postventa | Decisión, contexto de cliente/pedido, cobertura calculada, borrador |
| Responsable | Carga de trabajo + patrones “outer loop” (`dashboard.js`) |

Visor de documentos citados: `documentos.js` + `public/documento.html` / `public/js/documento.js`.

---

## 9. Límites del prototipo

- CRM simulado (`data/crm.json`), no Dynamics 365.  
- Correcciones de triaje, resolución de casos y reanálisis forzados: **memoria** del proceso Node (salvo el lote de `pretriaje.js` en disco).  
- La IA **propone**; el agente confirma, corrige o escala.  
- Sin cobertura de corpus: no se inventa respuesta técnica citada; se escala.

---

## 10. Resumen

> **`indexar.js` prepara el corpus. Por cada caso, `analizar.js` carga el CRM (`crm.js`), fija la cobertura (`cobertura.js`), limpia la consulta (`limpiar-consulta.js`), recupera documentación con `buscar.js` (embeddings + coseno) y, si hay cobertura, pide a GPT-4o el triaje y la propuesta; valida citas y coherencia en el propio `analizar.js`. `triaje.js` y `server.js` entregan el JSON a la SPA (`app.js`).**

---

*Documento técnico de proceso · Ventalia · Referencia de scripts del repositorio.*
