
(() => {
  const PIN_KEY = 'wte_admin_pin_hash_v1';
  const SESSION_KEY = 'wte_admin_unlocked_v1';
  const lock = document.getElementById('adminLock');
  const form = document.getElementById('adminLockForm');
  const input = document.getElementById('adminPin');
  const copy = document.getElementById('adminLockCopy');
  const error = document.getElementById('adminLockError');
  const logout = document.getElementById('adminLogout');

  async function hash(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
  }

  function unlock() {
    sessionStorage.setItem(SESSION_KEY, '1');
    lock.classList.add('hidden');
    document.body.classList.remove('admin-locked');
  }

  function showLock() {
    sessionStorage.removeItem(SESSION_KEY);
    lock.classList.remove('hidden');
    document.body.classList.add('admin-locked');
    input.value = '';
    input.focus();
  }

  const hasPin = Boolean(localStorage.getItem(PIN_KEY));
  if (!hasPin) {
    copy.textContent = 'Primo accesso: crea un PIN gestore di almeno 4 cifre.';
    input.placeholder = 'Crea PIN gestore';
    input.autocomplete = 'new-password';
  }

  if (sessionStorage.getItem(SESSION_KEY) === '1' && hasPin) {
    unlock();
  } else {
    showLock();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    const pin = input.value.trim();

    if (pin.length < 4) {
      error.textContent = 'Il PIN deve contenere almeno 4 caratteri.';
      return;
    }

    const hashed = await hash(pin);
    const saved = localStorage.getItem(PIN_KEY);

    if (!saved) {
      localStorage.setItem(PIN_KEY, hashed);
      unlock();
      return;
    }

    if (hashed !== saved) {
      error.textContent = 'PIN non corretto.';
      input.select();
      return;
    }

    unlock();
  });

  logout?.addEventListener('click', showLock);
})();



    (() => {
      const STORAGE_KEY = 'wte_requests_v1';
      const DB_NAME = 'wte_documents';
      const STORE_NAME = 'pdfs';
      const PHONE = '393477050250';

      const searchInput = document.getElementById('searchInput');
      const statusFilter = document.getElementById('statusFilter');
      const sortSelect = document.getElementById('sortSelect');
      const mobileList = document.getElementById('mobileList');
      const tableBody = document.getElementById('tableBody');
      const emptyState = document.getElementById('emptyState');
      const resultCount = document.getElementById('resultCount');
      const drawer = document.getElementById('drawer');

      let selectedId = null;

      function escapeHtml(value){
        return String(value ?? '').replace(/[&<>"']/g, char => ({
          '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
        }[char]));
      }

      function loadItems(){
        try{
          const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
          return Array.isArray(data) ? data : [];
        }catch{
          return [];
        }
      }

      function saveItems(items){
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      }

      function priceNumber(value){
        if(!value || value === 'Su misura') return 0;
        return Number(String(value).replace(/[^\d]/g,'')) || 0;
      }

      function formatDate(value){
        if(!value) return '—';
        const parts = String(value).split('-');
        if(parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
        return value;
      }

      function formatCreated(value){
        if(!value) return '—';
        const date = new Date(value);
        if(Number.isNaN(date.getTime())) return value;
        return date.toLocaleDateString('it-IT');
      }

      function statusClass(status){
        const s = String(status || '').toLowerCase();
        if(s.includes('confermat')) return 'ok';
        if(s.includes('annull')) return 'no';
        return 'wait';
      }

      function filteredItems(){
        const q = searchInput.value.trim().toLowerCase();
        const status = statusFilter.value;
        const sort = sortSelect.value;

        let items = loadItems().filter(item => {
          const haystack = [
            item.id,item.name,item.location,item.package,item.date,item.type,item.status
          ].join(' ').toLowerCase();

          return (!q || haystack.includes(q)) &&
                 (!status || item.status === status);
        });

        items.sort((a,b) => {
          if(sort === 'oldest'){
            return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
          }
          if(sort === 'eventDate'){
            return String(a.date || '').localeCompare(String(b.date || ''));
          }
          if(sort === 'value'){
            return priceNumber(b.price) - priceNumber(a.price);
          }
          return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        });

        return items;
      }

      function updateKpis(all){
        document.getElementById('kpiTotal').textContent = all.length;
        document.getElementById('kpiWaiting').textContent =
          all.filter(x => ['In attesa','Nuova','Contattata','Proposta inviata'].includes(x.status)).length;
        document.getElementById('kpiConfirmed').textContent =
          all.filter(x => x.status === 'Confermata').length;

        const value = all
          .filter(x => x.status !== 'Annullata')
          .reduce((sum,item) => sum + priceNumber(item.price),0);

        document.getElementById('kpiValue').textContent =
          value ? `€ ${value.toLocaleString('it-IT')}` : '€ 0';
      }

      function render(){
        const all = loadItems();
        const items = filteredItems();

        updateKpis(all);
        mobileList.innerHTML = '';
        tableBody.innerHTML = '';
        resultCount.textContent = `${items.length} ${items.length === 1 ? 'risultato' : 'risultati'}`;
        emptyState.style.display = items.length ? 'none' : 'block';

        items.forEach(item => {
          const card = document.createElement('article');
          card.className = 'practice-card';
          card.innerHTML = `
            <div class="practice-main">
              <strong>${escapeHtml(item.name || 'Senza nome')}</strong>
              <p>${escapeHtml(item.id || 'ID non assegnato')}</p>
              <p>${formatDate(item.date)} · ${escapeHtml(item.location || 'Location da definire')}</p>
              <p>${escapeHtml(item.package || 'Pacchetto da definire')} · ${item.guests || 0} invitati</p>
            </div>
            <div class="practice-side">
              <span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'In attesa')}</span>
              <strong>${escapeHtml(item.price || '—')}</strong>
            </div>
          `;
          card.addEventListener('click', () => openDetail(item.id));
          mobileList.appendChild(card);

          const row = document.createElement('tr');
          row.innerHTML = `
            <td>${escapeHtml(item.id || '—')}</td>
            <td><strong>${escapeHtml(item.name || 'Senza nome')}</strong></td>
            <td>${formatDate(item.date)}</td>
            <td>${escapeHtml(item.location || '—')}</td>
            <td>${escapeHtml(item.package || '—')}</td>
            <td>${escapeHtml(item.price || '—')}</td>
            <td><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'In attesa')}</span></td>
            <td>${formatCreated(item.createdAt)}</td>
          `;
          row.addEventListener('click', () => openDetail(item.id));
          tableBody.appendChild(row);
        });
      }

      function detailFields(item){
        return [
          ['ID pratica',item.id],
          ['Tipo',item.type],
          ['Data matrimonio',formatDate(item.date)],
          ['Location',item.location],
          ['Invitati',item.guests],
          ['Orario',item.startTime],
          ['Ore richieste',item.hours],
          ['Distanza',`${item.distance || 0} km`],
          ['Pacchetto',item.package],
          ['Prezzo',item.price],
          ['Tatuaggi stimati',item.tattoos],
          ['Trasferta',item.travel],
          ['Compatibilità',item.score ? `${item.score}%` : '—'],
          ['Ore extra',item.extraHours ?? 0],
          ['Firmatario',item.signedName],
          ['Firma registrata',item.signedAt],
        ];
      }

      function openDetail(id){
        const item = loadItems().find(x => x.id === id);
        if(!item) return;

        selectedId = id;
        document.getElementById('detailId').textContent = item.id || 'Pratica';
        document.getElementById('detailName').textContent = item.name || 'Dettaglio cliente';
        document.getElementById('detailNotes').value = item.notes || '';

        const grid = document.getElementById('detailGrid');
        grid.innerHTML = '';

        detailFields(item).forEach(([label,value]) => {
          const div = document.createElement('div');
          div.innerHTML = `<small>${escapeHtml(label)}</small><strong>${escapeHtml(value || '—')}</strong>`;
          grid.appendChild(div);
        });

        const advice = document.getElementById('detailAdvice');
        advice.innerHTML = '';
        const list = Array.isArray(item.advice) ? item.advice : [];

        if(list.length){
          list.forEach(text => {
            const li = document.createElement('li');
            li.textContent = text;
            advice.appendChild(li);
          });
        }else{
          const li = document.createElement('li');
          li.textContent = 'Nessun consiglio automatico salvato.';
          advice.appendChild(li);
        }

        drawer.classList.add('open');
        drawer.setAttribute('aria-hidden','false');
        document.body.classList.add('lock');
      }

      function closeDrawer(){
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden','true');
        document.body.classList.remove('lock');
        selectedId = null;
      }

      function openDb(){
        return new Promise((resolve,reject) => {
          const request = indexedDB.open(DB_NAME,1);

          request.onupgradeneeded = event => {
            const db = event.target.result;
            if(!db.objectStoreNames.contains(STORE_NAME)){
              db.createObjectStore(STORE_NAME,{keyPath:'id'});
            }
          };

          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }

      async function getPdf(id){
        const db = await openDb();
        return new Promise((resolve,reject) => {
          const tx = db.transaction(STORE_NAME,'readonly');
          const req = tx.objectStore(STORE_NAME).get(id);
          req.onsuccess = () => resolve(req.result?.blob || null);
          req.onerror = () => reject(req.error);
        });
      }

      document.querySelectorAll('[data-close-drawer]').forEach(el => {
        el.addEventListener('click',closeDrawer);
      });

      document.getElementById('closeDetailBtn').addEventListener('click',closeDrawer);

      document.getElementById('saveNotesBtn').addEventListener('click',() => {
        if(!selectedId) return;
        const items = loadItems();
        const item = items.find(x => x.id === selectedId);
        if(!item) return;

        item.notes = document.getElementById('detailNotes').value;
        item.updatedAt = new Date().toISOString();
        saveItems(items);
        render();
        closeDrawer();
      });

      document.getElementById('whatsappBtn').addEventListener('click',() => {
        const item = loadItems().find(x => x.id === selectedId);
        if(!item) return;

        const message =
`📋 PRATICA WEDDING TATTOO EXPERIENCE

ID: ${item.id}
Cliente: ${item.name}
Data: ${formatDate(item.date)}
Location: ${item.location}
Invitati: ${item.guests}
Pacchetto: ${item.package}
Prezzo: ${item.price}
Stato: ${item.status}

Note:
${item.notes || 'Nessuna nota'}`;

        window.open(
          `https://wa.me/${PHONE}?text=${encodeURIComponent(message)}`,
          '_blank',
          'noopener'
        );
      });

      document.getElementById('openPdfBtn').addEventListener('click',async() => {
        if(!selectedId) return;

        try{
          const blob = await getPdf(selectedId);

          if(!blob){
            alert('Nessun PDF archiviato per questa pratica su questo dispositivo.');
            return;
          }

          const url = URL.createObjectURL(blob);
          window.open(url,'_blank','noopener');
          setTimeout(() => URL.revokeObjectURL(url),60000);
        }catch(error){
          console.error(error);
          alert('Impossibile aprire il PDF archiviato.');
        }
      });

      searchInput.addEventListener('input',render);
      statusFilter.addEventListener('change',render);
      sortSelect.addEventListener('change',render);
      document.getElementById('refreshBtn').addEventListener('click',render);

      render();
    })();
  


(() => {
  const STORAGE_KEY = 'wte_requests_v1';
  const DB_NAME = 'wte_documents';
  const STORE_NAME = 'pdfs';

  function loadItems(){
    try{
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(data) ? data : [];
    }catch{
      return [];
    }
  }

  function saveItems(items){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  function downloadFile(filename, content, type){
    const blob = content instanceof Blob ? content : new Blob([content], {type});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function csvCell(value){
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function nextDuplicateId(baseId){
    const stamp = Date.now().toString(36).toUpperCase();
    return `${baseId || 'WTE'}-COPY-${stamp}`;
  }

  function getSelectedId(){
    return document.getElementById('detailId')?.textContent?.trim() || null;
  }

  function refreshDashboard(){
    document.getElementById('refreshBtn')?.click();
  }

  // Keep status selector synchronized when drawer opens.
  const originalOpenDetail = window.openDetail;
  const drawer = document.getElementById('drawer');

  const observer = new MutationObserver(() => {
    if (!drawer.classList.contains('open')) return;
    const id = getSelectedId();
    const item = loadItems().find(x => x.id === id);
    if (!item) return;
    const status = document.getElementById('detailStatus');
    if (status) status.value = item.status || 'In attesa';
  });

  observer.observe(drawer, {attributes:true, attributeFilter:['class']});

  // Save notes + status.
  const oldSave = document.getElementById('saveNotesBtn');
  if (oldSave) {
    const saveButton = oldSave.cloneNode(true);
    oldSave.replaceWith(saveButton);

    saveButton.addEventListener('click', () => {
      const id = getSelectedId();
      if (!id) return;

      const items = loadItems();
      const item = items.find(x => x.id === id);
      if (!item) return;

      item.notes = document.getElementById('detailNotes')?.value || '';
      item.status = document.getElementById('detailStatus')?.value || item.status || 'In attesa';
      item.updatedAt = new Date().toISOString();

      saveItems(items);
      refreshDashboard();
      document.getElementById('closeDetailBtn')?.click();
    });
  }

  // Duplicate practice.
  document.getElementById('duplicateBtn')?.addEventListener('click', () => {
    const id = getSelectedId();
    const items = loadItems();
    const source = items.find(x => x.id === id);
    if (!source) return;

    const copy = {
      ...source,
      id: nextDuplicateId(source.id),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'In attesa',
      type: 'Pratica duplicata',
      notes: source.notes ? `Copia di ${source.id}\n${source.notes}` : `Copia di ${source.id}`,
      hasPdf: false
    };

    items.unshift(copy);
    saveItems(items);
    refreshDashboard();
    alert(`Pratica duplicata con ID ${copy.id}`);
    document.getElementById('closeDetailBtn')?.click();
  });

  // Delete practice.
  document.getElementById('deleteBtn')?.addEventListener('click', async () => {
    const id = getSelectedId();
    if (!id) return;
    if (!confirm(`Eliminare definitivamente la pratica ${id}?`)) return;

    saveItems(loadItems().filter(x => x.id !== id));

    // Remove archived PDF if present.
    try{
      const request = indexedDB.open(DB_NAME, 1);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) return;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
      };
    }catch{}

    refreshDashboard();
    document.getElementById('closeDetailBtn')?.click();
  });

  // CSV export.
  document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
    const items = loadItems();
    const headers = [
      'ID','Cliente','Data matrimonio','Location','Invitati','Ore','Distanza',
      'Pacchetto','Prezzo','Stato','Tipo','Data creazione','Ultimo aggiornamento','Note'
    ];

    const rows = items.map(item => [
      item.id,item.name,item.date,item.location,item.guests,item.hours,item.distance,
      item.package,item.price,item.status,item.type,item.createdAt,item.updatedAt,item.notes
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(csvCell).join(';'))
      .join('\n');

    downloadFile('WTE_pratiche.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
  });

  // JSON export.
  document.getElementById('exportJsonBtn')?.addEventListener('click', () => {
    downloadFile(
      'WTE_pratiche.json',
      JSON.stringify(loadItems(), null, 2),
      'application/json'
    );
  });

  async function exportPdfIndex(){
    return new Promise(resolve => {
      const result = [];
      const request = indexedDB.open(DB_NAME, 1);

      request.onerror = () => resolve(result);

      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          resolve(result);
          return;
        }

        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const cursorRequest = store.openCursor();

        cursorRequest.onsuccess = event => {
          const cursor = event.target.result;
          if (!cursor) {
            resolve(result);
            return;
          }

          result.push({
            id: cursor.value.id,
            savedAt: cursor.value.savedAt,
            hasBlob: Boolean(cursor.value.blob)
          });

          cursor.continue();
        };

        cursorRequest.onerror = () => resolve(result);
      };
    });
  }

  // Full backup metadata.
  document.getElementById('backupBtn')?.addEventListener('click', async () => {
    const backup = {
      version: 'WTE-ADMIN-2B',
      createdAt: new Date().toISOString(),
      practices: loadItems(),
      pdfIndex: await exportPdfIndex()
    };

    downloadFile(
      `WTE_backup_${new Date().toISOString().slice(0,10)}.json`,
      JSON.stringify(backup, null, 2),
      'application/json'
    );
  });

  // Restore backup or raw JSON list.
  document.getElementById('restoreInput')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;

    try{
      const text = await file.text();
      const parsed = JSON.parse(text);
      const practices = Array.isArray(parsed) ? parsed : parsed.practices;

      if (!Array.isArray(practices)) {
        throw new Error('Formato archivio non valido');
      }

      if (!confirm(`Ripristinare ${practices.length} pratiche? L’archivio attuale verrà sostituito.`)) {
        event.target.value = '';
        return;
      }

      saveItems(practices);
      refreshDashboard();
      alert('Archivio ripristinato correttamente.');
    }catch(error){
      alert('Il file selezionato non è un backup WTE valido.');
    }finally{
      event.target.value = '';
    }
  });
})();



(() => {
  const STORAGE_KEY = 'wte_requests_v1';

  const MONTHS = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
  const PACKAGE_COLORS = {
    Bronze:'#8f5f2b',
    Silver:'#b8b2a8',
    Gold:'#d4a347',
    Luxury:'#efe0b5',
    Altro:'#6f6659'
  };

  function loadItems(){
    try{
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(data) ? data : [];
    }catch{
      return [];
    }
  }

  function priceNumber(value){
    if(!value || value === 'Su misura') return 0;
    return Number(String(value).replace(/[^\d]/g,'')) || 0;
  }

  function monthKey(date){
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
  }

  function monthLabel(date){
    return MONTHS[date.getMonth()];
  }

  function last12Months(){
    const out = [];
    const now = new Date();
    now.setDate(1);

    for(let i=11;i>=0;i--){
      const date = new Date(now.getFullYear(), now.getMonth()-i, 1);
      out.push({
        key:monthKey(date),
        label:monthLabel(date),
        year:date.getFullYear(),
        date
      });
    }
    return out;
  }

  function statusIsConfirmed(status){
    return ['Confermata','Acconto ricevuto','Evento concluso'].includes(status);
  }

  function monthFromItem(item){
    const source = item.createdAt || item.updatedAt || item.date;
    const date = new Date(source);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function buildMonthly(items, months){
    const map = Object.fromEntries(months.map(m => [m.key,{count:0,value:0}]));

    items.forEach(item => {
      const date = monthFromItem(item);
      if(!date) return;
      const key = monthKey(date);
      if(!map[key]) return;
      map[key].count += 1;
      map[key].value += priceNumber(item.price);
    });

    return months.map(month => ({
      ...month,
      count:map[month.key].count,
      value:map[month.key].value
    }));
  }

  function renderBars(monthly){
    const chart = document.getElementById('monthlyChart');
    chart.innerHTML = '';

    const max = Math.max(...monthly.map(x => x.count),1);

    monthly.forEach(item => {
      const wrap = document.createElement('div');
      wrap.className = 'bar-item';

      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = `${Math.max(2,(item.count/max)*100)}%`;
      bar.title = `${item.label}: ${item.count}`;

      const label = document.createElement('small');
      label.textContent = item.label;

      wrap.append(bar,label);
      chart.appendChild(wrap);
    });

    const total = monthly.reduce((sum,x) => sum+x.count,0);
    document.getElementById('monthlyTotal').textContent =
      `${total} ${total===1?'richiesta':'richieste'}`;

    const last = monthly.at(-1)?.count || 0;
    const previous = monthly.at(-2)?.count || 0;
    let trend = 'Stabile';

    if(previous === 0 && last > 0) trend = 'Nuove richieste';
    else if(previous > 0){
      const diff = Math.round(((last-previous)/previous)*100);
      trend = `${diff>=0?'+':''}${diff}% sul mese precedente`;
    }

    document.getElementById('monthlyTrend').textContent = trend;
  }

  function renderPackages(items){
    const counts = {};

    items.forEach(item => {
      const name = item.package || 'Altro';
      counts[name] = (counts[name] || 0) + 1;
    });

    const entries = Object.entries(counts).sort((a,b) => b[1]-a[1]);
    const total = entries.reduce((sum,[,value]) => sum+value,0);
    const top = entries[0]?.[0] || '—';

    document.getElementById('topPackage').textContent = top;
    document.getElementById('donutValue').textContent = total;

    const palette = entries.map(([name]) => PACKAGE_COLORS[name] || PACKAGE_COLORS.Altro);
    let cursor = 0;
    const parts = entries.map(([name,value],index) => {
      const start = total ? (cursor/total)*100 : 0;
      cursor += value;
      const end = total ? (cursor/total)*100 : 100;
      return `${palette[index]} ${start}% ${end}%`;
    });

    document.getElementById('packageDonut').style.background =
      total ? `conic-gradient(${parts.join(',')})` : 'conic-gradient(#2a241d 0 100%)';

    const legend = document.getElementById('packageLegend');
    legend.innerHTML = '';

    entries.slice(0,5).forEach(([name,value]) => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `
        <i class="legend-dot" style="background:${PACKAGE_COLORS[name] || PACKAGE_COLORS.Altro}"></i>
        <span>${name}</span>
        <strong>${value}</strong>`;
      legend.appendChild(row);
    });
  }

  function renderConversion(items){
    const confirmed = items.filter(item => statusIsConfirmed(item.status)).length;
    const open = Math.max(0,items.length-confirmed);
    const rate = items.length ? Math.round((confirmed/items.length)*100) : 0;

    document.getElementById('conversionRate').textContent = `${rate}%`;
    document.getElementById('conversionBar').style.width = `${rate}%`;
    document.getElementById('confirmedCount').textContent = confirmed;
    document.getElementById('openCount').textContent = open;
    document.getElementById('conversionCopy').textContent =
      confirmed ? `${confirmed} pratiche concluse` : 'Nessuna conferma';
  }

  function renderValueChart(monthly){
    const svg = document.getElementById('valueChart');
    const labels = document.getElementById('valueLabels');
    const values = monthly.map(x => x.value);
    const max = Math.max(...values,1);
    const width = 800;
    const height = 240;
    const padX = 12;
    const padY = 20;

    const points = values.map((value,index) => {
      const x = padX + (index/(values.length-1 || 1))*(width-padX*2);
      const y = height-padY-(value/max)*(height-padY*2);
      return {x,y,value};
    });

    const line = points.map(p => `${p.x},${p.y}`).join(' ');
    const area = `M ${points[0].x} ${height-padY} L ${points.map(p => `${p.x} ${p.y}`).join(' L ')} L ${points.at(-1).x} ${height-padY} Z`;

    svg.innerHTML = `
      <defs>
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#c99a43" stop-opacity=".36"/>
          <stop offset="100%" stop-color="#c99a43" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line class="grid-line" x1="0" y1="60" x2="800" y2="60"/>
      <line class="grid-line" x1="0" y1="120" x2="800" y2="120"/>
      <line class="grid-line" x1="0" y1="180" x2="800" y2="180"/>
      <path class="area" d="${area}"></path>
      <polyline class="line" points="${line}"></polyline>
      ${points.map(p => `<circle class="point" cx="${p.x}" cy="${p.y}" r="5"></circle>`).join('')}
    `;

    labels.innerHTML = monthly.map(x => `<span>${x.label}</span>`).join('');

    const total = values.reduce((sum,v) => sum+v,0);
    const nonZero = values.filter(v => v>0);
    const average = nonZero.length ? Math.round(total/nonZero.length) : 0;

    document.getElementById('economicTotal').textContent =
      total ? `€ ${total.toLocaleString('it-IT')}` : '€ 0';
    document.getElementById('averageValue').textContent =
      `Media € ${average.toLocaleString('it-IT')}`;
  }

  function renderInsights(items,monthly){
    const best = [...monthly].sort((a,b) => b.count-a.count)[0];
    document.getElementById('bestMonth').textContent =
      best?.count ? `${best.label} ${best.year}` : '—';
    document.getElementById('bestMonthCopy').textContent =
      best?.count ? `${best.count} richieste registrate.` : 'Nessun dato disponibile.';

    const priced = items.map(x => priceNumber(x.price)).filter(Boolean);
    const avgTicket = priced.length
      ? Math.round(priced.reduce((a,b)=>a+b,0)/priced.length)
      : 0;
    document.getElementById('averageTicket').textContent =
      avgTicket ? `€ ${avgTicket.toLocaleString('it-IT')}` : '€ 0';

    const leadDays = items.map(item => {
      const created = new Date(item.createdAt);
      const event = new Date(item.date);
      if(Number.isNaN(created.getTime()) || Number.isNaN(event.getTime())) return null;
      return Math.round((event-created)/(1000*60*60*24));
    }).filter(value => Number.isFinite(value) && value >= 0);

    const avgLead = leadDays.length
      ? Math.round(leadDays.reduce((a,b)=>a+b,0)/leadDays.length)
      : null;
    document.getElementById('averageLead').textContent =
      avgLead === null ? '—' : `${avgLead} giorni`;

    const statusCounts = {};
    items.forEach(item => {
      const status = item.status || 'In attesa';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    const dominant = Object.entries(statusCounts).sort((a,b)=>b[1]-a[1])[0];
    document.getElementById('dominantStatus').textContent = dominant?.[0] || '—';
    document.getElementById('dominantStatusCopy').textContent =
      dominant ? `${dominant[1]} pratiche in questo stato.` : 'Nessuna pratica presente.';
  }

  function renderAnalytics(){
    const items = loadItems();
    const months = last12Months();
    const monthly = buildMonthly(items,months);

    renderBars(monthly);
    renderPackages(items);
    renderConversion(items);
    renderValueChart(monthly);
    renderInsights(items,monthly);
  }

  const refreshButton = document.getElementById('refreshBtn');
  refreshButton?.addEventListener('click',() => setTimeout(renderAnalytics,0));

  const originalSetItem = localStorage.setItem;
  localStorage.setItem = function(key,value){
    originalSetItem.apply(this,arguments);
    if(key === STORAGE_KEY){
      setTimeout(renderAnalytics,0);
    }
  };

  window.addEventListener('storage',event => {
    if(event.key === STORAGE_KEY) renderAnalytics();
  });

  renderAnalytics();
})();



(() => {
  const STORAGE_KEY='wte_requests_v1';
  const MONTH_NAMES=[
    'Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
    'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'
  ];

  let currentMonth=new Date();
  currentMonth=new Date(currentMonth.getFullYear(),currentMonth.getMonth(),1);
  let selectedDate=null;

  function loadItems(){
    try{
      const data=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');
      return Array.isArray(data)?data:[];
    }catch{return[]}
  }

  function isoDate(date){
    const y=date.getFullYear();
    const m=String(date.getMonth()+1).padStart(2,'0');
    const d=String(date.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }

  function formatItalianDate(value){
    if(!value)return '—';
    const p=String(value).split('-');
    if(p.length!==3)return value;
    return `${p[2]}/${p[1]}/${p[0]}`;
  }

  function statusClass(status){
    if(status==='Confermata')return 'confirmed';
    if(status==='Acconto ricevuto')return 'deposit';
    if(status==='Evento concluso')return 'done';
    if(status==='Annullata')return 'cancelled';
    return 'wait';
  }

  function itemsByDate(){
    const map={};
    loadItems().forEach(item=>{
      if(!item.date)return;
      (map[item.date] ||= []).push(item);
    });
    return map;
  }

  function monthCells(year,month){
    const first=new Date(year,month,1);
    const last=new Date(year,month+1,0);
    let startDay=first.getDay();
    startDay=startDay===0?6:startDay-1;

    const cells=[];
    const startDate=new Date(year,month,1-startDay);

    for(let i=0;i<42;i++){
      const date=new Date(startDate);
      date.setDate(startDate.getDate()+i);
      cells.push({
        date,
        outside:date.getMonth()!==month
      });
    }

    return cells;
  }

  function renderSelected(dateString,events){
    const label=document.getElementById('calendarSelectedLabel');
    const count=document.getElementById('calendarSelectedCount');
    const wrap=document.getElementById('calendarSelectedEvents');

    label.textContent=dateString?formatItalianDate(dateString):'Seleziona un giorno';
    count.textContent=`${events.length} ${events.length===1?'evento':'eventi'}`;
    wrap.innerHTML='';

    if(!events.length){
      const empty=document.createElement('div');
      empty.className='calendar-no-events';
      empty.textContent='Nessun matrimonio registrato per questa data.';
      wrap.appendChild(empty);
      return;
    }

    events.forEach(item=>{
      const card=document.createElement('article');
      card.className='calendar-selected-card';
      card.innerHTML=`
        <div>
          <strong>${item.name||'Senza nome'}</strong>
          <p>${item.location||'Location da definire'} · ${item.package||'Pacchetto da definire'}</p>
          <p>${item.status||'In attesa'} · ${item.price||'—'}</p>
        </div>
        <button type="button">Apri</button>
      `;
      card.querySelector('button').addEventListener('click',()=>{
        if(typeof openDetail==='function') openDetail(item.id);
        else{
          const rows=[...document.querySelectorAll('tbody tr,.practice-card')];
          const target=rows.find(el=>el.textContent.includes(item.id));
          target?.click();
        }
      });
      wrap.appendChild(card);
    });
  }

  function renderCalendar(){
    const year=currentMonth.getFullYear();
    const month=currentMonth.getMonth();
    const map=itemsByDate();
    const grid=document.getElementById('calendarGrid');
    const title=document.getElementById('calendarTitle');

    title.textContent=`${MONTH_NAMES[month]} ${year}`;
    grid.innerHTML='';

    const today=isoDate(new Date());
    const cells=monthCells(year,month);

    cells.forEach(cell=>{
      const key=isoDate(cell.date);
      const events=map[key]||[];
      const day=document.createElement('div');
      day.className='calendar-day';
      if(cell.outside)day.classList.add('outside');
      if(key===today)day.classList.add('today');
      if(key===selectedDate)day.classList.add('selected');

      const visible=events.slice(0,2).map(item=>
        `<div class="calendar-event-chip ${statusClass(item.status)}">${item.name||'Evento'}</div>`
      ).join('');

      day.innerHTML=`
        <span class="calendar-day-number">${cell.date.getDate()}</span>
        <div class="calendar-events">
          ${visible}
          ${events.length>2?`<div class="calendar-more">+${events.length-2} altri</div>`:''}
        </div>
        <button type="button" aria-label="Apri ${key}"></button>
      `;

      day.querySelector('button').addEventListener('click',()=>{
        selectedDate=key;
        renderCalendar();
        renderSelected(key,events);
      });

      grid.appendChild(day);
    });

    if(selectedDate){
      renderSelected(selectedDate,map[selectedDate]||[]);
    }
  }

  document.getElementById('calendarPrev')?.addEventListener('click',()=>{
    currentMonth=new Date(currentMonth.getFullYear(),currentMonth.getMonth()-1,1);
    selectedDate=null;
    renderCalendar();
    renderSelected(null,[]);
  });

  document.getElementById('calendarNext')?.addEventListener('click',()=>{
    currentMonth=new Date(currentMonth.getFullYear(),currentMonth.getMonth()+1,1);
    selectedDate=null;
    renderCalendar();
    renderSelected(null,[]);
  });

  document.getElementById('calendarToday')?.addEventListener('click',()=>{
    const now=new Date();
    currentMonth=new Date(now.getFullYear(),now.getMonth(),1);
    selectedDate=isoDate(now);
    renderCalendar();
    const map=itemsByDate();
    renderSelected(selectedDate,map[selectedDate]||[]);
  });

  document.getElementById('refreshBtn')?.addEventListener('click',()=>setTimeout(renderCalendar,0));

  window.addEventListener('storage',event=>{
    if(event.key===STORAGE_KEY)renderCalendar();
  });

  const originalSetItem=localStorage.setItem;
  localStorage.setItem=function(key,value){
    originalSetItem.apply(this,arguments);
    if(key===STORAGE_KEY)setTimeout(renderCalendar,0);
  };

  renderCalendar();
  renderSelected(null,[]);
})();



(() => {
  const STORAGE_KEY='wte_requests_v1';

  function loadItems(){
    try{
      const data=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');
      return Array.isArray(data)?data:[];
    }catch{return[]}
  }

  function saveItems(items){
    localStorage.setItem(STORAGE_KEY,JSON.stringify(items));
  }

  function getSelectedId(){
    return document.getElementById('detailId')?.textContent?.trim()||null;
  }

  function formatMoney(value){
    return `€ ${Number(value||0).toLocaleString('it-IT')}`;
  }

  function todayIso(){
    return new Date().toISOString().slice(0,10);
  }

  function nowLabel(){
    return new Date().toLocaleString('it-IT');
  }

  function addTimeline(item,title,detail=''){
    item.timeline=Array.isArray(item.timeline)?item.timeline:[];
    item.timeline.unshift({
      id:`TL-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      title,
      detail,
      createdAt:new Date().toISOString()
    });
  }

  function ensureAutomaticTimeline(item){
    item.timeline=Array.isArray(item.timeline)?item.timeline:[];

    const existingTitles=new Set(item.timeline.map(x=>x.title));

    if(item.createdAt && !existingTitles.has('Richiesta ricevuta')){
      item.timeline.push({
        id:`TL-CREATED-${item.id}`,
        title:'Richiesta ricevuta',
        detail:item.type||'Pratica creata dal sito',
        createdAt:item.createdAt
      });
    }

    if(item.signedAt && !existingTitles.has('Proposta firmata')){
      item.timeline.push({
        id:`TL-SIGNED-${item.id}`,
        title:'Proposta firmata',
        detail:`Firmatario: ${item.signedName||item.name||'Cliente'}`,
        createdAt:item.updatedAt||item.createdAt
      });
    }

    if(item.hasPdf && !existingTitles.has('PDF generato')){
      item.timeline.push({
        id:`TL-PDF-${item.id}`,
        title:'PDF generato',
        detail:'Proposta PDF associata alla pratica',
        createdAt:item.updatedAt||item.createdAt
      });
    }

    item.timeline.sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  }

  function renderOperationalKpis(){
    const items=loadItems();
    const now=new Date();
    const month=now.getMonth();
    const year=now.getFullYear();
    const in30=new Date(now);
    in30.setDate(in30.getDate()+30);

    const deposits=items.reduce((sum,item)=>sum+Number(item.depositPaid||0),0);

    const thisMonth=items.filter(item=>{
      const date=new Date(item.date);
      return !Number.isNaN(date.getTime()) &&
        date.getMonth()===month &&
        date.getFullYear()===year;
    }).length;

    const next30=items.filter(item=>{
      const date=new Date(item.date);
      return !Number.isNaN(date.getTime()) && date>=now && date<=in30;
    }).length;

    const noReply=items.filter(item=>{
      const s=item.status||'';
      return ['In attesa','Nuova','Nuova richiesta','Preventivo inviato','Proposta inviata'].includes(s);
    }).length;

    document.getElementById('opsDeposits').textContent=formatMoney(deposits);
    document.getElementById('opsThisMonth').textContent=thisMonth;
    document.getElementById('opsNext30').textContent=next30;
    document.getElementById('opsNoReply').textContent=noReply;
  }

  function fillCrmFields(item){
    const set=(id,value)=>{
      const el=document.getElementById(id);
      if(el) el.value=value??'';
    };

    set('detailPhone',item.phone||'');
    set('detailEmail',item.email||'');
    set('detailOperator',item.operator||'');
    set('detailPriority',item.crmPriority||'Normale');
    set('detailDepositExpected',item.depositExpected||0);
    set('detailDepositPaid',item.depositPaid||0);
    set('detailDepositDate',item.depositDate||'');
    set('detailBalance',item.balance||0);

    const status=document.getElementById('detailStatus');
    if(status){
      const preferred=item.status||'Nuova richiesta';
      const exists=[...status.options].some(o=>o.value===preferred);
      status.value=exists?preferred:'Nuova richiesta';
    }

    renderTimeline(item);
  }

  function renderTimeline(item){
    ensureAutomaticTimeline(item);

    const wrap=document.getElementById('timelineList');
    wrap.innerHTML='';

    if(!item.timeline.length){
      wrap.innerHTML='<div class="timeline-empty">Nessuna attività registrata.</div>';
      return;
    }

    item.timeline.forEach(entry=>{
      const row=document.createElement('article');
      row.className='timeline-item';
      row.innerHTML=`
        <strong>${entry.title||'Attività'}</strong>
        ${entry.detail?`<span>${entry.detail}</span>`:''}
        <span>${new Date(entry.createdAt||Date.now()).toLocaleString('it-IT')}</span>
      `;
      wrap.appendChild(row);
    });
  }

  function getCurrentItem(){
    const id=getSelectedId();
    return loadItems().find(x=>x.id===id)||null;
  }

  function saveCrmFields(item){
    const val=id=>document.getElementById(id)?.value||'';

    item.phone=val('detailPhone');
    item.email=val('detailEmail');
    item.operator=val('detailOperator');
    item.crmPriority=val('detailPriority')||'Normale';
    item.depositExpected=Number(val('detailDepositExpected'))||0;
    item.depositPaid=Number(val('detailDepositPaid'))||0;
    item.depositDate=val('detailDepositDate');
    item.balance=Number(val('detailBalance'))||0;
    item.status=val('detailStatus')||item.status||'Nuova richiesta';
    item.notes=document.getElementById('detailNotes')?.value||'';
    item.updatedAt=new Date().toISOString();
  }

  const drawer=document.getElementById('drawer');
  const observer=new MutationObserver(()=>{
    if(!drawer.classList.contains('open')) return;
    const item=getCurrentItem();
    if(item) fillCrmFields(item);
  });
  observer.observe(drawer,{attributes:true,attributeFilter:['class']});

  // Replace save button again to persist all CRM fields.
  const oldSave=document.getElementById('saveNotesBtn');
  if(oldSave){
    const btn=oldSave.cloneNode(true);
    btn.textContent='Salva modifiche';
    oldSave.replaceWith(btn);

    btn.addEventListener('click',()=>{
      const items=loadItems();
      const item=items.find(x=>x.id===getSelectedId());
      if(!item)return;

      const oldStatus=item.status;
      saveCrmFields(item);

      if(item.status!==oldStatus){
        addTimeline(item,'Stato aggiornato',`${oldStatus||'—'} → ${item.status}`);
      }

      saveItems(items);
      renderOperationalKpis();
      document.getElementById('refreshBtn')?.click();
      document.getElementById('closeDetailBtn')?.click();
    });
  }

  document.getElementById('registerDepositBtn')?.addEventListener('click',()=>{
    const items=loadItems();
    const item=items.find(x=>x.id===getSelectedId());
    if(!item)return;

    const amount=Number(prompt('Importo acconto ricevuto:',item.depositPaid||item.depositExpected||0));
    if(!Number.isFinite(amount)||amount<0)return;

    item.depositPaid=amount;
    item.depositDate=todayIso();
    item.status='Acconto ricevuto';
    item.updatedAt=new Date().toISOString();

    const total=Number(String(item.price||'').replace(/[^\d]/g,''))||0;
    item.balance=Math.max(0,total-amount);

    addTimeline(item,'Acconto ricevuto',`${formatMoney(amount)} registrati`);
    saveItems(items);

    fillCrmFields(item);
    renderOperationalKpis();
    document.getElementById('refreshBtn')?.click();
  });

  document.getElementById('confirmEventBtn')?.addEventListener('click',()=>{
    const items=loadItems();
    const item=items.find(x=>x.id===getSelectedId());
    if(!item)return;

    item.status='Confermato';
    item.updatedAt=new Date().toISOString();
    addTimeline(item,'Evento confermato','La pratica è stata confermata dallo staff');
    saveItems(items);

    fillCrmFields(item);
    renderOperationalKpis();
    document.getElementById('refreshBtn')?.click();
  });

  document.getElementById('addTimelineBtn')?.addEventListener('click',()=>{
    const text=prompt('Scrivi la nuova attività o nota:');
    if(!text)return;

    const items=loadItems();
    const item=items.find(x=>x.id===getSelectedId());
    if(!item)return;

    addTimeline(item,'Nota interna',text);
    item.updatedAt=new Date().toISOString();
    saveItems(items);
    renderTimeline(item);
  });

  document.getElementById('callBtn')?.addEventListener('click',()=>{
    const item=getCurrentItem();
    if(!item?.phone){
      alert('Inserisci prima il numero di telefono.');
      return;
    }
    location.href=`tel:${item.phone.replace(/\s+/g,'')}`;
  });

  document.getElementById('emailBtn')?.addEventListener('click',()=>{
    const item=getCurrentItem();
    if(!item?.email){
      alert('Inserisci prima l’indirizzo email.');
      return;
    }

    const subject=encodeURIComponent(`Wedding Tattoo Experience — ${item.id}`);
    const body=encodeURIComponent(
      `Buongiorno ${item.name||''},\n\nin merito alla vostra richiesta per il ${item.date||''}.\n\nCordiali saluti,\nWedding Tattoo Experience`
    );

    location.href=`mailto:${item.email}?subject=${subject}&body=${body}`;
  });

  // Add phone to existing WhatsApp action if available.
  const oldWhatsapp=document.getElementById('whatsappBtn');
  if(oldWhatsapp){
    const btn=oldWhatsapp.cloneNode(true);
    oldWhatsapp.replaceWith(btn);

    btn.addEventListener('click',()=>{
      const item=getCurrentItem();
      if(!item)return;

      const phone=(item.phone||'393477050250').replace(/[^\d]/g,'');
      const message=
`📋 PRATICA WEDDING TATTOO EXPERIENCE

ID: ${item.id}
Cliente: ${item.name}
Data: ${item.date}
Location: ${item.location}
Pacchetto: ${item.package}
Prezzo: ${item.price}
Acconto: ${formatMoney(item.depositPaid||0)}
Stato: ${item.status}`;

      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`,'_blank','noopener');
    });
  }

  // Keep new records compatible.
  const originalSetItem=localStorage.setItem;
  localStorage.setItem=function(key,value){
    originalSetItem.apply(this,arguments);
    if(key===STORAGE_KEY)setTimeout(renderOperationalKpis,0);
  };

  window.addEventListener('storage',e=>{
    if(e.key===STORAGE_KEY)renderOperationalKpis();
  });

  renderOperationalKpis();
})();



(()=>{
const KEY='wte_requests_v1';
function load(){try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch{return[]}}
function save(v){localStorage.setItem(KEY,JSON.stringify(v))}
function id(){return document.getElementById('detailId')?.textContent?.trim()}
document.getElementById('saveFollow')?.addEventListener('click',()=>{
 const items=load(); const it=items.find(x=>x.id===id()); if(!it)return;
 it.followup={date:fuDate.value,type:fuType.value,notes:fuNotes.value};
 save(items); alert('Follow-up salvato');
});
document.getElementById('showToday')?.addEventListener('click',()=>{
 const today=new Date().toISOString().slice(0,10);
 const list=document.getElementById('todayList'); list.innerHTML='';
 load().filter(x=>x.followup&&x.followup.date===today).forEach(x=>{
  const d=document.createElement('div');
  d.className='today-item';
  d.innerHTML='<strong>'+x.name+'</strong><br>'+x.followup.type+'<br>'+x.followup.notes;
  list.appendChild(d);
 });
 if(!list.innerHTML)list.innerHTML='<div class="today-item">Nessun follow-up previsto per oggi.</div>';
});
})();



(() => {
  const STORAGE_KEY='wte_requests_v1';
  let draggedId=null;

  function loadItems(){
    try{
      const data=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');
      return Array.isArray(data)?data:[];
    }catch{return[]}
  }

  function saveItems(items){
    localStorage.setItem(STORAGE_KEY,JSON.stringify(items));
  }

  function escapeHtml(value){
    return String(value??'').replace(/[&<>"']/g,ch=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
    }[ch]));
  }

  function normalizeStatus(status){
    const map={
      'Nuova':'Nuova richiesta',
      'In attesa':'Nuova richiesta',
      'Proposta inviata':'Preventivo inviato',
      'Confermata':'Confermato',
      'Evento concluso':'Evento eseguito'
    };
    return map[status]||status||'Nuova richiesta';
  }

  function priorityClass(priority){
    const p=String(priority||'Normale').toLowerCase();
    if(p==='alta')return'high';
    if(p==='urgente')return'urgent';
    if(p==='bassa')return'low';
    return'';
  }

  function formatDate(value){
    if(!value)return'—';
    const p=String(value).split('-');
    return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:value;
  }

  function addTimeline(item,title,detail){
    item.timeline=Array.isArray(item.timeline)?item.timeline:[];
    item.timeline.unshift({
      id:`TL-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      title,
      detail,
      createdAt:new Date().toISOString()
    });
  }

  function movePractice(id,newStatus){
    const items=loadItems();
    const item=items.find(x=>x.id===id);
    if(!item)return;

    const oldStatus=normalizeStatus(item.status);
    if(oldStatus===newStatus)return;

    item.status=newStatus;
    item.updatedAt=new Date().toISOString();
    addTimeline(item,'Spostamento Kanban',`${oldStatus} → ${newStatus}`);
    saveItems(items);

    renderKanban();
    document.getElementById('refreshBtn')?.click();
  }

  function openPractice(id){
    const rows=[...document.querySelectorAll('tbody tr,.practice-card')];
    const target=rows.find(el=>el.textContent.includes(id));
    if(target){
      target.click();
      return;
    }

    const item=loadItems().find(x=>x.id===id);
    if(!item)return;

    alert(`Pratica ${item.id}\n${item.name}\n${item.status}`);
  }

  function cardMarkup(item){
    const priority=item.crmPriority||'Normale';
    return `
      <div class="kanban-card-top">
        <strong>${escapeHtml(item.name||'Senza nome')}</strong>
        <span class="kanban-priority ${priorityClass(priority)}">${escapeHtml(priority)}</span>
      </div>
      <p>${escapeHtml(item.id||'ID non assegnato')}</p>
      <p>${formatDate(item.date)} · ${escapeHtml(item.location||'Location da definire')}</p>
      <p>${escapeHtml(item.package||'Pacchetto da definire')} · ${item.guests||0} invitati</p>
      <div class="kanban-card-meta">
        <span>${escapeHtml(item.operator||'Non assegnato')}</span>
        <strong>${escapeHtml(item.price||'—')}</strong>
      </div>`;
  }

  function renderKanban(){
    const items=loadItems();

    document.querySelectorAll('.kanban-column').forEach(column=>{
      const status=column.dataset.status;
      const zone=column.querySelector('[data-dropzone]');
      const count=column.querySelector('[data-count]');
      const matching=items.filter(item=>normalizeStatus(item.status)===status);

      count.textContent=matching.length;
      zone.innerHTML='';

      if(!matching.length){
        const empty=document.createElement('div');
        empty.className='kanban-empty';
        empty.textContent='Nessuna pratica';
        zone.appendChild(empty);
      }

      matching
        .sort((a,b)=>new Date(b.updatedAt||b.createdAt||0)-new Date(a.updatedAt||a.createdAt||0))
        .forEach(item=>{
          const card=document.createElement('article');
          card.className='kanban-card';
          card.draggable=true;
          card.dataset.id=item.id;
          card.innerHTML=cardMarkup(item);

          card.addEventListener('dragstart',event=>{
            draggedId=item.id;
            card.classList.add('dragging');
            event.dataTransfer.effectAllowed='move';
            event.dataTransfer.setData('text/plain',item.id);
          });

          card.addEventListener('dragend',()=>{
            draggedId=null;
            card.classList.remove('dragging');
            document.querySelectorAll('.kanban-dropzone').forEach(z=>z.classList.remove('drag-over'));
          });

          card.addEventListener('click',event=>{
            if(event.detail===0)return;
            openPractice(item.id);
          });

          let touchTimer=null;
          let touchStartY=0;

          card.addEventListener('touchstart',event=>{
            touchStartY=event.touches[0]?.clientY||0;
            touchTimer=setTimeout(()=>{
              draggedId=item.id;
              card.classList.add('dragging');
            },450);
          },{passive:true});

          card.addEventListener('touchmove',event=>{
            const y=event.touches[0]?.clientY||0;
            if(Math.abs(y-touchStartY)>12 && touchTimer){
              clearTimeout(touchTimer);
              touchTimer=null;
            }
          },{passive:true});

          card.addEventListener('touchend',()=>{
            if(touchTimer)clearTimeout(touchTimer);
            touchTimer=null;
            card.classList.remove('dragging');
          });

          zone.appendChild(card);
        });
    });
  }

  document.querySelectorAll('.kanban-dropzone').forEach(zone=>{
    const status=zone.closest('.kanban-column').dataset.status;

    zone.addEventListener('dragover',event=>{
      event.preventDefault();
      event.dataTransfer.dropEffect='move';
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave',event=>{
      if(!zone.contains(event.relatedTarget))zone.classList.remove('drag-over');
    });

    zone.addEventListener('drop',event=>{
      event.preventDefault();
      zone.classList.remove('drag-over');
      const id=event.dataTransfer.getData('text/plain')||draggedId;
      if(id)movePractice(id,status);
    });

    zone.addEventListener('click',()=>{
      if(!draggedId)return;
      movePractice(draggedId,status);
      draggedId=null;
    });
  });

  document.getElementById('kanbanRefresh')?.addEventListener('click',renderKanban);

  document.getElementById('kanbanCompact')?.addEventListener('click',event=>{
    const board=document.getElementById('kanbanBoard');
    board.classList.toggle('compact');
    event.currentTarget.textContent=board.classList.contains('compact')
      ?'Vista estesa'
      :'Vista compatta';
  });

  document.getElementById('refreshBtn')?.addEventListener('click',()=>setTimeout(renderKanban,0));

  window.addEventListener('storage',event=>{
    if(event.key===STORAGE_KEY)renderKanban();
  });

  const originalSetItem=localStorage.setItem;
  localStorage.setItem=function(key,value){
    originalSetItem.apply(this,arguments);
    if(key===STORAGE_KEY)setTimeout(renderKanban,0);
  };

  renderKanban();
})();



(() => {
  const REQUEST_KEY='wte_requests_v1';
  const PIN_KEY='wte_admin_pin_hash_v1';
  const INSTALL_KEY='wte_admin_installed_at_v1';
  const LAST_BACKUP_KEY='wte_admin_last_backup_v1';
  const COUNTER_KEY='wte_progressive_counter_v1';
  const DB_NAME='wte_documents';
  const STORE_NAME='pdfs';

  const settings=document.getElementById('settingsModal');
  const resetModal=document.getElementById('confirmResetModal');
  const pinModal=document.getElementById('pinChangeModal');
  const toast=document.getElementById('settingsToast');

  if(!localStorage.getItem(INSTALL_KEY))localStorage.setItem(INSTALL_KEY,new Date().toISOString());

  function loadItems(){try{const d=JSON.parse(localStorage.getItem(REQUEST_KEY)||'[]');return Array.isArray(d)?d:[]}catch{return[]}}
  function showToast(msg){toast.textContent=msg;toast.classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>toast.classList.remove('show'),2600)}
  function download(filename,content,type='application/json'){const blob=content instanceof Blob?content:new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
  function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=e=>{const db=e.target.result;if(!db.objectStoreNames.contains(STORE_NAME))db.createObjectStore(STORE_NAME,{keyPath:'id'})};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
  async function countPdfs(){try{const db=await openDb();return await new Promise(resolve=>{const tx=db.transaction(STORE_NAME,'readonly');const req=tx.objectStore(STORE_NAME).count();req.onsuccess=()=>resolve(req.result||0);req.onerror=()=>resolve(0)})}catch{return 0}}
  async function clearPdfs(){try{const db=await openDb();await new Promise((resolve,reject)=>{const tx=db.transaction(STORE_NAME,'readwrite');tx.objectStore(STORE_NAME).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}catch(e){console.error(e)}}
  function formatDate(v){if(!v)return'—';const d=new Date(v);return Number.isNaN(d.getTime())?'—':d.toLocaleDateString('it-IT')}
  async function refreshSystemInfo(){document.getElementById('systemPracticeCount').textContent=loadItems().length;document.getElementById('systemPdfCount').textContent=await countPdfs();document.getElementById('systemInstalledAt').textContent=formatDate(localStorage.getItem(INSTALL_KEY));document.getElementById('systemLastBackup').textContent=formatDate(localStorage.getItem(LAST_BACKUP_KEY))}
  function openSettings(){settings.classList.add('open');settings.setAttribute('aria-hidden','false');document.body.classList.add('lock');refreshSystemInfo()}
  function closeSettings(){settings.classList.remove('open');settings.setAttribute('aria-hidden','true');document.body.classList.remove('lock')}

  document.getElementById('settingsBtn')?.addEventListener('click',openSettings);
  document.querySelectorAll('[data-close-settings]').forEach(el=>el.addEventListener('click',closeSettings));
  document.getElementById('resetArchiveBtn')?.addEventListener('click',()=>{resetModal.classList.add('open');resetModal.setAttribute('aria-hidden','false')});
  document.querySelectorAll('[data-cancel-reset]').forEach(el=>el.addEventListener('click',()=>{resetModal.classList.remove('open');resetModal.setAttribute('aria-hidden','true')}));

  document.getElementById('confirmResetBtn')?.addEventListener('click',async()=>{
    const button=document.getElementById('confirmResetBtn');
    const originalText=button.textContent;
    button.disabled=true;
    button.textContent='Azzeramento…';

    try{
      const api=String(
        localStorage.getItem('wte_cloud_api_url_v2')
        ||'https://wte-cloud-api.onrender.com'
      ).replace(/\/+$/,'');

      const token=
        localStorage.getItem('wte_cloud_token_v4')
        ||sessionStorage.getItem('wte_session_token_v8')
        ||localStorage.getItem('wte_cloud_token_v2')
        ||'';

      if(!token)throw new Error('Sessione Cloud non disponibile. Esci e accedi nuovamente.');

      const response=await fetch(`${api}/api/practices`,{
        method:'DELETE',
        headers:{Authorization:`Bearer ${token}`}
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||`Errore Cloud ${response.status}`);

      localStorage.removeItem(REQUEST_KEY);
      localStorage.removeItem(COUNTER_KEY);
      await clearPdfs();

      resetModal.classList.remove('open');
      resetModal.setAttribute('aria-hidden','true');
      await refreshSystemInfo();
      document.getElementById('refreshBtn')?.click();

      showToast(`Archivio azzerato: ${Number(result.deletedPractices||0)} pratiche eliminate.`);
    }catch(error){
      alert(`Archivio non azzerato: ${error.message}`);
    }finally{
      button.disabled=false;
      button.textContent=originalText;
    }
  });

  document.getElementById('settingsExportBtn')?.addEventListener('click',()=>{
    const backup={format:'WTE_BACKUP',version:'1.1',createdAt:new Date().toISOString(),practices:loadItems(),settings:{installedAt:localStorage.getItem(INSTALL_KEY),progressiveCounter:localStorage.getItem(COUNTER_KEY)}};
    const date=new Date().toISOString().slice(0,10);
    download(`WTE_backup_${date}.json`,JSON.stringify(backup,null,2));
    localStorage.setItem(LAST_BACKUP_KEY,new Date().toISOString());
    refreshSystemInfo();
    showToast('Backup esportato.');
  });

  document.getElementById('settingsImportInput')?.addEventListener('change',async event=>{
    const file=event.target.files?.[0];
    if(!file)return;
    try{
      const parsed=JSON.parse(await file.text());
      const practices=Array.isArray(parsed)?parsed:parsed.practices;
      if(!Array.isArray(practices))throw new Error();
      if(!confirm(`Importare ${practices.length} pratiche e sostituire l’archivio attuale?`)){event.target.value='';return}
      localStorage.setItem(REQUEST_KEY,JSON.stringify(practices));
      if(parsed.settings?.progressiveCounter)localStorage.setItem(COUNTER_KEY,parsed.settings.progressiveCounter);
      await refreshSystemInfo();
      document.getElementById('refreshBtn')?.click();
      showToast('Backup importato correttamente.');
    }catch{alert('Il file selezionato non è un backup WTE valido.')}
    finally{event.target.value=''}
  });

  async function hash(value){const bytes=new TextEncoder().encode(value);const digest=await crypto.subtle.digest('SHA-256',bytes);return[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')}
  document.getElementById('changePinBtn')?.addEventListener('click',()=>{['currentPin','newPin','confirmNewPin'].forEach(id=>document.getElementById(id).value='');document.getElementById('pinChangeError').textContent='';pinModal.classList.add('open');pinModal.setAttribute('aria-hidden','false')});
  document.querySelectorAll('[data-close-pin]').forEach(el=>el.addEventListener('click',()=>{pinModal.classList.remove('open');pinModal.setAttribute('aria-hidden','true')}));
  document.getElementById('pinChangeForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const current=document.getElementById('currentPin').value.trim();
    const next=document.getElementById('newPin').value.trim();
    const confirmNext=document.getElementById('confirmNewPin').value.trim();
    const error=document.getElementById('pinChangeError');
    error.textContent='';
    if(next.length<4){error.textContent='Il nuovo PIN deve avere almeno 4 caratteri.';return}
    if(next!==confirmNext){error.textContent='I due nuovi PIN non coincidono.';return}
    const savedHash=localStorage.getItem(PIN_KEY);
    if(!savedHash||await hash(current)!==savedHash){error.textContent='Il PIN attuale non è corretto.';return}
    localStorage.setItem(PIN_KEY,await hash(next));
    pinModal.classList.remove('open');
    pinModal.setAttribute('aria-hidden','true');
    showToast('PIN gestore aggiornato.');
  });

  refreshSystemInfo();
})();




/* =========================================================
   WTE v1.1 — FASE 2 PULIZIA COMPLETA
   Esegue una sola volta la pulizia dei dati di prova.
   Mantiene il PIN gestore.
   ========================================================= */
(() => {
  const MIGRATION_KEY = 'wte_v11_phase2_cleaned';
  const REQUEST_KEY = 'wte_requests_v1';
  const COUNTER_KEY = 'wte_progressive_counter_v1';
  const DB_NAME = 'wte_documents';
  const STORE_NAME = 'pdfs';
  const BANNER_KEY = 'wte_v11_clean_banner_hidden';

  async function clearPdfStore() {
    try {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = event => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, {keyPath:'id'});
          }
        };

        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).clear();
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        };

        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('WTE pulizia PDF:', error);
    }
  }

  async function runOneTimeClean() {
    if (localStorage.getItem(MIGRATION_KEY) === '1') return;

    // Deliberately preserve:
    // - wte_admin_pin_hash_v1
    // - wte_admin_installed_at_v1
    // - wte_admin_unlocked_v1 in sessionStorage
    localStorage.removeItem(REQUEST_KEY);
    localStorage.removeItem(COUNTER_KEY);

    // Remove any legacy/test keys without touching the PIN.
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;

      const isTestData =
        key.startsWith('wte_test_') ||
        key.startsWith('wte_demo_') ||
        key === 'wte_followups_v1' ||
        key === 'wte_statistics_v1' ||
        key === 'wte_drafts_v1';

      if (isTestData) keysToRemove.push(key);
    }

    keysToRemove.forEach(key => localStorage.removeItem(key));
    await clearPdfStore();

    localStorage.setItem(MIGRATION_KEY, '1');

    setTimeout(() => {
      document.getElementById('refreshBtn')?.click();
      window.dispatchEvent(new StorageEvent('storage', {
        key: REQUEST_KEY,
        newValue: '[]'
      }));
    }, 150);
  }

  function manageBanner() {
    const banner = document.getElementById('cleanStateBanner');
    if (!banner) return;

    if (localStorage.getItem(BANNER_KEY) === '1') {
      banner.classList.add('hidden');
    }

    document.getElementById('dismissCleanBanner')?.addEventListener('click', () => {
      localStorage.setItem(BANNER_KEY, '1');
      banner.classList.add('hidden');
    });
  }

  async function start() {
    await runOneTimeClean();
    manageBanner();

    // Ensure visible KPI values are refreshed immediately.
    setTimeout(() => {
      document.getElementById('refreshBtn')?.click();
    }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();




/* =========================================================
   WTE v1.1 — FASE 3 BACKUP AUTOMATICI
   ========================================================= */
(() => {
  const REQUEST_KEY='wte_requests_v1';
  const BACKUP_KEY='wte_auto_backups_v1';
  const LAST_BACKUP_KEY='wte_admin_last_backup_v1';
  const MAX_BACKUPS=10;
  const AUTO_DELAY=1200;

  let saveTimer=null;
  let lastSnapshotHash='';

  function loadItems(){
    try{
      const data=JSON.parse(localStorage.getItem(REQUEST_KEY)||'[]');
      return Array.isArray(data)?data:[];
    }catch{
      return [];
    }
  }

  function loadBackups(){
    try{
      const data=JSON.parse(localStorage.getItem(BACKUP_KEY)||'[]');
      return Array.isArray(data)?data:[];
    }catch{
      return [];
    }
  }

  function saveBackups(backups){
    localStorage.setItem(BACKUP_KEY,JSON.stringify(backups.slice(0,MAX_BACKUPS)));
  }

  function simpleHash(value){
    let hash=0;
    const text=JSON.stringify(value);
    for(let i=0;i<text.length;i++){
      hash=((hash<<5)-hash)+text.charCodeAt(i);
      hash|=0;
    }
    return String(hash);
  }

  function makeSnapshot(reason='Backup automatico'){
    const practices=loadItems();
    const hash=simpleHash(practices);

    if(reason==='Backup automatico' && hash===lastSnapshotHash){
      return null;
    }

    const snapshot={
      id:`BKP-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      reason,
      createdAt:new Date().toISOString(),
      practices,
      count:practices.length,
      hash
    };

    const backups=loadBackups();
    backups.unshift(snapshot);
    saveBackups(backups);

    lastSnapshotHash=hash;
    localStorage.setItem(LAST_BACKUP_KEY,snapshot.createdAt);
    updateBackupStatus();
    renderBackupHistory();

    return snapshot;
  }

  function scheduleAutoBackup(){
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>makeSnapshot('Backup automatico'),AUTO_DELAY);
  }

  function formatDateTime(value){
    if(!value)return'—';
    const date=new Date(value);
    return Number.isNaN(date.getTime())
      ?'—'
      :date.toLocaleString('it-IT');
  }

  function escapeHtml(value){
    return String(value??'').replace(/[&<>"']/g,ch=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
    }[ch]));
  }

  function updateBackupStatus(){
    const panel=document.getElementById('backupStatusPanel');
    const title=document.getElementById('backupStatusTitle');
    const copy=document.getElementById('backupStatusCopy');
    const backups=loadBackups();

    panel?.classList.remove('warning','error');

    if(!backups.length){
      if(title)title.textContent='Nessun backup disponibile';
      if(copy)copy.textContent='Crea il primo snapshot per proteggere l’archivio.';
      panel?.classList.add('warning');
      return;
    }

    const last=new Date(backups[0].createdAt);
    const ageHours=(Date.now()-last.getTime())/(1000*60*60);

    if(ageHours>72){
      if(title)title.textContent='Backup da aggiornare';
      if(copy)copy.textContent=`Ultimo backup: ${formatDateTime(backups[0].createdAt)}.`;
      panel?.classList.add('warning');
    }else{
      if(title)title.textContent='Backup automatico attivo';
      if(copy)copy.textContent=`Ultimo backup: ${formatDateTime(backups[0].createdAt)} · ${backups[0].count} pratiche.`;
    }
  }

  function renderBackupHistory(){
    const backups=loadBackups();
    const wrap=document.getElementById('backupHistoryList');
    const count=document.getElementById('backupHistoryCount');
    const last=document.getElementById('backupHistoryLast');

    if(count)count.textContent=backups.length;
    if(last)last.textContent=backups[0]?formatDateTime(backups[0].createdAt):'—';
    if(!wrap)return;

    wrap.innerHTML='';

    if(!backups.length){
      const empty=document.createElement('div');
      empty.className='backup-history-empty';
      empty.textContent='Nessun backup salvato.';
      wrap.appendChild(empty);
      return;
    }

    backups.forEach(snapshot=>{
      const card=document.createElement('article');
      card.className='backup-history-item';
      card.innerHTML=`
        <div>
          <strong>${escapeHtml(snapshot.reason||'Backup')}</strong>
          <p>${formatDateTime(snapshot.createdAt)} · ${snapshot.count||0} pratiche</p>
        </div>
        <div class="backup-history-item-actions">
          <button type="button" data-restore="${snapshot.id}">Ripristina</button>
          <button type="button" data-delete="${snapshot.id}">Elimina</button>
        </div>
      `;

      card.querySelector('[data-restore]').addEventListener('click',()=>{
        if(!confirm(`Ripristinare il backup del ${formatDateTime(snapshot.createdAt)}?`))return;
        localStorage.setItem(REQUEST_KEY,JSON.stringify(snapshot.practices||[]));
        document.getElementById('refreshBtn')?.click();
        scheduleAutoBackup();
        alert('Backup ripristinato correttamente.');
      });

      card.querySelector('[data-delete]').addEventListener('click',()=>{
        if(!confirm('Eliminare questo backup?'))return;
        saveBackups(loadBackups().filter(x=>x.id!==snapshot.id));
        updateBackupStatus();
        renderBackupHistory();
      });

      wrap.appendChild(card);
    });
  }

  function openHistory(){
    const modal=document.getElementById('backupHistoryModal');
    modal?.classList.add('open');
    modal?.setAttribute('aria-hidden','false');
    document.body.classList.add('lock');
    renderBackupHistory();
  }

  function closeHistory(){
    const modal=document.getElementById('backupHistoryModal');
    modal?.classList.remove('open');
    modal?.setAttribute('aria-hidden','true');
    document.body.classList.remove('lock');
  }

  document.getElementById('createSnapshotBtn')?.addEventListener('click',()=>{
    makeSnapshot('Snapshot manuale');
    alert('Snapshot creato.');
  });

  document.getElementById('openBackupHistoryBtn')?.addEventListener('click',openHistory);
  document.querySelectorAll('[data-close-backup-history]').forEach(el=>
    el.addEventListener('click',closeHistory)
  );

  window.addEventListener('storage',event=>{
    if(event.key===REQUEST_KEY)scheduleAutoBackup();
  });

  const originalSetItem=localStorage.setItem;
  localStorage.setItem=function(key,value){
    originalSetItem.apply(this,arguments);
    if(key===REQUEST_KEY)scheduleAutoBackup();
  };

  const current=loadItems();
  lastSnapshotHash=simpleHash(current);

  if(!loadBackups().length){
    makeSnapshot('Backup iniziale');
  }else{
    updateBackupStatus();
    renderBackupHistory();
  }
})();
