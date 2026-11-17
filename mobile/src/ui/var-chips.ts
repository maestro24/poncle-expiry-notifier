/**
 * Template editor variable chips (audit I8). A chip inserts the Korean token it
 * shows ({고객명}), not the English one — what the staff member sees in the chip
 * is what lands in the 문구. Only aliases the renderer knows (sender.ts
 * KOREAN_TOKEN_ALIASES) become chips, so a chip can never insert a token that
 * would be sent as-is; new aliases ({전화번호}, {거래처}, {담당}) appear as soon as
 * the domain adds them.
 */
import { KOREAN_TOKEN_ALIASES } from "../domain/sender";

export interface VarChip {
  label: string;
  token: string;
}

/** Display order: who, where, what, when. Unlisted aliases follow. */
const ORDER = [
  "고객명", "전화번호", "통신사", "거래처", "담당", "모델", "요금제",
  "개통일", "만료일", "시점", "경과개월", "경과년수",
];

export function templateVarChips(aliases: Readonly<Record<string, string>> = KOREAN_TOKEN_ALIASES): VarChip[] {
  const known = Object.keys(aliases);
  const labels = [...ORDER.filter((l) => known.includes(l)), ...known.filter((l) => !ORDER.includes(l))];
  return labels.map((label) => ({ label, token: `{${label}}` }));
}
