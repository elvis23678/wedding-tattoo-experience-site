
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


  function installImageEditor(){
    if(document.getElementById('wteImageEditor'))return;

    const style=document.createElement('style');
    style.textContent=`
      .wte-image-editor{position:fixed;inset:0;z-index:16000;display:none;align-items:center;justify-content:center;padding:7px;background:rgba(0,0,0,.9)}
      .wte-image-editor.open{display:flex}
      .wte-image-editor-card{width:min(560px,100%);max-height:97vh;overflow:auto;padding:12px;border:1px solid rgba(214,170,85,.38);background:#090604;color:#f3eadb}
      .wte-image-editor-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .wte-image-editor-head strong{font-family:Georgia,serif;font-size:22px;font-weight:400}
      .wte-image-editor-head button{width:38px;height:38px;border:1px solid rgba(214,170,85,.28);background:#100d09;color:#fff;font-size:21px}
      .wte-editor-help{margin:8px 0;color:#aa9b85;font-size:10px;line-height:1.4}
      .wte-editor-stage{position:relative;width:100%;aspect-ratio:1/1;overflow:hidden;border:1px solid rgba(214,170,85,.38);background:#fff;touch-action:none}
      .wte-editor-stage canvas{display:block;width:100%;height:100%;margin:0;background:#fff;touch-action:none}
      .wte-editor-crop{position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 2px rgba(211,166,79,.95)}
      .wte-editor-controls{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}
      .wte-editor-controls button,.wte-editor-actions button{min-height:43px;border:1px solid rgba(214,170,85,.25);background:#100d09;color:#eee3d3;font-size:8px;font-weight:800;text-transform:uppercase}
      .wte-editor-zoom{grid-column:1/-1;display:flex;align-items:center;gap:9px;padding:8px;border:1px solid rgba(214,170,85,.18)}
      .wte-editor-zoom span{font-size:8px;text-transform:uppercase;color:#b9a88e}
      .wte-editor-zoom input{flex:1}
      .wte-editor-actions{display:grid;grid-template-columns:1fr 2fr;gap:7px;margin-top:9px}
      .wte-editor-actions .save{border:0;background:linear-gradient(135deg,#f2dfad,#cc9f48,#a87526);color:#171006}`;
    document.head.appendChild(style);

    const modal=document.createElement('div');
    modal.className='wte-image-editor';
    modal.id='wteImageEditor';
    modal.innerHTML=`
      <section class="wte-image-editor-card">
        <header class="wte-image-editor-head">
          <strong>Ritaglia e ruota</strong>
          <button type="button" data-editor-close aria-label="Chiudi">×</button>
        </header>
        <p class="wte-editor-help">Trascina l'immagine per centrarla. Usa zoom e rotazione, poi salva.</p>
        <div class="wte-editor-stage">
          <canvas id="wteEditorCanvas"></canvas>
          <div class="wte-editor-crop"></div>
        </div>
        <div class="wte-editor-controls">
          <button type="button" data-editor-rotate="-90">Ruota sinistra</button>
          <button type="button" data-editor-rotate="90">Ruota destra</button>
          <div class="wte-editor-zoom">
            <span>Zoom</span>
            <input id="wteEditorZoom" type="range" min="1" max="3" step="0.01" value="1">
          </div>
        </div>
        <div class="wte-editor-actions">
          <button type="button" data-editor-cancel>Annulla</button>
          <button type="button" class="save" id="wteEditorSave">Salva immagine</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
  }

  function openImageEditor(file){
    installImageEditor();

    return new Promise((resolve,reject)=>{
      const modal=document.getElementById('wteImageEditor');
      const canvas=document.getElementById('wteEditorCanvas');
      const zoomInput=document.getElementById('wteEditorZoom');
      const saveButton=document.getElementById('wteEditorSave');
      const context=canvas.getContext('2d',{alpha:false});
      const image=new Image();
      const objectUrl=URL.createObjectURL(file);

      let rotation=0,zoom=1,offsetX=0,offsetY=0;
      let dragging=false,lastX=0,lastY=0,finished=false;

      function finish(result,error){
        if(finished)return;
        finished=true;
        URL.revokeObjectURL(objectUrl);
        modal.classList.remove('open');
        saveButton.disabled=false;
        saveButton.textContent='Salva immagine';
        if(error)reject(error);else resolve(result);
      }

      function rotatedDimensions(){
        return Math.abs(rotation/90)%2
          ? {width:image.naturalHeight,height:image.naturalWidth}
          : {width:image.naturalWidth,height:image.naturalHeight};
      }

      function draw(){
        const rect=canvas.getBoundingClientRect();
        const ratio=Math.min(window.devicePixelRatio||1,2);
        const size=Math.max(320,Math.round(rect.width*ratio));
        if(canvas.width!==size||canvas.height!==size){
          canvas.width=size;canvas.height=size;
        }

        context.setTransform(1,0,0,1,0,0);
        context.fillStyle='#fff';
        context.fillRect(0,0,size,size);

        const dimensions=rotatedDimensions();
        const scale=Math.max(size/dimensions.width,size/dimensions.height)*zoom;

        context.save();
        context.translate(size/2+offsetX*ratio,size/2+offsetY*ratio);
        context.rotate(rotation*Math.PI/180);
        context.scale(scale,scale);
        context.drawImage(image,-image.naturalWidth/2,-image.naturalHeight/2);
        context.restore();
      }

      image.onload=()=>{
        rotation=0;zoom=1;offsetX=0;offsetY=0;
        zoomInput.value='1';
        modal.classList.add('open');
        requestAnimationFrame(draw);
      };
      image.onerror=()=>finish(null,new Error('Impossibile leggere l’immagine.'));
      image.src=objectUrl;

      modal.querySelectorAll('[data-editor-rotate]').forEach(button=>{
        button.onclick=()=>{
          rotation=(rotation+Number(button.dataset.editorRotate)+360)%360;
          offsetX=0;offsetY=0;draw();
        };
      });

      zoomInput.oninput=()=>{zoom=Number(zoomInput.value);draw()};

      canvas.onpointerdown=event=>{
        dragging=true;lastX=event.clientX;lastY=event.clientY;
        canvas.setPointerCapture?.(event.pointerId);
      };
      canvas.onpointermove=event=>{
        if(!dragging)return;
        offsetX+=event.clientX-lastX;
        offsetY+=event.clientY-lastY;
        lastX=event.clientX;lastY=event.clientY;
        draw();
      };
      canvas.onpointerup=canvas.onpointercancel=()=>dragging=false;

      modal.querySelector('[data-editor-close]').onclick=()=>finish(null);
      modal.querySelector('[data-editor-cancel]').onclick=()=>finish(null);

      saveButton.onclick=()=>{
        saveButton.disabled=true;
        saveButton.textContent='Elaborazione…';

        try{
          const output=document.createElement('canvas');
          output.width=1200;output.height=1200;
          const oc=output.getContext('2d',{alpha:false});
          oc.fillStyle='#fff';oc.fillRect(0,0,1200,1200);

          const dimensions=rotatedDimensions();
          const scale=Math.max(1200/dimensions.width,1200/dimensions.height)*zoom;
          const conversion=1200/(canvas.getBoundingClientRect().width||1);

          oc.save();
          oc.translate(600+offsetX*conversion,600+offsetY*conversion);
          oc.rotate(rotation*Math.PI/180);
          oc.scale(scale,scale);
          oc.drawImage(image,-image.naturalWidth/2,-image.naturalHeight/2);
          oc.restore();

          let quality=.88;
          let result=output.toDataURL('image/jpeg',quality);
          while(result.length>2400000&&quality>.52){
            quality-=.08;
            result=output.toDataURL('image/jpeg',quality);
          }
          finish(result);
        }catch(error){
          saveButton.disabled=false;
          saveButton.textContent='Salva immagine';
          alert(error.message);
        }
      };
    });
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
        <img loading="lazy" src="${item.image}?v=${encodeURIComponent(item.updated_at||'')}" alt="${item.code}">
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
          <input data-action="image-file" type="file" accept="image/jpeg,image/png,image/webp" hidden>
          <button data-action="replace-image">Sostituisci immagine</button>
          <button data-action="save">Salva</button>
          <button data-action="toggle">${item.active?'Disattiva':'Riattiva'}</button>
          <button data-action="delete" class="danger">Elimina</button>
          <button data-action="copy">Copia codice</button>
        </div>`;

      const imageInput=card.querySelector('[data-action="image-file"]');
      card.querySelector('[data-action="replace-image"]').onclick=()=>imageInput.click();

      imageInput.onchange=async()=>{
        const file=imageInput.files?.[0];
        if(!file)return;
        const replaceButton=card.querySelector('[data-action="replace-image"]');

        try{
          const imageData=await openImageEditor(file);
          if(!imageData)return;

          replaceButton.disabled=true;
          replaceButton.textContent='Salvataggio…';

          await request(`/api/flash-catalog/${item.id}`,{
            method:'PATCH',
            body:JSON.stringify({imageData})
          });

          await loadCatalog();
          alert('Immagine aggiornata.');
        }catch(error){
          alert(error.message);
        }finally{
          replaceButton.disabled=false;
          replaceButton.textContent='Sostituisci immagine';
          imageInput.value='';
        }
      };

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
  flashCatalogRefreshBtn?.addEventListener('click',loadCatalog);
  flashCatalogSearch?.addEventListener('input',render);
  flashCatalogCategoryFilter?.addEventListener('change',render);
  flashCatalogStatusFilter?.addEventListener('change',render);
  flashUploadPrefix?.addEventListener('input',()=>flashUploadPrefix.value=normalizePrefix(flashUploadPrefix.value));
})();
