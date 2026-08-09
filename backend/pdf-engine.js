
import PDFDocument from 'pdfkit';
import {
  PDF_DOCUMENT_TYPES,
  documentFileName,
  euroFromCents,
  formatItalianDate,
  safePdfText,
  writeDocumentHeader,
  writeFooter,
  writeKeyValueRows,
  writeSectionTitle
} from './pdf-templates.js';

function pdfError(message, code = 'PDF_ENGINE_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function dataUrlToBuffer(value = '') {
  const match = String(value).match(
    /^data:image\/(?:png|jpeg|jpg);base64,(.+)$/i
  );
  return match ? Buffer.from(match[1], 'base64') : null;
}

function docOptions() {
  return {
    size: 'A4',
    margin: 42,
    bufferPages: true,
    info: {
      Producer: 'Wedding Tattoo Experience',
      Creator: 'WTE PDF Engine'
    }
  };
}

function streamDocument(res, doc, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`
  );
  doc.pipe(res);
}

export function createPdfEngine({
  pool,
  logger = console
}) {
  if (!pool?.query) {
    throw new Error('PDF Engine: pool PostgreSQL mancante.');
  }

  async function practiceBundle(practiceId) {
    const result = await pool.query(
      `SELECT p.id,p.data,p.updated_at,
              pp.token AS payment_token,
              pp.couple_token,
              pp.currency,
              pp.total_cents,pp.deposit_cents,pp.balance_cents,
              pp.deposit_status,pp.balance_status,
              pp.deposit_paid_at,pp.balance_paid_at,
              pp.deposit_provider,pp.balance_provider,
              pp.deposit_reference,pp.balance_reference,
              pp.deposit_receipt_url,pp.balance_receipt_url,
              ge.token AS guest_token,ge.status AS guest_status,
              ge.final_codes,ge.finalized_at,ge.closes_at,
              c.token AS contract_token,c.contract_number,
              c.package_snapshot,c.clauses,c.status AS contract_status,
              c.signer_name,c.signature_data,c.accepted_at
       FROM wte_practices p
       LEFT JOIN wte_payment_plans pp ON pp.practice_id=p.id
       LEFT JOIN wte_guest_events ge ON ge.practice_id=p.id
       LEFT JOIN LATERAL (
         SELECT *
         FROM wte_contracts c2
         WHERE c2.practice_id=p.id
         ORDER BY c2.created_at DESC
         LIMIT 1
       ) c ON TRUE
       WHERE p.id=$1`,
      [practiceId]
    );

    if (!result.rowCount) {
      throw pdfError(
        'Pratica non trovata.',
        'PRACTICE_NOT_FOUND',
        404
      );
    }

    return result.rows[0];
  }

  async function flashItems(codes = []) {
    if (!Array.isArray(codes) || !codes.length) return [];

    const result = await pool.query(
      `SELECT id,code,title,category,tags,image_data,image_mime
       FROM wte_flash_catalog
       WHERE code=ANY($1::text[])
       ORDER BY array_position($1::text[],code)`,
      [codes]
    );

    return result.rows;
  }

  async function flashRanking(eventToken, limit = 50) {
    if (!eventToken) return [];

    const result = await pool.query(
      `SELECT flash_code AS code,
              COUNT(*)::int AS votes,
              MIN(created_at) AS first_vote
       FROM wte_guest_votes
       WHERE event_token=$1
       GROUP BY flash_code
       ORDER BY votes DESC,first_vote ASC,flash_code ASC
       LIMIT $2`,
      [eventToken, limit]
    );

    return result.rows;
  }

  function writeContract(doc, bundle) {
    const practice = bundle.data || {};
    const pack = bundle.package_snapshot || {};
    const clauses = Array.isArray(bundle.clauses) ? bundle.clauses : [];

    writeDocumentHeader(doc, {
      title:
        bundle.contract_status === 'accepted'
          ? 'Contratto accettato'
          : 'Bozza di contratto',
      subtitle: pack.name || practice.package || '',
      practiceId: bundle.id,
      status: bundle.contract_number || ''
    });

    writeKeyValueRows(doc, [
      ['Cliente', practice.name],
      ['E-mail', practice.email || practice.mail],
      ['Telefono', practice.phone || practice.telefono],
      ['Data evento', practice.date],
      ['Ora', practice.time],
      ['Luogo', practice.location || practice.city],
      ['Invitati', practice.guests],
      ['Pacchetto', pack.name || practice.package],
      ['Prezzo base', pack.base_price_cents ? euroFromCents(pack.base_price_cents)+' + IVA' : 'Su misura'],
      ['Trasferta inclusa', pack.pricing ? `${pack.pricing.includedKm} km complessivi A/R` : 'Secondo pacchetto'],
      ['Km extra', pack.pricing && pack.pricing.extraKm ? `${pack.pricing.extraKm} km × 0,70 € + IVA` : 'Nessuno'],
      ['Imponibile', pack.pricing ? euroFromCents(pack.pricing.netCents) : '—'],
      ['IVA 22%', pack.pricing ? euroFromCents(pack.pricing.vatCents) : '—'],
      [
        'Totale IVA inclusa',
        pack.price_cents
          ? euroFromCents(pack.price_cents)
          : bundle.total_cents
            ? euroFromCents(bundle.total_cents)
            : 'Su misura'
      ]
    ]);

    clauses.forEach((clause, index) => {
      writeSectionTitle(
        doc,
        `${index + 1}. ${safePdfText(clause.title)}`
      );

      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#211B16')
        .text(safePdfText(clause.text), {
          align: 'justify',
          lineGap: 3
        });
    });

    writeSectionTitle(
      doc,
      bundle.contract_status === 'accepted'
        ? 'Accettazione registrata'
        : 'Stato documento'
    );

    if (bundle.contract_status === 'accepted') {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#211B16')
        .text(
          `Firmatario: ${safePdfText(bundle.signer_name || '-')}\n` +
          `Data: ${formatItalianDate(bundle.accepted_at, true)}`
        );

      const signature = dataUrlToBuffer(bundle.signature_data);
      if (signature) {
        try {
          doc.moveDown(0.6);
          doc.image(signature, {
            fit: [250, 80],
            align: 'left'
          });
        } catch (error) {
          logger.error('Firma contratto PDF non inserita', error);
        }
      }
    } else {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#6F6254')
        .text(
          'Documento in bozza. Sarà considerato accettato ' +
          'solo dopo la registrazione della firma.'
        );
    }
  }

  function writePaymentReceipt(doc, bundle, paymentType) {
    const practice = bundle.data || {};
    const isDeposit = paymentType === 'deposit';

    const amount = isDeposit
      ? bundle.deposit_cents
      : bundle.balance_cents;

    const paidAt = isDeposit
      ? bundle.deposit_paid_at
      : bundle.balance_paid_at;

    const provider = isDeposit
      ? bundle.deposit_provider
      : bundle.balance_provider;

    const reference = isDeposit
      ? bundle.deposit_reference
      : bundle.balance_reference;

    writeDocumentHeader(doc, {
      title: isDeposit
        ? 'Registrazione acconto'
        : 'Registrazione saldo',
      subtitle: practice.name || '',
      practiceId: bundle.id,
      status: paidAt ? 'Pagamento registrato' : 'Pagamento non registrato'
    });

    writeKeyValueRows(doc, [
      ['Cliente', practice.name],
      ['Data evento', practice.date],
      ['Ora', practice.time],
      ['Luogo', practice.location || practice.city],
      ['Importo', euroFromCents(amount)],
      ['Data pagamento', formatItalianDate(paidAt, true)],
      ['Metodo / provider', provider],
      ['Riferimento', reference],
      ['Pratica', bundle.id]
    ]);

    writeSectionTitle(doc, 'Nota');

    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor('#6F6254')
      .text(
        'Documento generato automaticamente dal gestionale ' +
        'Wedding Tattoo Experience. Attesta la registrazione ' +
        'del pagamento nella pratica e non sostituisce eventuali ' +
        'documenti fiscali previsti dalla normativa applicabile.',
        { lineGap: 3 }
      );
  }

  async function writeFlashSelection(doc, bundle) {
    const practice = bundle.data || {};
    const codes = Array.isArray(bundle.final_codes)
      ? bundle.final_codes
      : [];
    const items = await flashItems(codes);
    const ranking = await flashRanking(bundle.guest_token, 50);
    const votes = new Map(
      ranking.map(row => [row.code, Number(row.votes || 0)])
    );

    writeDocumentHeader(doc, {
      title: 'Flash definitivi',
      subtitle:
        practice.name
          ? `Matrimonio di ${practice.name}`
          : 'Selezione invitati',
      practiceId: bundle.id,
      status:
        bundle.guest_status === 'finalized'
          ? 'Selezione chiusa'
          : 'Selezione in corso'
    });

    writeKeyValueRows(doc, [
      ['Data evento', practice.date],
      ['Ora', practice.time],
      ['Luogo', practice.location || practice.city],
      ['Flash definitivi', items.length],
      [
        'Chiusura selezione',
        formatItalianDate(
          bundle.finalized_at || bundle.closes_at,
          true
        )
      ]
    ]);

    doc.moveDown(0.7);

    const columns = 3;
    const gap = 9;
    const usable =
      doc.page.width -
      doc.page.margins.left -
      doc.page.margins.right;
    const cellWidth = (usable - gap * (columns - 1)) / columns;
    const cellHeight = 176;

    let column = 0;
    let x = doc.page.margins.left;
    let y = doc.y;

    for (const item of items) {
      if (y + cellHeight > doc.page.height - 50) {
        doc.addPage();
        y = doc.page.margins.top;
        column = 0;
        x = doc.page.margins.left;
      }

      doc
        .roundedRect(x, y, cellWidth, cellHeight - 8, 3)
        .strokeColor('#CBB793')
        .stroke();

      try {
        if (item.image_data) {
          doc.image(item.image_data, x + 7, y + 7, {
            fit: [cellWidth - 14, 104],
            align: 'center',
            valign: 'center'
          });
        }
      } catch {
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor('#7A6C5B')
          .text(
            'Anteprima non disponibile',
            x + 8,
            y + 48,
            {
              width: cellWidth - 16,
              align: 'center'
            }
          );
      }

      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#211B16')
        .text(item.code, x + 8, y + 116, {
          width: cellWidth - 16,
          align: 'center'
        });

      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor('#6F6254')
        .text(
          safePdfText(item.title || item.category || ''),
          x + 8,
          y + 130,
          {
            width: cellWidth - 16,
            align: 'center',
            height: 20
          }
        );

      doc
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .fillColor('#8A5D1B')
        .text(
          `${votes.get(item.code) || 0} preferenze`,
          x + 8,
          y + 151,
          {
            width: cellWidth - 16,
            align: 'center'
          }
        );

      column += 1;
      if (column >= columns) {
        column = 0;
        x = doc.page.margins.left;
        y += cellHeight;
      } else {
        x += cellWidth + gap;
      }
    }
  }

  async function writeEventBundle(doc, bundle) {
    const practice = bundle.data || {};
    const finalCodes = Array.isArray(bundle.final_codes)
      ? bundle.final_codes
      : [];

    writeDocumentHeader(doc, {
      title: 'Dossier evento',
      subtitle: practice.name || '',
      practiceId: bundle.id,
      status: practice.workflowState || practice.status || ''
    });

    writeSectionTitle(doc, 'Dati evento');

    writeKeyValueRows(doc, [
      ['Cliente', practice.name],
      ['E-mail', practice.email || practice.mail],
      ['Telefono', practice.phone || practice.telefono],
      ['Data', practice.date],
      ['Ora', practice.time],
      ['Luogo', practice.location || practice.city],
      ['Invitati', practice.guests],
      ['Pacchetto', practice.package]
    ]);

    writeSectionTitle(doc, 'Pagamenti');

    writeKeyValueRows(doc, [
      [
        'Totale',
        bundle.total_cents
          ? euroFromCents(bundle.total_cents)
          : '-'
      ],
      [
        'Acconto',
        `${euroFromCents(bundle.deposit_cents)} · ` +
        `${bundle.deposit_status || 'non configurato'}`
      ],
      [
        'Saldo',
        `${euroFromCents(bundle.balance_cents)} · ` +
        `${bundle.balance_status || 'non configurato'}`
      ]
    ]);

    writeSectionTitle(doc, 'Documenti e preparazione');

    writeKeyValueRows(doc, [
      ['Contratto', bundle.contract_status || 'assente'],
      ['Firmatario', bundle.signer_name || '-'],
      ['Selezione invitati', bundle.guest_status || 'assente'],
      ['Flash definitivi', finalCodes.length],
      [
        'Pratica pronta',
        bundle.deposit_status === 'paid' &&
        bundle.balance_status === 'paid' &&
        bundle.guest_status === 'finalized'
          ? 'Sì'
          : 'No'
      ]
    ]);

    if (finalCodes.length) {
      writeSectionTitle(doc, 'Codici flash definitivi');

      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#211B16')
        .text(finalCodes.join(' · '), {
          lineGap: 4
        });
    }

    writeSectionTitle(doc, 'Note operative');

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#211B16')
      .text(
        safePdfText(
          practice.notes ||
          'Nessuna nota operativa inserita.'
        ),
        { lineGap: 3 }
      );
  }

  async function render(type, practiceId, {
    res = null,
    returnBuffer = false
  } = {}) {
    if (!PDF_DOCUMENT_TYPES.includes(type)) {
      throw pdfError(
        `Tipo documento non valido: ${type}`,
        'INVALID_PDF_TYPE'
      );
    }

    const bundle = await practiceBundle(practiceId);
    const doc = new PDFDocument(docOptions());
    const chunks = [];

    if (returnBuffer) {
      doc.on('data', chunk => chunks.push(chunk));
    }

    if (res) {
      streamDocument(
        res,
        doc,
        documentFileName(type, practiceId)
      );
    }

    if (type === 'contract') {
      writeContract(doc, bundle);
    } else if (type === 'deposit_receipt') {
      writePaymentReceipt(doc, bundle, 'deposit');
    } else if (type === 'balance_receipt') {
      writePaymentReceipt(doc, bundle, 'balance');
    } else if (type === 'flash_selection') {
      await writeFlashSelection(doc, bundle);
    } else if (type === 'event_bundle') {
      await writeEventBundle(doc, bundle);
    }

    writeFooter(
      doc,
      `Wedding Tattoo Experience · ${practiceId}`
    );

    if (returnBuffer) {
      return new Promise((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
      });
    }

    doc.end();
    return null;
  }

  async function registerDocument({
    practiceId,
    type,
    storageUrl = '',
    checksum = '',
    metadata = {}
  }) {
    if (!PDF_DOCUMENT_TYPES.includes(type)) {
      throw pdfError(
        'Tipo documento non valido.',
        'INVALID_PDF_TYPE'
      );
    }

    const result = await pool.query(
      `INSERT INTO wte_generated_documents
       (practice_id,document_type,status,storage_url,checksum,metadata)
       VALUES ($1,$2,'ready',$3,$4,$5::jsonb)
       ON CONFLICT (practice_id,document_type)
       DO UPDATE SET
         status='ready',
         storage_url=EXCLUDED.storage_url,
         checksum=EXCLUDED.checksum,
         metadata=wte_generated_documents.metadata || EXCLUDED.metadata,
         generated_at=NOW(),
         updated_at=NOW()
       RETURNING *`,
      [
        practiceId,
        type,
        storageUrl,
        checksum,
        JSON.stringify(metadata || {})
      ]
    );

    return result.rows[0];
  }

  async function listDocuments(practiceId) {
    const result = await pool.query(
      `SELECT id,practice_id,document_type,status,storage_url,
              checksum,metadata,generated_at,created_at,updated_at
       FROM wte_generated_documents
       WHERE practice_id=$1
       ORDER BY created_at ASC`,
      [practiceId]
    );

    return result.rows;
  }

  return {
    types: PDF_DOCUMENT_TYPES,
    render,
    registerDocument,
    listDocuments,
    practiceBundle
  };
}
