/**
 * TAMBAHAN Code.gs: aksi "updateProject" dan "deleteProject".
 * Disesuaikan dengan doPost Anda: PIN sudah dicek di awal doPost (SERVER_ADMIN_PIN),
 * jadi di sini tidak ada cek PIN lagi, dan tidak memanggil LockService lagi
 * (doPost sudah memegang lock).
 *
 * Urutan kolom Sheet (sama dengan appendRow di createProject):
 *   1 projectId | 2 clientName | 3 folderId | 4 detectSubfolders | 5 showOpeningGallery
 *   6 coverUrl  | 7 createdAt  | 8 adminWhatsapp | 9 eventDate
 */

function findProjectRow_(sheet, projectId) {
  const last = sheet.getLastRow();
  if (last < 1 || !projectId) return 0;
  const ids = sheet.getRange(1, 1, last, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(projectId)) return i + 1;
  }
  return 0;
}

function updateProject_(body) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const row = findProjectRow_(sheet, body.projectId);
  if (!row) return { success: false, error: 'Project tidak ditemukan' };

  // validasi dulu sebelum menulis apa pun
  let folderId = '';
  if (body.driveUrl) {
    folderId = extractFolderId(body.driveUrl);
    if (!folderId) return { success: false, error: 'Link Google Drive tidak valid' };
  }

  if (body.clientName !== undefined) sheet.getRange(row, 2).setValue(String(body.clientName || 'Klien').slice(0, 100));
  if (folderId) sheet.getRange(row, 3).setValue(folderId);
  if (body.detectSubfolders !== undefined) sheet.getRange(row, 4).setValue(Boolean(body.detectSubfolders));
  if (body.showOpeningGallery !== undefined) sheet.getRange(row, 5).setValue(Boolean(body.showOpeningGallery));
  if (body.coverUrl !== undefined) {
    let cover = String(body.coverUrl || '');
    if (cover.includes('=w600')) cover = cover.replace('=w600', '=w2000');
    sheet.getRange(row, 6).setValue(cover);
  }
  if (body.adminWhatsapp !== undefined) sheet.getRange(row, 8).setValue(String(body.adminWhatsapp || '').replace(/[^0-9]/g, ''));
  if (body.eventDate !== undefined) sheet.getRange(row, 9).setValue(String(body.eventDate || '').slice(0, 50));

  SpreadsheetApp.flush();
  return { success: true };
}

function deleteProject_(body) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const row = findProjectRow_(sheet, body.projectId);
  if (!row) return { success: false, error: 'Project tidak ditemukan' };
  sheet.deleteRow(row);
  return { success: true };
}
