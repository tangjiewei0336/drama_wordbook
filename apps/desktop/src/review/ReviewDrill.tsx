import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchReviewSnapshot,
  localCalendarDay,
  postReviewAnswer,
  postReviewStart,
  type ReviewQuestion,
} from "../api";
import { markReadingLcs, normalizeReadingInput } from "./lcsJa";
import { applyRomajiKey, romajiStateToSubmitText, type RomajiBufferState } from "./romajiKana";
import { REVIEW_LOADING_TIPS } from "./reviewLoadingTips";

function speakJapanese(text: string): void {
  const t = String(text || "").trim();
  if (!t) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t);
  u.lang = "ja-JP";
  window.speechSynthesis.speak(u);
}

type WrongReveal = {
  mode: "mc" | "sentence";
  correct: string;
  yours: string;
  next: ReviewQuestion | null;
  done: boolean;
  mastered?: boolean;
};

type Props = { sidecarOnline: boolean };

/** 桌面端本地复习（依赖侧车 /review） */
export function ReviewDrill({ sidecarOnline }: Props) {
  const calendarDay = localCalendarDay();
  const [limit, setLimit] = useState(20);
  const [snap, setSnap] = useState<{ eligible_heads: number; mastered_heads: number } | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [queueTotal, setQueueTotal] = useState(0);
  const [current, setCurrent] = useState<ReviewQuestion | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState("");

  const [mcPick, setMcPick] = useState<number | null>(null);
  const [romaji, setRomaji] = useState<RomajiBufferState>({ kana: "", pending: "" });
  const romajiFieldRef = useRef<HTMLDivElement | null>(null);
  const [readingLastGuess, setReadingLastGuess] = useState("");
  const [sentenceOrder, setSentenceOrder] = useState<string[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropOverIdx, setDropOverIdx] = useState<number | null>(null);
  const [wrongReveal, setWrongReveal] = useState<WrongReveal | null>(null);

  const [tipSpin, setTipSpin] = useState(0);
  const prevLoadingRef = useRef(false);

  useEffect(() => {
    if (loading && !prevLoadingRef.current) {
      setTipSpin(Math.floor(Math.random() * REVIEW_LOADING_TIPS.length));
    }
    prevLoadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    if (!loading) return;
    const id = window.setInterval(() => {
      setTipSpin((n) => (n + 1) % REVIEW_LOADING_TIPS.length);
    }, 4200);
    return () => window.clearInterval(id);
  }, [loading]);

  const activeTip = REVIEW_LOADING_TIPS[tipSpin % REVIEW_LOADING_TIPS.length] ?? REVIEW_LOADING_TIPS[0];

  const loadSnap = useCallback(async () => {
    if (!sidecarOnline) return;
    try {
      setSnap(await fetchReviewSnapshot());
    } catch {
      setSnap(null);
    }
  }, [sidecarOnline]);

  useEffect(() => {
    void loadSnap();
  }, [loadSnap]);

  const applyQuestion = useCallback((q: ReviewQuestion | null) => {
    setWrongReveal(null);
    setMcPick(null);
    setRomaji({ kana: "", pending: "" });
    setSentenceOrder([]);
    setDragIdx(null);
    setDropOverIdx(null);
    if (!q || q.mode !== "reading" || !(q.mistake_seen as boolean)) {
      setReadingLastGuess("");
    }
    setCurrent(q);
    if (q && q.mode === "sentence") {
      const ids = (q.shuffled_piece_ids as string[]) || [];
      setSentenceOrder([...ids]);
    }
  }, []);

  useEffect(() => {
    if (current?.mode === "reading" && !wrongReveal) {
      const t = window.setTimeout(() => romajiFieldRef.current?.focus(), 80);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [current?.id, current?.mode, wrongReveal]);

  const dismissWrongAndContinue = useCallback(() => {
    if (!wrongReveal) return;
    if (wrongReveal.mastered) {
      setBanner("恭喜，该词头已满足「三日记住」条件，将不再进入复习队列。");
    } else {
      setBanner("");
    }
    setDone(wrongReveal.done);
    applyQuestion(wrongReveal.next);
  }, [wrongReveal, applyQuestion]);

  const moveSentenceItem = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    setSentenceOrder((order) => {
      const arr = [...order];
      const [it] = arr.splice(from, 1);
      const insertAt = from < to ? to - 1 : to;
      arr.splice(insertAt, 0, it);
      return arr;
    });
  }, []);

  const onStart = async () => {
    if (!sidecarOnline) return;
    setLoading(true);
    setBanner("正在生成中文释义并组卷，请稍候……");
    try {
      const r = await postReviewStart(calendarDay, limit);
      setSessionId(r.session_id);
      setQueueTotal(r.total);
      setDone(r.completed);
      if (r.empty_reason === "no_eligible_heads") {
        setBanner("当前没有需要复习的词头（可能均已记住或词库为空）。");
        applyQuestion(null);
      } else if (r.empty_reason === "cannot_build_questions") {
        setBanner("无法从已有数据组合出题目，请检查词条是否含释义、读音或收藏句子。");
        applyQuestion(null);
      } else {
        applyQuestion(r.current);
        if (r.completed) {
          setBanner("今日队列已完成或无可出题项。");
        } else {
          setBanner("");
        }
      }
      await loadSnap();
    } catch (e) {
      setBanner(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  };

  const submitMc = async () => {
    if (!sessionId || mcPick === null || !current) return;
    const choices = (current.choices as string[]) || [];
    const pickIdx = mcPick;
    setLoading(true);
    try {
      const r = await postReviewAnswer({
        session_id: sessionId,
        calendar_day: calendarDay,
        choice_index: pickIdx,
      });
      if (!r.correct && current.mode === "mc") {
        const ci = Number(current.correct_index);
        setWrongReveal({
          mode: "mc",
          correct: choices[ci] ?? "",
          yours: choices[pickIdx] ?? "",
          next: r.current,
          done: r.done,
          mastered: Boolean(r.head_state?.mastered),
        });
        setMcPick(null);
        setDone(r.done);
        await loadSnap();
        return;
      }
      if (r.head_state?.mastered) {
        setBanner("恭喜，该词头已满足「三日记住」条件，将不再进入复习队列。");
      } else setBanner("");
      setDone(r.done);
      applyQuestion(r.current);
      await loadSnap();
    } catch (e) {
      setBanner(String((e as Error).message || e));
    } finally {
      setLoading(false);
      setMcPick(null);
    }
  };

  const submitReading = async () => {
    if (!sessionId || !current || current.mode !== "reading") return;
    const text = normalizeReadingInput(romajiStateToSubmitText(romaji));
    if (!text) {
      setBanner("请输入读音（罗马字转假名）。");
      return;
    }
    setLoading(true);
    try {
      const prev = current;
      const normGuess = normalizeReadingInput(text);
      const r = await postReviewAnswer({
        session_id: sessionId,
        calendar_day: calendarDay,
        text,
      });
      if (r.head_state?.mastered) {
        setBanner("恭喜，该词头已满足「三日记住」条件，将不再进入复习队列。");
      }
      setDone(r.done);
      applyQuestion(r.current);
      setRomaji({ kana: "", pending: "" });
      if (!r.hint_reading_after_wrong) {
        setReadingLastGuess("");
        if (!r.head_state?.mastered) {
          setBanner("");
        }
      } else {
        setReadingLastGuess(normGuess);
        const tts = String(prev.tts_text || prev.prompt_surface || "");
        speakJapanese(tts);
        if (!r.head_state?.mastered) {
          setBanner("再试一次；已朗读提示音。下方对照最近一次输入。");
        }
      }
    } catch (e) {
      setBanner(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  };

  const submitSentence = async () => {
    if (!sessionId || !current) return;
    const correctJa = String(current.correct_surface_join || "");
    const yoursJa = sentenceOrder.map((id) => idToSurf.get(id) || "").join("");
    setLoading(true);
    try {
      const r = await postReviewAnswer({
        session_id: sessionId,
        calendar_day: calendarDay,
        order_piece_ids: sentenceOrder,
      });
      if (!r.correct && current.mode === "sentence") {
        setWrongReveal({
          mode: "sentence",
          correct: correctJa,
          yours: yoursJa,
          next: r.current,
          done: r.done,
          mastered: Boolean(r.head_state?.mastered),
        });
        setDone(r.done);
        await loadSnap();
        return;
      }
      setDone(r.done);
      applyQuestion(r.current);
      if (r.head_state?.mastered) {
        setBanner("恭喜，该词头已满足「三日记住」条件，将不再进入复习队列。");
      } else setBanner("");
      await loadSnap();
    } catch (e) {
      setBanner(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  };

  const idToSurf = useMemo(() => {
    const m = new Map<string, string>();
    const arr = (current?.pieces as Array<{ id: string; surface: string }>) || [];
    for (const p of arr) {
      m.set(p.id, p.surface);
    }
    return m;
  }, [current]);

  const expectedNorm = typeof current?.expected_normalized === "string" ? current.expected_normalized : "";
  const showReadingLcs =
    current?.mode === "reading" && Boolean(current.mistake_seen && expectedNorm && readingLastGuess);

  const readingMarks = showReadingLcs ? markReadingLcs(expectedNorm, readingLastGuess) : [];

  const modeLabel = ((): string => {
    const m = current?.mode;
    if (m === "mc") return "选义";
    if (m === "reading") return "写读音";
    if (m === "sentence") return "连词成句";
    return "";
  })();

  return (
    <div className="review-pane-wrap">
      <div className="review-pane">
        <div className="review-header">
          <div>
            <span className="eyebrow">复习</span>
            <h2>百词斩式 · 单日一轮</h2>
          </div>
          <div className="review-stats">
            {snap ? (
              <>
                <span>
                  可出题词头：<strong>{snap.eligible_heads}</strong>
                </span>
                <span>
                  已标记记住：<strong>{snap.mastered_heads}</strong>
                </span>
              </>
            ) : (
              <span>{sidecarOnline ? "正在加载统计…" : "本地服务离线"}</span>
            )}
          </div>
        </div>

        <section className="review-controls">
          <label>
            今日日期 <code>{calendarDay}</code>
          </label>
          <label>
            题量
            <input
              type="number"
              min={5}
              max={200}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 20)}
              disabled={loading}
            />
          </label>
          <button type="button" className="primary" onClick={onStart} disabled={loading || !sidecarOnline}>
            {loading ? "处理中…" : sessionId ? "重新开始今日" : "开始一轮"}
          </button>
        </section>

        {banner ? <div className="review-banner">{banner}</div> : null}

        {done && !current ? (
          <div className="review-empty">
            <p>本轮已完成或无更多题目。</p>
          </div>
        ) : null}

        {current && !done ? (
          <section className="review-card review-card-relative">
            <div className="review-card-head">
              <span className="review-badge">{modeLabel}</span>
              {queueTotal ? <small>题库本轮约 {queueTotal} 题（含错题重排）</small> : null}
            </div>

            {current.mode === "mc" ? (
              <div className="review-mc">
                <p className="review-prompt">{String(current.prompt_surface || "")}</p>
                <p className="muted">下列选项均为中文释义</p>
                <div className="review-choices">
                  {((current.choices as string[]) || []).map((c, idx) => (
                    <button
                      key={`${idx}-${c}`}
                      type="button"
                      className={mcPick === idx ? "ghost active" : "ghost"}
                      onClick={() => setMcPick(idx)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <button type="button" className="primary" disabled={loading || mcPick === null} onClick={submitMc}>
                  确定
                </button>
              </div>
            ) : null}

            {current.mode === "reading" ? (
              <div className="review-reading">
                <p className="reading-hint">
                  {String(current.prompt_surface || "")}
                  {" · "}
                  <small>读音形态提示：{String(current.reading_script_hint || "mixed")}</small>
                </p>
                <p className="muted review-romaji-hint">
                  使用<strong>罗马字</strong>输入假名（如 <code>ka</code>→か、<code>shi</code>→し、双写辅音促音如{" "}
                  <code>tte</code>→って），<strong>Enter</strong> 提交；不依赖系统日文输入法。
                </p>
                <div
                  ref={romajiFieldRef}
                  className="review-romaji-field"
                  tabIndex={0}
                  role="textbox"
                  aria-label="罗马字输入假名"
                  lang="en"
                  inputMode="text"
                  autoCorrect="off"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === "Tab" || e.key === "Escape") return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submitReading();
                      return;
                    }
                    if (e.ctrlKey || e.metaKey || e.altKey) return;
                    if (e.key === "Backspace" || e.key === " " || (e.key.length === 1 && /[a-z]/i.test(e.key))) {
                      e.preventDefault();
                      setRomaji((s) => applyRomajiKey(s, e.key));
                    }
                  }}
                >
                  <span className="romaji-kana">{romaji.kana}</span>
                  <span className="romaji-pending">{romaji.pending}</span>
                  <span className="romaji-caret" aria-hidden />
                </div>
                {current.mode === "reading" && showReadingLcs ? (
                  <div className="review-lcs">
                    <small>最近一次输入校对（绿色为与标准答案 LCS 重合部分）：</small>
                    <div>
                      {readingMarks.map((x, i) => (
                        <span key={`${i}-${x.ch}`} className={x.bucket === "match" ? "lcs-ok" : "lcs-bad"}>
                          {x.ch}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <button type="button" className="primary" disabled={loading} onClick={submitReading}>
                  提交
                </button>
              </div>
            ) : null}

            {current.mode === "sentence" ? (
              <div className="review-sent">
                {current.example_zh ? <p className="muted">参考译：{String(current.example_zh)}</p> : null}
                <p className="muted">拖动词块调整顺序，还原日文原句：</p>
                <div className="sentence-chips" role="list">
                  {sentenceOrder.map((id, idx) => (
                    <div
                      key={id}
                      role="listitem"
                      draggable
                      className={`chip chip-draggable ${dragIdx === idx ? "chip-dragging" : ""} ${dropOverIdx === idx ? "chip-drop-target" : ""}`}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/review-idx", String(idx));
                        e.dataTransfer.effectAllowed = "move";
                        setDragIdx(idx);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDropOverIdx(idx);
                      }}
                      onDragLeave={() => setDropOverIdx((v) => (v === idx ? null : v))}
                      onDrop={(e) => {
                        e.preventDefault();
                        const raw = e.dataTransfer.getData("text/review-idx");
                        const from = Number.parseInt(raw, 10);
                        if (!Number.isNaN(from)) {
                          moveSentenceItem(from, idx);
                        }
                        setDragIdx(null);
                        setDropOverIdx(null);
                      }}
                      onDragEnd={() => {
                        setDragIdx(null);
                        setDropOverIdx(null);
                      }}
                    >
                      {idToSurf.get(id) || id}
                    </div>
                  ))}
                </div>
                <button type="button" className="primary" disabled={loading} onClick={submitSentence}>
                  提交
                </button>
              </div>
            ) : null}

            {wrongReveal ? (
              <div className="review-wrong-overlay">
                <div className="review-wrong-card">
                  <h3 className="review-wrong-title">再记一下</h3>
                  {wrongReveal.mode === "mc" ? (
                    <>
                      <p className="review-wrong-line">
                        <span className="label">你的选择</span>
                        <strong>{wrongReveal.yours || "—"}</strong>
                      </p>
                      <p className="review-wrong-line review-wrong-correct">
                        <span className="label">正确答案</span>
                        <strong>{wrongReveal.correct}</strong>
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="review-wrong-line">
                        <span className="label">你的排序</span>
                        <strong className="review-wrong-ja">{wrongReveal.yours || "—"}</strong>
                      </p>
                      <p className="review-wrong-line review-wrong-correct">
                        <span className="label">正确原句</span>
                        <strong className="review-wrong-ja">{wrongReveal.correct}</strong>
                      </p>
                    </>
                  )}
                  <button type="button" className="primary review-wrong-continue" onClick={dismissWrongAndContinue}>
                    继续
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <aside className="review-footnote">
          <p>
            精通规则：同一词头在<strong>三个不同日历日</strong>
            （不必连续）各答对过一题后即视为「记住」；之后在词库新增的同一词头也不会再参与复习出题。错题会在本轮末尾插队重现，题型可能与首次不同。
          </p>
        </aside>
      </div>

      {loading ? (
        <div className="review-loading-overlay" role="status" aria-live="polite">
          <div className="review-progress-block">
            <div className="review-progress-label">
              {banner && (banner.includes("稍候") || banner.includes("生成")) ? banner : "处理中，请稍候……"}
            </div>
            <div className="review-progress-track" aria-hidden>
              <div className="review-progress-indeterminate" />
            </div>
          </div>
          <div className="review-loading-tip">
            <p className="review-tip-ja">{activeTip.ja}</p>
            <p className="review-tip-zh">{activeTip.zh}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
