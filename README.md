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

### Nieuw in 68: niet meer vastlopen, en plaatrand = scanrand

**Vastlopen opgelost.** Met *Afstand tot scan* > 0 mat het programma de ruimte punt voor punt met een trage rasterzoeker. Op een betande scan van 300.000 facetten met was stond de pagina zo bijna 3 minuten stil ("Deze pagina reageert niet").
- Afstanden meten met een BVH (`js/bvh.js`): exact dezelfde uitkomst, tientallen keren sneller. Alleen punten die in de vorige ronde zijn verschoven worden opnieuw gemeten.
- Randentabel, dubbele facetten, oriënteren, rand opschonen en spikes zoeken in typed arrays: 2–9× sneller, met een bit-voor-bit gelijke uitkomst (getest tegen v67).
- Splinters na een booleaanse bewerking worden in JS weggelaten in plaats van met `decompose()` (dat kostte 4–9 s). Mislukt het weefselblok omdat de plaat zelf niet omgezet kan worden, dan stopt het direct in plaats van drie dure pogingen te doen.
- Tussen alle zware stappen ademt de browser even. De schaal rekent in stukjes van ±0,1 s (`shellAsync`). De voortgang staat in beeld (analyseren, repareren, bijsnijden, rand bepalen, plaat opbouwen, controle).
- Gemeten in Chrome, automatische beetplaat met was, afstand 2 mm, betande scan van 300.000 facetten: **178 s, waarvan 174 s aan één stuk vast → 20 s, langste blokkade 2,4 s.** Afstand 0 mm: 15–19 s. Tandeloze demokaak: 4 s.

**Plaatrand = scanrand (Beetplaat → Rand).**
- *Automatisch*: houdt de scan op vóór de plooi (intraorale scan, 3Shape-weefselzijde, strak bijgesneden model), dan loopt de beetplaat precies tot de rand van de scan. Anders gaat de rand tot in de plooi volgens de anatomie, zoals voorheen. Ook te kiezen: *Langs de scanrand* of *Volgens de anatomie*.
- *Afstand tot scanrand*: laat de plaat X mm binnen de scanrand stoppen. Gemeten langs het oppervlak, dus niet geprojecteerd; de bolling van een kroon boven de rand blijft heel.
- Bij een beetplaat langs de scanrand wordt de scan niet meer *aangevuld* (het paarse ontworpen deel). Daar liep de plaat voorbij de echte scanrand.
- *Rand ligt op de scan*: met afstand > 0 loopt de afstand in de laatste 2 mm (instelbaar) vloeiend naar 0, zodat de plaatrand precies op de scan ligt in plaats van 2 mm erboven te zweven.
- Laag *Scan buiten de rand* (🗂 Lagen) met een fader: met een werkstuk is de scan buiten de plaatrand doorschijnend (standaard 20 %). Op 0 is de scan precies op de plaatrand afgeknipt, op 100 zie je het origineel.
- Sleep je de lijn van een rand langs de scanrand, dan wordt het een gewone omtrek; de rest blijft exact de scanrand. ↶ zet de scanrand terug.

**Overig**
- De was blijft behouden als de beetplaat bij het openen eerst de scan voorbereidt. Voorheen werd de aangebrachte was dan stilletjes gewist.
- De onderkant van de beetwal sluit nu over de hele breedte op de plaat aan (7 punten in plaats van alleen de 2 hoeken). Hij steekt daardoor niet meer door de afdrukruimte of het pasvlak.
- Een beetwal *volgens de regels* wordt overgeslagen als de plooi niet gescand is of het occlusievlak onder de kam (tanden) zou liggen. Het programma meldt dat; wil je toch een wal, zet dan *Volgens de regels* uit.
- Waarschuwing als de buitenkant van de plaat in smalle ruimtes (tussen tanden) te dicht bij de scan komt.
- Afstand langs het oppervlak (afsluitzone, afstand tot scanrand) met de driehoeksupdate van fast marching. Daarbij is ook een afrondingsfout opgelost waardoor punten werden overgeslagen.

**Bekend:** op een scan mét tanden schiet de buitenkant van de plaat in smalle ruimtes tussen de elementen nog over de scan heen. Het programma toont dan de waarschuwing hierboven. Een afstand > 0 mm geeft op tanden geen nette afdrukruimte. Een echte offset voor tanden (volumetrisch) staat op de lijst.

**Getest:** 63 automatische tests (waarvan 9 nieuw, o.a. BVH tegen alle driehoeken, randentabel tegen de v67-versie, rand langs de scanrand, afsluitzone, was overnemen, splinters). Daarnaast in Chrome een betande intraorale scan (520.000 → 300.000 facetten) met afstand 0 en 2 mm, een betand model, en de demo-onder- en bovenkaak.

### Nieuw in 67: zware scans en de omtrek tekenen met vinger of muis

**Zware scans (labscanner, 1–3 miljoen facetten).** Voorheen stopte een lepel of beetplaat met *"Gebruik een uitgesneden scan met maximaal 400.000 facetten"*.
- Bij het openen wordt een scan boven 400.000 facetten automatisch vereenvoudigd tot ca. 300.000 (instelbaar bij Scan & mesh → 🔻 Vereenvoudigen, en uit te zetten). ↶ Terug zet de originele scan terug.
- Methode (`js/decimate.js`): quadric edge collapse als *half-edge collapse*: er blijven alleen originele scanpunten over, de rand blijft exact, en elk weggehaald scanpunt wordt bij elke stap nagemeten. Standaardgrens 0,01 mm (eis 0,05 mm); alleen als het anders niet onder de grens komt mag hij voor een plaat oplopen tot 0,025 mm. De gemeten afwijking staat in beeld.
- Gemeten: 1.563.232 facetten (ruisige testkaak) → 311.020, max. 0,010 mm; realistische scan 777.724 → 300.000, max. 0,009 mm, gemiddeld 0,0005 mm. Beetplaat daarna gesloten, pasvlak 100 % binnen 0,05 mm.
- Vangnet: is de scan bij *Genereer* toch nog te groot (oud project, automatisch uitgezet), dan wordt hij eerst vereenvoudigd, met melding. Ook de schaalberekening zelf vereenvoudigt in plaats van te stoppen.
- Sneller: lassen van punten 5× sneller (zelfde uitkomst), uitsnijden langs de omtrek per scan gecachet: een omtrekwijziging op een scan van 780.000 facetten kost 0,2 s in plaats van 3,3 s.

**Omtrek bewerken** (`js/steps/contour-tools.js`, rekenkern `js/contour-edit.js`):
- **Slepen op elke plek van de lijn**, niet alleen op een punt. De meeneemzone licht geel op (bij zweven met de muis en tijdens het slepen) en gaat zacht mee.
- **✏️ Teken**: één vinger of de linkermuis tekent de lijn in één beweging. Begin óp de lijn en eindig óp de lijn: dat stuk wordt vervangen (overtekenen). Een hele rondgang = nieuwe omtrek. Tikken zet losse punten zoals voorheen.
- Tijdens het tekenen: twee vingers of de rechtermuisknop draaien het beeld, knijpen of scrollen zoomt naar de vingers/muis toe. Esc breekt een streek af.
- **Vergrootglas** boven de vinger op een aanraakscherm, tijdens tekenen en slepen.
- **〰 Glad**: strijkt de hele omtrek gladder.
- De lijn is dikker, met een donkere rand, en blijft zichtbaar óp een gegenereerde plaat (de overlay test alleen tegen de diepte van de scan). Achter de kam wordt hij een vage schim.
- Na een wijziging staat bij het werkstuk *"Omtrek gewijzigd: tik op Genereer …"*.
- Punten die in de insteekrichting op elkaar vallen (steile wand) geven geen onterechte melding *"kruist zichzelf"* meer.
- Op de telefoon staat de aanwijzing onder de knoppen in plaats van in een smalle, hoge kolom, en de modusmelding is kort.

**Getest:** 54 automatische tests (waarvan 11 nieuw), plus in Chrome: desktop met de scan van 1,5 miljoen facetten (17 controles: laden + vereenvoudigen, beetplaat, slepen, zone, ongedaan maken, overtekenen, nieuwe rondgang, glad, draaien/zoomen tijdens tekenen, Esc, STL), telefoon met aanraken (11 controles, o.a. vergrootglas, twee vingers, tikken) en een rooktest van lepel, beetplaat en prothese met ⚡ (7 controles).

### Nieuw in 66

- **Bijsnijden met een strakke rand.** De bijsnijlijn van *Scan voorbereiden* loopt vloeiend, zonder inkepingen bij de lipbandjes. Daarna wordt de rand opgeschoond: bijna-dubbele snijpunten samengevoegd, losse "oortjes" en vlinders weg, spleetjes en gaatjes dicht, en de buitenrand gladgetrokken op het oppervlak. Gemeten op de demokaak: 1 rand in plaats van 3, geen nul-lange randen, scherpe knikken van 53 naar 11. Lasso en gum ruimen ook de oortjes langs hun nieuwe rand op.
- **Bovenbalk:** ◀ vorige en ▶ volgende stap, en ↶/↷ ongedaan maken of opnieuw in de stap waarin je bent (ook Ctrl+Z / Ctrl+Y). Bij de scan worden lepel, beetplaat en basis na het terugzetten opnieuw gemaakt.
- **Opstellen zonder voorwerk.** *Stel tanden op* zet zelf de referentiepunten en analyseert de kaak; je krijgt geen foutmelding meer over ontbrekende punten.
- **Prothesebasis:**
  - Anatomisch tandvleesprofiel: licht bol, vloeiend afgerond naar de halslijn.
  - Wortelreliëf (juga): de hoektand het sterkst, instelbaar in %.
  - De labiale flens loopt nu zonder trede door tot de rand, en achter het laatste element loopt de gingiva uit.
  - Zachte schaduw in de weergave, zodat de facetstrepen weg zijn, en de basis is ondoorzichtig.
  - De automatische rand is licht gladgestreken, frenulum-uitsparingen blijven.
  - Controle na het samenvoegen: sluit de anatomische vorm bij een grillige opstelling niet, dan kiest het programma zelf het eenvoudige profiel, zodat de prothese altijd gesloten blijft. Het programma meldt dat.

### Nieuw in 65.3: opruimen, betrouwbaar laden en betere scanbewerking

**Betrouwbaar laden.**
- Elke module laadt met een versienummer (`js/version.js` → `node scripts/stamp.mjs` zet het in de import-maps). Na een update gebruikt de browser dus nooit oude en nieuwe bestanden door elkaar. Dat gebeurde eerder door de cache van GitHub Pages (10 minuten) en dan werkte er niets.
- Opstartcontrole: open je `index.html` direct vanaf schijf, of gaat er bij het laden iets mis, dan staat er een duidelijke rode melding in beeld in plaats van een stil scherm.

**✂️ Scan bewerken** (stap Scan & mesh):
- **Lasso**: trek een lijn rond wat weg moet. Kies weg binnen de lijn of houd alleen binnen de lijn, en alleen de zichtbare kant of door en door.
- **Gum** en **Gladmaken**: penseel met instelbare straal; tijdens het vegen zie je de selectie in kleur.
- De geknipte rand wordt automatisch strak getrokken; de oorspronkelijke scanrand blijft exact.
- **Sokkel afsnijden**: op een instelbare hoogte onder de kam, met live voorbeeld van het vlak; de rand wordt exact gesneden.
- **Losse delen weg** en **Gaten dichten** (de buitenrand blijft open).
- Alles is terug te draaien met ↶. Lepel, beetplaat en basis worden daarna automatisch opnieuw gemaakt; de opstelling blijft staan.
- Tijdens het bewerken van de scan zijn de werkstukken verborgen, zodat je de scan zelf goed ziet.

**Opbouw.** Nieuwe code staat in losse modules met één taak:
- `js/scan-edit.js`: rekenkern van de scanbewerking, zonder interface en los getest.
- `js/steps/scan-tools.js`: interface van de scanbewerking.
- `js/setup-tools.js`: opstelling.
- `js/version.js`: het versienummer.

`main.js` wordt stap voor stap verder opgesplitst per programmastap.

### Nieuw in 65 — opstelling zoals in 3Shape/exocad, met verbeteringen

**📚 Eigen tandenbibliotheek (exocad-indeling).** Kies de ZIP (ook een ZIP in een ZIP of met wachtwoord: WinZip-AES) of de uitgepakte map. Herkend worden `teeth/<set>/{upperjaw,lowerjaw}/1…8.eoff` en `metadata/<set>/{upperjaw,lowerjaw}.xml`. Thimble-/cutback-varianten worden genegeerd. Kronen worden gesloten met een korte, taps toelopende wortelstomp (manifold, klaar voor de basis), gespiegeld voor de andere kaakhelft. De bibliotheek blijft **alleen op het apparaat** (IndexedDB): niets gaat naar een server of in deze repository.

**Automatisch ideaal of handmatig.** *Automatisch ideaal* neemt per element de angulatie, torque en hoogte (curve van Spee/Wilson) over uit de ToothBow van de bibliotheek en zet ze op de gemeten kamlijn. De breedtes langs de boog komen uit de echte kronen; daarna worden de approximale contacten exact nagemeten (≤ 0,05 mm). *Handmatig*: kies een element en tik op de kam, waarna het volgende element wordt voorgesteld.

**BK en OK tegelijk.** De tegenkaak wordt mee opgesteld op een eigen boog (front ~3 mm, zijdelings ~1 mm binnen of buiten de werkboog) en in occlusie gebracht. Download: *Elementen tegenkaak.stl*.

**Selecteren en slepen.** Selecteer per element, groep (front 3–3 of zijdelingse delen), kaak (blok) of BK + OK.
- Tikken selecteert.
- **Vasthouden + slepen** verplaatst; met de muis kun je direct slepen. De rij schuift mee en klikt bij loslaten weer aan, met de middellijn vast. Een groep slepen verschuift ook de middellijn.
- *↔ Naast elkaar zetten*: tik element A en dan B, en A komt aan die kant naast B te staan (volgorde wisselen).
- *Rij aansluiten* uit: vrij plaatsen.

**Morphen en draaien.** Grootte, breedte, hoogte en dikte in stappen van 2 %, met de rij die meeschuift. Angulatie, torque en draaien om de as: in stappen van 1° of met de vinger (horizontaal slepen). De gizmo blijft beschikbaar.

**🎨 Live contactkleuren** tijdens slepen, draaien, articuleren en slijpen. Magenta/rood = penetratie, oranje = contact, geel < 0,05, groen < 0,15, blauw < 0,35 mm.

**Articulator** (half-instelbaar, Bonwill 105 mm, condylusafstand 110 mm, Balkwill 22°): protrusie, laterotrusie rechts/links (Bennett-hoek, directe zijverschuiving) en openen. Er is een schuif per stand, *▶ Afspelen* en *Bewegingscontacten*: de kleinste afstand over de hele baan, zodat interferenties zichtbaar worden.

**Inslijpen.**
- *Automatisch*: in centrische stand of ook in de bewegingen. Penetrerende punten gaan naar het oppervlak van de antagonist, zoals bij een inslijpfolie.
- Instelbaar: in OK, BK of verdeeld; rest-speling; maximaal weg te nemen materiaal (de app meldt waar dat maximum is bereikt, zodat je daar de opstelling of geleiding aanpast); front wel of niet slijpen in de bewegingen.
- *Handmatig*: slijpkop wegnemen / opbouwen / gladmaken met straal en sterkte.
- De mesh blijft gesloten. Ingeslepen vormen gaan mee in het projectbestand.

### Nieuw in 64

**Werkwijze per werkstuk.** Lepel = plaat (met of zonder handvat), beetplaat = alleen de plaat, prothese = basis met elementen. Stappen en downloads die niet bij het werkstuk horen, zijn verborgen.

**🧹 Scan voorbereiden** (Scan & mesh, en de eerste stap van ⚡ Alles automatisch). Scanpunten worden nooit verschoven:
- analyse: delen, losse vlekjes, spikes, niet-manifold randen, gaten, open of gesloten (model met sokkel);
- reparatie: kapotte en dubbele facetten, losse delen, spikes (PCA-vlak van de buren) en niet-manifold facetten weg, kleine gaten dicht;
- bijsnijden tot het prothesegebied plus marge: sokkel, wang, tong en artefacten eruit, met alleen het deel dat de kam bevat;
- aanvullen: is de plooi niet gescand (scan stopt bij de plaatrand, zoals bij een 3Shape-weefselzijde), dan wordt de rand vloeiend verlengd en de plooidiepte geschat (mediaan van de rest van de kaak, anders BK 8 / OK 7 mm). Het ontworpen deel is paars en telt niet mee in de pasvlakcontrole.

**Omtrek: automatisch, en met de vinger aan te passen.** De omtrek wordt langs de insteekas exact uitgesneden, onafhankelijk van het camerastandpunt. Facetten binnen de lijn worden ongewijzigd overgenomen; facetten op de lijn worden exact gesneden (bisectie, rand ≤ 0,05 mm van de lijn).
- Sleep een punt: punten in de meeneemzone (instelbaar) gaan vloeiend mee en blijven op de scan.
- Tik op de lijn: er komt een punt bij. Houd een punt vast: het punt verdwijnt. ↶ en ↷ werken voor elke wijziging.

**Belijning volgens de literatuur:**
- lepel 2 mm korter dan de plooi (2–3 mm, ruimte voor randvormen), BK 2,5 mm voorbij de A-lijn door de hamulus-insnoeringen, OK over de hele retromolaire pad;
- beetplaat en basis tot de functionele plooidiepte, BK tot de A-lijn (1–2 mm vóór de foveae palatinae), OK ⅔ van de pad;
- frenumuitsparing labiaal smal, buccaal breder.

**🗂 Lagen met faders.** Scan, Was, Design, Tanden en Antagonist zijn elk apart aan en uit te zetten, met een fader voor de doorzichtigheid.

**🕯 Waslaag voor ondersnijdingen.** De ondersnijdingen worden langs de insteekas opgevuld (kegel met uitblokhoek, plus wat onder overhangend weefsel ligt). De was is te bewerken met penselen (toevoegen, wegnemen, gladmaken, Shift keert om) en komt nooit onder de scan. De plaat wordt op scan + was gebouwd; waar geen was ligt, is het pasvlak exact de scan.

**Nauwkeurigheid (doel 0,05 mm):**
- Bij elk werkstuk staat de afwijking van het pasvlak ten opzichte van de scan, of van de afdrukruimte bij een lepel; ook in Controle.
- Wortels, de onderkant van de gingivaband, wallen en handvatten die door het pasvlak staken, worden nu weggesneden met een weefselblok (scanoppervlak 0,005 mm in het weefsel).
- De afdrukruimte wordt gecorrigeerd met de echte afstand tot de scan (Minkowski): in holtes nooit te dicht, en smalle plooien worden overbrugd.

**Anatomische tanden.** De 32 elementen hebben leerboekvormen (Wheeler's Dental Anatomy), met knobbels, randlijsten, fissuren, fossae, cingulum en incisale rand, op de gepubliceerde gemiddelde maten. Het is een port van de open-source kroonbibliotheek van DentCraft (MIT/Apache-2.0, zie `NOTICE`). Knobbelhoogte en slijtage volgen het opstelconcept (monoplane = vlak). De gingiva heeft festoenen en papillen.

### Nieuw in 63

- **⚡ Alles automatisch** (werkbalk): in één keer referentiepunten → anatomie → omtrek → werkstuk volgens de opdrachtbon (lepel, beetplaat, of opstelling + prothesebasis), daarna direct de controle. Ongeveer 2–5 s; elke stap blijft daarna los aan te passen.
- **Boog op de gemeten kamlijn** (Boogvorm *Kamlijn*, nu standaard): tanden en beetwal volgen de echte kamtop in plaats van een standaardboog. Werkt ook bij scheve kaken (de analyse loopt in twee rondes langs de gemeten kam).
  - BK-front ~4 mm labiaal van de kam, hoektand ~2,5 mm; zijdelings de centrale fissuur boven de kam (lingualiseerd/Gerber: palatinale knobbel, +1 mm). OK-front ~1 mm labiaal, zijdelings boven de kam (Pound-lijn). Instelbaar met *Front labiaal van de kam*.
  - Zonder elementkeuze 7–7 (14 elementen); molaren die voorbij het einde van de kam (tuber/pad) zouden komen worden weggelaten, met melding.
- **Occlusievlak volgens de plooiregel**: BK 22 mm (front) / 18 mm (tuber) vanaf de plooi, OK 18 mm vanaf de plooi en achter op ⅔ van de retromolaire pad. Geldt voor de opstelling en voor de beetwal (*Volgens de regels*); de gemeten waarden staan erbij.
- **Statiekcontrole** in Controle: zijdelingse elementen ≤ 2 mm (BK) / ≤ 1,5 mm (OK, Pound-lijn) naast de kam, geen elementen voorbij het einde van de kam.

### Nieuw in 62

- **Anatomie & weefsel** (stap *Analyse*): zoekt de plooi (vestibulum) en de plooidiepte, frenula (labiaal, buccaal, tongriem), A-lijn/hamulus (BK) of retromolaire pad (OK) en een torus palatinus. Kleurt de **weefselkaart**: drukdragend (primair/secundair), ontlasten, afsluiting (post-dam/pad) en plooi/rand.
- **Automatische omtrek** (knop 🧭 bij Lepel/Beetplaat/Basis): lepel 2 mm korter dan de plooi en 2,5 mm voorbij de A-lijn; beetplaat/basis tot in de plooi, achter tot de A-lijn of over ⅔ van de retromolaire pad; V-uitsparing bij elk frenulum.
- **Scan aanpassen richting ideaal**: gladmaken (scanruis), ontlasten van papil (1,0 mm), raphe/torus/scherpe richels (0,5 mm), optioneel post-dam (BK, 0,8 mm). Terug te draaien.
- **Draaien en zoomen tijdens het tekenen** van de omtrek en het zetten van punten (slepen = draaien, tikken = punt). Bij het sluiten wordt automatisch het occlusale aanzicht gekozen.
- **STL bekijken**: 3D-voorbeeld per bestand in het orderoverzicht; in *Productie* elk uitvoerbestand los bekijken (👁) of los downloaden. Na elke download staat in beeld waar het bestand terechtkomt.
- **Anatomische demo-kaak** (boven of onder, met vestibulum, frenula, verhemelte/torus of retromolaire pads).
- Kamlijn-referentiepunten nauwkeuriger op de kamtop; handvat schuift automatisch op de plaat bij smalle platen; melding bij losse delen.

**Waar worden bestanden opgeslagen?** Alles blijft op het apparaat; er gaat niets naar een server. Downloads gaan naar de map *Downloads* (iPhone: app Bestanden → Downloads; Android: Mijn bestanden → Downloads; computer: map Downloads). Het complete project (met scan) bewaar je met 💾 Opslaan.

**Lab-referentie** (mediaan van 39 producten uit een 3Shape-export, kamtop-tot-kamtop): bovenkaak boog 42 × 27 mm, verhemeltediepte ~14 mm; onderkaak 50 × 34 mm.

**Literatuur (samenvatting van de gebruikte regels):** lepelrand 2–3 mm korter dan de plooi en achter door de hamulus-insnoeringen voorbij de A-lijn; OK-basis over ½–⅔ van de retromolaire pad; drukdragend BK: hard verhemelte naast de raphe en postero-laterale kamhellingen; OK: buccal shelf; ontlasten: papilla incisiva, raphe mediana, torus palatinus, scherpe benige richels; frenula met V-uitsparing. Bronnen o.a. Zarb/Boucher (*Prosthodontic Treatment for Edentulous Patients*), opleidingsdictaten prothetiek en *British Dental Journal* (tips custom trays).

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
mkdir -p node_modules/three && ln -sf ../../vendor/three.module.js node_modules/three/three.module.js && ln -sf ../../vendor/three.core.js node_modules/three/three.core.js && printf '{"name":"three","type":"module","exports":"./three.module.js"}' > node_modules/three/package.json
node tests/run.mjs
```

Rekenmodules zonder browser (Node 20+; `three` wordt uit `vendor/` geladen via `node_modules/three`, zie hieronder): naamherkenning, OFF/eoff, WinZip-AES, bibliotheek sluiten en spiegelen, ideale standen, rij aansluiten ≤ 0,05 mm, articulatorbewegingen, inslijpen, 3ox/inf, controles, printsimulatie, ZIP, randopschoning, schaal, weefselzijde, kamlijn.

Validatie van versie 61 op een echte lab-export (51 STL-bestanden, 3Shape DentalDesigner + losse beetwallen):

- weefselzijde + nieuwe plaat: **39/39 gesloten**, 1–4 s per product;
- beetplaten vergeleken met het 3Shape-origineel: mediaan **0,04–0,13 mm** afwijking van de buitenvorm, wand 2,0 mm (p1 ≥ 1,94 mm);
- beetwal op echte scans: 33/39 volledig schoon, 6 gesloten met enkele niet-manifold randen (melding in het programma);
- handvat op 12 echte lepels: 12/12 schoon;
- penselen: toevoegen, wegnemen, gladmaken, verschuiven, pasvlak beschermd, gesloten na bewerken, ongedaan maken;
- anatomie op de demo-kaken: plooi binnen 1 mm, alle frenula en de tongriem gevonden, torus herkend, omtrek geldig;
- browser-doorloop (Chrome, desktop + mobiel, incl. penselen, anatomie, automatische omtrek, scan aanpassen, STL-voorbeelden): 40/40.

## Structuur

```
index.html, orders.html     pagina's
css/                        opmaak
js/main.js                  CAD-interface
js/orders.js, orders-ui.js  orderoverzicht (rekenwerk / interface)
js/intaglio.js              weefselzijde uit gesloten product
js/sculpt.js                penselen (vrij bewerken)
js/anatomy.js               plooi, frenula, omtrek, weefselzones, scan richting ideaal
js/shell.js, mesh.js, csg.js, construct.js, contour.js, analysis.js, setup.js, teeth.js
js/prep.js                  scan voorbereiden (analyse, reparatie, aanvullen)
js/trim.js                  exacte uitsnede langs de omtrek (insteekas)
js/wax.js                   waslaag (ondersnijdingen), penselen
js/crowns.js                anatomische kronen (port van DentCraft, MIT/Apache-2.0)
js/library.js, off.js, aes.js  tandenbibliotheek importeren (exocad .eoff + ToothBow, ZIP/AES), op het apparaat bewaren
js/arrange.js               rij: boog, langs de boog schuiven, aansluiten, morphen, draaien
js/setup-tools.js           opstelgereedschap: selectie, slepen, BK+OK, contact, articulator, inslijpen (UI)
js/contacts.js              getekende afstanden en contactkleuren
js/articulator.js           virtuele articulator (protrusie, laterotrusie, openen)
js/grind.js                 inslijpen (automatisch en slijpkop)
js/scan-edit.js             scanbewerking: lasso, gum, gladmaken, vlak afsnijden, losse delen, gaten (rekenkern)
js/steps/scan-tools.js      scanbewerking (interface)
js/version.js               versienummer (scripts/stamp.mjs zet het in de import-maps)
js/unzip.js, zip.js, handoff.js, stl.js, viewer.js
vendor/                     three.js, three-mesh-bvh, manifold-3d (WebAssembly)
tests/run.mjs               headless tests
legacy/v52.html             vorige versie (één bestand)
```
