
(() => {
  const API_KEY='wte_cloud_api_url_v2';
  const TOKEN_KEY='wte_cloud_token_v4';
  const USER_KEY='wte_current_user_v8';
  const SESSION_TOKEN_KEY='wte_session_token_v8';

  const $=id=>document.getElementById(id);
  const api=()=>String(localStorage.getItem(API_KEY)||'https://wte-cloud-api.onrender.com').replace(/\/+$/,'');
  const token=()=>localStorage.getItem(TOKEN_KEY)||sessionStorage.getItem(SESSION_TOKEN_KEY)||'';

  function saveSession(result,remember){
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    (remember?localStorage:sessionStorage).setItem(
      remember?TOKEN_KEY:SESSION_TOKEN_KEY,
      result.token
    );
    localStorage.setItem(USER_KEY,JSON.stringify(result.user||{}));
  }

  function clearSession(){
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function request(path,options={}){
    const headers={'Content-Type':'application/json',...(options.headers||{})};
    if(token())headers.Authorization=`Bearer ${token()}`;
    const response=await fetch(api()+path,{...options,headers});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||`Errore ${response.status}`);
    return data;
  }

  function permissions(user){
    if(user?.role==='admin'){
      return {
        dashboard:true,practices:true,documents:true,payments:true,flash:true,
        notifications:true,settings:true,users:true,delete_practices:true,
        ...(user.permissions||{})
      };
    }
    return {
      dashboard:true,practices:true,documents:true,payments:true,flash:true,
      notifications:true,settings:false,users:false,delete_practices:false,
      ...(user?.permissions||{})
    };
  }

  function applyPermissions(user){
    const p=permissions(user);
    document.documentElement.dataset.role=user.role||'collaborator';

    $('currentUserName').textContent=user.name||user.email||'Utente';
    $('currentUserRole').textContent=user.role==='admin'?'Admin':'Collaboratrice';

    if($('personalAccountName'))$('personalAccountName').textContent=user.name||'Profilo';
    if($('personalAccountCopy')){
      $('personalAccountCopy').textContent=
        `${user.email||''} · ${user.role==='admin'?'Amministratore':'Collaboratrice'}`;
    }

    const settings=$('settingsBtn');
    if(settings)settings.hidden=!p.settings;

    const usersCard=$('usersSettingsCard');
    if(usersCard)usersCard.hidden=!p.users;

    document.querySelectorAll('[data-admin-only]').forEach(el=>el.hidden=user.role!=='admin');

    if(!p.delete_practices){
      const hideDelete=()=>{
        document.querySelectorAll('#deleteBtn,[data-action="delete"],.danger[data-delete]')
          .forEach(el=>el.hidden=true);
      };
      hideDelete();
      new MutationObserver(hideDelete).observe(document.body,{childList:true,subtree:true});
    }

    window.WTE_CURRENT_USER=user;
    window.WTE_PERMISSIONS=p;
    window.dispatchEvent(new CustomEvent('wte:user-ready',{detail:{user,permissions:p}}));
  }

  function showLogin(message=''){
    document.body.classList.add('account-locked');
    $('accountLogin').classList.remove('hidden');
    $('accountLoginError').textContent=message;
    setTimeout(()=>$('accountEmail')?.focus(),100);
  }

  function hideLogin(){
    document.body.classList.remove('account-locked');
    $('accountLogin').classList.add('hidden');
  }

  function requirePasswordChange(){
    $('accountPasswordModal').classList.add('open');
    $('accountPasswordModal').setAttribute('aria-hidden','false');
    document.body.classList.add('account-locked');
  }

  async function validate(){
    if(!token())return showLogin();
    try{
      const data=await request('/api/auth/me');
      localStorage.setItem(USER_KEY,JSON.stringify(data.user));
      applyPermissions(data.user);
      hideLogin();
      if(data.user.mustChangePassword)requirePasswordChange();
    }catch(error){
      clearSession();
      showLogin('La sessione è scaduta. Accedi nuovamente.');
    }
  }

  $('accountLoginForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    $('accountLoginError').textContent='Accesso in corso…';
    try{
      const result=await request('/api/auth/login',{
        method:'POST',
        body:JSON.stringify({
          email:$('accountEmail').value.trim(),
          password:$('accountPassword').value
        })
      });
      saveSession(result,$('accountRemember').checked);
      $('accountPassword').value='';
      applyPermissions(result.user);
      hideLogin();
      if(result.user.mustChangePassword)requirePasswordChange();
      window.dispatchEvent(new CustomEvent('wte:auth-login'));
    }catch(error){
      $('accountLoginError').textContent=error.message;
    }
  });

  $('accountPasswordForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const current=$('accountCurrentPassword').value;
    const next=$('accountNewPassword').value;
    const confirm=$('accountConfirmPassword').value;
    const error=$('accountPasswordError');
    error.textContent='';

    if(next.length<8)return error.textContent='Usa almeno 8 caratteri.';
    if(next!==confirm)return error.textContent='Le nuove password non coincidono.';

    try{
      await request('/api/auth/change-password',{
        method:'POST',
        body:JSON.stringify({currentPassword:current,newPassword:next})
      });
      $('accountPasswordModal').classList.remove('open');
      $('accountPasswordModal').setAttribute('aria-hidden','true');
      document.body.classList.remove('account-locked');
      ['accountCurrentPassword','accountNewPassword','accountConfirmPassword']
        .forEach(id=>$(id).value='');
      alert('Password aggiornata.');
      await validate();
    }catch(e){error.textContent=e.message}
  });

  $('personalChangePasswordBtn')?.addEventListener('click',()=>{
    $('accountPasswordModal').classList.add('open');
    $('accountPasswordModal').setAttribute('aria-hidden','false');
  });

  // Sostituisce il vecchio logout PIN.
  $('adminLogout')?.addEventListener('click',event=>{
    event.preventDefault();
    event.stopImmediatePropagation();
    clearSession();
    location.reload();
  },true);

  // Disattiva il vecchio lock PIN.
  const legacyLock=$('adminLock');
  if(legacyLock)legacyLock.remove();

  validate();
})();
