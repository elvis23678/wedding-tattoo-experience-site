
(() => {
  const REQUEST_KEY = 'wte_requests_v1';
  const API_KEY = 'wte_cloud_api_url_v2';
  const TOKEN_KEY = 'wte_cloud_token_v4';
  const REMEMBER_KEY = 'wte_cloud_remember_v4';
  const LAST_SYNC_KEY = 'wte_cloud_last_sync_v2';
  const DEVICE_KEY = 'wte_cloud_device_v2';

  let syncing = false;
  let debounceTimer = null;
  let applyingRemote = false;

  const apiInput = document.getElementById('cloudApiUrl');
  const passwordInput = document.getElementById('cloudPassword');
  const connectBtn = document.getElementById('cloudConnectBtn');
  const syncBtn = document.getElementById('cloudSyncBtn');
  const statusBox = document.getElementById('cloudStatus');
  const topStatus = document.getElementById('cloudTopStatus');

  function normalizeUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function getApi() {
    return normalizeUrl(localStorage.getItem(API_KEY) || 'https://wte-cloud-api.onrender.com');
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem('wte_session_token_v8') || sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `DEV-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function loadLocal() {
    try {
      const value = JSON.parse(localStorage.getItem(REQUEST_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function setStatus(type, text) {
    if (statusBox) {
      statusBox.className = `cloud-status ${type}`;
      statusBox.querySelector('span').textContent = text;
    }

    if (topStatus) {
      topStatus.className = `cloud-top-status ${type}`;
      topStatus.textContent =
        type === 'online' ? 'Cloud' :
        type === 'syncing' ? 'Sync…' :
        type === 'error' ? 'Offline' : 'Cloud non connesso';
    }
  }

  async function request(path, options = {}) {
    const api = getApi();
    if (!api) throw new Error('Backend non configurato');

    const headers = {
      'Content-Type': 'application/json',
      'X-WTE-Device': getDeviceId(),
      ...(options.headers || {})
    };

    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${api}${path}`, {
      ...options,
      headers
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || `Errore server ${response.status}`);
    }

    return payload;
  }

  async function login() {
    const api = normalizeUrl(apiInput?.value);
    const password = passwordInput?.value || '';
    const email = window.WTE_CURRENT_USER?.role === 'admin'
      ? ''
      : (window.WTE_CURRENT_USER?.email || '');

    if (!api) {
      alert('Inserisci URL del backend.');
      return;
    }

    if (!password && getToken()) {
      setStatus('online','Cloud connesso');
      return syncNow({preferRemote:true});
    }

    if (!password) {
      alert('Inserisci la password per riconnettere il Cloud.');
      return;
    }

    localStorage.setItem(API_KEY, api);
    setStatus('syncing', 'Connessione in corso…');

    try {
      const result = await request('/api/auth/login', {
        method:'POST',
        body:JSON.stringify({email,password})
      });

      const remember = document.getElementById('cloudRememberConnection')?.checked !== false;
      localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, result.token);
      passwordInput.value = '';
      setStatus('online', 'Cloud connesso');
      await syncNow({preferRemote:true});
    } catch (error) {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      setStatus('error', error.message);
      alert(error.message);
    }
  }

  function mergePractices(localItems, remoteItems) {
    const map = new Map();

    [...localItems, ...remoteItems].forEach(item => {
      if (!item?.id) return;

      const existing = map.get(item.id);
      if (!existing) {
        map.set(item.id, item);
        return;
      }

      const oldTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
      const newTime = new Date(item.updatedAt || item.createdAt || 0).getTime();

      if (newTime >= oldTime) map.set(item.id, item);
    });

    return [...map.values()].sort((a,b) =>
      new Date(b.updatedAt || b.createdAt || 0) -
      new Date(a.updatedAt || a.createdAt || 0)
    );
  }

  async function syncNow({preferRemote = false} = {}) {
    if (syncing || !getToken() || !getApi()) return;

    syncing = true;
    setStatus('syncing', 'Sincronizzazione…');

    try {
      const remote = await request('/api/practices');
      const local = loadLocal();
      const remoteItems = Array.isArray(remote.practices) ? remote.practices : [];
      const merged = preferRemote
        ? remoteItems
        : mergePractices(local, remoteItems);

      await request('/api/practices/sync', {
        method:'POST',
        body:JSON.stringify({practices:merged})
      });

      applyingRemote = true;
      localStorage.setItem(REQUEST_KEY, JSON.stringify(merged));
      applyingRemote = false;

      localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
      document.getElementById('refreshBtn')?.click();
      window.dispatchEvent(new CustomEvent('wte:cloud-synced',{detail:{count:merged.length}}));
      setStatus('online', `Sincronizzato · ${merged.length} pratiche`);
    } catch (error) {
      setStatus('error', error.message);
    } finally {
      syncing = false;
    }
  }

  function scheduleSync() {
    if (applyingRemote || !getToken()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => syncNow(), 1200);
  }

  connectBtn?.addEventListener('click', login);
  syncBtn?.addEventListener('click', () => syncNow());

  if (apiInput) apiInput.value = getApi();
  const rememberInput = document.getElementById('cloudRememberConnection');
  if (rememberInput) rememberInput.checked = localStorage.getItem(REMEMBER_KEY) !== '0';

  window.addEventListener('storage', event => {
    if (event.key === REQUEST_KEY) scheduleSync();
  });

  const originalSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, value) {
    originalSetItem(key, value);
    if (key === REQUEST_KEY) scheduleSync();
  };

  if (getApi() && getToken()) {
    setStatus('online', 'Cloud connesso');
    syncNow({preferRemote:true});
  } else {
    setStatus('local', 'Cloud non connesso');
  }

  // Periodic sync while Admin is open.
  setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
  }, 30000);
})();
