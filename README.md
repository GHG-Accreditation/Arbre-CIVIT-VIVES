# Arbre Genealògic — Família Civit · Vives

Aplicació web (HTML + JS, sense backend) per gestionar i navegar l'arbre
genealògic de les famílies Civit i Vives. **1.243 persones úniques**
precarregades des dels dos Excels originals, amb relacions
pare-fill i matrimonials extretes automàticament dels arbres visuals.

## Com obrir-la

Doble clic a `index.html`. Funciona directament sense servidor.

Recomanat (per a evitar restriccions de `file://` en alguns navegadors):

```bash
python3 -m http.server 8000
# i obre  http://localhost:8000
```

> Si obres l'app sense connexió a internet, la **vista de Mapa** no carregarà
> els tiles d'OpenStreetMap. La resta funciona en local.

## Desplegar a GitHub Pages (1 click, automàtic)

El repositori ja inclou un workflow (`.github/workflows/deploy-pages.yml`)
que publica l'app cada cop que es fa un push. Només cal **activar Pages
una vegada** al repositori:

1. Ves a **Settings → Pages** (a github.com/GHG-Accreditation/Arbre-CIVIT-VIVES/settings/pages)
2. A *Source* tria: **GitHub Actions**
3. Guarda.

A partir d'aquí, cada `git push` a `main` o a `claude/genealogy-tree-app-mw2SM`
publicarà automàticament. URL final:

> `https://ghg-accreditation.github.io/Arbre-CIVIT-VIVES/`

(També pots disparar el deploy a mà des de la pestanya **Actions →
Deploy to GitHub Pages → Run workflow**.)

## Desplegar a Vercel (URL pública)

Per a tenir-la accessible des de qualsevol dispositiu (mòbil, etc.):

### Opció A — des de la web de Vercel (la més fàcil)
1. Entra a https://vercel.com/new
2. Inicia sessió amb GitHub
3. **Import Project** → tria el repositori `Claude-2`
4. A "Branch", canvia a `claude/genealogy-tree-app-mw2SM` (o fes merge a `main` abans)
5. Framework Preset: **Other** · Build Command: *(buit)* · Output Directory: *(buit)*
6. **Deploy** — en 30 segons tindràs una URL tipus `arbre-genealogic.vercel.app`

### Opció B — des de la línia de comandes
```bash
git clone -b claude/genealogy-tree-app-mw2SM https://github.com/GHG-Accreditation/Claude-2.git
cd Claude-2
npx vercel        # primer cop: fer login amb el navegador
npx vercel --prod # quan vulguis publicar la versió final
```

Vercel detecta automàticament que és una web estàtica (té `vercel.json`
amb les capçaleres de cache). Cap configuració addicional necessària.

> Cada push a la branca crea automàticament una nova preview-URL si tens
> la integració de GitHub activada.

## Tres vistes

### 1. Llista
- Cercador per nom, cognoms, lloc o any.
- Filtre per **branca** (chips multiselecció): Civit, Moncusí, Gomis, Domínguez,
  Lázaro, Vives, Prat, Cusidó-Plana i Línia Directa.
- Ordenació per cognoms, nom o any de naixement.
- Targetes amb dades de vida, llocs i branques.
- Detall lateral amb edició completa (incloent pares, cònjuges i fills derivats).

### 2. Arbre
- Visualització SVG centrada en una persona.
- Pots configurar quantes **generacions amunt** (ancestres) i **avall**
  (descendents) mostrar.
- **Clic** en qualsevol node = re-centrar l'arbre en aquella persona.
- **Doble clic** = obrir el detall per editar.
- **Arrossegar** per moure'l, **roda del ratolí** o pessigada per fer zoom.
- Cada node mostra el nom, cognoms, anys de vida i una franja de colors amb
  les branques on apareix.
- Línies sòlides = pare-fill · Línies discontínues = matrimoni.

### 3. Mapa
- Tots els llocs de naixement i defunció sobre un mapa OpenStreetMap.
- Marcadors agrupats per zoom (clusters).
- Filtres: per branca i per tipus (naixements / defuncions / tots).
- Clic en un marcador = popup amb la llista de persones associades a aquell
  lloc, navegable.
- 89 dels 108 llocs únics tenen coordenades; els menys habituals (un sol
  esdeveniment) encara no s'han geolocalitzat.

## Navegació encreuada
- Des del detall d'una persona → botó **"Veure a l'arbre →"** centra l'arbre
  en ella i canvia de vista.
- Des de l'arbre → doble clic obre el detall.
- Des del mapa → clic en un nom obre el detall.

## Què s'ha extret automàticament

L'aplicació parseja les hojas visuals dels Excels (`Francesc (Civit)`,
`Rosa Maria (Vives)`, etc.) i, mitjançant la coincidència de cognoms entre
pares i fills, infereix les relacions:
- **~450 persones** amb cònjuge identificat.
- **~120 persones** amb pares identificats.
- La resta es poden completar a mà des del detall.

## Estructura de fitxers

```
index.html   estructura
styles.css   estils
app.js       lògica (vistes, arbre SVG, mapa Leaflet, persistència)
data.js      dades precarregades dels Excels (1.243 persones + relacions + 89 llocs)
data.json    equivalent en JSON pur
```

## Properes millores possibles

- Geolocalitzar manualment els llocs que falten (afegir un editor de places).
- Vista de cronologia (timeline horitzontal) per branca.
- Generació automàtica d'una "història" textual d'un avantpassat.
- Detecció i fusió de duplicats potencials.
- Suport per adjuntar fotos i documents.
- Sincronització cloud opcional.
- Compartir un arbre per URL (encoding del state).
