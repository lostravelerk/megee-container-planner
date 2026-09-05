// Shipment arithmetic is deliberately independent of the geometry optimizer.
// Dimensions are mm, mass is kg (resolved to grams), quantity is integer EA.
import { CARTON_WEIGHT_BASIS, cartonBatchMass } from './cartonMass.js';
export const SHIPPING_SCHEMA = 1;
const known = v => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));
const grams = v => known(v) && Number(v) >= 0 ? Math.round(Number(v) * 1000) : null;
const sumKnown = values => values.every(v => v !== null) ? values.reduce((a, b) => a + b, 0) : null;
const kg = g => g === null ? null : g / 1000;
export const boxVolume = size => [size.l, size.w, size.h].every(v => known(v) && Number(v) > 0 && Number(v) <= 20000)
  ? Number(size.l) * Number(size.w) * Number(size.h) / 1e9 : null;
export function cartonCbmPerTenThousand(size, eaPerBox) {
  const cbm = boxVolume(size);
  return cbm !== null && Number.isSafeInteger(eaPerBox) && eaPerBox > 0 ? cbm * 10000 / eaPerBox : null;
}

export function calculateShipment(shipment) {
  // Confirmed legacy records retain their original arithmetic. New drafts and
  // revisions explicitly opt into the requested standard-carton convention.
  const standard = shipment.weightBasis === CARTON_WEIGHT_BASIS;
  const errors = [], pending = [], cartons = [], lines = [], ids = new Set();
  for (const line of shipment.lines || []) {
    const tag = line.code || line.id || 'SKU';
    if (!line.id || ids.has(line.id)) { errors.push(`${tag}: duplicate / missing line ID`); continue; }
    ids.add(line.id);
    const qty = Number(line.quantity), ea = Number(line.eaPerBox), cbm = boxVolume(line);
    if (!Number.isSafeInteger(qty) || qty <= 0 || !Number.isSafeInteger(ea) || ea <= 0 || cbm === null) {
      errors.push(`${tag}: quantity, EA/BOX and measured carton dimensions are required`); continue;
    }
    const count = Math.ceil(qty / ea);
    if (count > 20000 || cartons.length + count > 50000) { errors.push(`${tag}: carton limit exceeded (20,000 per line / 50,000 shipment)`); continue; }
    if (!String(line.code || '').trim()) errors.push(`${tag}: product code is required`);
    for (const field of standard ? ['grossKg'] : ['grossKg', 'netKg', 'tailGrossKg', 'tailNetKg']) {
      if (known(line[field]) && (Number(line[field]) < 0 || !Number.isSafeInteger(Math.round(Number(line[field]) * 1000)))) errors.push(`${tag}: invalid ${field}`);
    }
    const own = [];
    for (let index = 0; index < count; index++) {
      const quantity = Math.min(ea, qty - index * ea), tail = quantity < ea;
      const derived = standard ? cartonBatchMass(quantity, ea, line.grossKg) : null;
      if (derived?.error) errors.push(`${tag}: ${derived.error}`);
      const grossG = standard ? grams(derived.grossKg) : grams(tail ? line.tailGrossKg : line.grossKg);
      const netG = standard ? grams(derived.netKg) : grams(tail ? line.tailNetKg : line.netKg);
      const carton = { id: `${line.id}:${index + 1}`, lineId: line.id, code: line.code, name: line.name,
        lot: line.lot || '', number: index + 1, quantity, tail, grossKg: kg(grossG), netKg: kg(netG),
        cbm, l: Number(line.l), w: Number(line.w), h: Number(line.h), containerNo: line.containerNo || '' };
      if (grossG === null || grossG <= 0) pending.push(`${tag} #${index + 1}: ${!standard && tail ? 'measured partial-carton' : 'standard carton'} gross weight required`);
      if (netG !== null && grossG !== null && netG > grossG) errors.push(`${tag} #${index + 1}: net weight exceeds gross weight`);
      cartons.push(carton); own.push(carton);
    }
    lines.push({ ...line, cartons: count, tailEa: qty % ea, cbm: cbm * count,
      grossKg: kg(sumKnown(own.map(c => grams(c.grossKg)))), netKg: kg(sumKnown(own.map(c => grams(c.netKg)))) });
  }
  if (!lines.length) errors.push('At least one valid shipment line is required');
  const byId = new Map(cartons.map(c => [c.id, c])), assigned = new Set(), palletNos = new Set(), pallets = [];
  for (const pallet of shipment.pallets || []) {
    const no = String(pallet.number || '').trim();
    if (!no || palletNos.has(no)) errors.push('Pallet numbers must be present and unique');
    palletNos.add(no);
    const members = [];
    for (const id of pallet.cartonIds || []) {
      const carton = byId.get(id);
      if (!carton) { errors.push(`${no}: unknown carton ${id}`); continue; }
      if (assigned.has(id)) { errors.push(`${no}: carton ${id} assigned more than once`); continue; }
      assigned.add(id); members.push(carton);
    }
    if (!members.length) errors.push(`${no}: empty pallet`);
    const cbm = boxVolume(pallet), tare = grams(pallet.tareKg), extra = grams(pallet.extraKg);
    for (const [base, loaded] of [['baseL','l'],['baseW','w'],['baseH','h']]) {
      if (pallet[base] != null && pallet[base] !== '' && (!Number.isFinite(pallet[base]) || pallet[base] <= 0
        || pallet[loaded] !== '' && Number(pallet[base]) > Number(pallet[loaded])))
        errors.push(`${no}: bare pallet dimension exceeds the measured loaded envelope or is invalid`);
    }
    if (cbm !== null && members.reduce((sum,c) => sum+c.cbm,0) > cbm+1e-9) errors.push(`${no}: enclosed cartons exceed measured pallet envelope volume`);
    if (cbm === null) pending.push(`${no}: measured loaded pallet envelope required (including pallet, film and bulge)`);
    if (!standard && (tare === null || tare <= 0)) pending.push(`${no}: pallet tare weight required`);
    if (!standard && extra === null) pending.push(`${no}: film / separators / straps weight required; enter 0 only if confirmed`);
    const cartonG = sumKnown(members.map(c => grams(c.grossKg)));
    const grossG = standard ? cartonG : sumKnown([cartonG, tare, extra]);
    const capacity = grams(pallet.maxGrossKg);
    if (!standard && capacity !== null && grossG !== null && grossG > capacity) errors.push(`${no}: loaded pallet exceeds entered gross-weight limit`);
    pallets.push({ ...pallet, number: no, members, cbm, grossKg: kg(grossG),
      netKg: kg(sumKnown(members.map(c => grams(c.netKg)))), quantity: members.reduce((n, c) => n + c.quantity, 0) });
  }
  const loose = cartons.filter(c => !assigned.has(c.id));
  const packaging = [...loose, ...pallets];
  const totalGross = sumKnown(packaging.map(p => grams(p.grossKg)));
  const totalCbm = sumKnown(packaging.map(p => p.cbm));
  return { errors: [...new Set(errors)], pending: [...new Set(pending)], ready: errors.length === 0 && pending.length === 0,
    lines, cartons, pallets, loose, totalQuantity: cartons.reduce((n, c) => n + c.quantity, 0),
    totalGrossKg: kg(totalGross), totalNetKg: kg(sumKnown(cartons.map(c => grams(c.netKg)))),
    totalCbm, cartonCbm: cartons.reduce((n, c) => n + c.cbm, 0) };
}

export function confirmShipment(draft, now = new Date().toISOString()) {
  const result = calculateShipment(draft);
  if (!result.ready) throw new Error([...result.errors, ...result.pending].join('; '));
  if (!String(draft.reference || '').trim()) throw new Error('Shipment reference is required');
  return structuredClone({ ...draft, schemaVersion: SHIPPING_SCHEMA, status: 'confirmed', confirmedAt: now });
}

// An explicit profile selection creates a copy. Later catalogue edits never
// update an existing shipment or a confirmed revision.
export function lineFromProfile(profile, id) {
  return { ...structuredClone(profile), id, profileId: profile.id, profileRevision: profile.revision,
    quantity: '', lot: '', containerNo: '', tailGrossKg: '', tailNetKg: '' };
}
