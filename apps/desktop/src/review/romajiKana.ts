/**
 * 简易罗马字 → 平假名（Hepburn 系），用于复习读音题，不依赖系统日文输入法。
 * 规则：小写 a-z 输入；退格删假名/缓冲；空格提交缓冲中音节（若有）。
 */

export type RomajiBufferState = {
  /** 已确定的假名 */
  kana: string;
  /** 尚未组成音节的罗马字尾缀（灰色显示） */
  pending: string;
};

/** 多音节优先（长匹配在前） */
const SYLLABLES: Array<[string, string]> = [
  ["kya", "きゃ"],
  ["kyu", "きゅ"],
  ["kyo", "きょ"],
  ["sha", "しゃ"],
  ["shu", "しゅ"],
  ["sho", "しょ"],
  ["chi", "ち"],
  ["cha", "ちゃ"],
  ["chu", "ちゅ"],
  ["cho", "ちょ"],
  ["nya", "にゃ"],
  ["nyu", "にゅ"],
  ["nyo", "にょ"],
  ["hya", "ひゃ"],
  ["hyu", "ひゅ"],
  ["hyo", "ひょ"],
  ["bya", "びゃ"],
  ["byu", "びゅ"],
  ["byo", "びょ"],
  ["pya", "ぴゃ"],
  ["pyu", "ぴゅ"],
  ["pyo", "ぴょ"],
  ["mya", "みゃ"],
  ["myu", "みゅ"],
  ["myo", "みょ"],
  ["rya", "りゃ"],
  ["ryu", "りゅ"],
  ["ryo", "りょ"],
  ["gya", "ぎゃ"],
  ["gyu", "ぎゅ"],
  ["gyo", "ぎょ"],
  ["ja", "じゃ"],
  ["ju", "じゅ"],
  ["jo", "じょ"],
  ["jya", "じゃ"],
  ["jyu", "じゅ"],
  ["jyo", "じょ"],
  ["dzu", "づ"],
  ["dji", "ぢ"],
  ["shi", "し"],
  ["fu", "ふ"],
  ["wi", "うぃ"],
  ["we", "うぇ"],
  ["wo", "を"],
  ["ye", "いぇ"],
  ["yi", "い"],
  ["ka", "か"],
  ["ki", "き"],
  ["ku", "く"],
  ["ke", "け"],
  ["ko", "こ"],
  ["ga", "が"],
  ["gi", "ぎ"],
  ["gu", "ぐ"],
  ["ge", "げ"],
  ["go", "ご"],
  ["sa", "さ"],
  ["si", "し"],
  ["su", "す"],
  ["se", "せ"],
  ["so", "そ"],
  ["za", "ざ"],
  ["zi", "じ"],
  ["zu", "ず"],
  ["ze", "ぜ"],
  ["zo", "ぞ"],
  ["ta", "た"],
  ["ti", "ち"],
  ["tu", "つ"],
  ["te", "て"],
  ["to", "と"],
  ["da", "だ"],
  ["di", "ぢ"],
  ["du", "づ"],
  ["de", "で"],
  ["do", "ど"],
  ["na", "な"],
  ["ni", "に"],
  ["nu", "ぬ"],
  ["ne", "ね"],
  ["no", "の"],
  ["nn", "ん"],
  ["ha", "は"],
  ["hi", "ひ"],
  ["he", "へ"],
  ["ho", "ほ"],
  ["ba", "ば"],
  ["bi", "び"],
  ["bu", "ぶ"],
  ["be", "べ"],
  ["bo", "ぼ"],
  ["pa", "ぱ"],
  ["pi", "ぴ"],
  ["pu", "ぷ"],
  ["pe", "ぺ"],
  ["po", "ぽ"],
  ["ma", "ま"],
  ["mi", "み"],
  ["mu", "む"],
  ["me", "め"],
  ["mo", "も"],
  ["ya", "や"],
  ["yu", "ゆ"],
  ["yo", "よ"],
  ["ra", "ら"],
  ["ri", "り"],
  ["ru", "る"],
  ["re", "れ"],
  ["ro", "ろ"],
  ["wa", "わ"],
  ["a", "あ"],
  ["i", "い"],
  ["u", "う"],
  ["e", "え"],
  ["o", "お"],
];

function tryConsume(buf: string): { kana: string; rest: string } | null {
  const lower = buf.toLowerCase();
  for (const [rom, kana] of SYLLABLES) {
    if (lower.startsWith(rom)) {
      return { kana, rest: buf.slice(rom.length) };
    }
  }
  return null;
}

/** 将 pending 罗马字尽量转成假名；剩余无法匹配的留在 pending */
export function flushRomajiToKana(kana: string, pending: string): RomajiBufferState {
  let k = kana;
  let p = pending.toLowerCase();
  while (p.length) {
    if (
      p.length >= 2 &&
      p[0] === p[1] &&
      /^[bcdfghjklmpqrstvwxyz]$/u.test(p[0])
    ) {
      k += "っ";
      p = p.slice(1);
      continue;
    }
    const m = tryConsume(p);
    if (!m) break;
    k += m.kana;
    p = m.rest;
  }
  return { kana: k, pending: p };
}

/** 处理一次按键：可打印 a-z、退格、空格（尝试 flush） */
export function applyRomajiKey(state: RomajiBufferState, key: string): RomajiBufferState {
  if (key === "Backspace") {
    if (state.pending.length) {
      return { kana: state.kana, pending: state.pending.slice(0, -1) };
    }
    if (state.kana.length) {
      const g = [...state.kana];
      g.pop();
      return { kana: g.join(""), pending: "" };
    }
    return state;
  }
  if (key === " " || key === "Enter") {
    return flushRomajiToKana(state.kana, state.pending);
  }
  if (key.length === 1 && /[a-z]/i.test(key)) {
    const ch = key.toLowerCase();
    return flushRomajiToKana(state.kana, state.pending + ch);
  }
  return state;
}

export function romajiStateToSubmitText(s: RomajiBufferState): string {
  const flushed = flushRomajiToKana(s.kana, s.pending);
  let k = flushed.kana;
  let p = flushed.pending;
  if (p === "n") {
    k += "ん";
    p = "";
  }
  return k + p;
}
