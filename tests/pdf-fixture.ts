// A real two-page PDF with a known text page and a page without text; offsets are generated from the PDF format.
export function samplePdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '', '',
  ];
  const text='BT /F1 18 Tf 72 720 Td (Financial basics: interest and time.) Tj ET';
  objects[5]=`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`; objects[6]='<< /Length 0 >>\nstream\n\nendstream';
  let contents='%PDF-1.4\n'; const offsets=[0];
  for (let i=0;i<objects.length;i++){ offsets.push(Buffer.byteLength(contents)); contents+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`; }
  const start=Buffer.byteLength(contents); contents+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(contents);
}
export function blankPdf(pages: number): Uint8Array {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${pages} >>`,...Array.from({length:pages},()=> '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>')];
  let contents='%PDF-1.4\n';const offsets:number[]=[];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(contents));contents+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(contents);contents+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(contents);
}
