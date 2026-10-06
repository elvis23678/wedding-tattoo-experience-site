const ORIGIN = 'Via Torino 1A, 10055 Condove, Italia';
export function createEventRouter({apiKey, fetchImpl=fetch}={}) {
  const cache = new Map();
  async function request(path, params) {
    if(!apiKey) throw new Error('Calcolo trasferta non configurato. Contatta lo studio.');
    const url=new URL(`https://api.geoapify.com/v1/${path}`);
    for(const [k,v] of Object.entries({...params,apiKey})) url.searchParams.set(k,v);
    try {
      const response=await fetchImpl(url,{signal:AbortSignal.timeout(10000)});
      if(!response.ok) throw new Error('provider');
      return await response.json();
    } catch { throw new Error('Calcolo trasferta temporaneamente non disponibile. Riprova tra poco.'); }
  }
  async function geocode(text) {
    // Comma-separated Italian street addresses avoid free-text city/county confusion.
    const parts=String(text).split(',').map(p=>p.trim()).filter(Boolean);
    const street=parts[0]?.match(/^(.+?)\s+(\d+\s*[a-zA-Z]?)$/);
    const cityPart=parts[1]?.replace(/\s*\([A-Z]{2}\)\s*$/, '');
    const postcode=cityPart?.match(/^(\d{5})\s+(.+)$/);
    const city=postcode?.[2] || cityPart;
    const structured=street && city && !/^(italia|italy)$/i.test(city);
    const address=structured ? {street:street[1],housenumber:street[2].replace(/\s/g,''),city,
      ...(postcode?{postcode:postcode[1]}:{})} : {text};
    const json=await request('geocode/search',{...address,format:'json',limit:3,lang:'it',filter:'countrycode:it'});
    const normalize=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
    const results=(json.results||[]).filter(r=>!structured || normalize(r.city||r.town||r.village||r.municipality)===normalize(city));
    const result=results[0];
    const hint=(json.results||[]).slice(0,2).map(r=>r.formatted).filter(Boolean).join(' / ');
    if(!result || !Number.isFinite(result.lat) || !Number.isFinite(result.lon) ||
      !['building','street','amenity'].includes(result.result_type) ||
      Number(result.rank?.confidence||0)<0.7)
      throw new Error('Indirizzo non riconosciuto con sufficiente precisione. Inserisci via, numero civico e città.'+(hint?` Risultati: ${hint}`:''));
    const second=results[1];
    if(second && Math.abs(result.rank?.confidence-second.rank?.confidence)<0.02 &&
       Math.hypot(result.lat-second.lat,result.lon-second.lon)>0.01)
      throw new Error(`Indirizzo ambiguo: ${result.formatted} / ${second.formatted}. Specifica anche il CAP.`);
    return result;
  }
  return async function routeFor(location) {
    const key=String(location).trim().toLowerCase();
    const cached=cache.get(key);
    if(cached && cached.expires>Date.now()) return cached.route;
    const originCached=cache.get('__origin');
    const origin=originCached?.route || await geocode(ORIGIN).catch(error=>{throw new Error(`Indirizzo dello studio: ${error.message}`);});
    cache.set('__origin',{route:origin,expires:Infinity});
    const destination=await geocode(location);
    const point=p=>`${p.lat},${p.lon}`;
    const json=await request('routing',{waypoints:[origin,destination,origin].map(point).join('|'),mode:'drive',traffic:'approximated',units:'metric'});
    const p=json.features?.[0]?.properties;
    if(!p || !Number.isFinite(p.distance) || p.distance<0 || !Number.isFinite(p.time) || p.time<0)
      throw new Error('Percorso stradale non disponibile per questa location.');
    const route={roundTripMeters:p.distance,roundTripSeconds:p.time,origin:origin.formatted,
      destination:destination.formatted,provider:'Geoapify',calculatedAt:new Date().toISOString()};
    if(cache.size>250) cache.clear();
    cache.set(key,{route,expires:Date.now()+86400000});
    return route;
  };
}
