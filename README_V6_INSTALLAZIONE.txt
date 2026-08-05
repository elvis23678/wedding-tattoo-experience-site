WTE V6 COMPLETA

NOVITA
- Utenti Admin e Collaboratrice
- Registro attività backend
- Centro notifiche e popup mentre il CRM è aperto
- Sessione personale per selezione massimo 50 flash
- Firma cliente
- Pagina stampabile/PDF
- Manuale collaboratrice PDF

INSTALLAZIONE
Caricare l'intero progetto come per la V5.
Dopo il commit:
1. Render > wte-cloud-api > Manual Deploy > Deploy latest commit.
2. Attendere deploy di wte-admin e sito clienti.
3. Admin > Impostazioni > Collaboratori: creare l'utente.
4. Inserire le immagini reali in flash/images e compilare flash/catalog.json.

LIMITI ATTUALI
- Nel progetto fornito non erano presenti immagini flash: il catalogo è predisposto ma vuoto.
- I popup funzionano quando il CRM è aperto. Le notifiche push a sito completamente chiuso richiedono VAPID/Web Push o un servizio esterno.
- I PDF flash vengono prodotti tramite Stampa/PDF del browser.
