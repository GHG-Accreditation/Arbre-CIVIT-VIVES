# Arbre Genealògic — Família Civit · Vives

Aplicació web (HTML + JS, sense backend) per gestionar l'arbre genealògic
de les famílies Civit i Vives, amb les dades dels dos fitxers Excel
originals ja precarregades (**1.243 persones úniques**).

## Com obrir-la

Només cal obrir `index.html` al navegador.

Recomanació: serveix-la amb un mini-servidor local per evitar restriccions de
`file://` en alguns navegadors:

```bash
python3 -m http.server 8000
# i obre  http://localhost:8000
```

## Què inclou ara mateix

- **Cercador** per nom, cognoms, lloc o any.
- **Filtre per branca** (chips clicables): Civit, Moncusí, Gomis, Domínguez,
  Lázaro, Vives, Prat, Cusidó-Plana i Línia Directa. Es poden combinar.
- **Ordenació** per cognoms, nom o any de naixement.
- **Targetes** amb nom, cognoms, dates de vida, llocs i les branques on apareix.
- **Detall i edició** de cada persona: nom, cognoms, naixement, defunció,
  branques, notes.
- **Relacions**: pares (fins a 2), cònjuges, fills (derivat automàticament
  dels pares dels altres).
- **Alta de noves persones** i eliminació.
- **Import / Export JSON** per fer còpies de seguretat o moure dades entre
  dispositius.
- **Reinicialitzar** a les dades originals dels Excels.
- **Persistència** dels canvis a `localStorage` del navegador.

## Estructura de fitxers

```
index.html   — estructura
styles.css   — estils
app.js       — lògica
data.js      — dades precarregades dels Excels (1.243 persones)
data.json    — equivalent en JSON pur (per referència / import)
```

## Properes millores possibles

- Vista d'arbre gràfic (canvas/SVG) navegable a partir d'un nodo.
- Importar més camps dels Excels (dates exactes, parròquies, fonts).
- Reconstruir parentius automàticament a partir de les fulles d'arbre
  visual dels Excels (Francesc Civit, Francesc Gomis…).
- Línia del temps i mapa de llocs.
- Adjuntar fotos i documents.
- Sincronització cloud opcional.
