# Digital Denture CAD

Browserprototype voor het ontwerpen van individuele lepels, beetplaten en prothesen op 3D-scans (STL), plus een orderoverzicht voor 3Shape-exports.

> Prototype · niet klinisch gevalideerd · niet voor productie zonder controle in slicer/CAM en door een tandtechnicus.

## Openen

Het programma gebruikt JavaScript-modules en heeft dus een webserver nodig (dubbelklikken op `index.html` werkt niet).

- **Online:** GitHub Pages van deze repository.
- **Lokaal:** `python3 -m http.server 8000` in deze map en open `http://localhost:8000`.

## Onderdelen

| Pagina | Wat |
|---|---|
| `index.html` | CAD: opdrachtbon → scan → analyse → lepel / beetplaat → opstelling → basis → controle → productie |
| `orders.html` | Orderoverzicht: 3Shape-export (ZIP of losse .3ox/.inf/.stl/.pts) inlezen, controleren, printsimulatie, naamgeving |

### Nieuw in 61

- **Vrij bewerken** (stap *Bewerken*): penselen zoals de freeform-/wasmes-tools in 3Shape en de penselen in Photoshop: *Toevoegen*, *Wegnemen*, *Gladmaken*, *Vlakmaken* en *Verschuiven*. Penseelgrootte en sterkte met schuifjes (of `[` `]`), Shift keert toevoegen/wegnemen om, sneltoetsen A/R/S/V/D, ongedaan maken/opnieuw (Ctrl+Z/Y), optioneel symmetrisch links/rechts. Het pasvlak (kant van de scan) is beschermd. **Diktekaart** toont waar de plaat dunner is dan de ingestelde minimale dikte. Het werkstuk blijft een gesloten mesh.
- **Beetplaat met of zonder wal**: standaard zonder; vink *Met beetwal* aan voor een wal.
- **Asiga Ultra (32/50) en MAX** in de printsimulatie, met automatische oriëntatie per werkstuk (rechtop, staand, schuin 20–70° of plat) en instelbare laagtijd.

- **Orderoverzicht** (`orders.html`): leest een complete 3Shape-export, ook een ZIP van honderden MB (stapsgewijs, alles lokaal). Groepeert per patiënt en ordernummer en signaleert o.a.:
  - kaak in de naam (OK/BK) die niet klopt met het FDI-element in 3Shape;
  - wisselende spelling van de patiëntnaam binnen één ordernummer;
  - ontbrekende of open STL's, losse mini-fragmenten, werkstukken uit meerdere delen;
  - materiaal dat niet bij het werkstuk past (bijv. tijdelijke kronen op "Denture base"), kleur alleen in de naam;
  - verstreken leverdatum, alleen OK of alleen BK aanwezig, inconsistente naamopbouw (met voorstel).
  - Herkent beetwallen, platen, kronen en fragmenten ook aan de vorm (bestanden zonder 3ox).
  - **Printsimulatie** voor Form 4/3B+, Asiga MAX, SprintRay Pro 95: indeling per printplaat, tijd, hars en kosten.
  - Export naar CSV/JSON; per STL **"Nieuwe plaat hierop"** opent het product direct in het CAD.
- **Weefselzijde uit bestaand product** (Scan & mesh): haalt uit een gesloten lepel/beetplaat/beetwal de binnenkant als scan. Ondersnijdingen worden met de echte productvlakken opgevuld, de referentiepunten worden automatisch gezet. Daarna direct een nieuwe lepel of beetplaat (met wal/handvat) genereren.
- **Robuuster op echte scans:**
  - randopschoning (vlinderpunten, losse eilandjes) vóór het maken van de schaal;
  - hoekcompensatie: de wand wordt nergens dunner dan ingesteld (begrensd ×1,3, geen bulten);
  - beetwal en handvat sluiten robuust aan op de scan (missers geïnterpoleerd, gladgestreken);
  - Booleaanse bewerkingen laten geen splinters of losse lipjes meer achter;
  - automatische kamlijn crasht niet meer op grote scans.

## Tests

```bash
node tests/run.mjs
```

Rekenmodules zonder browser (Node 20+): naamherkenning, 3ox/inf, controles, printsimulatie, ZIP, randopschoning, schaal, weefselzijde, kamlijn.

Validatie van versie 61 op een echte lab-export (51 STL-bestanden, 3Shape DentalDesigner + losse beetwallen):

- weefselzijde + nieuwe plaat: **39/39 gesloten**, 1–4 s per product;
- beetplaten vergeleken met het 3Shape-origineel: mediaan **0,04–0,13 mm** afwijking van de buitenvorm, wand 2,0 mm (p1 ≥ 1,94 mm);
- beetwal op echte scans: 33/39 volledig schoon, 6 gesloten met enkele niet-manifold randen (melding in het programma);
- handvat op 12 echte lepels: 12/12 schoon;
- penselen: toevoegen, wegnemen, gladmaken, verschuiven, pasvlak beschermd, gesloten na bewerken, ongedaan maken;
- browser-doorloop (Chrome, desktop + mobiel, incl. penseelstreek met de muis en diktekaart): 25/25.

## Structuur

```
index.html, orders.html     pagina's
css/                        opmaak
js/main.js                  CAD-interface
js/orders.js, orders-ui.js  orderoverzicht (rekenwerk / interface)
js/intaglio.js              weefselzijde uit gesloten product
js/sculpt.js                penselen (vrij bewerken)
js/shell.js, mesh.js, csg.js, construct.js, contour.js, analysis.js, setup.js, teeth.js
js/unzip.js, zip.js, handoff.js, stl.js, viewer.js
vendor/                     three.js, three-mesh-bvh, manifold-3d (WebAssembly)
tests/run.mjs               headless tests
legacy/v52.html             vorige versie (één bestand)
```
