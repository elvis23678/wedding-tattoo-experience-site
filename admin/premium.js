
(() => {
  const KEY='wte_requests_v1';
  const API_KEY='wte_cloud_api_url_v2';
  const TOKEN_KEY='wte_cloud_token_v2';

  const load=()=>{try{const d=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(d)?d:[]}catch{return[]}};
  const euro=v=>new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(Number(v||0));
  const fmt=v=>v?new Date(v).toLocaleString('it-IT'):'—';
  const api=()=>String(localStorage.getItem(API_KEY)||'https://wte-cloud-api.onrender.com').replace(/\/+$/,'');
  const token=()=>sessionStorage.getItem(TOKEN_KEY)||'';

  function number(v){
    const n=Number(String(v??'').replace(/[^\d,.-]/g,'').replace(',','.'));
    return Number.isFinite(n)?n:0;
  }

  async function request(path,options={}){
    if(!token())throw new Error('Connetti prima WTE Cloud.');
    const res=await fetch(`${api()}${path}`,{
      ...options,
      headers:{
        'Content-Type':'application/json',
        Authorization:`Bearer ${token()}`,
        ...(options.headers||{})
      }
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||`Errore ${res.status}`);
    return data;
  }

  function paymentState(item){
    const total=number(item.paymentTotalPrice||item.price);
    const paid=number(item.depositReceived||item.depositPaid);
    if(total>0&&paid>=total)return'paid';
    if(paid>0)return'partial';
    return'unpaid';
  }

  function render(){
    const items=load();
    const active=items.filter(x=>!['Annullato','Annullata','Archiviato','Archiviata'].includes(x.status));
    const confirmed=active.filter(x=>['Confermata','Confermato','Acconto ricevuto','Evento eseguito'].includes(x.status));
    const confirmedValue=confirmed.reduce((s,x)=>s+number(x.paymentTotalPrice||x.price),0);
    const deposits=active.reduce((s,x)=>s+number(x.depositReceived||x.depositPaid),0);
    const balances=active.reduce((s,x)=>{
      const total=number(x.paymentTotalPrice||x.price);
      const paid=number(x.depositReceived||x.depositPaid);
      return s+Math.max(0,total-paid);
    },0);
    const conversion=active.length?Math.round(confirmed.length/active.length*100):0;

    premiumConfirmedValue.textContent=euro(confirmedValue);
    premiumDeposits.textContent=euro(deposits);
    premiumBalance.textContent=euro(balances);
    premiumConversion.textContent=`${conversion}%`;

    const statusMap={};
    active.forEach(x=>statusMap[x.status||'Nuova richiesta']=(statusMap[x.status||'Nuova richiesta']||0)+1);
    premiumPipeline.innerHTML='';
    Object.entries(statusMap).sort((a,b)=>b[1]-a[1]).forEach(([status,count])=>{
      const row=document.createElement('div');
      row.className='premium-pipeline-row';
      row.innerHTML=`<span>${status}</span><strong>${count}</strong>`;
      premiumPipeline.appendChild(row);
    });
    if(!Object.keys(statusMap).length)premiumPipeline.innerHTML='<div class="premium-empty">Nessuna pratica.</div>';

    const today=new Date();today.setHours(0,0,0,0);
    const deadlines=[];
    active.forEach(x=>{
      [
        ['Acconto',x.documentDepositDueDate],
        ['Saldo',x.balanceDueDate],
        ['Evento',x.date]
      ].forEach(([label,date])=>{
        if(!date)return;
        const d=new Date(String(date).slice(0,10)+'T00:00:00');
        const diff=Math.round((d-today)/(86400000));
        if(diff>=0&&diff<=30)deadlines.push({label,date:d,diff,item:x});
      });
    });
    deadlines.sort((a,b)=>a.date-b.date);
    premiumDeadlines.innerHTML='';
    deadlines.slice(0,8).forEach(d=>{
      const row=document.createElement('div');
      row.className='premium-deadline-row';
      row.innerHTML=`<strong>${d.label}: ${d.item.name||d.item.id}</strong><span>${d.date.toLocaleDateString('it-IT')}</span><small>${d.diff===0?'Oggi':`Tra ${d.diff} giorni`}</small>`;
      premiumDeadlines.appendChild(row);
    });
    if(!deadlines.length)premiumDeadlines.innerHTML='<div class="premium-empty">Nessuna scadenza nei prossimi 30 giorni.</div>';

    const packages=[...new Set(items.map(x=>x.package).filter(Boolean))].sort();
    const current=premiumPackageFilter.value;
    premiumPackageFilter.innerHTML='<option value="">Tutti i pacchetti</option>'+packages.map(p=>`<option>${p}</option>`).join('');
    premiumPackageFilter.value=current;
  }

  function applyFilters(){
    const from=premiumDateFrom.value;
    const to=premiumDateTo.value;
    const pkg=premiumPackageFilter.value;
    const payment=premiumPaymentFilter.value;
    const search=document.getElementById('searchInput');

    const criteria=[from&&`da:${from}`,to&&`a:${to}`,pkg&&`pacchetto:${pkg}`,payment&&`pagamento:${payment}`].filter(Boolean).join(' ');
    if(search)search.value=criteria;

    window.__wtePremiumFilter={from,to,pkg,payment};
    document.getElementById('refreshBtn')?.click();
  }

  function exportReport(){
    const items=load();
    const rows=[
      ['ID','Cliente','Data evento','Location','Pacchetto','Prezzo','Acconto','Saldo','Stato'],
      ...items.map(x=>{
        const total=number(x.paymentTotalPrice||x.price);
        const paid=number(x.depositReceived||x.depositPaid);
        return [x.id,x.name,x.date,x.location,x.package,total,paid,Math.max(0,total-paid),x.status];
      })
    ];
    const csv=rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';')).join('\n');
    const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=`WTE_report_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
  }

  async function createCloudBackup(){
    try{
      await request('/api/backups/create',{
        method:'POST',
        body:JSON.stringify({practices:load()})
      });
      alert('Backup Cloud creato.');
      await loadCloudBackups();
    }catch(e){alert(e.message)}
  }

  async function loadCloudBackups(){
    try{
      const data=await request('/api/backups');
      const backups=data.backups||[];
      cloudBackupsCount.textContent=backups.length;
      cloudBackupsLast.textContent=backups[0]?fmt(backups[0].created_at):'—';
      cloudBackupLast.textContent=backups[0]?fmt(backups[0].created_at):'—';
      cloudBackupsList.innerHTML='';

      if(!backups.length){
        cloudBackupsList.innerHTML='<div class="premium-empty">Nessun backup Cloud.</div>';
        return;
      }

      backups.forEach(b=>{
        const row=document.createElement('article');
        row.className='cloud-backup-row';
        row.innerHTML=`<div><strong>Backup #${b.id}</strong><span>${fmt(b.created_at)} · ${b.count||0} pratiche</span></div><button type="button">Ripristina</button>`;
        row.querySelector('button').addEventListener('click',async()=>{
          if(!confirm('Ripristinare questo backup Cloud?'))return;
          try{
            const data=await request(`/api/backups/${b.id}`);
            localStorage.setItem(KEY,JSON.stringify(data.data||[]));
            document.getElementById('refreshBtn')?.click();
            alert('Backup Cloud ripristinato.');
          }catch(e){alert(e.message)}
        });
        cloudBackupsList.appendChild(row);
      });
    }catch(e){
      cloudBackupsList.innerHTML=`<div class="premium-empty">${e.message}</div>`;
    }
  }

  premiumRefreshBtn?.addEventListener('click',render);
  premiumExportReportBtn?.addEventListener('click',exportReport);
  premiumApplyFilters?.addEventListener('click',applyFilters);
  premiumResetFilters?.addEventListener('click',()=>{
    premiumDateFrom.value='';premiumDateTo.value='';premiumPackageFilter.value='';premiumPaymentFilter.value='';
    window.__wtePremiumFilter=null;
    const s=document.getElementById('searchInput');if(s)s.value='';
    document.getElementById('refreshBtn')?.click();
  });

  createCloudBackupBtn?.addEventListener('click',createCloudBackup);
  openCloudBackupsBtn?.addEventListener('click',async()=>{
    cloudBackupsModal.classList.add('open');
    document.body.classList.add('lock');
    await loadCloudBackups();
  });
  document.querySelectorAll('[data-close-cloud-backups]').forEach(x=>x.addEventListener('click',()=>{
    cloudBackupsModal.classList.remove('open');
    document.body.classList.remove('lock');
  }));

  document.getElementById('refreshBtn')?.addEventListener('click',()=>setTimeout(render,50));
  window.addEventListener('storage',e=>{if(e.key===KEY)render()});
  setTimeout(render,250);
})();
