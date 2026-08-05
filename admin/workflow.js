
(() => {
  const KEY='wte_requests_v1', SETTINGS_KEY='wte_payment_settings_v3', QUEUE_KEY='wte_message_queue_v3';
  const $=id=>document.getElementById(id);
  const load=()=>{try{const d=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(d)?d:[]}catch{return[]}};
  const save=v=>localStorage.setItem(KEY,JSON.stringify(v));
  const loadQueue=()=>{try{const d=JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]');return Array.isArray(d)?d:[]}catch{return[]}};
  const saveQueue=v=>localStorage.setItem(QUEUE_KEY,JSON.stringify(v.slice(-100)));
  const loadSettings=()=>{try{return{payee:'Tattoo Beauty Saloon',iban:'',paypal:'',depositPercent:30,autoOpenWhatsapp:true,...(JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')||{})}}catch{return{payee:'Tattoo Beauty Saloon',iban:'',paypal:'',depositPercent:30,autoOpenWhatsapp:true}}};
  const selectedId=()=>$('detailId')?.textContent?.trim()||'';

  function parseMoney(value){
    if(typeof value==='number')return Number.isFinite(value)?value:0;
    let t=String(value??'').trim().replace(/\s|€|EUR/gi,'');
    if(t.includes(',')&&t.includes('.'))t=t.replace(/\./g,'').replace(',','.');
    else if(t.includes(','))t=t.replace(',','.');
    else if(/^\d{1,3}(\.\d{3})+$/.test(t))t=t.replace(/\./g,'');
    const n=Number(t.replace(/[^\d.-]/g,''));
    return Number.isFinite(n)?n:0;
  }

  const euro=v=>new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(Number(v||0));
  const fmt=v=>{if(!v)return'—';const d=new Date(String(v).slice(0,10)+'T00:00:00');return Number.isNaN(d.getTime())?'—':d.toLocaleDateString('it-IT')};
  const addDays=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.toISOString().slice(0,10)};
  const minusDays=(v,n)=>{if(!v)return'';const d=new Date(String(v).slice(0,10)+'T00:00:00');if(Number.isNaN(d.getTime()))return'';d.setDate(d.getDate()-n);return d.toISOString().slice(0,10)};
  const daysUntil=v=>{if(!v)return null;const t=new Date(String(v).slice(0,10)+'T00:00:00'),n=new Date();n.setHours(0,0,0,0);return Number.isNaN(t.getTime())?null:Math.round((t-n)/86400000)};

  function packagePrice(item){
    const direct=parseMoney(item.paymentTotalPrice||item.price||item.totalPrice);
    if(direct>0)return direct;
    const p=String(item.package||'').toLowerCase();
    if(p.includes('bronze'))return 790;
    if(p.includes('silver'))return 1090;
    if(p.includes('gold'))return 1690;
    return 0;
  }

  function phone(item){
    let p=String(item.phone||item.mobile||'').replace(/[^\d]/g,'');
    if(p&&!p.startsWith('39'))p='39'+p;
    return p;
  }

  function timeline(item,title,detail){
    item.timeline=Array.isArray(item.timeline)?item.timeline:[];
    item.timeline.unshift({id:`WF-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,title,detail,createdAt:new Date().toISOString()});
  }

  function queue(item,type,message,dueDate){
    const q=loadQueue(),id=`${item.id}:${type}:${dueDate||'now'}`;
    if(!q.some(x=>x.id===id))q.push({id,practiceId:item.id,type,message,dueDate,createdAt:new Date().toISOString(),sent:false});
    saveQueue(q);
  }

  function paymentMethods(){
    const s=loadSettings();
    return [s.iban?`Bonifico intestato a ${s.payee}: ${s.iban}`:'',s.paypal?`PayPal: ${s.paypal}`:''].filter(Boolean).join('\n');
  }

  function message(item,type){
    const s=loadSettings(),total=packagePrice(item),deposit=parseMoney(item.depositExpected||item.documentDepositAmount||Math.round(total*s.depositPercent/100)),paid=parseMoney(item.depositPaid||item.depositReceived),balanceDue=item.balanceDueDate||minusDays(item.date,7),methods=paymentMethods();

    if(type==='deposit-request')return `🎉 *Wedding Tattoo Experience – Data disponibile*

Ciao ${item.name||''},
la data del ${fmt(item.date)} è disponibile.

Per bloccarla definitivamente è richiesto un acconto di *${euro(deposit)}* entro il *${fmt(item.depositDueDate)}*.

${methods||'Le coordinate di pagamento verranno comunicate dallo staff.'}

Causale: Acconto WTE – ${item.id}

Il saldo di *${euro(Math.max(0,total-deposit))}* dovrà essere ricevuto entro il *${fmt(balanceDue)}*, 7 giorni prima del matrimonio.

⚠️ Senza il saldo entro tale termine il servizio non verrà eseguito e l’acconto resterà acquisito per il blocco della data, salvo quanto inderogabilmente previsto dalla legge.`;

    if(type==='deposit-received')return `✅ *Acconto ricevuto*

Ciao ${item.name||''},
abbiamo registrato l’acconto di *${euro(paid)}*.
La data del ${fmt(item.date)} è confermata.

Il saldo residuo di *${euro(Math.max(0,total-paid))}* dovrà essere ricevuto entro il *${fmt(balanceDue)}*.`;

    return `⏰ *Promemoria saldo Wedding Tattoo Experience*

Ciao ${item.name||''},
il saldo residuo di *${euro(Math.max(0,total-paid))}* deve essere ricevuto entro il *${fmt(balanceDue)}*.

⚠️ Senza il saldo entro la scadenza, il servizio non verrà eseguito e l’acconto resterà acquisito per il blocco della data.

${methods}`;
  }

  function openWhatsapp(item,text){
    window.open(`https://wa.me/${phone(item)}?text=${encodeURIComponent(text)}`,'_blank','noopener');
  }

  function refreshDrawer(item){
    if(!item)return;
    const s=loadSettings(),total=packagePrice(item),deposit=parseMoney(item.depositExpected||item.documentDepositAmount||Math.round(total*s.depositPercent/100)),paid=parseMoney(item.depositPaid||item.depositReceived),balance=Math.max(0,total-paid);
    if($('workflowPaymentState'))$('workflowPaymentState').textContent=item.paymentStatus||item.status||'Da configurare';
    if($('workflowTotal'))$('workflowTotal').textContent=euro(total);
    if($('workflowDeposit'))$('workflowDeposit').textContent=euro(deposit);
    if($('workflowBalance'))$('workflowBalance').textContent=euro(balance);
    if($('workflowDeadlineCopy'))$('workflowDeadlineCopy').textContent=`Acconto entro ${fmt(item.depositDueDate)} · Saldo entro ${fmt(item.balanceDueDate||minusDays(item.date,7))}`;
  }

  function confirmEvent(e){
    e.preventDefault();e.stopImmediatePropagation();
    const items=load(),item=items.find(x=>x.id===selectedId());if(!item)return;
    const s=loadSettings(),total=packagePrice(item);if(total<=0){alert('Prezzo totale non definito.');return}
    const deposit=Math.round(total*Number(s.depositPercent||30)/100);
    Object.assign(item,{paymentTotalPrice:total,depositExpected:deposit,documentDepositAmount:deposit,documentDepositPercent:Number(s.depositPercent||30),depositDueDate:addDays(7),documentDepositDueDate:addDays(7),balanceDueDate:minusDays(item.date,7),balance:total-deposit,balanceRemaining:total-deposit,status:'In attesa di acconto',paymentStatus:'In attesa di acconto',quoteCreatedAt:item.quoteCreatedAt||new Date().toISOString(),contractDraftCreatedAt:item.contractDraftCreatedAt||new Date().toISOString(),updatedAt:new Date().toISOString()});
    timeline(item,'Data disponibile e richiesta acconto generata',`Totale ${euro(total)} · Acconto ${euro(deposit)} entro ${fmt(item.depositDueDate)} · Saldo entro ${fmt(item.balanceDueDate)}`);
    const msg=message(item,'deposit-request');queue(item,'deposit-request',msg,item.depositDueDate);save(items);refreshDrawer(item);$('refreshBtn')?.click();
    if(s.autoOpenWhatsapp)openWhatsapp(item,msg);
  }

  function registerDeposit(e){
    e.preventDefault();e.stopImmediatePropagation();
    const items=load(),item=items.find(x=>x.id===selectedId());if(!item)return;
    const raw=prompt('Importo acconto ricevuto:',parseMoney(item.depositExpected||item.documentDepositAmount)||0);if(raw===null)return;
    const amount=parseMoney(raw);if(amount<=0)return;
    const total=packagePrice(item);
    Object.assign(item,{depositPaid:amount,depositReceived:amount,depositDate:new Date().toISOString().slice(0,10),balance:Math.max(0,total-amount),balanceRemaining:Math.max(0,total-amount),balanceDueDate:item.balanceDueDate||minusDays(item.date,7),status:'Confermato',paymentStatus:'Acconto ricevuto',updatedAt:new Date().toISOString()});
    timeline(item,'Acconto ricevuto',`${euro(amount)} registrati · Saldo ${euro(item.balance)} entro ${fmt(item.balanceDueDate)}`);
    const msg=message(item,'deposit-received');queue(item,'deposit-received',msg,new Date().toISOString().slice(0,10));save(items);refreshDrawer(item);$('refreshBtn')?.click();
    if(loadSettings().autoOpenWhatsapp)openWhatsapp(item,msg);
  }

  function buildReminders(){
    const items=load();
    items.forEach(item=>{
      const total=packagePrice(item),paid=parseMoney(item.depositPaid||item.depositReceived);
      if(!item.date||total<=0||paid<=0||paid>=total)return;
      item.balanceDueDate=item.balanceDueDate||minusDays(item.date,7);
      const days=daysUntil(item.date);
      [14,10,7].forEach(day=>{if(days===day)queue(item,`balance-${day}`,message(item,'balance-reminder'),new Date().toISOString().slice(0,10))});
      if(days!==null&&days<7&&!['Evento eseguito','Archiviato','Annullato'].includes(item.status)){
        item.status='Evento sospeso - saldo mancante';item.paymentStatus='Saldo scaduto';item.updatedAt=new Date().toISOString();
      }
    });
    save(items);
  }

  function renderNotifications(){
    buildReminders();
    const items=load(),q=loadQueue();let deposits=0,balances=0,suspended=0;
    items.forEach(i=>{const paid=parseMoney(i.depositPaid||i.depositReceived),total=packagePrice(i),d=daysUntil(i.balanceDueDate||minusDays(i.date,7));if(i.status==='In attesa di acconto'&&paid<=0)deposits++;if(d!==null&&d>=0&&d<=7&&paid>0&&paid<total)balances++;if(String(i.status).includes('sospeso'))suspended++});
    $('workflowDepositsDue').textContent=deposits;$('workflowBalancesDue').textContent=balances;$('workflowSuspended').textContent=suspended;$('workflowMessagesReady').textContent=q.filter(x=>!x.sent).length;
    const wrap=$('workflowNotificationList');wrap.innerHTML='';
    const pending=q.filter(x=>!x.sent).slice().reverse();
    if(!pending.length){wrap.innerHTML='<div class="workflow-empty">Nessun avviso da gestire.</div>';return}
    pending.forEach(entry=>{const item=items.find(x=>x.id===entry.practiceId);if(!item)return;const card=document.createElement('article');card.className=`workflow-alert ${entry.type.includes('balance-7')||String(item.status).includes('sospeso')?'danger':'warning'}`;card.innerHTML=`<div><strong>${item.name||item.id}</strong><span>${entry.type.replace(/-/g,' ')} · Evento ${fmt(item.date)}</span></div><button type="button">Apri WhatsApp</button>`;card.querySelector('button').onclick=()=>{openWhatsapp(item,entry.message);const all=loadQueue(),t=all.find(x=>x.id===entry.id);if(t)t.sent=true;saveQueue(all);renderNotifications()};wrap.appendChild(card)});
  }

  function initSettings(){
    const s=loadSettings();
    $('settingsPayee').value=s.payee||'';$('settingsIban').value=s.iban||'';$('settingsPaypal').value=s.paypal||'';$('settingsDepositPercent').value=s.depositPercent||30;$('settingsAutoOpenWhatsapp').checked=s.autoOpenWhatsapp!==false;
  }

  $('savePaymentSettingsBtn')?.addEventListener('click',()=>{localStorage.setItem(SETTINGS_KEY,JSON.stringify({payee:$('settingsPayee').value.trim(),iban:$('settingsIban').value.trim(),paypal:$('settingsPaypal').value.trim(),depositPercent:Number($('settingsDepositPercent').value||30),autoOpenWhatsapp:$('settingsAutoOpenWhatsapp').checked}));alert('Impostazioni pagamento salvate.')});
  $('confirmEventBtn')?.addEventListener('click',confirmEvent,true);
  $('registerDepositBtn')?.addEventListener('click',registerDeposit,true);
  $('workflowRefreshBtn')?.addEventListener('click',renderNotifications);
  $('refreshBtn')?.addEventListener('click',()=>setTimeout(renderNotifications,50));

  const drawer=$('drawer');
  if(drawer)new MutationObserver(()=>{if(drawer.classList.contains('open'))refreshDrawer(load().find(x=>x.id===selectedId()))}).observe(drawer,{attributes:true,attributeFilter:['class']});
  window.addEventListener('wte:cloud-synced',()=>setTimeout(renderNotifications,50));
  initSettings();setTimeout(renderNotifications,300);
})();
