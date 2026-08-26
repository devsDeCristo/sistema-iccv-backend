import { buildQrCodePath, buildRegistrationCode } from './qrcode.mjs';
import { createElement as h } from 'react';
import { renderToBuffer, Document, Page, View, Text, Svg, Path, StyleSheet } from '@react-pdf/renderer';
import zlib from 'node:zlib';

const code = buildRegistrationCode('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d','9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a');

for (const margin of [4, 2]) {
  const qr = buildQrCodePath(code, margin);
  console.log(`marginSize ${margin} -> ${qr.cells} celulas`);
}

const qr = buildQrCodePath(code);
const QR_PT = 56, PAD = 4;
const st = StyleSheet.create({
  body: { padding: 15 },
  badge: { width: '8.7cm', height: '11cm', borderWidth: 1, position: 'relative' },
  nameArea: { position: 'absolute', top: 210, left: 0, right: 0, alignItems: 'center' },
  textName: { fontSize: 20, textAlign: 'center' },
  qrBox: { backgroundColor: '#FFFFFF', padding: PAD, marginTop: 4 },
  qrCode: { width: QR_PT, height: QR_PT },
});

async function medir(nome, rotulo) {
  const buf = await renderToBuffer(h(Document, null, h(Page, { size: 'A4', style: st.body },
    h(View, { style: st.badge },
      h(View, { style: st.nameArea },
        h(Text, { style: st.textName }, nome),
        h(View, { style: st.qrBox }, h(Svg, { style: st.qrCode, viewBox: `0 0 ${qr.cells} ${qr.cells}` },
          h(Path, { d: qr.path, fill: '#000000' })))
      ))
  )));

  // infla os content streams e coleta os Y de todo comando de path
  let ys = [], nOps = 0, textY = null;
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let txt;
    try { txt = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); }
    catch { continue; }
    for (const op of txt.matchAll(/([\d.]+) ([\d.]+) (?:m|l)\b/g)) { ys.push(+op[2]); nOps++; }
    const t = txt.match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/);
    if (t) textY = +t[2];
  }
  const PAGE_H = 841.89, TOPO = 15;               // padding do body
  const badgeTopo = PAGE_H - TOPO;                 // y do topo do cracha
  const badgeBase = badgeTopo - (11 * 72 / 2.54);  // 11cm em pt
  const qrTopoY = Math.max(...ys), qrBaseY = Math.min(...ys);
  console.log(`\n[${rotulo}] "${nome}"`);
  console.log(`  ops de path: ${nOps}`);
  console.log(`  cracha         : y ${badgeBase.toFixed(1)} .. ${badgeTopo.toFixed(1)}`);
  console.log(`  baseline nome  : y ${textY}  (=> ${(badgeTopo - textY).toFixed(1)}pt abaixo do topo)`);
  console.log(`  QR             : y ${qrBaseY.toFixed(1)} .. ${qrTopoY.toFixed(1)}`);
  console.log(`  QR abaixo do nome? ${qrTopoY < textY ? 'SIM' : 'NAO — COLIDE'}`);
  console.log(`  QR dentro do cracha? ${qrBaseY >= badgeBase ? 'SIM' : `NAO — vaza ${(badgeBase - qrBaseY).toFixed(1)}pt`}`);
}

await medir('Ana', '1 linha curta');
await medir('Maria de Fatima Oliveira Santos', '1-2 linhas');
await medir('Joao Pedro da Silva Santos Oliveira Nascimento', 'nome muito longo');
