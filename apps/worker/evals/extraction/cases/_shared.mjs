// What every extraction eval case shares (GET-1048): our side and the account most cases are about.
//
// EVERY NAME HERE IS INVENTED. This folder is exported to the public repo with the extractor it
// tests, and `node scripts/export-preview.mjs --scan --strict` fails on a real client or contact.
// A case built from a real misread keeps the SHAPE of the misread (a rep's guess filed as the
// buyer's budget, a customer's own bot filed as a competitor) and none of its names, numbers or
// wording. Files starting with "_" are not cases; the loader skips them.

/** Our side: the seller whose calls and emails are being read. The offer is what decides
 *  competitor vs tech_stack (extractionText.mjs ourOfferBlock), so it has to say what we sell. */
export const OUR_SIDE = {
  company: 'Corvane',
  names: ['Theo Bramwell', 'Mara Quint'],
  offer: 'Corvane reads a sales team\'s calls, emails and messages and turns them into account intelligence: '
    + 'buying signals, objections, competitors and next steps, filed on every account record so a rep '
    + 'knows where each deal stands without writing notes.',
};

/** The account most cases are about, and its people. */
export const BRINDLE = { name: 'Brindle', industry: 'B2B payroll software' };
export const INES = { name: 'Ines Halloran', title: 'Head of Revenue Operations' };
export const ODILE = { name: 'Odile Ferrant', title: 'CFO' };

export const ATLAS = { name: 'Atlas Freight', industry: 'Freight brokerage' };
export const RUAIRI = { name: 'Ruairi Doyle', title: 'VP Sales' };
