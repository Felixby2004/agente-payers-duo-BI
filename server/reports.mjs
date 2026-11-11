import { money, paymentLabels } from '../shared/orders.mjs';

export const reportKinds = {
  M5: { title: 'Ingresos de reservas liquidadas', date: 'Fecha de cierre', label: 'Medio de liquidación', value: 'Total cobrado' },
  M1: { title: 'Anticipos confirmados', date: 'Confirmación', label: 'Medio del anticipo', value: 'Anticipo neto' },
  M3: { title: 'Asistencia de titulares', date: 'Fecha de visita', label: 'Registro de caja', value: 'Titulares' },
};

function pdfText(value) {
  return String(value ?? '').normalize('NFC').replace(/[^\x20-\xff]/g, ' ').replace(/[\\()]/g, '\\$&');
}

export function reportPdf(measure, from, to, rows) {
  const kind = reportKinds[measure];
  const amount = (value) => measure === 'M3' ? String(value) : money(value);
  const firstRows = 17;
  const pages = 1 + Math.ceil(Math.max(0, rows.length - firstRows) / 23);
  const total = rows.reduce((sum, row) => sum + Number(row.value), 0);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count ' + pages + ' /Kids [' + Array.from({length:pages}, (_,i) => (5+i*2)+' 0 R').join(' ') + '] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  for (let page = 0; page < pages; page++) {
    const commands = [];
    const block = (x,y,w,h,color) => commands.push(color+' rg '+x+' '+y+' '+w+' '+h+' re f');
    const text = (x,y,content,size=11,bold=false,color='0.18 0.13 0.15') => {
      commands.push('BT /F'+(bold?2:1)+' '+size+' Tf '+color+' rg '+x+' '+y+' Td ('+pdfText(content)+') Tj ET');
    };
    block(0,831,595,11,'0.43 0.14 0.24');
    text(42,797,'PARRILLADAS EL ESTABLO / PAYERS',11,true);
    text(42,751,kind.title,25,true);
    text(42,725,measure+'   |   '+from+' a '+to+'   |   Hora de Lima',11);
    block(42,636,511,62,'0.43 0.14 0.24');
    text(56,678,'TOTAL DEL PERÍODO',10,true,'1 1 1');
    text(56,650,amount(total),23,true,'1 1 1');
    if (page === 0) {
      const dayMs = 86400000;
      const first = Date.parse(from);
      const days = (Date.parse(to) - first) / dayMs + 1;
      const step = Math.ceil(days / 10);
      const groups = Array.from({ length: Math.ceil(days / step) }, (_, i) => ({
        label: new Date(first + i * step * dayMs).toISOString().slice(5, 10), value: 0,
      }));
      for (const row of rows) groups[Math.floor((Date.parse(row.date) - first) / dayMs / step)].value += Number(row.value);
      const max = Math.max(1, ...groups.map(item => item.value));
      const width = 495 / groups.length;
      text(42,610,step === 1 ? 'Evolución por día' : 'Evolución por bloques de ' + step + ' días',12,true);
      block(48,505,501,1,'0.84 0.79 0.80');
      for (const [i,item] of groups.entries()) {
        const x = Math.round(48 + i*width + width/2);
        const height = Math.round(item.value / max * 72);
        if (height) block(x-13,506,26,height,'0.56 0.27 0.36');
        if (groups.length <= 7) text(x-15,515+height,amount(item.value),8,true);
        text(x-11,491,item.label,8);
      }
    }
    const header = page === 0 ? 453 : 596;
    block(42,header,511,25,'0.97 0.94 0.90');
    [kind.date,'Reserva',kind.label,kind.value].forEach((value,i) => text([52,163,283,447][i],header+9,value,10,true));
    const start = page === 0 ? 0 : firstRows + (page-1)*23;
    const end = page === 0 ? firstRows : start+23;
    for (const [i,row] of rows.slice(start,end).entries()) {
      const y = header-16-i*21;
      if (i%2) block(42,y-6,511,21,'0.98 0.96 0.94');
      const label = paymentLabels[row.label] || row.label || 'Sin dato';
      [row.date,row.ref,String(label).slice(0,30),amount(row.value)].forEach((value,j) => text([52,163,283,447][j],y,value,10,j===3));
    }
    if (!rows.length) text(52,header-22,'No se registran operaciones para el periodo elegido.');
    text(42,53,measure === 'M5' ? 'Cada reserva liquidada aporta una vez el anticipo y el saldo aplicados.'
      : measure === 'M1' ? 'Importes netos por fecha de confirmación del anticipo.'
        : 'Solo se incluye la presencia del titular confirmada por caja.',9);
    text(42,30,'PAYERS / '+(page+1)+' de '+pages,9,true);
    const stream = commands.join('\n');
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents '+(6+page*2)+' 0 R >>',
      '<< /Length '+Buffer.byteLength(stream,'latin1')+' >>\nstream\n'+stream+'\nendstream');
  }
  let data = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i,obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(data,'latin1'));
    data += (i+1)+' 0 obj\n'+obj+'\nendobj\n';
  }
  const xref = Buffer.byteLength(data,'latin1');
  data += 'xref\n0 '+offsets.length+'\n0000000000 65535 f \n'
    + offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')
    + 'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  return Buffer.from(data,'latin1');
}

