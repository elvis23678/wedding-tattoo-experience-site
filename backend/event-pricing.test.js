import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateEventPrice as price} from './event-pricing.js';
import {createEventRouter} from './event-route.js';
test('staff thresholds use guests and total work including setup and travel',()=>{
 const route={roundTripMeters:100000,roundTripSeconds:3600};
 const a=price({guests:100,serviceHours:5.5,route});
 assert.equal(a.expectedTattoos,20);assert.equal(a.assistants,3);assert.equal(a.assistantRateCents,15000);
 const b=price({guests:101,serviceHours:5.5,route:{...route,roundTripSeconds:3601}});
 assert.equal(b.expectedTattoos,21);assert.equal(b.assistants,4);assert.equal(b.assistantRateCents,20000);
});
test('agreed example totals and rounding',()=>{
 const p=price({guests:150,serviceHours:8,route:{roundTripMeters:100000,roundTripSeconds:7200}});
 assert.equal(p.costsCents,240000);assert.equal(p.totalCents,336720);
 assert.equal(p.depositCents,101016);assert.equal(p.balanceCents,235704);
 assert.throws(()=>price({guests:150,serviceHours:8}));
});
test('route uses three waypoints and provider totals; secrets stay out of output',async()=>{
 let count=0;
 const router=createEventRouter({apiKey:'secret',fetchImpl:async url=>{
 count++;assert.equal(url.searchParams.get('apiKey'),'secret');
 if(url.pathname.endsWith('/search'))return {ok:true,json:async()=>({results:[{lat:45,lon:7,formatted:'Via test',result_type:'building',rank:{confidence:1}}]})};
 assert.equal(url.searchParams.get('waypoints').split('|').length,3);
 return {ok:true,json:async()=>({features:[{properties:{distance:100000,time:7200}}]})};
 }});
 const r=await router('Test route address');assert.equal(r.roundTripMeters,100000);assert.equal(r.roundTripSeconds,7200);
 assert.ok(!JSON.stringify(r).includes('secret'));await router('Test route address');assert.equal(count,3);
});
test('missing key fails without estimating a distance',async()=>{
 await assert.rejects(createEventRouter({})('Other address'),/non configurato/);
});
