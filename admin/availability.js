
(() => {
  const REQUEST_KEY='wte_requests_v1';
  const BLOCKED_KEY='wte_blocked_dates_v2';
  const NOTES_KEY='wte_date_notes_v2';

  let selectedDate=null;

  const loadJson=(key,fallback)=>{
    try{
      const d=JSON.parse(localStorage.getItem(key)||'null');
      return d??fallback;
    }catch{return fallback}
  };

  const loadItems=()=>{
    const d=loadJson(REQUEST_KEY,[]);
    return Array.isArray(d)?d:[];
  };

  const loadBlocked=()=>{
    const d=loadJson(BLOCKED_KEY,[]);
    return Array.isArray(d)?d:[];
  };

  const loadNotes=()=>{
    const d=loadJson(NOTES_KEY,{});
    return d&&typeof d==='object'&&!Array.isArray(d)?d:{};
  };

  const saveBlocked=v=>localStorage.setItem(BLOCKED_KEY,JSON.stringify([...new Set(v)].sort()));
  const saveNotes=v=>localStorage.setItem(NOTES_KEY,JSON.stringify(v));

  function isoDate(date){
    const y=date.getFullYear();
    const m=String(date.getMonth()+1).padStart(2,'0');
    const d=String(date.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }

  function dateLabel(value){
    const d=new Date(value+'T00:00:00');
    return Number.isNaN(d.getTime())
      ?'—'
      :d.toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  }

  function eventDate(item){
    return String(item.date||'').slice(0,10);
  }

  function activeItem(item){
    return !['Annullato','Annullata','Archiviato','Archiviata'].includes(item.status);
  }

  function eventsByDate(){
    const map=new Map();
    loadItems().filter(activeItem).forEach(item=>{
      const date=eventDate(item);
      if(!date)return;
      if(!map.has(date))map.set(date,[]);
      map.get(date).push(item);
    });
    return map;
  }

  function conflicts(){
    const result=[];
    const map=eventsByDate();
    const blocked=new Set(loadBlocked());

    map.forEach((items,date)=>{
      if(items.length>1){
        result.push({
          date,
          type:'double',
          title:`${items.length} pratiche nella stessa data`,
          items
        });
      }

      if(blocked.has(date)){
        result.push({
          date,
          type:'blocked',
          title:'Evento su data bloccata',
          items
        });
      }
    });

    return result.sort((a,b)=>a.date.localeCompare(b.date));
  }

  function patchCalendar(){
    const cells=document.querySelectorAll('.calendar-day');
    if(!cells.length)return;

    const blocked=new Set(loadBlocked());
    const notes=loadNotes();
    const map=eventsByDate();
    const conflictDates=new Set(conflicts().map(x=>x.date));

    cells.forEach(cell=>{
      cell.classList.remove('availability-blocked','availability-conflict','availability-free');
      cell.querySelector('.calendar-day-note')?.remove();

      const raw=cell.dataset.date || cell.getAttribute('data-date');
      if(!raw)return;

      if(conflictDates.has(raw)){
        cell.classList.add('availability-conflict');
      }else if(blocked.has(raw)){
        cell.classList.add('availability-blocked');
      }else if(!map.has(raw)){
        cell.classList.add('availability-free');
      }

      if(notes[raw]){
        const label=document.createElement('span');
        label.className='calendar-day-note';
        label.textContent='Nota';
        cell.appendChild(label);
      }

      if(!cell.dataset.availabilityBound){
        cell.dataset.availabilityBound='1';
        cell.addEventListener('contextmenu',event=>{
          event.preventDefault();
          openDay(raw);
        });
        cell.addEventListener('dblclick',()=>openDay(raw));
      }
    });

    refreshKpis();
  }

  function refreshKpis(){
    const now=new Date();
    const month=now.getMonth();
    const year=now.getFullYear();
    const map=eventsByDate();
    const blocked=loadBlocked();
    const allConflicts=conflicts();

    let monthEvents=0;
    let next7=0;
    const today=new Date();
    today.setHours(0,0,0,0);

    map.forEach((items,date)=>{
      const d=new Date(date+'T00:00:00');
      if(d.getMonth()===month && d.getFullYear()===year)monthEvents+=items.length;

      const diff=Math.round((d-today)/(1000*60*60*24));
      if(diff>=0 && diff<=7)next7+=items.length;
    });

    document.getElementById('availabilityMonthEvents').textContent=monthEvents;
    document.getElementById('availabilityBlockedCount').textContent=blocked.length;
    document.getElementById('availabilityConflictCount').textContent=allConflicts.length;
    document.getElementById('availabilityNext7').textContent=next7;
  }

  function openDay(date){
    selectedDate=date;
    const blocked=loadBlocked();
    const isBlocked=blocked.includes(date);
    const notes=loadNotes();
    const items=eventsByDate().get(date)||[];

    availabilityDayTitle.textContent=dateLabel(date);

    if(items.length>1){
      availabilityDayStatus.textContent=`Attenzione: ${items.length} pratiche presenti nella stessa data.`;
    }else if(items.length===1 && isBlocked){
      availabilityDayStatus.textContent='Conflitto: la data è bloccata ma contiene una pratica.';
    }else if(items.length===1){
      availabilityDayStatus.textContent='Data occupata da una pratica.';
    }else if(isBlocked){
      availabilityDayStatus.textContent='Data bloccata manualmente.';
    }else{
      availabilityDayStatus.textContent='Data disponibile.';
    }

    availabilityDayEvents.innerHTML='';

    if(!items.length){
      availabilityDayEvents.innerHTML='<div class="availability-empty">Nessuna pratica in questa data.</div>';
    }else{
      items.forEach(item=>{
        const card=document.createElement('article');
        card.className='availability-event-card';
        card.innerHTML=`
          <strong>${item.name||'Cliente senza nome'}</strong>
          <span>${item.location||'Location da definire'} · ${item.package||'Pacchetto da definire'}</span>
          <span>Stato: ${item.status||'Nuova richiesta'}</span>
        `;
        card.addEventListener('click',()=>{
          document.getElementById('searchInput').value=item.id;
          document.getElementById('refreshBtn')?.click();
          closeDay();
        });
        availabilityDayEvents.appendChild(card);
      });
    }

    availabilityDayNote.value=notes[date]||'';
    availabilityToggleBlockBtn.textContent=isBlocked?'Sblocca data':'Blocca data';
    availabilityToggleBlockBtn.classList.toggle('block',!isBlocked);
    availabilityToggleBlockBtn.classList.toggle('unblock',isBlocked);

    availabilityDayModal.classList.add('open');
    document.body.classList.add('lock');
  }

  function closeDay(){
    availabilityDayModal.classList.remove('open');
    document.body.classList.remove('lock');
    selectedDate=null;
  }

  function renderConflicts(){
    const list=conflicts();
    availabilityConflictsList.innerHTML='';

    if(!list.length){
      availabilityConflictsList.innerHTML='<div class="availability-empty">Nessun conflitto rilevato.</div>';
      return;
    }

    list.forEach(conflict=>{
      const card=document.createElement('article');
      card.className='availability-conflict-card';
      card.innerHTML=`
        <strong>${dateLabel(conflict.date)}</strong>
        <span>${conflict.title}</span>
        <span>${conflict.items.map(x=>x.name||x.id).join(' · ')}</span>
      `;
      card.addEventListener('click',()=>{
        availabilityConflictsModal.classList.remove('open');
        openDay(conflict.date);
      });
      availabilityConflictsList.appendChild(card);
    });
  }

  availabilityTodayBtn?.addEventListener('click',()=>{
    document.getElementById('calendarToday')?.click();
    setTimeout(patchCalendar,100);
  });

  availabilityBlockedBtn?.addEventListener('click',()=>{
    const blocked=loadBlocked();
    if(!blocked.length){
      alert('Nessuna data bloccata.');
      return;
    }
    openDay(blocked[0]);
  });

  availabilityConflictsBtn?.addEventListener('click',()=>{
    renderConflicts();
    availabilityConflictsModal.classList.add('open');
    document.body.classList.add('lock');
  });

  availabilityToggleBlockBtn?.addEventListener('click',()=>{
    if(!selectedDate)return;

    const blocked=loadBlocked();
    const index=blocked.indexOf(selectedDate);

    if(index>=0)blocked.splice(index,1);
    else blocked.push(selectedDate);

    saveBlocked(blocked);
    openDay(selectedDate);
    patchCalendar();
  });

  availabilitySaveNoteBtn?.addEventListener('click',()=>{
    if(!selectedDate)return;

    const notes=loadNotes();
    const value=availabilityDayNote.value.trim();

    if(value)notes[selectedDate]=value;
    else delete notes[selectedDate];

    saveNotes(notes);
    patchCalendar();
    alert('Nota salvata.');
  });

  document.querySelectorAll('[data-close-availability-day]').forEach(x=>x.addEventListener('click',closeDay));
  document.querySelectorAll('[data-close-conflicts]').forEach(x=>x.addEventListener('click',()=>{
    availabilityConflictsModal.classList.remove('open');
    document.body.classList.remove('lock');
  }));

  document.getElementById('calendarPrev')?.addEventListener('click',()=>setTimeout(patchCalendar,100));
  document.getElementById('calendarNext')?.addEventListener('click',()=>setTimeout(patchCalendar,100));
  document.getElementById('calendarToday')?.addEventListener('click',()=>setTimeout(patchCalendar,100));
  document.getElementById('refreshBtn')?.addEventListener('click',()=>setTimeout(patchCalendar,100));

  const observer=new MutationObserver(()=>patchCalendar());
  const grid=document.getElementById('calendarGrid');
  if(grid)observer.observe(grid,{childList:true,subtree:true});

  window.addEventListener('storage',event=>{
    if([REQUEST_KEY,BLOCKED_KEY,NOTES_KEY].includes(event.key))patchCalendar();
  });

  setTimeout(patchCalendar,300);
})();
