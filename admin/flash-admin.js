
(() => {
  const API='https://wte-cloud-api.onrender.com';
  let currentSession=null;
  let observedPractice='';

  const $=id=>document.getElementById(id);
  const token=()=>localStorage.getItem('wte_cloud_token_v4')
    ||sessionStorage.getItem('wte_session_token_v8')
    ||localStorage.getItem('wte_cloud_token_v2')
    ||'';
  const practiceId=()=>String($('detailId')?.textContent||'').trim();

  async function request(path,options={}){
    const response=await fetch(API+path,{
      ...options,
      headers:{
        'Content-Type':'application/json',
        Authorization:`Bearer ${token()}`,
        ...(options.headers||{})
      }
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||'Errore');
    return data;
  }

  function publicUrl(sessionToken){
    return `https://www.weddingtattooexperience.it/flash.html?token=${sessionToken}`;
  }

  function updateUI(session){
    currentSession=session||null;
    if(!session){
      $('flashSelectionStatus').textContent='Non avviata';
      $('flashSelectionLink').value='';
      $('flashSelectionMeta').textContent='Nessuna selezione collegata.';
      return;
    }

    const count=Array.isArray(session.selections)?session.selections.length:Number(session.count||0);
    const locked=Boolean(session.locked);
    const accepted=session.accepted_at||session.acceptedAt;
    $('flashSelectionLink').value=session.url||publicUrl(session.token);
    $('flashSelectionStatus').textContent=locked?'Firmata e confermata':'In attesa del cliente';
    $('flashSelectionMeta').textContent=locked
      ? `${count} flash confermati · Firma acquisita ${accepted?new Date(accepted).toLocaleString('it-IT'):''}`
      : `${count} flash selezionati · il cliente può ancora modificare e firmare.`;
    $('downloadClientFlashPdfBtn').disabled=!locked;
    $('downloadOperatorFlashPdfBtn').disabled=!locked;
    $('reopenFlashSelectionBtn').disabled=!locked;
  }

  async function ensureSession(itemOrId){
    const id=typeof itemOrId==='string'?itemOrId:(itemOrId?.id||practiceId());
    if(!id)throw new Error('Apri una pratica.');
    const name=typeof itemOrId==='object'
      ? (itemOrId.name||'')
      : ($('detailName')?.textContent||'');

    const data=await request('/api/flash-sessions',{
      method:'POST',
      body:JSON.stringify({practiceId:id,customerName:name,maxItems:50})
    });
    const session={
      token:data.token,url:data.url||publicUrl(data.token),
      locked:data.locked,count:data.count,acceptedAt:data.acceptedAt,
      selections:[]
    };
    updateUI(session);
    return session;
  }

  async function loadPracticeSession(){
    const id=practiceId();
    if(!id)return updateUI(null);
    try{
      const data=await request(`/api/flash-sessions/practice/${encodeURIComponent(id)}`);
      const session=(data.sessions||[])[0];
      if(session){
        session.url=publicUrl(session.token);
        updateUI(session);
      }else updateUI(null);
    }catch{
      updateUI(null);
    }
  }

  $('createFlashLinkBtn')?.addEventListener('click',async()=>{
    try{
      await ensureSession(practiceId());
      alert('Link flash pronto.');
    }catch(e){alert(e.message)}
  });

  $('copyFlashLinkBtn')?.addEventListener('click',async()=>{
    const value=$('flashSelectionLink').value;
    if(!value)return alert('Crea prima il link.');
    await navigator.clipboard?.writeText(value);
    alert('Link copiato.');
  });

  $('openFlashLinkBtn')?.addEventListener('click',()=>{
    const value=$('flashSelectionLink').value;
    if(value)window.open(value,'_blank');
  });

  $('downloadClientFlashPdfBtn')?.addEventListener('click',()=>{
    if(!currentSession?.token)return;
    window.open(`${API}/api/public/flash-session/${currentSession.token}/pdf?type=client`,'_blank');
  });

  $('downloadOperatorFlashPdfBtn')?.addEventListener('click',()=>{
    if(!currentSession?.token)return;
    window.open(`${API}/api/public/flash-session/${currentSession.token}/pdf?type=operator`,'_blank');
  });

  $('reopenFlashSelectionBtn')?.addEventListener('click',async()=>{
    if(!currentSession?.token)return;
    if(!confirm('Riaprire la selezione? La firma precedente verrà annullata.'))return;
    try{
      await request(`/api/flash-sessions/${currentSession.token}/reopen`,{method:'POST'});
      await loadPracticeSession();
      alert('Selezione riaperta.');
    }catch(e){alert(e.message)}
  });

  window.WTEFlash={ensureSession,loadPracticeSession};

  setInterval(()=>{
    const id=practiceId();
    if(id!==observedPractice){
      observedPractice=id;
      setTimeout(loadPracticeSession,250);
    }
  },500);

  window.addEventListener('wte:auth-login',()=>setTimeout(loadPracticeSession,500));
})();
