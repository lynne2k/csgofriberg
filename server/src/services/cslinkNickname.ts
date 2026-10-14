/**
 * CS Link 排行榜 / 房间座位上显示的昵称。只改显示，不改身份：
 * 成绩、排名、房间成员仍按访客 key 或登录用户 id 区分。
 * 前端 client/src/cslink/nick.ts 用同一套规则，两边要一起改。
 */
export function cleanCsLinkNickname(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const text = raw.normalize('NFKC')
    .replace(/[\p{C}<>"'`&\\]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const length = [...text].length;
  return length >= 2 && length <= 12 ? text : null;
}
