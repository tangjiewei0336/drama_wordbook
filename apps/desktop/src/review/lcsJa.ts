/** 日文读音：按 grapheme LCS，将用户输入逐字符标成 match/miss */

export type CharBucket = "match" | "miss";

export function normalizeReadingInput(s: string): string {
  const t = [...s.normalize("NFKC")].filter((ch) => !/\s/u.test(ch));
  return t.join("");
}

export function graphemes(s: string): string[] {
  try {
    const seg = new Intl.Segmenter("ja-JP", { granularity: "grapheme" });
    return Array.from(seg.segment(s), (x) => x.segment).filter(Boolean);
  } catch {
    return [...s];
  }
}

export function markReadingLcs(expectedNorm: string, userNorm: string): Array<{ ch: string; bucket: CharBucket }> {
  const a = graphemes(expectedNorm.toLowerCase());
  const b = graphemes(userNorm.toLowerCase());
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  const out: Array<{ ch: string; bucket: CharBucket }> = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ ch: b[j], bucket: "match" });
      i++;
      j++;
    } else if (i < n && dp[i][j] === dp[i + 1][j]) {
      i++;
    } else if (j < m) {
      out.push({ ch: b[j], bucket: "miss" });
      j++;
    }
  }
  return out;
}
