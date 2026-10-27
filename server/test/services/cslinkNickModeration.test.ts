import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { moderateCsLinkNickname } from '../../src/services/cslinkNickModeration';
import { cleanCsLinkNickname, displayCsLinkNickname } from '../../src/services/cslinkNickname';

const blocked = ['糸田井并瓦', '细井瓶', '习近平', '習近平', '习 近 平', 'x1jinp1ng', 'XJP', '小熊维尼', '维尼',
  '胡锦涛', '法輪功', '氵去车仑功', '六四', '天安门', '共产党', 'fuck', 'f u c k', '操你妈',
  '台湾', '政府', '炸弹', '炸弹人'];
const allowed = ['老汤', '老尼', '好好学习', '习惯了', '平平无奇', 'NiKo', 's1mple', '卡托维兹', 'AK47', '细田',
  '井瓶', '打电话哈', '拯救地球'];

describe('cslink nickname moderation', () => {
  it.each(blocked)('blocks %s', (name) => expect(moderateCsLinkNickname(name).ok).toBe(false));
  it.each(allowed)('allows %s', (name) => expect(moderateCsLinkNickname(name).ok).toBe(true));

  it('does not flag any player nickname', () => {
    const file = path.resolve(__dirname, '../../../client/public/cslink/data/players.json');
    const players = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[][];
    const flagged = players.map((p) => String(p[1])).filter((n) => !moderateCsLinkNickname(n).ok);
    expect(players.length).toBeGreaterThan(1000);
    expect(flagged).toEqual([]);
  });

  it('falls back to a display code for stored bad names', () => {
    expect(cleanCsLinkNickname('习近平')).toBeNull();
    expect(cleanCsLinkNickname('老汤')).toBe('老汤');
    expect(displayCsLinkNickname('维尼', 'g:abc')).toMatch(/^访客#[0-9A-Z]{5}$/);
    expect(displayCsLinkNickname('维尼', 'u:7')).toMatch(/^用户#[0-9A-Z]{5}$/);
    expect(displayCsLinkNickname('老尼', 'g:abc')).toBe('老尼');
  });
});
