export const menu = [
  { name: 'Picaña a la parrilla', price: 3900 },
  { name: 'Bife ancho · 350 g', price: 3800 },
  { name: 'Bife angosto', price: 3600 },
  { name: 'Tira de cerdo', price: 3200 },
  { name: 'Lomo fino', price: 3500 },
  { name: 'Parrilla personal', price: 3500 },
  { name: 'Parrilla mixta especial', price: 5800 },
  { name: 'Pollo parrillero', price: 2800 },
  { name: 'Parrilla familiar', price: 14900 },
  { name: 'Combo amigos', price: 11000 },
  { name: 'Jarra de chicha morada', price: 1800 },
  { name: 'Papas rústicas', price: 1200 },
];

const names = ['Ana', 'Luis', 'María', 'Diego', 'Valeria', 'Jorge', 'Lucía', 'Mateo', 'Daniela', 'Andrés', 'Rosa', 'Felipe', 'Mónica', 'Hugo', 'Carmen', 'Renato', 'Elena', 'Javier', 'Paola', 'Sergio'];
const surnames = ['Cárdenas', 'Salazar', 'Vargas', 'Gutiérrez', 'Paredes'];
export const samples = Array.from({ length: 100 }, (_, i) => {
  const guests = (i % 6) + 1;
  const main = menu[i % 8];
  const items = [{ ...main, quantity: guests }];
  if (guests >= 2) items.push({ ...menu[10], quantity: Math.ceil(guests / 3) });
  if (i % 4 === 0) items.push({ ...menu[11], quantity: 1 });
  return { key: i + 1, payer: names[i % names.length] + ' ' + surnames[Math.floor(i / 20)],
    phone: '', guests, items, notes: 'Caso ficticio ' + String(i + 1).padStart(3, '0'), synthetic: true };
});
