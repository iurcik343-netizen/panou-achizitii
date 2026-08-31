# Panou achiziții — documentație tehnică

Acest document explică cum e construit și găzduit tool-ul, unde e fiecare piesă, și cum se rezolvă problemele întâlnite frecvent. E scris ca oricine (tu, un programator nou, sau un AI) să poată prelua proiectul fără context în plus.

## 1. Ce este

O aplicație de comparare furnizori/prețuri, urmărire scumpiri, construire comenzi și verificare stoc din MoySklad, pentru achiziții. A pornit ca artifact în Claude.ai, apoi a fost migrată să funcționeze independent, online, cu date persistente și acces securizat.

## 2. Arhitectură — cele patru piese

| Piesă | Ce face | Unde locuiește |
|---|---|---|
| **Aplicația** (frontend) | Tot ce vezi și cu ce interacționezi — un singur fișier HTML+CSS+JS, fără framework | [`index.html`](index.html), găzduit static pe **GitHub Pages** |
| **Baza de date** | Ține toate datele (furnizori, produse, comenzi, setări) | **Supabase** (Postgres + Auth), proiect `panou-achizitii` |
| **Autentificare** | Login/parolă, resetare parolă | Tot Supabase (Supabase Auth) |
| **Proxy stocuri MoySklad** | Server mic care ține tokenul MoySklad ascuns și trimite aplicației doar cantități | **Cloudflare Worker**, cod în [`moysklad-proxy/worker.js`](moysklad-proxy/worker.js) |

Cele patru piese sunt complet independente — poți actualiza codul aplicației fără să atingi datele, poți schimba tokenul MoySklad fără să atingi aplicația, etc.

## 3. Linkuri și locații

- **Aplicația live**: https://iurcik343-netizen.github.io/panou-achizitii/
- **Repo GitHub** (codul sursă): https://github.com/iurcik343-netizen/panou-achizitii
- **Fișier local de lucru**: `C:\Users\AOC\Desktop\Proiect panou de achizitii\index.html` (aceeași aplicație, deschisă direct din disc — vorbește cu aceeași bază de date online)
- **Proiect Supabase**: `panou-achizitii`, organizația „Iurie - Sublime", URL `https://wijumzjsgjrzzipgdeyd.supabase.co`
- **Worker Cloudflare**: `moysklad-proxy`, URL `https://moysklad-proxy.iurcik343.workers.dev`

## 4. Cum se actualizează codul aplicației

1. Se editează [`index.html`](index.html) local.
2. Se testează local (deschis direct din disc, sau prin unealta de preview).
3. Se încarcă pe GitHub: repo → **Add file → Upload files** → tragi `index.html` → **Commit changes** (suprascrie automat).
4. GitHub Pages republică automat în ~1 minut, la același link.

> Notă din experiență: `git push` din linia de comandă a fost blocat constant de restricțiile locale de securitate din acest mediu de lucru — de-asta s-a folosit mereu upload manual prin interfața web GitHub. Dacă cineva lucrează din alt calculator/mediu fără această restricție, `git push` normal ar trebui să funcționeze la fel de bine.

Datele din Supabase **nu sunt afectate niciodată** de o actualizare de cod.

## 5. Supabase — bază de date și autentificare

### Schema (tabelul `app_state`)

Tot conținutul aplicației (furnizori, produse, comenzi, setări) e ținut ca **un singur obiect JSON**, într-un singur rând, nu în tabele separate. E simplu și robust pentru un tool cu un singur "document" de lucru.

```sql
create table app_state (
  id text primary key default 'main',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table app_state enable row level security;
create policy "authenticated select" on app_state for select using (auth.role() = 'authenticated');
create policy "authenticated insert" on app_state for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on app_state for update using (auth.role() = 'authenticated');
```

Regula de securitate (RLS): **oricine e logat** poate citi/scrie acest rând. Nu există separare pe utilizator — toată lumea logată vede și editează aceleași date (intenționat, e un tool de echipă).

### Schema (tabelul `app_state_history`)

Plasă de siguranță pentru „am șters ceva din greșeală": la fiecare salvare (dar nu mai des de o dată la 15 minute) aplicația păstrează o copie completă a datelor într-un rînd nou, aici. Din tab-ul **Setări → Istoric versiuni**, utilizatorul poate vedea lista de momente salvate și reveni la oricare dintre ele. Tabelul trebuie creat o singură dată, manual, în SQL Editor din Supabase:

```sql
create table app_state_history (
  id bigserial primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table app_state_history enable row level security;
create policy "authenticated select" on app_state_history for select using (auth.role() = 'authenticated');
create policy "authenticated insert" on app_state_history for insert with check (auth.role() = 'authenticated');
create policy "authenticated delete" on app_state_history for delete using (auth.role() = 'authenticated');
```

Aplicația păstrează automat doar ultimele 200 de instantanee (le șterge pe cele mai vechi după fiecare instantaneu nou), ca tabelul să nu crească nelimitat.

### Chei de conectare (în cod, în `index.html`)

```js
var SUPABASE_URL = 'https://wijumzjsgjrzzipgdeyd.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_HSpJConvyLeGt3zPf7h8bw_RniB4NC7';
```

Cheia `anon`/`publishable` **e menită să fie publică** — apare în codul sursă al paginii, vizibilă oricui. Securitatea reală vine din regulile RLS de mai sus (trebuie autentificat), nu din secretul cheii.

### Utilizatori (login în aplicație)

Se gestionează din Supabase → **Authentication → Users**:
- **Add user → Create new user**: tu setezi email+parolă direct.
- **Add user → Send invitation**: persoana primește un email, își setează singură parola (recomandat pentru colegi).

Aplicația are și:
- **„Am uitat parola"** pe ecranul de login → trimite email de resetare.
- **„Schimbă parola"** în tab-ul Setări → Cont, pentru cineva deja logat.

> Important: la prima configurare, câmpul **Site URL** din Supabase → Authentication → URL Configuration trebuie să fie link-ul live (`https://iurcik343-netizen.github.io/panou-achizitii/`), nu `localhost:3000` (valoarea implicită) — altfel linkurile din emailurile de invitație/resetare duc în gol.

## 6. Integrare MoySklad — cum funcționează

MoySklad **nu permite** apeluri directe din browser: nu trimite headere CORS, iar tokenul de acces nu poate fi expus în codul unei pagini publice (oricine l-ar putea citi și fura accesul la cont). De-asta există Worker-ul intermediar.

### Rutele Worker-ului (`moysklad-proxy/worker.js`)

Worker-ul răspunde diferit după parametrul din URL:

| Apel | Ce face | Folosit de |
|---|---|---|
| `GET /` (fără parametri) | Stoc rapid: combină `entity/product` (barcode-uri) cu `report/stock/all/current` (cantități) → `{ "barcode": cantitate }` | Butonul „Actualizează stocuri MoySklad" din tab-ul Comparație produse |
| `GET /?catalog=1` | Catalog complet: nume, barcode, preț de achiziție (`buyPrice`), stoc, zile în depozit (`stockDays`), link imagine miniaturală — din `entity/product` + `report/stock/all` (raportul extins) | Tab-ul „Produse MoySklad" |
| `GET /?history=<id-produs-moysklad>` | Istoric achiziții pentru UN produs: dată, furnizor, cantitate, preț plătit — din `entity/supply` filtrat cu `filter=assortment=<link produs>` (nu scanează tot istoricul contului) | Săgeata de expandare (▸) din tab-ul „Produse MoySklad", încărcat la cerere |

> Bug găsit și reparat: rândurile din `report/stock/all` vin cu un `meta.href` care are un query string atașat (`...?expand=supplier`) — dacă îl compari direct cu ID-ul curat din `entity/product`, nu se potrivesc niciodată și stocul/zilele în depozit rămân goale. Rezolvarea: se taie orice ce vine după `?` înainte de comparație (funcția `extractId` din worker.js).

> Imaginile **nu** trec prin Worker — `report/stock/all` include deja link-ul `image.tiny.href`, iar acesta s-a dovedit a fi public, fără autentificare (testat direct, răspunde 200 OK). Aplicația pune acest link direct în `<img src>`, fără niciun ocol.

### Variabile configurate pe Worker (Cloudflare → Settings → Variables and secrets)

| Nume | Tip | Valoare |
|---|---|---|
| `MOYSKLAD_AUTH` | **Secret** | `Bearer <access_token>` — tokenul MoySklad (vezi mai jos cum se generează) |
| `ALLOWED_ORIGIN` | Text | `*` (oricine poate apela Worker-ul; datele expuse sunt doar cantități, fără informații sensibile) |

> **După orice modificare de variabile**, Cloudflare creează o versiune nouă dar **nu o pune automat live**. Trebuie mers la tab-ul **Deployments** → găsit ultima versiune → meniul „..." → **Promote version** → confirmat la 100% trafic. Fără acest pas, Worker-ul continuă să ruleze cu variabilele vechi.

### Cum se generează/regenerează tokenul MoySklad

Tokenul se obține trimițând login+parolă (o singură dată) către MoySklad, care întoarce un token de acces reutilizabil. Se rulează local, în PowerShell (**niciodată** distribuit prin chat/email):

```powershell
$cred = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("login:parola"))
curl.exe --compressed -X POST "https://api.moysklad.ru/api/remap/1.2/security/token" -u "login:parola"
```

Răspuns așteptat: `{"access_token":"...."}`. Copiezi acea valoare, o pui pe Cloudflare ca `Bearer <valoare>`, la `MOYSKLAD_AUTH`.

> Generarea unui token nou **invalidează automat** tokenul anterior — nu există limită la câte poți genera, e gratuit și instant.

### Cum se folosește în aplicație

- Tab **Setări → MoySklad — stocuri**: se completează URL-ul Worker-ului (`https://moysklad-proxy.iurcik343.workers.dev`), se apasă **Testează și salvează**.
- Tab **Comparație produse**: apare un buton **„🔄 Actualizează stocuri MoySklad"** — sincronizarea e **manuală**, nu automată. Fiecare click ia cantitățile curente din MoySklad și le afișează în coloana **„Stoc MS"**, pentru orice produs al cărui barcode se potrivește.
- Tab **„Produse MoySklad"** (catalog separat, complet independent de fluxul de comparare furnizori) — vezi secțiunea 7 de mai jos.
- Datele MoySklad (stoc, catalog, istoric) **nu se salvează** în Supabase — sunt doar în memoria browserului, cât timp pagina e deschisă. La reîncărcarea paginii, trebuie apăsat din nou „Actualizează"/„Sincronizează".

## 7. Tab-ul „Produse MoySklad" — catalogul complet

Un tab separat, gândit ca listă de referință a **întregului** catalog MoySklad — independent de tab-ul „Comparație produse" (care ține doar produsele urmărite manual, per furnizor).

- **Buton „🔄 Sincronizează catalogul MoySklad"** — aduce toate produsele active (nearhivate), cu: imagine miniaturală, barcode, denumire, preț de achiziție anterior (`buyPrice`, convertit din bani în unități întregi + moneda reală), stoc curent, zile în depozit (`stockDays` — cu cât e mai mare, cu atât produsul stă mai mult nevândut).
- **Căutare** după nume sau barcode, cu o limită de afișare la 200 de rânduri (catalogul poate avea mii de produse) — se îngustează prin căutare.
- **Săgeata (▸) de lângă fiecare produs** — expandează un panou cu **istoricul de achiziții**: dată, furnizor, cantitate, preț plătit. Se încarcă **la cerere** (doar când expandezi acel produs), nu în masă la sincronizare, ca să nu încetinească totul — fiecare produs cu istoric propriu înseamnă un apel separat către MoySklad.
- Ultimele 20 de recepții per produs (limită fixă în cod, `limit=20` în worker.js, la ruta `?history=`).

## 8. Design

Paleta actuală (variabile CSS, în `:root`, la începutul `index.html`):

```css
--bg: #F2F5F4;       /* fundal pagină */
--panel: #FFFFFF;    /* carduri/panouri */
--accent: #0F6E56;   /* teal — butoane, linkuri, accente */
--accent-dark: #085041;
--text: #1E2624;
--text-soft: #71827D;
```

Font: sans-serif ('Segoe UI' și fallback-uri) peste tot — nu se mai folosește serif (schimbare intenționată față de designul inițial, mai "editorial").

Există și un prim pas de responsive (media query pentru ecrane sub 640px) — util pentru acces de pe telefon, dar nu testat exhaustiv pe toate tab-urile.

## 9. Probleme întâlnite și rezolvate (istoric util)

- **Câmpul de parolă arăta rupt la login** — regula CSS pentru inputuri uita `input[type=password]`. Rezolvat prin includerea lui explicită în selector.
- **`git push` blocat constant** — restricție locală de siguranță în mediul de lucru folosit la dezvoltare; soluția a fost upload manual prin GitHub web UI. Nu are legătură cu GitHub sau cu proiectul în sine.
- **Invitațiile Supabase duceau la `localhost:3000`** — trebuia actualizat câmpul **Site URL** din Supabase Authentication → URL Configuration cu link-ul live.
- **Token MoySklad: eroare „415 Unsupported Media Type"** — o particularitate de compatibilitate; s-a rezolvat folosind `curl.exe -u login:parolă` (curl calculează el headerul de autentificare) în loc de a-l construi manual.
- **„Failed to fetch" la sincronizarea stocurilor, doar când deschis local** — Worker-ul avea `ALLOWED_ORIGIN` restricționat la domeniul GitHub Pages; deschiderea fișierului local (`file://`) trimite o origine diferită, blocată de CORS. Rezolvat prin setarea `ALLOWED_ORIGIN = *`.
- **Modificarea variabilelor pe Cloudflare nu avea efect imediat** — trebuie „promovată" manual noua versiune la 100% trafic din tab-ul Deployments (vezi secțiunea 6).
- **Branduri greșite apărute la import** — la importul din Excel, dacă numele fișierului conținea o virgulă (ex: „Nume produs [30ml], factura.xlsx"), codul presupunea greșit că partea dinaintea virgulei e brandul întregului fișier, și îl aplica la toate produsele fără brand real din acel fișier. Reparat prin eliminarea completă a acestei presupuneri (`extractBrandFromFilename`) — acum, fără o coloană de brand mapată explicit, produsul rămâne fără brand. Pentru brandurile deja corupte, există butonul **„🔧 curăță branduri greșite"** (tab Comparație produse) — șterge orice brand care conține caracterul `[`, semn sigur că era de fapt o denumire de produs.
- **Stocul și zilele în depozit ieșeau goale în catalogul MoySklad** — rândurile din raportul extins `report/stock/all` vin cu `meta.href` având un query string atașat (`?expand=supplier`), care nu se mai potrivea cu ID-ul curat din lista de produse. Reparat prin tăierea query string-ului înainte de comparație.

## 10. Limitări cunoscute, de reținut

- **Editare simultană**: dacă două persoane salvează în același minut, ultima salvare câștigă — nu există îmbinare automată a modificărilor. Pentru uz zilnic normal, riscul e mic, dar merită știut.
- **Datele MoySklad (stoc, catalog, istoric) nu se actualizează singure** — necesită apăsarea manuală a butoanelor de sincronizare, de fiecare sesiune de lucru.
- **Fără mediu de test separat** — testele de cod noi rulează pe **aceleași date reale** din Supabase ca și utilizarea zilnică. Schimbări riscante (ex: funcții de ștergere în masă) ar trebui testate cu grijă, ideal când nimeni altcineva nu lucrează activ.
- **Catalog foarte mare (multe mii de produse)**: Worker-ul MoySklad are un prag de siguranță la paginare (se oprește după ~200.000 de produse citite) — nerelevant pentru cataloage normale, dar de reținut dacă sincronizarea pare incompletă pe un catalog uriaș.
- **Istoricul de achiziții arată doar ultimele 20 de recepții** per produs (limită fixă, ajustabilă în `worker.js`, ruta `?history=`).

## 11. Ce faci dacă ceva nu merge

1. **Aplicația nu se încarcă deloc / pagină albă** → verifică în consola browserului (F12 → Console) dacă apare o eroare JS; de obicei indică o greșeală de sintaxă introdusă la o editare recentă a `index.html`.
2. **Nu te poți loga** → verifică email/parolă în Supabase → Authentication → Users; poți reseta parola din acolo, sau prin „Am uitat parola" din aplicație.
3. **Datele nu se salvează** → verifică în consolă erori de la Supabase (de obicei mesaj clar, afișat și ca notificare roșie în aplicație); poate fi un RLS greșit configurat sau proiectul Supabase în pauză (planurile gratuite pot pune proiectul „to sleep" după inactivitate lungă — se trezește automat la prima cerere, cu o mică întârziere).
4. **Stocurile/catalogul MoySklad nu se actualizează** → verifică mai întâi tab-ul Setări (butonul „Testează și salvează" arată eroarea exactă); dacă tokenul a expirat/fost schimbat, se regenerează (secțiunea 6) și se pune din nou pe Cloudflare, cu promovare de versiune.
5. **Imaginile din catalog nu apar** → normal pentru produsele fără imagine încărcată în MoySklad; pentru celelalte, verifică în consolă (F12) dacă link-ul `image.tiny.href` întors de MoySklad mai răspunde public (s-ar putea schimba politica lor de acces în timp).
6. **Ai nevoie de o versiune anterioară a codului** → tot istoricul e păstrat pe GitHub (`https://github.com/iurcik343-netizen/panou-achizitii/commits/main`), fiecare commit poate fi vizualizat sau restaurat.
