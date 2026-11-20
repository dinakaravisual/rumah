import { getPublicData, invalidatePublicCache, DEFAULT_WA_TEMPLATES } from '../lib/config.js';
import { isAuthenticated } from '../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (req.query?.fresh && isAuthenticated(req)) invalidatePublicCache(); // hanya admin yang boleh melewati cache
  try {
    const { config, bookedDates, busyTimes } = await getPublicData();
    const s = config.settings;
    return res.status(200).json({
      config,
      waTemplateDefaults: DEFAULT_WA_TEMPLATES,
      bookedDates,
      busyTimes,
      configured: Boolean(s.adminWa && s.accountHolder && ((s.bcaActive && s.bcaNo) || (s.jagoActive && s.jagoNo))),
    });
  } catch {
    return res.status(502).json({ error: 'Data belum bisa dimuat. Coba lagi sebentar lagi.' });
  }
}
