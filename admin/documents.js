
(() => {
  const KEY='wte_requests_v1';
  let selectedId=null;
  let currentType='quote';

  const load=()=>{try{const d=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(d)?d:[]}catch{return[]}};
  const save=v=>localStorage.setItem(KEY,JSON.stringify(v));
  const euro=v=>new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(Number(v||0));
  const fmt=v=>{if(!v)return'—';const p=String(v).slice(0,10).split('-');return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:v};
  const addDays=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.toISOString().slice(0,10)};
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

  function currentId(){return document.getElementById('detailId')?.textContent?.trim()}
  function item(){return load().find(x=>x.id===selectedId)}

  function updateDeposit(){
    const total=Number(docTotalPrice.value||0);
    const pct=Number(docDepositPercent.value||0);
    docDepositAmount.value=Math.round(total*pct/100);
  }

  function openModal(){
    selectedId=currentId();
    const it=item();
    if(!it){alert('Apri prima una pratica.');return}

    documentPanelTitle.textContent=`Documenti · ${it.name||it.id}`;
    docTotalPrice.value=Number(it.paymentTotalPrice||String(it.price||'').replace(/[^\d,.-]/g,'').replace(',','.'))||'';
    docDepositPercent.value=Number(it.documentDepositPercent||30);
    docDepositAmount.value=Number(it.documentDepositAmount||0);
    if(!docDepositAmount.value)updateDeposit();
    docDepositDueDate.value=it.documentDepositDueDate||addDays(7);
    docQuoteValidUntil.value=it.quoteValidUntil||addDays(10);
    docBalanceDueDate.value=it.balanceDueDate||'';
    docSpecialTerms.value=it.documentSpecialTerms||'';

    documentGeneratorModal.classList.add('open');
    document.body.classList.add('lock');
    refreshStatus(it);
  }

  function closeModal(){
    documentGeneratorModal.classList.remove('open');
    document.body.classList.remove('lock');
  }

  function data(){
    const total=Number(docTotalPrice.value||0);
    const deposit=Number(docDepositAmount.value||0);
    return {
      total,deposit,balance:Math.max(0,total-deposit),
      percent:Number(docDepositPercent.value||0),
      depositDue:docDepositDueDate.value,
      balanceDue:docBalanceDueDate.value,
      validUntil:docQuoteValidUntil.value,
      terms:docSpecialTerms.value.trim()
    };
  }

  function persist(type,it,d){
    const all=load();
    const target=all.find(x=>x.id===it.id);
    target.paymentTotalPrice=d.total;
    target.documentDepositPercent=d.percent;
    target.documentDepositAmount=d.deposit;
    target.documentDepositDueDate=d.depositDue;
    target.balanceDueDate=d.balanceDue;
    target.quoteValidUntil=d.validUntil;
    target.documentSpecialTerms=d.terms;
    target.balanceRemaining=d.balance;
    target.updatedAt=new Date().toISOString();

    if(type==='quote'){
      target.quoteCreatedAt=new Date().toISOString();
      target.status='Preventivo inviato';
    }else{
      target.contractDraftCreatedAt=new Date().toISOString();
      target.status='Contratto inviato';
    }

    target.timeline=Array.isArray(target.timeline)?target.timeline:[];
    target.timeline.unshift({
      id:`DOC-${Date.now()}`,
      title:type==='quote'?'Preventivo generato':'Bozza contratto generata',
      detail:`Totale ${euro(d.total)} · Acconto ${euro(d.deposit)}`,
      createdAt:new Date().toISOString()
    });

    save(all);
    refreshStatus(target);
    document.getElementById('refreshBtn')?.click();
  }

  function header(type,it){
    return `<header class="doc-header">
      <div class="doc-brand"><small>Wedding Tattoo Experience</small><h1>${type==='quote'?'Preventivo':'Contratto di servizio'}</h1></div>
      <div class="doc-meta"><strong>${esc(it.id)}</strong><br>Data documento: ${fmt(new Date().toISOString())}<br>${type==='quote'?'Validità: '+fmt(docQuoteValidUntil.value):'Bozza contrattuale'}</div>
    </header>`;
  }

  function client(it){
    return `<section class="doc-section"><h2>Dati cliente ed evento</h2><div class="doc-grid">
      <div class="doc-row"><small>Cliente</small><strong>${esc(it.name||'—')}</strong></div>
      <div class="doc-row"><small>Telefono</small><strong>${esc(it.phone||'—')}</strong></div>
      <div class="doc-row"><small>Email</small><strong>${esc(it.email||'—')}</strong></div>
      <div class="doc-row"><small>Data evento</small><strong>${fmt(it.date)}</strong></div>
      <div class="doc-row"><small>Location</small><strong>${esc(it.location||'—')}</strong></div>
      <div class="doc-row"><small>Invitati</small><strong>${esc(it.guests||'—')}</strong></div>
      <div class="doc-row"><small>Pacchetto</small><strong>${esc(it.package||'—')}</strong></div>
      <div class="doc-row"><small>Ore previste</small><strong>${esc(it.hours||'—')}</strong></div>
    </div></section>`;
  }

  function totals(d){
    return `<section class="doc-total-box">
      <div><span>Prezzo totale servizio</span><strong>${euro(d.total)}</strong></div>
      <div><span>Acconto entro ${fmt(d.depositDue)}</span><strong>${euro(d.deposit)}</strong></div>
      <div><span>Saldo entro ${fmt(d.balanceDue)}</span><strong>${euro(d.balance)}</strong></div>
    </section>`;
  }

  function render(type){
    const it=item();
    if(!it)return;
    const d=data();
    currentType=type;
    documentWatermark.textContent=type==='quote'?'PREVENTIVO':'BOZZA';

    documentPreview.innerHTML=type==='quote'
      ?`${header(type,it)}${client(it)}
        <section class="doc-section"><h2>Servizio proposto</h2><p class="doc-terms">Il preventivo comprende il servizio Wedding Tattoo Experience relativo al pacchetto <strong>${esc(it.package||'selezionato')}</strong>.</p></section>
        ${totals(d)}
        <section class="doc-section"><h2>Condizioni</h2><p class="doc-terms">La data sarà confermata soltanto dopo la ricezione dell’acconto e l’emissione del contratto definitivo.${d.terms?'<br><br>'+esc(d.terms):''}</p></section>
        <footer class="doc-footer">Tattoo Beauty Saloon · Via Torino 1A, Condove (TO)</footer>`
      :`${header(type,it)}${client(it)}
        <section class="doc-section"><h2>Oggetto del contratto</h2><p class="doc-terms">Il cliente incarica Wedding Tattoo Experience di svolgere il servizio durante l’evento indicato, nel rispetto delle condizioni organizzative e igienico-sanitarie concordate.</p></section>
        ${totals(d)}
        <section class="doc-section"><h2>Condizioni essenziali</h2><p class="doc-terms">La data si considera riservata dopo l’incasso dell’acconto. Il saldo deve essere ricevuto entro e non oltre 7 giorni prima dell’evento. In assenza del saldo entro tale termine, il servizio non verrà eseguito e l’acconto versato resterà acquisito quale corrispettivo per il blocco della data, salvo diversa disposizione inderogabile di legge. I tatuaggi saranno eseguiti esclusivamente su maggiorenni, previa acquisizione del consenso informato.${d.terms?'<br><br>'+esc(d.terms):''}</p></section>
        <section class="doc-signatures"><div class="doc-signature">Firma cliente</div><div class="doc-signature">Wedding Tattoo Experience</div></section>
        <footer class="doc-footer">BOZZA NON VALIDA FINO ALLA CONFERMA DELL’ACCONTO</footer>`;

    persist(type,it,d);
  }

  function refreshStatus(it){
    documentQuoteStatus.textContent=it.quoteCreatedAt?`Creato ${fmt(it.quoteCreatedAt)}`:'Non creato';
    documentContractStatus.textContent=it.contractDraftCreatedAt?`Bozza ${fmt(it.contractDraftCreatedAt)}`:'Non creato';
    documentDepositStatus.textContent=euro(it.documentDepositAmount||0);
  }

  openDocumentGeneratorBtn?.addEventListener('click',openModal);
  document.querySelectorAll('[data-close-document-generator]').forEach(x=>x.addEventListener('click',closeModal));
  docTotalPrice?.addEventListener('input',updateDeposit);
  docDepositPercent?.addEventListener('input',updateDeposit);
  generateQuoteBtn?.addEventListener('click',()=>render('quote'));
  generateContractBtn?.addEventListener('click',()=>render('contract'));
  printDocumentBtn?.addEventListener('click',()=>window.print());

  sendDocumentWhatsappBtn?.addEventListener('click',()=>{
    const it=item(); if(!it)return;
    const d=data();
    const msg=currentType==='contract'
      ?`Wedding Tattoo Experience%0A%0ABozza contratto ${encodeURIComponent(it.id)}%0ATotale: ${encodeURIComponent(euro(d.total))}%0AAcconto: ${encodeURIComponent(euro(d.deposit))}`
      :`Wedding Tattoo Experience%0A%0APreventivo ${encodeURIComponent(it.id)}%0ATotale: ${encodeURIComponent(euro(d.total))}%0AAcconto: ${encodeURIComponent(euro(d.deposit))}`;
    const phone=String(it.phone||'').replace(/[^\d]/g,'');
    window.open(`https://wa.me/${phone}?text=${msg}`,'_blank','noopener');
  });
})();
