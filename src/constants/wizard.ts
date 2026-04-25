// Built-in territory sheet suggestions for the wizard empty-state.
// Server-side only — never import from frontend code.
export const BUILTIN_SEED_SHEETS = [
  'https://docs.google.com/spreadsheets/d/1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8/edit?gid=294606982#gid=294606982',
  'https://docs.google.com/spreadsheets/d/1p5nM6NNB-vCnaoKxyThnR1zuj_e_80WqzmWh-RsODlQ/edit?gid=409386986#gid=409386986',
]

export function getSeedSheets(): string[] {
  const env = process.env.WIZARD_SEED_SHEETS ?? ''
  const envSheets = env.split(',').map(s => s.trim()).filter(Boolean)
  const all = [...BUILTIN_SEED_SHEETS, ...envSheets]
  return [...new Set(all)] // deduplicate
}
