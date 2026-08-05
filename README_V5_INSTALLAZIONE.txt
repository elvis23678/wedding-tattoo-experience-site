WEDDING TATTOO EXPERIENCE — V5 STABLE

PACCHETTO COMPLETO
Questo ZIP contiene l’intero repository, non una patch.

INSTALLAZIONE SU GITHUB
1. Apri il repository wedding-tattoo-experience-site.
2. Carica e sostituisci tutti i file e le cartelle contenuti nella cartella principale dello ZIP.
3. Conferma con Commit changes.
4. Attendi il deploy automatico dei due siti statici.
5. Su Render apri wte-cloud-api > Manual Deploy > Deploy latest commit.

PRIMA CONFIGURAZIONE
Admin > Impostazioni:
- URL Cloud: https://wte-cloud-api.onrender.com
- password Admin Cloud
- Mantieni automaticamente collegato: attivo
- intestatario, IBAN, PayPal e percentuale acconto

FUNZIONI V5
- Cloud persistente con token valido 30 giorni
- sincronizzazione automatica ogni 30 secondi mentre il CRM è aperto
- prezzo pacchetti interpretato correttamente (es. 1.090,00 €)
- acconto automatico, predefinito 30%
- scadenza acconto a 7 giorni dalla conferma
- saldo 7 giorni prima del matrimonio
- richiesta acconto visibile nella pratica e pronta per WhatsApp
- registrazione acconto e saldo
- avvisi saldo a 14, 10 e 7 giorni
- sospensione evento per saldo mancante
- clausola contrattuale aggiornata

LIMITAZIONE
WhatsApp viene aperto con il messaggio già compilato. L’invio autonomo a sito chiuso richiede WhatsApp Business API e credenziali Meta. Gli avvisi automatici del browser vengono elaborati quando il CRM è aperto; per notifiche server anche a sito chiuso servirà uno scheduler backend.
