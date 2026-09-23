# Ventalia — AI-Assisted Case Management

An AI copilot for customer service teams at an industrial equipment manufacturer. When a support case comes in, it proposes a triage, a diagnosis or post-sales decision, a draft reply to the customer, and the sources behind every claim. The agent always makes the final call.

> **Ventalia Ventilation Group** is a fictional HVAC manufacturer used as the demo brand. All CRM and documentation data is synthetic. The UI and demo content are in Spanish.

![Ventalia case view]docs/Screenshot 2026-09-23 at 09.55.48.png

---

## The problem

For every case, a support agent has to cross-check three sources: the customer record (account, product, order, case history), the technical and commercial documentation, and the warranty rules. It is slow, and it is where inconsistent answers come from.

An LLM can speed this up, but in customer support a reply with an invented warranty term or a citation to a manual section that doesn't say that is worse than no reply at all. This project explores how to get the speed without giving up trust.

---

## Key design decisions

**Facts are computed, not generated.**
Warranty coverage (months since delivery, inside or outside the 24-month term, courtesy margin) and the customer's commercial segment (Gold / Silver / Standard, recomputed from trailing 12-month revenue) are calculated deterministically in `cobertura.js` *before* the model is called. The model receives them as fixed facts it must not recalculate or contradict.

**Every documentation claim is verified after generation.**
The model must tag each claim with its origin: CRM, corpus, or model. A corpus claim must cite a fragment ID that was actually retrieved for this case, and any figure in the claim must appear literally in that fragment. Claims that fail either check are moved to a discarded list instead of reaching the agent.

**No coverage, no answer.**
Retrieval uses a calibrated cosine-similarity threshold (~0.50). If nothing in the documentation clears it, the system skips the full RAG call, performs a lightweight triage from CRM data only, and proposes escalation. It never produces a cited technical answer without supporting documentation.

**Retrieval is scoped by role and product.**
Technical and post-sales agents search different knowledge domains, and fragments are filtered by product reference. For post-sales claims, a second retrieval pass pulls the commercial policy that applies to the customer's segment.

**Inconsistencies are flagged, not silently fixed.**
If the model's post-sales verdict conflicts with the computed warranty coverage, the conflict is surfaced to the agent rather than overridden behind the scenes.

**The AI proposes, the agent decides.**
Agents can confirm the proposal, correct the triage, resolve, or escalate.

---

## How it works

```text
Support case
   │
   ├─► CRM context                crm.js              account, product, order, similar cases
   ├─► Warranty & segment rules   cobertura.js        deterministic, no AI
   ├─► Query cleanup              limpiar-consulta.js deterministic, no AI
   └─► Retrieval                  buscar.js           embeddings + cosine, role/product filters, threshold
          │
          ├─ no coverage ──► CRM-only triage ──► escalation proposal
          │
          └─ coverage ─────► GPT-4o
                             (CRM context + computed coverage + retrieved fragments)
                                   │
                                   ▼
                             Post-model validation   enums, citations, coherence
                                   │
                                   ▼
                             JSON ──► API ──► UI
```

`analizar.js` orchestrates the whole flow. A batch **pre-triage** script (`pretriaje.js`) analyzes all open cases in advance, so agent queues arrive already triaged and routed; opening a case uses the cached analysis unless a re-run is forced.

The UI has three role-based views:

- **Technical agent** — verification steps, supporting evidence from the documentation and CRM, draft reply.
- **Post-sales agent** — decision proposal, customer and order context, computed coverage, draft reply.
- **Supervisor** — workload overview and detection of recurring patterns across cases.

A detailed step-by-step description of the pipeline, script by script, is available in [`docs/como-funciona-el-analisis.md`](docs/como-funciona-el-analisis.md) (in Spanish).

---

## Tech stack

- **Backend:** Node.js + Express
- **AI:** OpenAI `text-embedding-3-small` (retrieval) and `gpt-4o` (reasoning and drafting)
- **Frontend:** vanilla JavaScript single-page app
- **Data:** synthetic CRM (accounts, cases, products, orders, interaction history) and a 9-document knowledge corpus, indexed into a JSON embedding store

---

## Quickstart

Requires Node.js and an OpenAI API key.

```bash
git clone https://github.com/pablomasv/ventalia.git
cd ventalia
npm install

# Add your OpenAI key
echo "OPENAI_API_KEY=sk-..." > .env

# Build the embedding index (only needed when the corpus changes)
node indexar.js

# Pre-triage open cases (recommended: without it, cases appear as pending)
node pretriaje.js

# Start the app
node server.js
```

`probar-busqueda.js` lets you test and calibrate retrieval from the terminal without starting the server.

---

## Limitations

- The CRM is simulated with a JSON file, not a live integration.
- Agent actions (triage corrections, resolutions, forced re-runs) are kept in process memory; only the pre-triage batch is persisted to disk.
- Similarity search is brute-force over a JSON index; a larger corpus would call for a vector database.
- Numeric validation is literal matching, so a correct figure expressed differently from the source (e.g. a unit conversion) is discarded rather than accepted.

---

## Roadmap

- **Assisted case creation:** a form that uses documentation knowledge to guide data collection before the case exists in the CRM.
- **Conversational channel:** a chat interface that creates the case and responds to the customer in real time.
