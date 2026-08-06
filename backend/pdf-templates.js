
export const PDF_DOCUMENT_TYPES = Object.freeze([
  'contract',
  'deposit_receipt',
  'balance_receipt',
  'flash_selection',
  'event_bundle'
]);

export const PDF_LABELS = Object.freeze({
  contract: 'Contratto',
  deposit_receipt: 'Ricevuta acconto',
  balance_receipt: 'Ricevuta saldo',
  flash_selection: 'Flash definitivi',
  event_bundle: 'Dossier evento'
});

export function safePdfText(value = '') {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function euroFromCents(value = 0) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR'
  }).format(Number(value || 0) / 100);
}

export function formatItalianDate(value, includeTime = false) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(
      'it-IT',
      includeTime
        ? { dateStyle: 'medium', timeStyle: 'short' }
        : { dateStyle: 'medium' }
    ).format(new Date(value));
  } catch {
    return String(value);
  }
}

export function documentFileName(type, practiceId, suffix = '') {
  const label = PDF_LABELS[type] || type;
  const cleanPractice = safePdfText(practiceId || 'WTE').replace(/[^\w-]+/g, '_');
  const cleanLabel = label.replace(/[^\w-]+/g, '_');
  const cleanSuffix = suffix ? `_${String(suffix).replace(/[^\w-]+/g, '_')}` : '';
  return `${cleanPractice}_${cleanLabel}${cleanSuffix}.pdf`;
}

export function writeDocumentHeader(doc, {
  title,
  subtitle = '',
  practiceId = '',
  status = ''
}) {
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor('#8A5D1B')
    .text('WEDDING TATTOO EXPERIENCE', { characterSpacing: 1.3 });

  doc.moveDown(0.45);

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor('#211B16')
    .text(safePdfText(title));

  if (subtitle) {
    doc
      .moveDown(0.2)
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#6F6254')
      .text(safePdfText(subtitle));
  }

  const meta = [
    practiceId ? `Pratica ${practiceId}` : '',
    status ? safePdfText(status) : ''
  ].filter(Boolean).join(' · ');

  if (meta) {
    doc
      .moveDown(0.45)
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#8A7964')
      .text(meta);
  }

  doc
    .moveDown(0.7)
    .strokeColor('#CBB793')
    .lineWidth(0.7)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke()
    .moveDown(0.8);
}

export function writeKeyValueRows(doc, rows = []) {
  rows.forEach(([label, value]) => {
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#8A7964')
      .text(`${safePdfText(label).toUpperCase()}:`, {
        continued: true,
        width: 145
      });

    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor('#211B16')
      .text(` ${safePdfText(value || '-')}`);

    doc.moveDown(0.2);
  });
}

export function writeSectionTitle(doc, title) {
  if (doc.y > doc.page.height - 110) {
    doc.addPage();
  }

  doc
    .moveDown(0.7)
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#8A5D1B')
    .text(safePdfText(title))
    .moveDown(0.4);
}

export function writeFooter(doc, text = '') {
  const range = doc.bufferedPageRange();

  for (let pageIndex = 0; pageIndex < range.count; pageIndex++) {
    doc.switchToPage(pageIndex);
    const footerY = doc.page.height - 31;

    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#8A7964')
      .text(
        `${safePdfText(text || 'Documento generato automaticamente')} · ` +
        `Pagina ${pageIndex + 1} di ${range.count}`,
        doc.page.margins.left,
        footerY,
        {
          width:
            doc.page.width -
            doc.page.margins.left -
            doc.page.margins.right,
          align: 'center',
          lineBreak: false
        }
      );
  }
}
