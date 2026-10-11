import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CsLinkEvidence } from '../services/cslinkEvidence';
import { CsLinkQuestions } from '../services/cslinkQuestions';

async function main() {
  const versionDir = process.env.CSLINK_REVIEW_VERSION_DIR;
  if (!versionDir) throw new Error('CSLINK_REVIEW_VERSION_DIR is required');
  const store = await CsLinkEvidence.open(versionDir);
  try {
    const bank = new CsLinkQuestions(store);
    const outputRoot = path.resolve(versionDir, '../../question-banks');
    const directory = path.join(outputRoot, bank.bank.bankVersion);
    const payload = JSON.stringify(bank.reviewExport(), null, 2) + '\n';
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const manifest = JSON.stringify({ bankVersion: bank.bank.bankVersion, dataVersion: store.version,
      releaseReady: false, artifacts: { 'review.json': digest } }, null, 2) + '\n';
    if (fs.existsSync(directory)) {
      if (fs.readFileSync(path.join(directory, 'review.json'), 'utf8') !== payload ||
          fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8') !== manifest) {
        throw new Error('Existing question bank differs; preserved without overwrite');
      }
    } else {
      fs.mkdirSync(outputRoot, { recursive: true });
      const staging = fs.mkdtempSync(path.join(outputRoot, '.building-'));
      try {
        fs.writeFileSync(path.join(staging, 'review.json'), payload);
        fs.writeFileSync(path.join(staging, 'manifest.json'), manifest);
        fs.renameSync(staging, directory);
      } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
    }
    console.log(JSON.stringify({ directory, ...bank.metadata(), reviewSample: bank.reviewExport().reviewSample.length }, null, 2));
  } finally { store.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
