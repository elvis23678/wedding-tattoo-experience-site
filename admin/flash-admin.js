(() => {
const API='https://wte-cloud-api.onrender.com';
const token=()=>localStorage.getItem('wte_cloud_token_v4')||localStorage.getItem('wte_cloud_token_v2')||'';
const practiceId=()=>document.getElementById('detailId')?.textContent?.trim()||'';
async function req(path,opt={}){const r=await fetch(API+path,{...opt,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Errore');return d}
createFlashLinkBtn?.addEventListener('click',async()=>{try{const id=practiceId();if(!id)return alert('Apri una pratica.');const name=document.getElementById('detailName')?.textContent||'';const d=await req('/api/flash-sessions',{method:'POST',body:JSON.stringify({practiceId:id,customerName:name,maxItems:50})});const url=`https://www.weddingtattooexperience.it${d.url}`;flashSelectionLink.value=url;flashSelectionStatus.textContent='Link creato'}catch(e){alert(e.message)}});
copyFlashLinkBtn?.addEventListener('click',async()=>{if(!flashSelectionLink.value)return;navigator.clipboard?.writeText(flashSelectionLink.value);alert('Link copiato.')});
openFlashLinkBtn?.addEventListener('click',()=>{if(flashSelectionLink.value)window.open(flashSelectionLink.value,'_blank')});
})();