// Rates agreed with the owner. All intermediate monetary values are cents.
export function calculateEventPrice({guests, serviceHours, route}) {
  if(!Number.isInteger(guests) || guests<1 || guests>5000)
    throw new Error('Numero invitati non valido');
  if(!Number.isFinite(serviceHours) || serviceHours<=0 || serviceHours>24)
    throw new Error('Ore di servizio non valide');
  const {roundTripMeters, roundTripSeconds}=route||{};
  if(!Number.isFinite(roundTripMeters) || roundTripMeters<0 ||
     !Number.isFinite(roundTripSeconds) || roundTripSeconds<0)
    throw new Error('Percorso stradale verificato necessario');
  const expectedTattoos=Math.ceil(guests/5);
  const assistants=expectedTattoos>20?4:3;
  const setupSeconds=90*60;
  const totalWorkSeconds=serviceHours*3600+roundTripSeconds+setupSeconds;
  const assistantRateCents=totalWorkSeconds<=8*3600?15000:20000;
  const serviceCents=Math.round(serviceHours*10000);
  const travelAndSetupCents=Math.round((roundTripSeconds+setupSeconds)*8000/3600);
  const vehicleCents=Math.round(roundTripMeters*70/1000);
  const materialsCents=expectedTattoos*1500;
  const assistantsCents=assistants*assistantRateCents;
  const costsCents=serviceCents+travelAndSetupCents+vehicleCents+materialsCents+assistantsCents;
  const extraCents=Math.round(costsCents*15/100);
  const netCents=costsCents+extraCents;
  const vatCents=Math.round(netCents*22/100);
  const totalCents=netCents+vatCents;
  const depositCents=Math.round(totalCents*30/100);
  return {expectedTattoos,assistants,assistantRateCents,totalWorkSeconds,
    serviceCents,travelAndSetupCents,vehicleCents,materialsCents,assistantsCents,
    costsCents,extraCents,netCents,vatCents,totalCents,depositCents,
    balanceCents:totalCents-depositCents,route};
}
