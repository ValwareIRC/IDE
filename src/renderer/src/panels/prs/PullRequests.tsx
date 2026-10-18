// Pull requests: review GitHub's open pull requests, or the current branch before pushing it. Each finding can
// go to the agent to fix, onto GitHub as a comment, or be called "not a problem" (kept as a rule for next time).
import { useEffect, useState } from "react";
import { openLink } from '@/lib/open'
import {
  ExternalLink,
  GitPullRequest,
  KeyRound,
  Loader2,
  MessageSquarePlus,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  Wrench,
} from "lucide-react";
import type { PullRequestInfo, ReviewFinding } from "@shared/types";
import { prism } from "@/lib/ipc";
import { useApp } from "@/state/app";
import { useLayout } from "@/state/layout";
import { useSessions } from "@/state/sessions";
import { toastError, useUi } from "@/state/ui";
import { cx, timeAgo } from "@/lib/format";

type Target = { kind: "branch" } | { kind: "pr"; pr: PullRequestInfo };

const clean = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );

function handToAgent(text: string): void {
  useLayout.getState().openAgent();
  const st = useSessions.getState();
  if (st.active) st.hand(st.active, text, []);
  else
    void st
      .create()
      .then((x) => x && useSessions.getState().hand(x.id, text, []));
}

function Finding({
  f,
  target,
  headSha,
  onGone,
}: {
  f: ReviewFinding;
  target: Target;
  headSha: string | null;
  onGone: () => void;
}): React.JSX.Element {
  const [posted, setPosted] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
  const fix = (): void =>
    handToAgent(
      `${target.kind === "pr" ? `In pull request #${target.pr.number} (branch ${target.pr.branch}): ` : ""}a review found this${where ? ` at ${where}` : ""}.\n\n**${f.title}**: ${f.detail}\n\nSuggested fix: ${f.fix}\n\nCheck it is real, then fix it${target.kind === "pr" ? " on that branch" : ""}.\n\n`,
    );
  const post = async (): Promise<void> => {
    if (target.kind !== "pr" || !headSha) return;
    try {
      setPosted(await prism.prs.post(target.pr.number, f, headSha));
    } catch (e) {
      toastError(e, "Could not post it");
    }
  };
  const dismiss = async (): Promise<void> => {
    try {
      await prism.prs.dismiss(f, reason);
      useUi
        .getState()
        .toast(
          "success",
          "Kept as a rule",
          "Later reviews will not report this. The rules are in .prism/review-rules.md.",
        );
      onGone();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className={cx("pr-finding", f.severity)}>
      <div className="pr-f-head">
        {f.severity === "problem" ? (
          <ShieldAlert size={14} className="rose" />
        ) : f.severity === "risk" ? (
          <ShieldAlert size={14} className="amber" />
        ) : (
          <ShieldCheck size={14} className="faint" />
        )}
        <b>{f.title}</b>
        {where && (
          <button
            className="pr-where mono"
            title="Open the file"
            onClick={() => useLayout.getState().openEditor(f.file)}
          >
            {where}
          </button>
        )}
      </div>
      <div className="pr-f-detail">{f.detail}</div>
      {f.fix && (
        <div className="pr-f-fix">
          <span className="faint">Fix: </span>
          {f.fix}
        </div>
      )}
      <div className="pr-f-acts">
        <button className="btn sm" onClick={fix}>
          <Wrench size={12} /> Fix in Prism
        </button>
        {target.kind === "pr" &&
          (posted ? (
            <a
              className="btn sm ghost"
              href={posted}
              onClick={(e) => (
                e.preventDefault(),
                openLink(posted)
              )}
            >
              <ExternalLink size={12} /> Posted
            </a>
          ) : (
            <button
              className="btn sm ghost"
              onClick={() => void post()}
              title="Add it as a comment on that line of the pull request"
            >
              <MessageSquarePlus size={12} /> Post to GitHub
            </button>
          ))}
        {dismissing ? (
          <span className="row grow" style={{ gap: 4 }}>
            <input
              className="input sm grow"
              autoFocus
              placeholder="Why it is fine (optional): later reviews learn from it"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void dismiss()}
            />
            <button className="btn sm" onClick={() => void dismiss()}>
              Keep as a rule
            </button>
          </span>
        ) : (
          <button
            className="btn sm ghost"
            onClick={() => setDismissing(true)}
            title="Not a problem: later reviews will not report it"
          >
            <ThumbsDown size={12} /> Not a problem
          </button>
        )}
      </div>
    </div>
  );
}

export function PullRequestsPanel(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace);
  const [data, setData] = useState<Awaited<
    ReturnType<typeof prism.prs.list>
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<Target>({ kind: "branch" });
  const [result, setResult] = useState<{
    key: string;
    findings: ReviewFinding[];
    model: string;
    title: string;
    headSha: string | null;
  } | null>(null);
  const [reviewing, setReviewing] = useState<"general" | "security" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [askToken, setAskToken] = useState(false);

  const load = (): void => {
    setLoading(true);
    void prism.prs
      .list()
      .then(setData)
      .catch((e: unknown) => setError(clean(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [workspace]);

  const key = target.kind === "pr" ? `pr${target.pr.number}` : "branch";
  const review = async (focus: "general" | "security"): Promise<void> => {
    setReviewing(focus);
    setError(null);
    try {
      const r = await prism.prs.review(
        target.kind === "pr" ? target.pr.number : null,
        focus,
      );
      setResult({ key, ...r });
    } catch (e) {
      setError(clean(e));
    } finally {
      setReviewing(null);
    }
  };
  const saveToken = async (): Promise<void> => {
    try {
      const login = await prism.prs.token(token);
      setToken("");
      setAskToken(false);
      useUi
        .getState()
        .toast(
          "success",
          login ? `Connected to GitHub as ${login}` : "Token removed",
        );
      load();
    } catch (e) {
      toastError(e, "GitHub did not accept it");
    }
  };

  const shown = result && result.key === key ? result : null;
  return (
    <div className="prs-wrap">
      <div className="prs-panel">
        <div className="prs-side">
          <div className="prs-side-head">
            <GitPullRequest size={14} className="accent" />
            <b>Pull requests</b>
            <span className="grow" />
            {loading && <Loader2 size={12} className="spin faint" />}
          </div>
          <button
            className={cx("prs-item", target.kind === "branch" && "on")}
            onClick={() => setTarget({ kind: "branch" })}
          >
            <span className="t">This branch</span>
            <span className="d">
              What a pull request from it would hold, reviewed before you push.
            </span>
          </button>
          {data?.repo ? (
            <>
              <div className="prs-group faint xs">
                {data.repo.owner}/{data.repo.repo} on GitHub ·{" "}
                {data.pulls.length} open
              </div>
              {data.pulls.map((p) => (
                <button
                  key={p.number}
                  className={cx(
                    "prs-item",
                    target.kind === "pr" &&
                      target.pr.number === p.number &&
                      "on",
                  )}
                  onClick={() => setTarget({ kind: "pr", pr: p })}
                >
                  <span className="t">
                    #{p.number} {p.title}
                  </span>
                  <span className="d">
                    {p.author} · {p.branch} · {timeAgo(p.updatedAt)}
                    {p.draft ? " · draft" : ""}
                  </span>
                </button>
              ))}
              {data.error && <div className="prs-note">{data.error}</div>}
            </>
          ) : (
            <div className="prs-note faint">
              This project's origin is not on GitHub, so only this branch can be
              reviewed.
            </div>
          )}
          <div className="prs-token">
            {data?.login ? (
              <span className="faint xs">
                <KeyRound size={11} /> GitHub: {data.login}{" "}
                <button
                  className="link-btn"
                  onClick={() => void prism.prs.token("").then(load)}
                >
                  forget
                </button>
              </span>
            ) : askToken ? (
              <div className="row" style={{ gap: 4 }}>
                <input
                  className="input sm grow"
                  type="password"
                  placeholder="GitHub token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void saveToken()}
                />
                <button
                  className="btn sm"
                  disabled={!token.trim()}
                  onClick={() => void saveToken()}
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                className="link-btn xs"
                onClick={() => setAskToken(true)}
                title="Needed for private repositories and to post comments. Kept encrypted on this computer."
              >
                <KeyRound size={11} /> Add a GitHub token
              </button>
            )}
          </div>
        </div>
        <div className="prs-main">
          <div className="prs-main-head">
            <b className="truncate">
              {target.kind === "pr"
                ? `#${target.pr.number} ${target.pr.title}`
                : "This branch"}
            </b>
            {target.kind === "pr" && (
              <button
                className="icon-btn sm"
                title="Open on GitHub"
                onClick={() => openLink(target.pr.url)}
              >
                <ExternalLink size={12} />
              </button>
            )}
            <span className="grow" />
            <button
              className="btn sm solid"
              disabled={!!reviewing}
              onClick={() => void review("general")}
            >
              {reviewing === "general" ? (
                <Loader2 size={12} className="spin" />
              ) : (
                <Sparkles size={12} />
              )}{" "}
              Review
            </button>
            <button
              className="btn sm"
              disabled={!!reviewing}
              onClick={() => void review("security")}
              title="Look only for security problems"
            >
              {reviewing === "security" ? (
                <Loader2 size={12} className="spin" />
              ) : (
                <ShieldAlert size={12} />
              )}{" "}
              Security review
            </button>
          </div>
          {error && <div className="prs-error">{error}</div>}
          {!shown && !reviewing && !error && (
            <div className="prs-empty faint">
              Review reads the whole change and lists only what is worth your
              time: where, why, and how to fix it.
            </div>
          )}
          {reviewing && (
            <div className="prs-empty">
              <Loader2 size={14} className="spin accent" /> Reading the change…
            </div>
          )}
          {shown && !reviewing && (
            <>
              <div className="prs-summary faint xs">
                {shown.findings.length
                  ? `${shown.findings.length} finding${shown.findings.length === 1 ? "" : "s"}`
                  : "Nothing worth reporting."}{" "}
                · {shown.title} · reviewed by {shown.model}
                {shown.findings.length > 1 && (
                  <button
                    className="btn sm ghost"
                    style={{ marginLeft: 8 }}
                    onClick={() =>
                      handToAgent(
                        `A review of ${shown.title} found these. Check each is real, then fix them:\n\n${shown.findings.map((f, i) => `${i + 1}. **${f.title}**${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}: ${f.detail} Fix: ${f.fix}`).join("\n")}\n\n`,
                      )
                    }
                  >
                    <Wrench size={12} /> Fix all in Prism
                  </button>
                )}
              </div>
              {shown.findings.map((f, i) => (
                <Finding
                  key={`${i}${f.title}`}
                  f={f}
                  target={target}
                  headSha={shown.headSha}
                  onGone={() =>
                    setResult((r) =>
                      r
                        ? { ...r, findings: r.findings.filter((x) => x !== f) }
                        : r,
                    )
                  }
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
