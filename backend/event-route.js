const cache = new Map();
const ORIGIN = 'Via Torino 1A, 10055 Condove, Italia';
export function createEventRouter({apiKey, fetchImpl=fetch}={}) {
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
    const json=await request('geocode/search',{text,format:'json',limit:2,lang:'it',filter:'countrycode:it'});
    const result=json.results?.[0];
    if(!result || !Number.isFinite(result.lat) || !Number.isFinite(result.lon) ||
      !['building','street','amenity'].includes(result.result_type) ||
      Number(result.rank?.confidence||0)<0.7)
      throw new Error('Inserisci l’indirizzo completo della location: via, numero civico e città.');
    const second=json.results?.[1];
    if(second && Math.abs(result.rank?.confidence-second.rank?.confidence)<0.02 &&
       Math.hypot(result.lat-second.lat,result.lon-second.lon)>0.01)
      throw new Error('Location ambigua: specifica via, numero civico e città.');
    return result;
  }
  return async function routeFor(location) {
    const key=String(location).trim().toLowerCase();
    const cached=cache.get(key);
    if(cached && cached.expires>Date.now()) return cached.route;
    const originCached=cache.get('__origin');
    const origin=originCached?.route || await geocode(ORIGIN);
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
