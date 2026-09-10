# Datos del prototipo — cómo están diseñados y por qué

Estos datos no son relleno. Cada pieza está puesta para que uno de los tres
escenarios funcione. Si cambias algo, comprueba antes qué escenario rompes.

## Dónde va cada cosa

```
tu-proyecto/
  data/
    crm.json          ← el CRM simulado
    corpus/           ← los 5 artículos de conocimiento
      01-manual-vnt-rec-200-ruido-vibracion.md
      02-guia-sustitucion-filtros.md
      03-nota-tecnica-seleccion-recuperador.md
      04-faq-procedimiento-garantia.md
      05-manual-vnt-ext-td800-instalacion.md
```

Cada artículo lleva una cabecera con `id`, `titulo`, `producto` y `dominio`.
El `id` es lo que la IA devuelve como fuente de una cita, y el `dominio`
(tecnico / postventa) es lo que te permite demostrar los permisos por rol.

---

## Escenario A — CASE-2026-018342 · Ruido y vibración

**Qué tiene que pasar:** la IA clasifica como incidencia técnica, recupera del
manual las tres causas posibles, y **las reordena** poniendo el desequilibrio de
rotor por delante, porque el histórico del CRM dice que fue la causa en 2 de los
3 casos anteriores del mismo cliente y modelo.

Piezas que lo hacen posible:

- El manual (§4.2) lista el filtro saturado **primero** y el desequilibrio de
  rotor **segundo**. Esa inversión es deliberada: si la IA respeta el orden del
  manual, no está usando el CRM. Si lo cambia, la orquestación se ve.
- El manual dice que el desequilibrio suena **más en arranques y paradas**. La
  descripción del caso dice "sobre todo por la mañana cuando arranca". Ese es el
  enganche entre el texto libre del cliente y el conocimiento.
- Histórico: `CASE-2025-016004` y `CASE-2026-017120` con causa raíz
  "Desequilibrio de rotor"; `CASE-2025-015233` con "Filtro saturado". Dos de tres.
- El manual (§4.2.4) exige **horas de funcionamiento** para cerrar el
  diagnóstico, y el caso no las da. De ahí sale el "falta un dato" y la pregunta
  al cliente en vez de un diagnóstico inventado.

---

## Escenario B — CASE-2026-018357 · Garantía

**Qué tiene que pasar:** la IA no responde "procede". Cruza tres cosas y llega a
una conclusión matizada: por fecha entra, pero hay una exclusión aplicable y un
antecedente en el histórico, así que propone pedir el informe de puesta en marcha
antes de aprobar.

Piezas que lo hacen posible:

- Pedido `PO-90117`, entrega **2024-12-18**. A julio de 2026 son 19 meses:
  dentro de los 24 de cobertura. La IA tiene que hacer esa cuenta.
- La FAQ de garantía tiene una exclusión explícita por **instalación fuera de
  especificación**, y exige el informe de puesta en marcha cuando hay constancia
  previa de una incidencia de instalación.
- El histórico tiene exactamente eso: `CASE-2025-014120`, sobre el **mismo
  pedido**, donde se documentó montaje rígido sin soportes elásticos.
- El manual del TD800 (§3.2) dice literalmente que ese montaje es instalación
  fuera de especificación. Es el eslabón que conecta el histórico con la
  exclusión.
- El pedido tiene `informe_puesta_en_marcha: false`. Ese campo es el que
  convierte todo lo anterior en una acción concreta.

Este es el escenario que enseña criterio. No lo simplifiques.

---

## Escenario C — CASE-2026-018361 · Fuera de conocimiento

**Qué tiene que pasar:** ninguna cita. La IA declara que no tiene cobertura,
propone escalar a Ingeniería de Producto, y aun así deja el caso documentado con
lo que sí sabe del CRM (cuenta, pedido, 4 unidades, puesta en marcha próxima).

Pieza que lo hace posible: **ninguno de los cinco artículos menciona protocolos
de comunicación, BACnet, Modbus ni integración con sistemas de gestión de
edificios**. La única mención de conectividad es el bus propietario en la nota
técnica de selección, que no responde a la pregunta.

Esto es a propósito y conviene decirlo en la memoria: el hueco de conocimiento
está diseñado, no es un fallo de recuperación.

---

## Si quieres subir la apuesta

Añade un cuarto caso de texto libre en blanco para que el cliente escriba el
suyo en la demo. Con el umbral bien puesto, lo peor que puede pasar es que caiga
en el comportamiento del escenario C, que también es una buena demo.
