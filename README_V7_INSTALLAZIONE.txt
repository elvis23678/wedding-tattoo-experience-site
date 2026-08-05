WTE V7 — GESTIONE CATALOGO FLASH

NUOVE FUNZIONI
- Pulsante Catalogo Flash nell'Admin
- Caricamento multiplo da telefono
- Compressione automatica immagini
- Codice progressivo automatico
- Categoria e tag
- Ricerca e filtri
- Modifica, disattivazione, riattivazione, eliminazione
- Catalogo salvato nel database Cloud
- Flash immediatamente visibili nella pagina cliente
- Admin e Collaboratrice possono caricare/modificare
- Solo Admin può eliminare definitivamente

INSTALLAZIONE
1. Caricare l'intero progetto come per V5/V6.
2. Render > wte-cloud-api > Manual Deploy > Deploy latest commit.
3. Attendere deploy di wte-admin e sito clienti.
4. Admin > Catalogo Flash.
5. Selezionare immagini e premere Carica nel Cloud.

ARCHIVIAZIONE
Le immagini vengono compresse nel browser e salvate nel database PostgreSQL.
Questa soluzione è semplice e immediata. Per cataloghi molto grandi (centinaia o
migliaia di immagini ad alta risoluzione) sarà opportuno migrare le immagini su
Cloudinary, S3 o storage equivalente, mantenendo i metadati nel database.
