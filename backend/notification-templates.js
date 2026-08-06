
function euro(cents = 0) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR'
  }).format(Number(cents || 0) / 100);
}

function date(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString('it-IT');
  } catch {
    return String(value);
  }
}

function safe(value = '') {
  return String(value || '').trim();
}

export const NOTIFICATION_TYPES = Object.freeze([
  'contract_ready',
  'contract_accepted',
  'deposit_due',
  'deposit_paid',
  'guest_qr_ready',
  'guest_selection_closing',
  'guest_selection_closed',
  'flash_pdf_ready',
  'balance_reminder_30',
  'balance_due_7',
  'balance_paid',
  'event_ready',
  'event_tomorrow',
  'event_completed',
  'workflow_exception'
]);

export function renderNotification(type, context = {}) {
  const customer = safe(context.customerName || context.name || 'Cliente');
  const practiceId = safe(context.practiceId || '');
  const eventDate = date(context.eventDate);
  const paymentUrl = safe(context.paymentUrl || '');
  const coupleUrl = safe(context.coupleUrl || '');
  const guestUrl = safe(context.guestUrl || '');
  const contractUrl = safe(context.contractUrl || '');
  const pdfUrl = safe(context.pdfUrl || '');
  const deposit = euro(context.depositCents || 0);
  const balance = euro(context.balanceCents || 0);

  const templates = {
    contract_ready: {
      subject: 'La tua proposta Wedding Tattoo Experience',
      body:
        `Ciao ${customer}, la proposta è pronta. ` +
        `Puoi leggere la bozza del contratto qui: ${contractUrl}`
    },

    contract_accepted: {
      subject: 'Contratto accettato',
      body:
        `Ciao ${customer}, il contratto è stato registrato correttamente. ` +
        (paymentUrl
          ? `Puoi completare l’acconto qui: ${paymentUrl}`
          : 'Riceverai a breve le istruzioni per l’acconto.')
    },

    deposit_due: {
      subject: 'Acconto da completare',
      body:
        `Ciao ${customer}, per confermare la data del matrimonio ` +
        `è necessario completare l’acconto di ${deposit}. ` +
        (paymentUrl ? `Pagamento: ${paymentUrl}` : '')
    },

    deposit_paid: {
      subject: 'Acconto ricevuto',
      body:
        `Ciao ${customer}, l’acconto è stato registrato. ` +
        `La prenotazione è ora confermata. ` +
        (coupleUrl ? `Area Sposi: ${coupleUrl}` : '')
    },

    guest_qr_ready: {
      subject: 'QR invitati pronto',
      body:
        `Ciao ${customer}, il catalogo invitati è pronto. ` +
        `Condividi questo link o il relativo QR con gli invitati: ${guestUrl}`
    },

    guest_selection_closing: {
      subject: 'La selezione flash sta per chiudersi',
      body:
        `Ciao ${customer}, la raccolta delle preferenze degli invitati ` +
        `si chiuderà presto. ` +
        (guestUrl ? `Catalogo: ${guestUrl}` : '')
    },

    guest_selection_closed: {
      subject: 'Selezione invitati conclusa',
      body:
        `Ciao ${customer}, la selezione dei flash è stata chiusa automaticamente.`
    },

    flash_pdf_ready: {
      subject: 'PDF flash definitivo pronto',
      body:
        `Ciao ${customer}, il PDF con i flash scelti dagli invitati è pronto. ` +
        (pdfUrl ? `Documento: ${pdfUrl}` : '')
    },

    balance_reminder_30: {
      subject: 'Promemoria saldo',
      body:
        `Ciao ${customer}, manca circa un mese al matrimonio` +
        (eventDate ? ` del ${eventDate}` : '') +
        `. Il saldo previsto è ${balance}. ` +
        (paymentUrl ? `Pagamento: ${paymentUrl}` : '')
    },

    balance_due_7: {
      subject: 'Saldo in scadenza',
      body:
        `Ciao ${customer}, il saldo di ${balance} è ora dovuto prima dell’evento. ` +
        (paymentUrl ? `Pagamento: ${paymentUrl}` : '')
    },

    balance_paid: {
      subject: 'Saldo ricevuto',
      body:
        `Ciao ${customer}, il saldo è stato registrato. ` +
        `La pratica risulta pronta per l’evento. ` +
        (coupleUrl ? `Area Sposi: ${coupleUrl}` : '')
    },

    event_ready: {
      subject: 'Tutto pronto per il matrimonio',
      body:
        `Ciao ${customer}, contratto, pagamenti e selezione flash risultano completi. ` +
        `La pratica ${practiceId} è pronta.`
    },

    event_tomorrow: {
      subject: 'Il matrimonio è domani',
      body:
        `Ciao ${customer}, domani è il grande giorno. ` +
        `La pratica Wedding Tattoo Experience risulta pronta.`
    },

    event_completed: {
      subject: 'Evento completato',
      body:
        `Ciao ${customer}, grazie per aver scelto Wedding Tattoo Experience.`
    },

    workflow_exception: {
      subject: `Attenzione pratica ${practiceId}`,
      body:
        `È stata rilevata un’anomalia nella pratica ${practiceId}: ` +
        `${safe(context.description || context.title || 'controllo richiesto')}.`
    }
  };

  const output = templates[type];
  if (!output) {
    throw new Error(`Template notifica non trovato: ${type}`);
  }

  return {
    type,
    subject: output.subject,
    body: output.body.replace(/\s+/g, ' ').trim()
  };
}
