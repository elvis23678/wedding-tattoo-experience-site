
(() => {
  const API='https://wte-cloud-api.onrender.com';
  let catalog=[];

  const $=id=>document.getElementById(id);
  const token=()=>localStorage.getItem('wte_cloud_token_v4')
    || localStorage.getItem('wte_cloud_token_v2')
    || localStorage.getItem('wte_cloud_token_v6')
    || '';

  async function request(path,options={}){
    const response=await fetch(`${API}${path}`,{
      ...options,
      headers:{
        'Content-Type':'application/json',
        Authorization:`Bearer ${token()}`,
        ...(options.headers||{})
      }
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||`Errore ${response.status}`);
    return data;
  }

  function tags(value){
    return String(value||'')
      .split(',')
      .map(x=>x.trim())
      .filter(Boolean)
      .slice(0,30);
  }

  function normalizePrefix(value){
    return String(value||'WTE')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g,'')
      .slice(0,8)||'WTE';
  }

  async function compressImage(file){
    const bitmap=await createImageBitmap(file);
    const maxSide=1400;
    const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
    const width=Math.max(1,Math.round(bitmap.width*scale));
    const height=Math.max(1,Math.round(bitmap.height*scale));
    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{alpha:false});
    context.fillStyle='#ffffff';
    context.fillRect(0,0,width,height);
    context.drawImage(bitmap,0,0,width,height);
    bitmap.close();

    let quality=.84;
    let result=canvas.toDataURL('image/jpeg',quality);
    while(result.length>2_400_000 && quality>.50){
      quality-=.08;
      result=canvas.toDataURL('image/jpeg',quality);
    }
    return result;
  }

  function progress(name,state,text){
    const row=document.createElement('div');
    row.className=`flash-upload-progress-row ${state||''}`;
    row.textContent=`${name}: ${text}`;
    flashUploadProgress.appendChild(row);
    return row;
  }

  async function upload(){
    const files=[...flashUploadFiles.files];
    if(!files.length)return alert('Seleziona almeno un’immagine.');
    if(!token())return alert('Collega prima il Cloud.');

    flashUploadStartBtn.disabled=true;
    flashUploadProgress.innerHTML='';

    const category=flashUploadCategory.value;
    const prefix=normalizePrefix(flashUploadPrefix.value);
    const commonTags=tags(flashUploadTags.value);

    for(const file of files){
      const row=progress(file.name,'','Compressione…');
      try{
        const imageData=await compressImage(file);
        row.textContent=`${file.name}: caricamento…`;

        const title=file.name.replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ');
        const data=await request('/api/flash-catalog',{
          method:'POST',
          body:JSON.stringify({
            imageData,
            title,
            category,
            tags:commonTags,
            prefix
          })
        });

        row.className='flash-upload-progress-row success';
        row.textContent=`${file.name}: ${data.item.code} caricato`;
      }catch(error){
        row.className='flash-upload-progress-row error';
        row.textContent=`${file.name}: ${error.message}`;
      }
    }

    flashUploadStartBtn.disabled=false;
    flashUploadFiles.value='';
    await loadCatalog();
  }


  async function importSeedCatalog(){
    if(!token())return alert('Collega prima il Cloud.');

    flashSeedImportBtn.disabled=true;
    flashUploadProgress.innerHTML='';

    try{
      const seed=await fetch('/flash-seed.json',{cache:'no-store'}).then(response=>{
        if(!response.ok)throw new Error('Archivio iniziale non disponibile.');
        return response.json();
      });

      const existing=new Set(catalog.map(item=>item.code));
      let imported=0;
      let skipped=0;
      let failed=0;

      for(const item of seed.items||[]){
        if(existing.has(item.code)){
          progress(item.code,'success','già presente');
          skipped++;
          continue;
        }

        const row=progress(item.code,'','caricamento...');
        try{
          await request('/api/flash-catalog',{
            method:'POST',
            body:JSON.stringify({
              imageData:item.imageData,
              title:item.title,
              category:item.category,
              tags:item.tags||[],
              code:item.code,
              prefix:'WTE'
            })
          });
          row.className='flash-upload-progress-row success';
          row.textContent=`${item.code}: importato`;
          imported++;
        }catch(error){
          row.className='flash-upload-progress-row error';
          row.textContent=`${item.code}: ${error.message}`;
          failed++;
        }
      }

      await loadCatalog();
      alert(`Importazione completata. Nuovi: ${imported}, già presenti: ${skipped}, errori: ${failed}.`);
    }catch(error){
      alert(error.message);
    }finally{
      flashSeedImportBtn.disabled=false;
    }
  }

  function categoryOptions(value){
    const categories=[
      'Wedding','Cuori','Fedi','Iniziali','Floreale',
      'Animali','Simboli','Minimal','Altro'
    ];
    if(value&&!categories.includes(value))categories.push(value);
    return categories.map(cat=>`<option ${cat===value?'selected':''}>${cat}</option>`).join('');
  }

  function render(){
    const query=flashCatalogSearch.value.trim().toLowerCase();
    const category=flashCatalogCategoryFilter.value;
    const status=flashCatalogStatusFilter.value;

    const filtered=catalog.filter(item=>{
      const text=[item.code,item.title,item.category,...(item.tags||[])].join(' ').toLowerCase();
      if(query&&!text.includes(query))return false;
      if(category&&item.category!==category)return false;
      if(status==='active'&&!item.active)return false;
      if(status==='inactive'&&item.active)return false;
      return true;
    });

    flashManagerGrid.innerHTML='';

    if(!filtered.length){
      flashManagerGrid.innerHTML='<div class="flash-manager-empty">Nessun flash trovato.</div>';
    }

    filtered.forEach(item=>{
      const card=document.createElement('article');
      card.className=`flash-manager-card ${item.active?'':'inactive'}`;
      card.innerHTML=`
        <img loading="lazy"
             src="/flash/${encodeURIComponent(item.code)}.png"
             data-api-image="${item.image||''}"
             onerror="if(this.dataset.apiImage&&this.src!==this.dataset.apiImage){this.onerror=null;this.src=this.dataset.apiImage+'?v=${encodeURIComponent(item.updated_at||'')}'}"
             alt="${item.code}">
        <div class="flash-manager-card-head">
          <div><strong>${item.code}</strong><span>${item.image_size?Math.round(item.image_size/1024)+' KB':''}</span></div>
          <span>${item.active?'Attivo':'Disattivato'}</span>
        </div>
        <div class="flash-manager-fields">
          <input data-field="code" value="${item.code||''}" placeholder="Codice">
          <input data-field="title" value="${item.title||''}" placeholder="Titolo">
          <select data-field="category">${categoryOptions(item.category)}</select>
          <input data-field="tags" value="${(item.tags||[]).join(', ')}" placeholder="Tag separati da virgola">
        </div>
        <div class="flash-manager-actions">
          <button data-action="save">Salva</button>
          <button data-action="toggle">${item.active?'Disattiva':'Riattiva'}</button>
          <button data-action="delete" class="danger">Elimina</button>
          <button data-action="copy">Copia codice</button>
        </div>`;

      card.querySelector('[data-action="save"]').onclick=async()=>{
        try{
          await request(`/api/flash-catalog/${item.id}`,{
            method:'PATCH',
            body:JSON.stringify({
              code:card.querySelector('[data-field="code"]').value.trim(),
              title:card.querySelector('[data-field="title"]').value.trim(),
              category:card.querySelector('[data-field="category"]').value,
              tags:tags(card.querySelector('[data-field="tags"]').value)
            })
          });
          await loadCatalog();
        }catch(error){alert(error.message)}
      };

      card.querySelector('[data-action="toggle"]').onclick=async()=>{
        try{
          await request(`/api/flash-catalog/${item.id}`,{
            method:'PATCH',
            body:JSON.stringify({active:!item.active})
          });
          await loadCatalog();
        }catch(error){alert(error.message)}
      };

      card.querySelector('[data-action="delete"]').onclick=async()=>{
        if(!confirm(`Eliminare definitivamente ${item.code}?`))return;
        try{
          await request(`/api/flash-catalog/${item.id}`,{method:'DELETE'});
          await loadCatalog();
        }catch(error){alert(error.message)}
      };

      card.querySelector('[data-action="copy"]').onclick=()=>{
        navigator.clipboard?.writeText(item.code);
      };

      flashManagerGrid.appendChild(card);
    });

    const active=catalog.filter(x=>x.active).length;
    flashCatalogTotal.textContent=catalog.length;
    flashCatalogActive.textContent=active;
    flashCatalogInactive.textContent=catalog.length-active;
    flashCatalogCategoriesCount.textContent=new Set(catalog.map(x=>x.category)).size;
  }

  function updateCategoryFilter(){
    const current=flashCatalogCategoryFilter.value;
    const categories=[...new Set(catalog.map(x=>x.category).filter(Boolean))].sort();
    flashCatalogCategoryFilter.innerHTML='<option value="">Tutte le categorie</option>'
      +categories.map(x=>`<option>${x}</option>`).join('');
    flashCatalogCategoryFilter.value=current;
  }

  async function loadCatalog(){
    try{
      const data=await request('/api/flash-catalog');
      catalog=data.items||[];
      updateCategoryFilter();
      render();
    }catch(error){
      flashManagerGrid.innerHTML=`<div class="flash-manager-empty">${error.message}</div>`;
    }
  }

  flashCatalogBtn?.addEventListener('click',()=>{
    flashCatalogModal.classList.add('open');
    document.body.classList.add('lock');
    loadCatalog();
  });

  document.querySelectorAll('[data-close-flash-catalog]').forEach(x=>x.addEventListener('click',()=>{
    flashCatalogModal.classList.remove('open');
    document.body.classList.remove('lock');
  }));

  flashUploadStartBtn?.addEventListener('click',upload);
  flashSeedImportBtn?.addEventListener('click',importSeedCatalog);
  flashCatalogRefreshBtn?.addEventListener('click',loadCatalog);
  flashCatalogSearch?.addEventListener('input',render);
  flashCatalogCategoryFilter?.addEventListener('change',render);
  flashCatalogStatusFilter?.addEventListener('change',render);
  flashUploadPrefix?.addEventListener('input',()=>flashUploadPrefix.value=normalizePrefix(flashUploadPrefix.value));
})();
