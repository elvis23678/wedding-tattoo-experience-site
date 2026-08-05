
(() => {
  const API='https://wte-cloud-api.onrender.com';
  const $=id=>document.getElementById(id);
  const token=()=>localStorage.getItem('wte_cloud_token_v4')
    ||sessionStorage.getItem('wte_session_token_v8')
    ||'';

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

  const permissionLabels={
    dashboard:'Dashboard',
    practices:'Pratiche',
    documents:'Documenti',
    payments:'Pagamenti',
    flash:'Catalogo flash',
    notifications:'Notifiche',
    settings:'Impostazioni',
    users:'Gestione utenti',
    delete_practices:'Eliminazione pratiche'
  };

  function fmt(value){
    if(!value)return'Mai';
    return new Date(value).toLocaleString('it-IT');
  }

  function permissionEditor(user,row){
    const wrap=document.createElement('div');
    wrap.className='permission-editor';
    const current=user.permissions||{};

    Object.entries(permissionLabels).forEach(([key,label])=>{
      const item=document.createElement('label');
      item.innerHTML=`<input type="checkbox" data-permission="${key}" ${current[key]?'checked':''}> ${label}`;
      wrap.appendChild(item);
    });

    const save=document.createElement('button');
    save.type='button';
    save.textContent='Salva permessi';
    save.onclick=async()=>{
      const permissions={};
      wrap.querySelectorAll('[data-permission]').forEach(input=>{
        permissions[input.dataset.permission]=input.checked;
      });
      try{
        await request(`/api/users/${user.id}`,{
          method:'PATCH',
          body:JSON.stringify({permissions})
        });
        alert('Permessi aggiornati.');
        loadUsers();
      }catch(e){alert(e.message)}
    };
    wrap.appendChild(save);
    row.appendChild(wrap);
  }

  async function loadUsers(){
    const wrap=$('usersList');
    if(!wrap)return;
    try{
      const data=await request('/api/users');
      wrap.innerHTML='';

      data.users.forEach(user=>{
        const row=document.createElement('article');
        row.className='user-row-v8';
        row.innerHTML=`
          <header>
            <div>
              <strong>${user.name}</strong>
              <span>${user.email}</span>
            </div>
            <b class="${user.enabled?'active':'disabled'}">${user.enabled?'Attivo':'Disabilitato'}</b>
          </header>
          <div class="user-meta-v8">
            <span>Ruolo: ${user.role==='admin'?'Admin':'Collaboratrice'}</span>
            <span>Ultimo accesso: ${fmt(user.last_login_at)}</span>
            <span>IP: ${user.last_login_ip||'—'}</span>
            <span>Password: ${user.must_change_password?'Da cambiare':'Personale'}</span>
          </div>
          <div class="user-actions-v8">
            <button data-action="toggle">${user.enabled?'Disabilita':'Riattiva'}</button>
            <button data-action="reset">Reimposta password</button>
            <button data-action="permissions">Permessi</button>
            <button data-action="delete" class="danger">Elimina</button>
          </div>`;

        row.querySelector('[data-action="toggle"]').onclick=async()=>{
          try{
            await request(`/api/users/${user.id}`,{
              method:'PATCH',
              body:JSON.stringify({enabled:!user.enabled})
            });
            loadUsers();
          }catch(e){alert(e.message)}
        };

        row.querySelector('[data-action="reset"]').onclick=async()=>{
          const temporary=prompt(
            `Inserisci una nuova password temporanea per ${user.name} (almeno 8 caratteri):`
          );
          if(temporary===null)return;
          if(temporary.length<8)return alert('La password deve contenere almeno 8 caratteri.');
          try{
            await request(`/api/users/${user.id}`,{
              method:'PATCH',
              body:JSON.stringify({password:temporary,mustChangePassword:true})
            });
            await navigator.clipboard?.writeText(
              `Accesso Wedding Tattoo Experience\nEmail: ${user.email}\nPassword temporanea: ${temporary}\nLink: https://admin.weddingtattooexperience.it`
            );
            alert('Password reimpostata. Credenziali copiate negli appunti.');
            loadUsers();
          }catch(e){alert(e.message)}
        };

        row.querySelector('[data-action="permissions"]').onclick=()=>{
          const old=row.querySelector('.permission-editor');
          if(old)return old.remove();
          permissionEditor(user,row);
        };

        row.querySelector('[data-action="delete"]').onclick=async()=>{
          if(!confirm(`Eliminare definitivamente l'account di ${user.name}?`))return;
          try{
            await request(`/api/users/${user.id}`,{method:'DELETE'});
            loadUsers();
          }catch(e){alert(e.message)}
        };

        wrap.appendChild(row);
      });
    }catch(e){
      wrap.innerHTML=`<small>${e.message}</small>`;
    }
  }

  async function loadHistory(){
    const wrap=$('loginHistoryList');
    if(!wrap)return;
    try{
      const data=await request('/api/auth/login-history');
      wrap.innerHTML='';
      data.logins.slice(0,30).forEach(login=>{
        const row=document.createElement('div');
        row.className=`login-history-row ${login.success?'success':'failed'}`;
        row.innerHTML=`
          <strong>${login.name||login.email||'Accesso'}</strong>
          <span>${login.success?'Riuscito':'Fallito'} · ${fmt(login.created_at)}</span>
          <span>${login.ip_address||'IP non disponibile'}</span>`;
        wrap.appendChild(row);
      });
    }catch(e){
      wrap.innerHTML=`<small>${e.message}</small>`;
    }
  }

  $('createUserBtn')?.addEventListener('click',async()=>{
    const name=$('newUserName').value.trim();
    const email=$('newUserEmail').value.trim();
    const password=$('newUserPassword').value;
    const role=$('newUserRole').value;

    if(!name||!email||password.length<8){
      return alert('Inserisci nome, email e una password temporanea di almeno 8 caratteri.');
    }

    try{
      await request('/api/users',{
        method:'POST',
        body:JSON.stringify({name,email,password,role})
      });

      const copy=
`Accesso Wedding Tattoo Experience
Email: ${email}
Password temporanea: ${password}
Link: https://admin.weddingtattooexperience.it

Al primo accesso dovrai creare una nuova password.`;

      await navigator.clipboard?.writeText(copy);
      $('newUserName').value='';
      $('newUserEmail').value='';
      $('newUserPassword').value='';
      alert('Utente creato. Le credenziali sono state copiate negli appunti.');
      loadUsers();
      loadHistory();
    }catch(e){alert(e.message)}
  });

  $('settingsBtn')?.addEventListener('click',()=>{
    setTimeout(()=>{loadUsers();loadHistory()},200);
  });

  window.addEventListener('wte:user-ready',event=>{
    if(event.detail?.user?.role==='admin'){
      loadUsers();
      loadHistory();
    }
  });
})();
