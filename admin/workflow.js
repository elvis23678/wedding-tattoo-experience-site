
(() => {
  const KEY='wte_requests_v1';
  const SETTINGS_KEY='wte_payment_settings_v4';
  const QUEUE_KEY='wte_message_queue_v4';
  const LAST_MESSAGE_KEY='wte_last_message_v4';

  const $=id=>document.getElementById(id);

  function load(){
    try{
      const d=JSON.parse(localStorage.getItem(KEY)||'[]');
      return Array.isArray(d)?d:[];
    }catch{return[]}
  }

  function save(items){
    localStorage.setItem(KEY,JSON.stringify(items));
  }

  function settings(){
    try{
      return {
        payee:'Tattoo Beauty Saloon',
        iban:'',
        paypal:'',
        depositPercent:30,
        autoOpenWhatsapp:true,
        ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')||{})
      };
    }catch{
      return {payee:'Tattoo Beauty Saloon',iban:'',paypal:'',depositPercent:30,autoOpenWhatsapp:true};
    }
  }

  function loadQueue(){
    try{
      const q=JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]');
      return Array.isArray(q)?q:[];
    }catch{return[]}
  }

  function saveQueue(q){
    localStorage.setItem(QUEUE_KEY,JSON.stringify(q.slice(-200)));
  }

  function selectedId(){
    return $('detailId')?.textContent?.trim()||'';
  }

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

  function fmt(v){
    if(!v)return'—';
    const d=new Date(String(v).slice(0,10)+'T00:00:00');
    return Number.isNaN(d.getTime())?'—':d.toLocaleDateString('it-IT');
  }

  function addDays(n){
    const d=new Date();
    d.setDate(d.getDate()+n);
    return d.toISOString().slice(0,10);
  }

  function minusDays(v,n){
    if(!v)return'';
    const d=new Date(String(v).slice(0,10)+'T00:00:00');
    if(Number.isNaN(d.getTime()))return'';
    d.setDate(d.getDate()-n);
    return d.toISOString().slice(0,10);
  }

  function daysUntil(v){
    if(!v)return null;
    const t=new Date(String(v).slice(0,10)+'T00:00:00');
    const n=new Date();n.setHours(0,0,0,0);
    return Number.isNaN(t.getTime())?null:Math.round((t-n)/86400000);
  }

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
    item.timeline.unshift({
      id:`WF-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      title,detail,createdAt:new Date().toISOString()
    });
  }

  function paymentMethods(){
    const s=settings();
    return [
      s.iban?`Bonifico intestato a ${s.payee}: ${s.iban}`:'',
      s.paypal?`PayPal: ${s.paypal}`:''
    ].filter(Boolean).join('\n');
  }

  function buildMessage(item,type){
    const s=settings();
    const total=packagePrice(item);
    const deposit=parseMoney(item.depositExpected||item.documentDepositAmount||Math.round(total*s.depositPercent/100));
    const paid=parseMoney(item.depositPaid||item.depositReceived);
    const due=item.balanceDueDate||minusDays(item.date,7);
    const methods=paymentMethods();

    if(type==='deposit-request'){
      return `🎉 *Wedding Tattoo Experience – Data disponibile*

Ciao ${item.name||''},
la data del ${fmt(item.date)} è disponibile.

Per bloccarla definitivamente è richiesto un acconto di *${euro(deposit)}* entro il *${fmt(item.depositDueDate)}*.

${methods||'Le coordinate di pagamento verranno comunicate dallo staff.'}

Causale: Acconto WTE – ${item.id}

Il saldo di *${euro(Math.max(0,total-deposit))}* dovrà essere ricevuto entro il *${fmt(due)}*, 7 giorni prima del matrimonio.

⚠️ Senza il saldo entro tale termine, il servizio non verrà eseguito e l’acconto resterà acquisito quale corrispettivo per il blocco della data, salvo quanto inderogabilmente previsto dalla legge.`;
    }

    if(type==='deposit-received'){
      return `✅ *Acconto ricevuto*

Ciao ${item.name||''},
abbiamo registrato l’acconto di *${euro(paid)}*.
La data del ${fmt(item.date)} è confermata.

Il saldo residuo di *${euro(Math.max(0,total-paid))}* dovrà essere ricevuto entro il *${fmt(due)}*, 7 giorni prima del matrimonio.`;
    }

    if(type==='balance-received'){
      return `✅ *Saldo ricevuto*

Ciao ${item.name||''},
abbiamo registrato il saldo del servizio Wedding Tattoo Experience.

La pratica ${item.id} risulta completamente pagata e pronta per l’evento del ${fmt(item.date)}.`;
    }

    return `⏰ *Promemoria saldo Wedding Tattoo Experience*

Ciao ${item.name||''},
il saldo residuo di *${euro(Math.max(0,total-paid))}* deve essere ricevuto entro il *${fmt(due)}*.

⚠️ Senza il saldo entro la scadenza, il servizio non verrà eseguito e l’acconto resterà acquisito per il blocco della data.

${methods}`;
  }

  function storeMessage(item,type,text){
    const payload={practiceId:item.id,type,text,createdAt:new Date().toISOString()};
    localStorage.setItem(LAST_MESSAGE_KEY,JSON.stringify(payload));
    const q=loadQueue();
    const id=`${item.id}:${type}:${new Date().toISOString().slice(0,10)}`;
    if(!q.some(x=>x.id===id)){
      q.push({...payload,id,sent:false});
      saveQueue(q);
    }
    showMessage(item,type,text);
  }

  function showMessage(item,type,text){
    if($('paymentMessageTitle')){
      const map={
        'deposit-request':'Richiesta acconto pronta',
        'deposit-received':'Conferma acconto pronta',
        'balance-reminder':'Promemoria saldo pronto',
        'balance-received':'Conferma saldo pronta'
      };
      $('paymentMessageTitle').textContent=map[type]||'Messaggio pronto';
    }
    if($('paymentMessagePreview'))$('paymentMessagePreview').value=text||'';
    $('openPreparedWhatsappBtn')?.setAttribute('data-practice-id',item?.id||'');
  }

  function openWhatsapp(item,text){
    const p=phone(item);
    window.open(`https://wa.me/${p}?text=${encodeURIComponent(text)}`,'_blank','noopener');
  }

  function refreshDrawer(item){
    if(!item)return;
    const s=settings();
    const total=packagePrice(item);
    const deposit=parseMoney(item.depositExpected||item.documentDepositAmount||Math.round(total*s.depositPercent/100));
    const paid=parseMoney(item.depositPaid||item.depositReceived);
    const balance=Math.max(0,total-paid);

    if($('workflowPaymentState'))$('workflowPaymentState').textContent=item.paymentStatus||item.status||'Da configurare';
    if($('workflowTotal'))$('workflowTotal').textContent=euro(total);
    if($('workflowDeposit'))$('workflowDeposit').textContent=euro(deposit);
    if($('workflowBalance'))$('workflowBalance').textContent=euro(balance);
    if($('workflowDeadlineCopy')){
      $('workflowDeadlineCopy').textContent=`Acconto entro ${fmt(item.depositDueDate)} · Saldo entro ${fmt(item.balanceDueDate||minusDays(item.date,7))}`;
    }

    const last=loadQueue().filter(x=>x.practiceId===item.id).slice(-1)[0];
    if(last)showMessage(item,last.type,last.text);
  }

  function confirmEvent(e){
    e.preventDefault();
    e.stopImmediatePropagation();

    const items=load();
    const item=items.find(x=>x.id===selectedId());
    if(!item)return;

    const s=settings();
    const total=packagePrice(item);
    if(total<=0){
      alert('Prezzo totale non definito.');
      return;
    }

    const deposit=Math.round(total*Number(s.depositPercent||30)/100);
    const depositDue=addDays(7);
    const balanceDue=minusDays(item.date,7);

    Object.assign(item,{
      paymentTotalPrice:total,
      depositExpected:deposit,
      documentDepositAmount:deposit,
      documentDepositPercent:Number(s.depositPercent||30),
      depositDueDate:depositDue,
      documentDepositDueDate:depositDue,
      balanceDueDate:balanceDue,
      balance:total-deposit,
      balanceRemaining:total-deposit,
      status:'In attesa di acconto',
      paymentStatus:'In attesa di acconto',
      quoteCreatedAt:item.quoteCreatedAt||new Date().toISOString(),
      contractDraftCreatedAt:item.contractDraftCreatedAt||new Date().toISOString(),
      updatedAt:new Date().toISOString()
    });

    timeline(item,'Data disponibile e richiesta acconto generata',
      `Totale ${euro(total)} · Acconto ${euro(deposit)} entro ${fmt(depositDue)} · Saldo entro ${fmt(balanceDue)}`);

    const msg=buildMessage(item,'deposit-request');
    storeMessage(item,'deposit-request',msg);
    save(items);
    refreshDrawer(item);
    $('refreshBtn')?.click();

    if(s.autoOpenWhatsapp)openWhatsapp(item,msg);
  }

  function registerDeposit(e){
    e.preventDefault();
    e.stopImmediatePropagation();

    const items=load();
    const item=items.find(x=>x.id===selectedId());
    if(!item)return;

    const expected=parseMoney(item.depositExpected||item.documentDepositAmount);
    const raw=prompt('Importo acconto ricevuto:',expected||0);
    if(raw===null)return;

    const amount=parseMoney(raw);
    if(amount<=0)return;

    const total=packagePrice(item);
    Object.assign(item,{
      depositPaid:amount,
      depositReceived:amount,
      depositDate:new Date().toISOString().slice(0,10),
      balance:Math.max(0,total-amount),
      balanceRemaining:Math.max(0,total-amount),
      balanceDueDate:item.balanceDueDate||minusDays(item.date,7),
      status:'Confermato',
      paymentStatus:'Acconto ricevuto',
      updatedAt:new Date().toISOString()
    });

    timeline(item,'Acconto ricevuto',
      `${euro(amount)} registrati · Saldo ${euro(item.balance)} entro ${fmt(item.balanceDueDate)}`);

    const msg=buildMessage(item,'deposit-received');
    storeMessage(item,'deposit-received',msg);
    save(items);
    refreshDrawer(item);
    $('refreshBtn')?.click();

    if(settings().autoOpenWhatsapp)openWhatsapp(item,msg);
  }

  function registerBalance(e){
    e.preventDefault();
    e.stopImmediatePropagation();

    const items=load();
    const item=items.find(x=>x.id===selectedId());
    if(!item)return;

    const total=packagePrice(item);
    const paid=parseMoney(item.depositPaid||item.depositReceived);
    const remaining=Math.max(0,total-paid);
    const raw=prompt('Importo saldo ricevuto:',remaining);
    if(raw===null)return;

    const amount=parseMoney(raw);
    if(amount<=0)return;

    item.balancePaid=amount;
    item.balanceReceivedDate=new Date().toISOString().slice(0,10);
    item.balanceRemaining=Math.max(0,remaining-amount);
    item.balance=item.balanceRemaining;
    item.paymentStatus=item.balanceRemaining<=0?'Pagato':'Saldo parziale';
    item.status=item.balanceRemaining<=0?'Pronto per evento':'Confermato';
    item.updatedAt=new Date().toISOString();

    timeline(item,'Saldo ricevuto',
      `${euro(amount)} registrati · Residuo ${euro(item.balanceRemaining)}`);

    const msg=buildMessage(item,'balance-received');
    storeMessage(item,'balance-received',msg);
    save(items);
    refreshDrawer(item);
    $('refreshBtn')?.click();

    if(settings().autoOpenWhatsapp)openWhatsapp(item,msg);
  }

  function buildReminders(){
    const items=load();

    items.forEach(item=>{
      const total=packagePrice(item);
      const deposit=parseMoney(item.depositPaid||item.depositReceived);
      const balancePaid=parseMoney(item.balancePaid);
      const paid=deposit+balancePaid;

      if(!item.date||total<=0||deposit<=0||paid>=total)return;

      item.balanceDueDate=item.balanceDueDate||minusDays(item.date,7);
      const days=daysUntil(item.date);

      [14,10,7].forEach(day=>{
        if(days===day){
          const msg=buildMessage(item,'balance-reminder');
          storeMessage(item,'balance-reminder',msg);
        }
      });

      if(days!==null&&days<7&&paid<total&&!['Evento eseguito','Archiviato','Annullato'].includes(item.status)){
        item.status='Evento sospeso - saldo mancante';
        item.paymentStatus='Saldo scaduto';
        item.updatedAt=new Date().toISOString();
      }
    });

    save(items);
  }

  function renderNotifications(){
    buildReminders();

    const items=load();
    const q=loadQueue();
    let deposits=0,balances=0,suspended=0;

    items.forEach(item=>{
      const deposit=parseMoney(item.depositPaid||item.depositReceived);
      const balancePaid=parseMoney(item.balancePaid);
      const total=packagePrice(item);
      const d=daysUntil(item.balanceDueDate||minusDays(item.date,7));

      if(item.status==='In attesa di acconto'&&deposit<=0)deposits++;
      if(d!==null&&d>=0&&d<=7&&deposit>0&&(deposit+balancePaid)<total)balances++;
      if(String(item.status).includes('sospeso'))suspended++;
    });

    if($('workflowDepositsDue'))$('workflowDepositsDue').textContent=deposits;
    if($('workflowBalancesDue'))$('workflowBalancesDue').textContent=balances;
    if($('workflowSuspended'))$('workflowSuspended').textContent=suspended;
    if($('workflowMessagesReady'))$('workflowMessagesReady').textContent=q.filter(x=>!x.sent).length;

    const wrap=$('workflowNotificationList');
    if(!wrap)return;
    wrap.innerHTML='';

    const pending=q.filter(x=>!x.sent).slice().reverse();

    if(!pending.length){
      wrap.innerHTML='<div class="workflow-empty">Nessun avviso da gestire.</div>';
      return;
    }

    pending.forEach(entry=>{
      const item=items.find(x=>x.id===entry.practiceId);
      if(!item)return;

      const card=document.createElement('article');
      const danger=entry.type.includes('balance-reminder')||String(item.status).includes('sospeso');
      card.className=`workflow-alert ${danger?'danger':'warning'}`;
      card.innerHTML=`
        <div>
          <strong>${item.name||item.id}</strong>
          <span>${entry.type.replace(/-/g,' ')} · Evento ${fmt(item.date)}</span>
        </div>
        <button type="button">Apri WhatsApp</button>`;

      card.querySelector('button').addEventListener('click',()=>{
        openWhatsapp(item,entry.text);
        const all=loadQueue();
        const target=all.find(x=>x.id===entry.id);
        if(target)target.sent=true;
        saveQueue(all);
        renderNotifications();
      });

      wrap.appendChild(card);
    });
  }

  function initSettings(){
    const s=settings();
    if($('settingsPayee'))$('settingsPayee').value=s.payee||'';
    if($('settingsIban'))$('settingsIban').value=s.iban||'';
    if($('settingsPaypal'))$('settingsPaypal').value=s.paypal||'';
    if($('settingsDepositPercent'))$('settingsDepositPercent').value=s.depositPercent||30;
    if($('settingsAutoOpenWhatsapp'))$('settingsAutoOpenWhatsapp').checked=s.autoOpenWhatsapp!==false;
  }

  $('savePaymentSettingsBtn')?.addEventListener('click',()=>{
    localStorage.setItem(SETTINGS_KEY,JSON.stringify({
      payee:$('settingsPayee').value.trim(),
      iban:$('settingsIban').value.trim(),
      paypal:$('settingsPaypal').value.trim(),
      depositPercent:Number($('settingsDepositPercent').value||30),
      autoOpenWhatsapp:$('settingsAutoOpenWhatsapp').checked
    }));
    alert('Impostazioni pagamento salvate.');
  });

  $('confirmEventBtn')?.addEventListener('click',confirmEvent,true);
  $('registerDepositBtn')?.addEventListener('click',registerDeposit,true);
  $('registerBalanceBtn')?.addEventListener('click',registerBalance,true);

  $('openPreparedWhatsappBtn')?.addEventListener('click',()=>{
    const item=load().find(x=>x.id===selectedId());
    if(!item)return;
    const text=$('paymentMessagePreview')?.value||'';
    if(!text){
      alert('Nessun messaggio pronto.');
      return;
    }
    openWhatsapp(item,text);
  });

  $('workflowRefreshBtn')?.addEventListener('click',renderNotifications);
  $('refreshBtn')?.addEventListener('click',()=>setTimeout(renderNotifications,50));

  const drawer=$('drawer');
  if(drawer){
    new MutationObserver(()=>{
      if(drawer.classList.contains('open')){
        refreshDrawer(load().find(x=>x.id===selectedId()));
      }
    }).observe(drawer,{attributes:true,attributeFilter:['class']});
  }

  window.addEventListener('wte:cloud-synced',()=>setTimeout(renderNotifications,50));
  initSettings();
  setTimeout(renderNotifications,300);
})();
